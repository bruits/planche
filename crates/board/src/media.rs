//! What a file holds, from as little of its start as tells, so that hosts need not copy every
//! image whole into the core, whose memory never shrinks.

use std::num::NonZeroU32;

use serde::Serialize;

use crate::animation::{Animation, animation, from_start};
use crate::video::{Video, brands};
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

/// Every extension that [`extension`] gives. Both name asset files, so changing either changes
/// the format.
pub const EXTENSIONS: [&str; 12] = [
    "avif", "bmp", "gif", "heic", "jpg", "mkv", "mov", "mp4", "png", "svg", "webm", "webp",
];

/// The extension of a file holding `bytes`, its start or all of it, from no more of them than
/// [`MEDIA_START`], so that both name it alike.
pub fn extension(bytes: &[u8]) -> Option<&'static str> {
    let bytes = &bytes[..bytes.len().min(MEDIA_START)];
    let brands = brands(bytes);
    if let Some(video) = video(bytes) {
        return Some(match video {
            Video::Mp4 if brands.as_ref().is_none_or(|(major, _)| *major == b"qt  ") => "mov",
            Video::Mp4 => "mp4",
            Video::WebM => "webm",
            Video::Matroska => "mkv",
        });
    }
    if is_markup(bytes) {
        return bytes.windows(4).any(|tag| tag == b"<svg").then_some("svg");
    }
    match bytes {
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n', ..] => Some("png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("jpg"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("gif"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("webp"),
        [b'B', b'M', ..] => Some("bmp"),
        _ => {
            let (major, compatible) = brands?;
            if std::iter::once(major)
                .chain(compatible)
                .any(|brand| [b"avif", b"avis"].contains(&brand))
            {
                Some("avif")
            } else {
                let heic = [b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis"];
                heic.contains(&major).then_some("heic")
            }
        }
    }
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
    fn a_file_takes_the_extension_its_start_tells() {
        let webm = [
            0x1A, 0x45, 0xDF, 0xA3, 0x87, 0x42, 0x82, 0x84, b'w', b'e', b'b', b'm',
        ];
        for (bytes, told) in [
            (b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".as_slice(), Some("png")),
            (b"\xFF\xD8\xFF\xE0\x00\x10JFIF", Some("jpg")),
            (b"GIF87a\x01\x00", Some("gif")),
            (&gif(2), Some("gif")),
            (b"RIFF\x04\x00\x00\x00WEBPVP8 ", Some("webp")),
            (b"BM\x3a\x00", Some("bmp")),
            (
                b"\x00\x00\x00\x18ftypavif\x00\x00\x00\x00avifmif1",
                Some("avif"),
            ),
            (
                b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1avif",
                Some("avif"),
            ),
            (
                b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic",
                Some("heic"),
            ),
            (b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1miaf", None),
            (
                b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2\x00\x00\x00\x08mdat",
                Some("mp4"),
            ),
            // Boxes running to the end of the file, or with a size of 64 bits.
            (b"\x00\x00\x00\x00ftypisom\x00\x00\x02\x00isom", Some("mp4")),
            (
                b"\x00\x00\x00\x00ftypavif\x00\x00\x00\x00mif1",
                Some("avif"),
            ),
            (
                b"\x00\x00\x00\x01ftyp\x00\x00\x00\x00\x00\x00\x00\x20isom\x00\x00\x02\x00isom",
                Some("mp4"),
            ),
            (b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  ", Some("mov")),
            // An old QuickTime movie, from before `ftyp`.
            (b"\x00\x00\x00\x08wide\x00\x00\x00\x08mdat", Some("mov")),
            (&webm, Some("webm")),
            (
                br#"<?xml version="1.0"?><svg width="20" height="10"/>"#,
                Some("svg"),
            ),
            (b"\xEF\xBB\xBF <svg viewBox=\"0 0 1 1\"/>", Some("svg")),
            (b"<html></html>", None),
            (b"plain text", None),
            (b"", None),
        ] {
            assert_eq!(
                extension(bytes),
                told,
                "{:?}",
                String::from_utf8_lossy(bytes)
            );
            if let Some(told) = told {
                assert!(EXTENSIONS.contains(&told));
            }
        }

        // Whether given its start or all of it.
        let mut late = b"<!--".to_vec();
        late.resize(MEDIA_START, b' ');
        late.extend(b"--><svg/>");
        assert_eq!(extension(&late), None);
        assert_eq!(extension(&late[..MEDIA_START]), None);
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
