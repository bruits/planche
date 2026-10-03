//! The natural size of an SVG, from its bytes alone. Engines disagree on the size of one
//! sized by its `viewBox` or by percentages, so it follows one rule everywhere, read from the
//! root element's attributes.

use std::ops::Range;

use crate::Size;

/// What CSS gives a replaced element with no size of its own.
const DEFAULT_WIDTH: f64 = 300.0;
const DEFAULT_HEIGHT: f64 = 150.0;
/// CSS pixels per absolute unit, a length without one being in pixels.
const UNITS: [(&str, f64); 8] = [
    ("", 1.0),
    ("px", 1.0),
    ("pt", 96.0 / 72.0),
    ("pc", 16.0),
    ("in", 96.0),
    ("cm", 96.0 / 2.54),
    ("mm", 96.0 / 25.4),
    ("q", 96.0 / 101.6),
];

/// In CSS pixels. `None` when the bytes do not start as an SVG document.
pub fn svg_size(bytes: &[u8]) -> Option<Size> {
    Some(svg_root(bytes)?.size())
}

/// The SVG with its root's `width` and `height` set to `size`, and the rest as it was, so that
/// every engine draws it at that size. `size` is the natural size its images hold, so that they
/// draw as they did whatever rule [`crate::media`] reads it by, as long as the images of one
/// asset hold one size. `None` when the bytes do not start as an SVG document.
pub fn sized_svg(bytes: &[u8], size: Size) -> Option<Vec<u8>> {
    let root = svg_root(bytes)?;
    let Size { width, height } = size;
    let mut sized = bytes[..root.name_end].to_vec();
    sized.extend_from_slice(format!(r#" width="{width}" height="{height}""#).as_bytes());
    let mut kept = root.name_end;
    for attribute in &root.attributes {
        if attribute.name == b"width" || attribute.name == b"height" {
            sized.extend_from_slice(&bytes[kept..attribute.span.start]);
            kept = attribute.span.end;
        }
    }
    sized.extend_from_slice(&bytes[kept..]);
    Some(sized)
}

struct Tag<'a> {
    name: &'a [u8],
    /// Where its name ends in the document.
    name_end: usize,
    attributes: Vec<Attribute<'a>>,
}

struct Attribute<'a> {
    name: &'a [u8],
    value: &'a [u8],
    /// From its name to its closing quote, in the document.
    span: Range<usize>,
}

impl Tag<'_> {
    fn value(&self, name: &[u8]) -> Option<&str> {
        let attribute = self
            .attributes
            .iter()
            .find(|attribute| attribute.name == name)?;
        std::str::from_utf8(attribute.value).ok()
    }

    fn size(&self) -> Size {
        let width = self.value(b"width").and_then(length);
        let height = self.value(b"height").and_then(length);
        let (width, height) = match (width, height, self.value(b"viewBox").and_then(view_box)) {
            (Some(width), Some(height), _) => (width, height),
            (Some(width), None, Some((box_width, box_height))) => {
                (width, width * box_height / box_width)
            }
            (None, Some(height), Some((box_width, box_height))) => {
                (height * box_width / box_height, height)
            }
            (None, None, Some(size)) => size,
            (width, height, None) => (
                width.unwrap_or(DEFAULT_WIDTH),
                height.unwrap_or(DEFAULT_HEIGHT),
            ),
        };
        Size {
            width: pixels(width),
            height: pixels(height),
        }
    }
}

/// Whatever its prefix. Whether its namespace is SVG's is the host's to find, as an entity may
/// declare it.
fn svg_root(bytes: &[u8]) -> Option<Tag<'_>> {
    let root = root(bytes)?;
    (root.name == b"svg" || root.name.ends_with(b":svg")).then_some(root)
}

fn root(bytes: &[u8]) -> Option<Tag<'_>> {
    let mut rest = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    loop {
        rest = rest.trim_ascii_start();
        rest = if let Some(instruction) = rest.strip_prefix(b"<?") {
            after(instruction, b"?>")?
        } else if let Some(comment) = rest.strip_prefix(b"<!--") {
            after(comment, b"-->")?
        } else if let Some(declaration) = rest.strip_prefix(b"<!") {
            after_declaration(declaration)?
        } else {
            let tag = rest.strip_prefix(b"<")?;
            return start_tag(tag, bytes.len() - tag.len());
        };
    }
}

fn after<'a>(bytes: &'a [u8], end: &[u8]) -> Option<&'a [u8]> {
    let at = bytes.windows(end.len()).position(|window| window == end)?;
    Some(&bytes[at + end.len()..])
}

/// Past a `<!DOCTYPE`, whose internal subset, quoted strings, comments, and processing
/// instructions may hold a `>` of their own.
fn after_declaration(mut bytes: &[u8]) -> Option<&[u8]> {
    let mut depth = 0_usize;
    loop {
        bytes = if let Some(comment) = bytes.strip_prefix(b"<!--") {
            after(comment, b"-->")?
        } else if let Some(instruction) = bytes.strip_prefix(b"<?") {
            after(instruction, b"?>")?
        } else {
            let (&byte, rest) = bytes.split_first()?;
            match byte {
                b'"' | b'\'' => after(rest, &[byte])?,
                b'[' => {
                    depth += 1;
                    rest
                }
                b']' => {
                    depth = depth.saturating_sub(1);
                    rest
                }
                b'>' if depth == 0 => return Some(rest),
                _ => rest,
            }
        };
    }
}

/// From right after its `<`, which is `at` into the document, up to its `>`.
fn start_tag(bytes: &[u8], at: usize) -> Option<Tag<'_>> {
    let offset = |rest: &[u8]| at + bytes.len() - rest.len();
    let end = bytes
        .iter()
        .position(|&byte| byte.is_ascii_whitespace() || byte == b'/' || byte == b'>')?;
    let (name, mut rest) = bytes.split_at(end);
    if name.is_empty() {
        return None;
    }
    let name_end = offset(rest);
    let mut attributes = Vec::new();
    loop {
        rest = rest.trim_ascii_start();
        if rest.starts_with(b">") || rest.starts_with(b"/>") {
            return Some(Tag {
                name,
                name_end,
                attributes,
            });
        }
        let start = offset(rest);
        let end = rest
            .iter()
            .position(|&byte| byte == b'=' || byte.is_ascii_whitespace())?;
        let (attribute, value) = rest.split_at(end);
        let value = value
            .trim_ascii_start()
            .strip_prefix(b"=")?
            .trim_ascii_start();
        let (&quote, value) = value.split_first()?;
        if quote != b'"' && quote != b'\'' {
            return None;
        }
        let end = value.iter().position(|&byte| byte == quote)?;
        rest = &value[end + 1..];
        attributes.push(Attribute {
            name: attribute,
            value: &value[..end],
            span: start..offset(rest),
        });
    }
}

/// In CSS pixels, when absolute and positive.
fn length(value: &str) -> Option<f64> {
    let value = value.trim_ascii();
    let number = value.trim_end_matches(|character: char| character.is_ascii_alphabetic());
    let unit = &value[number.len()..];
    let (_, per_unit) = UNITS
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(unit))?;
    let length = number.parse::<f64>().ok()? * per_unit;
    (length.is_finite() && length > 0.0).then_some(length)
}

fn view_box(value: &str) -> Option<(f64, f64)> {
    let numbers: Vec<f64> = value
        .split(|character: char| character.is_ascii_whitespace() || character == ',')
        .filter(|number| !number.is_empty())
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    match numbers[..] {
        [x, y, width, height]
            if [x, y, width, height]
                .iter()
                .all(|number| number.is_finite())
                && width > 0.0
                && height > 0.0 =>
        {
            Some((width, height))
        }
        _ => None,
    }
}

/// Saturates past `u32::MAX`, as a cast from a float does.
fn pixels(length: f64) -> u32 {
    length.round().max(1.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(svg: &str) -> Option<(u32, u32)> {
        svg_size(svg.as_bytes()).map(|size| (size.width, size.height))
    }

    fn with(attributes: &str) -> Option<(u32, u32)> {
        size(&format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" {attributes}><rect/></svg>"#
        ))
    }

    #[test]
    fn two_absolute_lengths_are_the_size() {
        assert_eq!(with(r#"width="120" height="80.4""#), Some((120, 80)));
        assert_eq!(with(r#"width="1in" height="2.54cm""#), Some((96, 96)));
        assert_eq!(with(r#"width="72pt" height="6pc""#), Some((96, 96)));
        assert_eq!(with(r#"width="25.4mm" height="101.6Q""#), Some((96, 96)));
        assert_eq!(with(r#"width=" 10PX " height="1e2""#), Some((10, 100)));
    }

    #[test]
    fn a_missing_length_follows_the_view_box_ratio() {
        assert_eq!(
            with(r#"width="200" viewBox="0 0 100 50""#),
            Some((200, 100))
        );
        assert_eq!(with(r#"height="10mm" viewBox="0,0,3,1""#), Some((113, 38)));
    }

    #[test]
    fn without_absolute_lengths_the_view_box_is_the_size() {
        assert_eq!(with(r#"viewBox="0 0 30 10""#), Some((30, 10)));
        assert_eq!(
            with(r#"width="100%" height="100%" viewBox="-5 -5, 349.47 405.12""#),
            Some((349, 405))
        );
        for relative in ["auto", "2em", "1ex", "1rem", "10vw", "-4", "0", "px", "4e"] {
            assert_eq!(
                with(&format!(r#"width="{relative}" viewBox="0 0 30 10""#)),
                Some((30, 10)),
                "{relative}"
            );
        }
    }

    #[test]
    fn what_is_still_missing_is_what_css_gives_a_replaced_element() {
        assert_eq!(with(""), Some((300, 150)));
        assert_eq!(with(r#"width="20""#), Some((20, 150)));
        assert_eq!(with(r#"height="20""#), Some((300, 20)));
        assert_eq!(with(r#"width="50%" viewBox="0 0 -1 5""#), Some((300, 150)));
        assert_eq!(with(r#"viewBox="0 0 30""#), Some((300, 150)));
        assert_eq!(with(r#"viewBox="0 0 30 nan""#), Some((300, 150)));
    }

    #[test]
    fn sizes_are_whole_pixels_of_one_at_least() {
        assert_eq!(with(r#"width="0.4" height="2.5""#), Some((1, 3)));
        assert_eq!(
            with(r#"width="50000" height="50000""#),
            Some((50000, 50000))
        );
        assert_eq!(with(r#"width="1e20" height="1""#), Some((u32::MAX, 1)));
    }

    #[test]
    fn what_comes_before_the_root_is_skipped() {
        let svg = "\u{FEFF}<?xml version=\"1.0\"?>\n<!-- <svg width=\"1\"> -->\n\
            <!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x>y\" [\n\
              <!ENTITY shape \"<rect/>\">\n\
            ]>\n\
            <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"7\" height=\"8\"/>";
        assert_eq!(size(svg), Some((7, 8)));
        let root = r#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="5"/>"#;
        for subset in [
            "<!-- it's -->",
            "<!-- ] -->",
            "<!-- [ -->",
            "<?pi it's ?>",
            "<?pi ] ?>",
        ] {
            assert_eq!(
                size(&format!("<!DOCTYPE svg [ {subset} ]>{root}")),
                Some((4, 5)),
                "{subset}"
            );
        }
    }

    #[test]
    fn quoted_values_may_hold_what_ends_a_tag() {
        assert_eq!(
            size(
                r#"<svg data-note='a > b / c' xmlns='http://www.w3.org/2000/svg' width = '4' height='5'>"#
            ),
            Some((4, 5))
        );
    }

    #[test]
    fn a_root_named_svg_is_one_whatever_its_prefix_or_namespace() {
        assert_eq!(
            size(r#"<s:svg xmlns:s="http://www.w3.org/2000/svg" width="4" height="5"/>"#),
            Some((4, 5))
        );
        assert_eq!(
            size(r#"<svg xmlns="&ns_svg;" width="4" height="5">"#),
            Some((4, 5))
        );
    }

    fn sized(svg: &str, width: u32, height: u32) -> Option<String> {
        sized_svg(svg.as_bytes(), Size { width, height })
            .map(|bytes| String::from_utf8(bytes).unwrap())
    }

    #[test]
    fn a_sized_svg_holds_the_size_given_in_place_of_its_own() {
        assert_eq!(
            sized(
                r#"<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>"#,
                300,
                150
            )
            .as_deref(),
            Some(
                r#"<svg width="300" height="150" xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>"#
            )
        );
        assert_eq!(
            sized(
                r#"<?xml version="1.0"?><s:svg height="100%" xmlns:s="&ns_svg;" viewBox="0 0 3 1" width='1in'/>"#,
                96,
                32
            )
            .as_deref(),
            Some(
                r#"<?xml version="1.0"?><s:svg width="96" height="32"  xmlns:s="&ns_svg;" viewBox="0 0 3 1" />"#
            )
        );
        assert_eq!(
            sized(
                "\u{FEFF}<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"7\"/>",
                7,
                150
            )
            .as_deref(),
            Some("\u{FEFF}<svg width=\"7\" height=\"150\" xmlns=\"http://www.w3.org/2000/svg\" />")
        );
        assert_eq!(
            sized("<svg/>", 300, 150).as_deref(),
            Some(r#"<svg width="300" height="150"/>"#)
        );
        assert_eq!(
            sized(r#"<svg width="10" height="10"/>"#, 40, 20).as_deref(),
            Some(r#"<svg width="40" height="20"  />"#)
        );
    }

    #[test]
    fn other_documents_are_not_svgs() {
        for other in [
            "",
            "hello",
            "<!DOCTYPE html><html><svg xmlns=\"http://www.w3.org/2000/svg\"/></html>",
            "<svgx width=\"4\" height=\"5\"></svgx>",
            "<html:svg-like/>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"",
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=4>",
            "<!-- unclosed",
        ] {
            assert_eq!(size(other), None, "{other}");
            assert_eq!(sized(other, 1, 1), None, "{other}");
        }
        assert_eq!(svg_size(b"\x89PNG\r\n\x1a\n"), None);
    }
}
