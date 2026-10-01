//! The frames of animated images, decoded one at a time, as browsers play them.

use std::io::Cursor;
use std::sync::Arc;

use image::codecs::{gif::GifDecoder, png::PngDecoder, webp::WebPDecoder};
use image::metadata::Orientation;
use image::{AnimationDecoder, Frame, Frames, ImageDecoder, ImageError, ImageFormat, Rgba};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Image(#[from] ImageError),
    #[error("{0:?} images do not move")]
    Still(ImageFormat),
    #[error("turned or flipped images do not move")]
    Turned,
}

pub type Result<T> = std::result::Result<T, Error>;

/// The frames of an animated GIF, PNG, or WebP, decoded one at a time onto its canvas.
pub struct Animation {
    bytes: Arc<[u8]>,
    frames: Frames<'static>,
    /// Since it last started.
    drawn: bool,
}

impl Animation {
    pub fn new(bytes: Vec<u8>) -> Result<Self> {
        let bytes = Arc::from(bytes);
        let frames = frames(&bytes)?;
        Ok(Self {
            bytes,
            frames,
            drawn: false,
        })
    }

    pub fn restart(&mut self) -> Result<()> {
        self.frames = frames(&self.bytes)?;
        self.drawn = false;
        Ok(())
    }

    /// The next frame, on its whole canvas, `None` once none is left.
    pub fn next_frame(&mut self) -> Result<Option<Frame>> {
        match self.frames.next() {
            Some(Ok(frame)) => {
                self.drawn = true;
                Ok(Some(frame))
            }
            // A truncated GIF, or one without its trailer, ends with its last whole frame, as
            // browsers play it. Its frames go on failing.
            Some(Err(_)) if self.drawn => Ok(None),
            Some(Err(error)) => Err(error.into()),
            None => Ok(None),
        }
    }
}

fn frames(bytes: &Arc<[u8]>) -> Result<Frames<'static>> {
    let reader = Cursor::new(Arc::clone(bytes));
    Ok(match image::guess_format(bytes)? {
        ImageFormat::Gif => upright(GifDecoder::new(reader)?)?.into_frames(),
        ImageFormat::Png => upright(PngDecoder::new(reader)?)?.apng()?.into_frames(),
        ImageFormat::WebP => {
            let mut decoder = upright(WebPDecoder::new(reader)?)?;
            // Without one, frames disposed to the background stay, where browsers clear them.
            decoder.set_background_color(Rgba([0, 0, 0, 0]))?;
            decoder.into_frames()
        }
        other => return Err(Error::Still(other)),
    })
}

/// The browser turns or flips the first frame as the image says, which its frames do not.
fn upright<Decoder: ImageDecoder>(mut decoder: Decoder) -> Result<Decoder> {
    if decoder.orientation()? == Orientation::NoTransforms {
        Ok(decoder)
    } else {
        Err(Error::Turned)
    }
}

#[cfg(test)]
mod tests {
    use image::codecs::gif::GifEncoder;
    use image::codecs::png::PngEncoder;
    use image::{ImageEncoder, RgbaImage};

    use super::*;

    const RED: Rgba<u8> = Rgba([255, 0, 0, 255]);
    const BLUE: Rgba<u8> = Rgba([0, 0, 255, 255]);

    fn gif(colours: &[Rgba<u8>]) -> Vec<u8> {
        let mut bytes = Vec::new();
        GifEncoder::new(&mut bytes)
            .encode_frames(
                colours
                    .iter()
                    .map(|&colour| Frame::new(RgbaImage::from_pixel(2, 2, colour))),
            )
            .unwrap();
        bytes
    }

    fn colours(animation: &mut Animation) -> Vec<Rgba<u8>> {
        let mut colours = Vec::new();
        while let Some(frame) = animation.next_frame().unwrap() {
            colours.push(*frame.buffer().get_pixel(0, 0));
        }
        colours
    }

    #[test]
    fn a_truncated_gif_ends_with_its_last_whole_frame() {
        let mut bytes = gif(&[RED, BLUE]);
        // Into the second frame's image data.
        bytes.truncate(bytes.len() - 4);
        let mut animation = Animation::new(bytes).unwrap();
        assert_eq!(colours(&mut animation), [RED]);
        assert!(animation.next_frame().unwrap().is_none());
        animation.restart().unwrap();
        assert_eq!(colours(&mut animation), [RED]);
    }

    #[test]
    fn a_gif_truncated_before_its_first_whole_frame_fails() {
        let mut bytes = gif(&[RED]);
        bytes.truncate(bytes.len() - 4);
        let mut animation = Animation::new(bytes).unwrap();
        assert!(animation.next_frame().is_err());
    }

    /// A 2 by 2 red VP8 key frame, as cwebp encodes it.
    const LOSSY_RED: &[u8] = b"\x74\x01\x00\x9d\x01\x2a\x02\x00\x02\x00\x00\x00\x4c\x00\x09\xd2\xe8\x00\x11\x9a\x00\xfe\xee\x43\x1f\xee\x6c\x73\x8b\x67\x77\xff\x65\x63\xff\x4a\xc7\xfe\x95\x8f\xe1\x50\x00\x00";

    fn riff(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = kind.to_vec();
        bytes.extend((data.len() as u32).to_le_bytes());
        bytes.extend(data);
        if data.len() % 2 == 1 {
            bytes.push(0);
        }
        bytes
    }

    fn u24(value: u32) -> [u8; 3] {
        let [a, b, c, _] = value.to_le_bytes();
        [a, b, c]
    }

    /// A lossy frame 2 px a side at `x`, cleared to the background once shown.
    fn lossy_frame(x: u32) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend(u24(x / 2));
        data.extend(u24(0));
        data.extend(u24(1));
        data.extend(u24(1));
        data.extend(u24(100));
        data.push(0b11);
        data.extend(riff(b"VP8 ", LOSSY_RED));
        riff(b"ANMF", &data)
    }

    #[test]
    fn a_webp_clears_a_frame_disposed_to_the_background_under_a_lossy_one() {
        let mut header = vec![0b0001_0010, 0, 0, 0];
        header.extend(u24(3));
        header.extend(u24(1));
        let mut chunks = riff(b"VP8X", &header);
        // An opaque white background, which browsers ignore.
        chunks.extend(riff(b"ANIM", &[255, 255, 255, 255, 0, 0]));
        chunks.extend(lossy_frame(0));
        chunks.extend(lossy_frame(2));
        let mut bytes = b"RIFF".to_vec();
        bytes.extend((chunks.len() as u32 + 4).to_le_bytes());
        bytes.extend(b"WEBP");
        bytes.extend(chunks);
        let mut animation = Animation::new(bytes).unwrap();
        animation.next_frame().unwrap().unwrap();
        let second = animation.next_frame().unwrap().unwrap().into_buffer();
        for y in 0..2 {
            assert_eq!(second.get_pixel(0, y), &Rgba([0, 0, 0, 0]));
            assert_eq!(second.get_pixel(1, y), &Rgba([0, 0, 0, 0]));
            assert_eq!(second.get_pixel(2, y).0[3], 255);
            assert_eq!(second.get_pixel(3, y).0[3], 255);
        }
    }

    #[test]
    fn a_turned_image_does_not_move() {
        // Little-endian TIFF holding one tag: orientation 6, turned a quarter clockwise.
        let exif = b"II\x2a\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00\x00\x00\x00\x00";
        let mut bytes = Vec::new();
        let mut encoder = PngEncoder::new(&mut bytes);
        encoder.set_exif_metadata(exif.to_vec()).unwrap();
        encoder
            .write_image(&RED.0, 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        assert!(matches!(Animation::new(bytes), Err(Error::Turned)));
    }
}
