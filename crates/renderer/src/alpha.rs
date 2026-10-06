//! Colours as a render over a see-through background leaves them, multiplied by their alpha, made
//! straight again, as pictures store them.

pub fn unpremultiply(pixels: &mut [u8]) {
    for pixel in pixels.as_chunks_mut::<4>().0 {
        let alpha = u16::from(pixel[3]);
        if alpha == 0 || alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            let straight = (u16::from(*channel) * 255 + alpha / 2) / alpha;
            *channel = u8::try_from(straight).unwrap_or(u8::MAX);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::unpremultiply;

    #[test]
    fn divides_each_colour_by_its_alpha() {
        let mut pixels = [64, 32, 0, 128, 255, 0, 0, 255, 0, 0, 0, 0];
        unpremultiply(&mut pixels);
        assert_eq!(pixels, [128, 64, 0, 128, 255, 0, 0, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn keeps_colours_within_a_byte() {
        // Rounding on the GPU may leave a colour a little over its alpha.
        let mut pixels = [12, 10, 3, 10];
        unpremultiply(&mut pixels);
        assert_eq!(pixels, [255, 255, 77, 10]);
    }
}
