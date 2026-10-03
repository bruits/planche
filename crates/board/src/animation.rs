//! Whether an image moves, and how it plays, from its bytes alone: a GIF, a PNG, or a WebP with
//! more than one frame, played as browsers play them.

use std::num::NonZeroU32;

/// How many times an animated image plays through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Animation {
    Forever,
    Plays(NonZeroU32),
}

/// `None` when the bytes are not an image of more than one frame. A GIF plays once without a
/// loop extension, and one more time than it repeats with one.
pub fn animation(bytes: &[u8]) -> Option<Animation> {
    gif(bytes).or_else(|| png(bytes)).or_else(|| webp(bytes))
}

/// How long a frame shows, in milliseconds. 100 for one of 10 or less, which browsers take as
/// meant to be as fast as they allow.
pub fn frame_delay(milliseconds: f64) -> f64 {
    if milliseconds > 10.0 {
        milliseconds
    } else {
        100.0
    }
}

fn plays(times: u32) -> Animation {
    NonZeroU32::new(times).map_or(Animation::Forever, Animation::Plays)
}

const GIF_IMAGE: u8 = 0x2C;
const GIF_EXTENSION: u8 = 0x21;
const GIF_APPLICATION: u8 = 0xFF;

/// Its frames counted up to its trailer, or to where a truncated file stops, as browsers play what
/// they received.
fn gif(bytes: &[u8]) -> Option<Animation> {
    let rest = bytes
        .strip_prefix(b"GIF87a")
        .or_else(|| bytes.strip_prefix(b"GIF89a"))?;
    let mut rest = after_colour_table(rest.get(7..)?, *rest.get(4)?)?;
    let mut frames = 0_u32;
    let mut repeats = None;
    while let Some((&block, after)) = rest.split_first() {
        let next = match block {
            GIF_IMAGE => after_image(after).inspect(|_| frames += 1),
            GIF_EXTENSION => after_extension(after, &mut repeats),
            _ => None,
        };
        let Some(next) = next else {
            break;
        };
        rest = next;
    }
    (frames > 1).then(|| match repeats {
        None => plays(1),
        Some(0) => Animation::Forever,
        Some(repeats) => plays(u32::from(repeats) + 1),
    })
}

fn after_colour_table(bytes: &[u8], packed: u8) -> Option<&[u8]> {
    if packed & 0x80 == 0 {
        Some(bytes)
    } else {
        bytes.get(3 << ((packed & 0x07) + 1)..)
    }
}

fn after_image(bytes: &[u8]) -> Option<&[u8]> {
    let data = after_colour_table(bytes.get(9..)?, *bytes.get(8)?)?;
    // Past the minimum code size.
    after_sub_blocks(data.get(1..)?)
}

/// Takes how many times the animation repeats from a loop extension.
fn after_extension<'a>(bytes: &'a [u8], repeats: &mut Option<u16>) -> Option<&'a [u8]> {
    let (&label, rest) = bytes.split_first()?;
    let looping = matches!(
        rest.get(..12),
        Some(b"\x0bNETSCAPE2.0" | b"\x0bANIMEXTS1.0")
    );
    if label == GIF_APPLICATION
        && looping
        && let Some(&[3, 1, low, high]) = rest.get(12..16)
    {
        *repeats = Some(u16::from_le_bytes([low, high]));
    }
    after_sub_blocks(rest)
}

fn after_sub_blocks(mut bytes: &[u8]) -> Option<&[u8]> {
    loop {
        let (&size, rest) = bytes.split_first()?;
        if size == 0 {
            return Some(rest);
        }
        bytes = rest.get(usize::from(size)..)?;
    }
}

/// As [`animation`] tells from the start of an image's bytes, `None` while it takes more of them,
/// as a GIF's frames, and an animated WebP's, do.
pub(crate) fn from_start(bytes: &[u8]) -> Option<Option<Animation>> {
    if bytes.starts_with(b"GIF8") {
        None
    } else if let Some(chunks) = bytes.strip_prefix(PNG) {
        png_chunks(chunks)
    } else if bytes.get(..4) == Some(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        // Only the extended format animates, which its first chunk says.
        let animated = bytes.get(12..16)? == b"VP8X" && bytes.get(20)? & 0x02 != 0;
        (!animated).then_some(None)
    } else {
        Some(None)
    }
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

fn png(bytes: &[u8]) -> Option<Animation> {
    png_chunks(bytes.strip_prefix(PNG)?).flatten()
}

/// An APNG says how it plays before its image data. `None` when the chunks stop before that.
fn png_chunks(mut rest: &[u8]) -> Option<Option<Animation>> {
    loop {
        let length = usize::try_from(u32::from_be_bytes(rest.get(..4)?.try_into().ok()?)).ok()?;
        let end = length.checked_add(8)?;
        match rest.get(4..8)? {
            b"acTL" => {
                let data = rest.get(8..end)?;
                let frames = u32::from_be_bytes(data.get(..4)?.try_into().ok()?);
                let times = u32::from_be_bytes(data.get(4..8)?.try_into().ok()?);
                return Some((frames > 1).then(|| plays(times)));
            }
            b"IDAT" => return Some(None),
            // Past its checksum.
            _ => rest = rest.get(end.checked_add(4)?..)?,
        }
    }
}

fn webp(bytes: &[u8]) -> Option<Animation> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    let mut rest = bytes.get(12..)?;
    let mut animated = false;
    let mut times = 0;
    let mut frames = 0_u32;
    while let Some((kind, data, next)) = riff_chunk(rest) {
        match kind {
            b"VP8X" => animated = data.first().is_some_and(|flags| flags & 0x02 != 0),
            b"ANIM" => {
                if let Some(&[low, high]) = data.get(4..6) {
                    times = u16::from_le_bytes([low, high]);
                }
            }
            b"ANMF" => frames += 1,
            _ => {}
        }
        rest = next;
    }
    (animated && frames > 1).then(|| plays(u32::from(times)))
}

/// Its kind, its data, and what follows it, as chunks are padded to an even size.
fn riff_chunk(bytes: &[u8]) -> Option<(&[u8], &[u8], &[u8])> {
    let kind = bytes.get(..4)?;
    let size = usize::try_from(u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?)).ok()?;
    let end = size.checked_add(8)?;
    let data = bytes.get(8..end)?;
    let next = bytes.get(end + size % 2..).unwrap_or_default();
    Some((kind, data, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn times(times: u32) -> Option<Animation> {
        Some(Animation::Plays(NonZeroU32::new(times).unwrap()))
    }

    /// 1 by 1, with a global colour table of two colours.
    fn gif_header() -> Vec<u8> {
        let mut bytes = b"GIF89a\x01\x00\x01\x00\x80\x00\x00".to_vec();
        bytes.extend([0; 6]);
        bytes
    }

    fn gif_loop(repeats: u16) -> Vec<u8> {
        let mut bytes = b"\x21\xFF\x0BNETSCAPE2.0\x03\x01".to_vec();
        bytes.extend(repeats.to_le_bytes());
        bytes.push(0);
        bytes
    }

    /// With a graphic control extension, and a local colour table when `local`.
    fn gif_frame(local: bool) -> Vec<u8> {
        let mut bytes = b"\x21\xF9\x04\x00\x0A\x00\x00\x00".to_vec();
        bytes.extend([GIF_IMAGE, 0, 0, 0, 0, 1, 0, 1, 0]);
        if local {
            bytes.push(0x81);
            bytes.extend([0; 12]);
        } else {
            bytes.push(0);
        }
        bytes.extend([2, 2, 0x4C, 0x01, 0]);
        bytes
    }

    fn gif(repeats: Option<u16>, frames: usize) -> Vec<u8> {
        let mut bytes = gif_header();
        if let Some(repeats) = repeats {
            bytes.extend(gif_loop(repeats));
        }
        for at in 0..frames {
            bytes.extend(gif_frame(at % 2 == 1));
        }
        bytes.push(0x3B);
        bytes
    }

    #[test]
    fn a_gif_moves_once_it_has_two_frames_and_repeats_as_its_loop_says() {
        assert_eq!(animation(&gif(None, 1)), None);
        assert_eq!(animation(&gif(Some(0), 1)), None);
        assert_eq!(animation(&gif(None, 2)), times(1));
        assert_eq!(animation(&gif(Some(0), 3)), Some(Animation::Forever));
        assert_eq!(animation(&gif(Some(2), 2)), times(3));
        assert_eq!(animation(&gif(Some(u16::MAX), 2)), times(65536));
    }

    #[test]
    fn a_gif_loop_counts_wherever_it_sits() {
        let mut bytes = gif_header();
        bytes.extend(gif_frame(false));
        bytes.extend(gif_loop(0));
        bytes.extend(gif_frame(false));
        bytes.push(0x3B);
        assert_eq!(animation(&bytes), Some(Animation::Forever));
    }

    #[test]
    fn a_truncated_gif_moves_with_the_frames_it_holds_whole() {
        let whole = gif(Some(0), 3);
        let third = gif(Some(0), 2).len() - 1;
        assert_eq!(animation(&whole[..third + 12]), Some(Animation::Forever));
        let second = gif(Some(0), 1).len() - 1;
        assert_eq!(animation(&whole[..second + 12]), None);
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
        bytes.extend(kind);
        bytes.extend(data);
        bytes.extend([0; 4]);
        bytes
    }

    fn png(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend(png_chunk(b"IHDR", &[0; 13]));
        bytes.extend(chunks.concat());
        bytes.extend(png_chunk(b"IEND", &[]));
        bytes
    }

    fn animation_control(frames: u32, plays: u32) -> Vec<u8> {
        png_chunk(
            b"acTL",
            &[frames.to_be_bytes(), plays.to_be_bytes()].concat(),
        )
    }

    #[test]
    fn a_png_moves_once_it_says_so_before_its_image_data() {
        let data = png_chunk(b"IDAT", &[0; 3]);
        let colour = png_chunk(b"iCCP", &[0; 7]);
        assert_eq!(
            animation(&png(&[
                colour.clone(),
                animation_control(3, 0),
                data.clone()
            ])),
            Some(Animation::Forever)
        );
        assert_eq!(
            animation(&png(&[animation_control(2, 4), data.clone()])),
            times(4)
        );
        assert_eq!(
            animation(&png(&[animation_control(1, 0), data.clone()])),
            None
        );
        assert_eq!(
            animation(&png(&[data.clone(), animation_control(3, 0)])),
            None
        );
        assert_eq!(animation(&png(&[colour, data])), None);
    }

    fn riff(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = kind.to_vec();
        bytes.extend(u32::try_from(data.len()).unwrap().to_le_bytes());
        bytes.extend(data);
        if data.len() % 2 == 1 {
            bytes.push(0);
        }
        bytes
    }

    fn webp(animated: bool, times: u16, frames: usize) -> Vec<u8> {
        let flags = if animated { 0x02 } else { 0 };
        let mut chunks = riff(b"VP8X", &[flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        chunks.extend(riff(
            b"ANIM",
            &[[0; 4].as_slice(), &times.to_le_bytes()].concat(),
        ));
        for _ in 0..frames {
            chunks.extend(riff(b"ANMF", &[0; 17]));
        }
        let mut bytes = b"RIFF".to_vec();
        bytes.extend(u32::try_from(chunks.len() + 4).unwrap().to_le_bytes());
        bytes.extend(b"WEBP");
        bytes.extend(chunks);
        bytes
    }

    #[test]
    fn a_webp_moves_once_it_is_animated_with_two_frames() {
        assert_eq!(animation(&webp(true, 0, 2)), Some(Animation::Forever));
        assert_eq!(animation(&webp(true, 3, 4)), times(3));
        assert_eq!(animation(&webp(true, 0, 1)), None);
        assert_eq!(animation(&webp(false, 0, 2)), None);
        let whole = webp(true, 0, 3);
        assert_eq!(
            animation(&whole[..whole.len() - 4]),
            Some(Animation::Forever)
        );
        assert_eq!(animation(&whole[..whole.len() - 30]), None);
    }

    #[test]
    fn the_start_of_an_image_tells_whether_it_moves_but_for_a_gif_or_an_animated_webp() {
        let data = png_chunk(b"IDAT", &[0; 3]);
        let moving = png(&[animation_control(2, 4), data.clone()]);
        assert_eq!(from_start(&moving[..60]), Some(times(4)));
        assert_eq!(
            from_start(&png(std::slice::from_ref(&data))[..45]),
            Some(None)
        );
        // Its first chunks run past the start.
        let colour = png_chunk(b"iCCP", &[0; 100]);
        assert_eq!(from_start(&png(&[colour, data])[..60]), None);
        assert_eq!(from_start(&gif(Some(0), 1)), None);
        assert_eq!(from_start(&webp(true, 0, 3)[..30]), None);
        assert_eq!(from_start(&webp(false, 0, 3)[..30]), Some(None));
        assert_eq!(from_start(b"\xFF\xD8\xFF\xE0\x00\x10JFIF"), Some(None));
    }

    #[test]
    fn other_bytes_do_not_move() {
        for other in [
            b"".as_slice(),
            b"GIF8",
            b"GIF89a\x01\x00",
            b"\xFF\xD8\xFF\xE0\x00\x10JFIF",
            b"\x89PNG\r\n\x1a\n",
            b"RIFF\x04\x00\x00\x00WEBP",
            b"<svg/>",
        ] {
            assert_eq!(animation(other), None, "{other:?}");
        }
    }

    #[test]
    fn frames_that_ask_for_no_delay_show_for_a_tenth_of_a_second() {
        for (asked, shown) in [
            (0.0, 100.0),
            (10.0, 100.0),
            (10.5, 10.5),
            (20.0, 20.0),
            (f64::NAN, 100.0),
        ] {
            assert_eq!(frame_delay(asked), shown, "{asked}");
        }
    }
}
