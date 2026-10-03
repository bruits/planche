//! What a file holds, from as little of its start as tells, so that hosts need not copy every
//! image whole into the core, whose memory never shrinks.

use std::num::NonZeroU32;

use serde::Serialize;

use crate::animation::{Animation, animation, from_start};
use crate::{Size, svg_size, video};

/// How much of a file's start [`media`] takes to tell what most files hold.
pub const MEDIA_START: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Media {
    /// Played from a blob of this type.
    Video {
        #[serde(rename = "type")]
        mime: &'static str,
    },
    Svg {
        size: Size,
    },
    /// Markup that is no SVG, such as HTML.
    Markup,
    /// Played through this many times, `None` for ever.
    Animated {
        plays: Option<NonZeroU32>,
    },
    Still,
}

/// What a file holds, from `bytes`, its start, or all of it when `whole`. `None` when its start
/// does not tell, as a GIF's frames, an animated WebP's, or an SVG's root past it take more.
pub fn media(bytes: &[u8], whole: bool) -> Option<Media> {
    if let Some(video) = video(bytes) {
        return Some(Media::Video { mime: video.mime() });
    }
    if is_markup(bytes) {
        return match svg_size(bytes) {
            Some(size) => Some(Media::Svg { size }),
            None => whole.then_some(Media::Markup),
        };
    }
    let moving = if whole {
        animation(bytes)
    } else {
        from_start(bytes)?
    };
    Some(match moving {
        Some(Animation::Forever) => Media::Animated { plays: None },
        Some(Animation::Plays(times)) => Media::Animated { plays: Some(times) },
        None => Media::Still,
    })
}

/// Only an SVG may start so.
fn is_markup(bytes: &[u8]) -> bool {
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    text.trim_ascii_start().starts_with(b"<")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gif(frames: usize) -> Vec<u8> {
        let mut bytes = b"GIF89a\x01\x00\x01\x00\x00\x00\x00".to_vec();
        for _ in 0..frames {
            bytes.extend(b"\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x4C\x01\x00");
        }
        bytes.push(0x3B);
        bytes
    }

    #[test]
    fn a_file_is_told_by_its_start_but_for_what_takes_more_of_it() {
        let movie = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2\x00\x00\x00\x08mdat";
        assert_eq!(
            media(movie, false),
            Some(Media::Video { mime: "video/mp4" })
        );
        let svg = br#"<?xml version="1.0"?> <svg width="20" height="10"><rect/></svg>"#;
        let size = Size {
            width: 20,
            height: 10,
        };
        assert_eq!(media(svg, false), Some(Media::Svg { size }));
        // Its root past the start, or none at all.
        assert_eq!(media(&svg[..30], false), None);
        assert_eq!(media(b"\xEF\xBB\xBF <html></html>", false), None);
        assert_eq!(
            media(b"\xEF\xBB\xBF <html></html>", true),
            Some(Media::Markup)
        );
        assert_eq!(media(&gif(2)[..20], false), None);
        assert_eq!(
            media(&gif(2), true),
            Some(Media::Animated {
                plays: NonZeroU32::new(1)
            })
        );
        assert_eq!(media(&gif(1), true), Some(Media::Still));
        let jpeg = b"\xFF\xD8\xFF\xE0\x00\x10JFIF";
        assert_eq!(media(jpeg, false), Some(Media::Still));
        assert_eq!(media(jpeg, true), Some(Media::Still));
    }

    #[test]
    fn what_a_file_holds_reads_as_the_web_app_takes_it() {
        let told = |media: Media| serde_json::to_string(&media).unwrap();
        assert_eq!(
            told(Media::Video { mime: "video/webm" }),
            r#"{"kind":"video","type":"video/webm"}"#
        );
        assert_eq!(
            told(Media::Animated { plays: None }),
            r#"{"kind":"animated","plays":null}"#
        );
        assert_eq!(told(Media::Still), r#"{"kind":"still"}"#);
    }
}
