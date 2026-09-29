//! A board as plain data. No I/O, clock, or randomness, so that it builds for
//! `wasm32-unknown-unknown`.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("`{0}` is not a valid id")]
    InvalidId(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Board {
    pub elements: BTreeMap<ElementId, Element>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Element {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<ElementId>,
    pub kind: ElementKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ElementKind {
    Image {
        asset: AssetId,
        frame: Rect,
        edits: ImageEdits,
    },
    Note {
        frame: Rect,
        text: String,
    },
    Shape {
        frame: Rect,
        shape: Shape,
    },
    Arrow {
        from: Point,
        to: Point,
    },
    Group,
}

impl ElementKind {
    pub fn asset(&self) -> Option<AssetId> {
        match self {
            Self::Image { asset, .. } => Some(*asset),
            _ => None,
        }
    }

    /// JSON cannot hold a NaN or an infinity. Fields are destructured in full, so a new one
    /// fails to compile until it is checked here.
    pub fn is_finite(&self) -> bool {
        match self {
            Self::Image {
                asset: _,
                frame,
                edits,
            } => frame.is_finite() && edits.is_finite(),
            Self::Note { frame, text: _ } | Self::Shape { frame, shape: _ } => frame.is_finite(),
            Self::Arrow { from, to } => from.is_finite() && to.is_finite(),
            Self::Group => true,
        }
    }
}

/// Applied when drawing. The asset's bytes never change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ImageEdits {
    /// In asset pixels, before rotation.
    pub crop: Option<Rect>,
    /// Clockwise, in degrees.
    pub rotation: f64,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub greyscale: bool,
}

impl ImageEdits {
    fn is_finite(&self) -> bool {
        let Self {
            crop,
            rotation,
            flip_horizontal: _,
            flip_vertical: _,
            greyscale: _,
        } = self;
        crop.is_none_or(|crop| crop.is_finite()) && rotation.is_finite()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    Rectangle,
    Ellipse,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    fn is_finite(&self) -> bool {
        let Self { x, y } = self;
        x.is_finite() && y.is_finite()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn is_finite(&self) -> bool {
        let Self {
            x,
            y,
            width,
            height,
        } = self;
        [x, y, width, height].iter().all(|value| value.is_finite())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ElementId(Hex<16>);

impl ElementId {
    pub const fn from_random(bits: u128) -> Self {
        Self(Hex(bits.to_be_bytes()))
    }
}

impl fmt::Display for ElementId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for ElementId {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self> {
        text.parse().map(Self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AssetId(Hex<32>);

impl AssetId {
    pub fn of(bytes: &[u8]) -> Self {
        Self(Hex(Sha256::digest(bytes).into()))
    }
}

impl fmt::Display for AssetId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for AssetId {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self> {
        text.parse().map(Self)
    }
}

/// Ids name files, so each has a single spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Hex<const N: usize>([u8; N]);

impl<const N: usize> fmt::Display for Hex<N> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0
            .iter()
            .try_for_each(|byte| write!(formatter, "{byte:02x}"))
    }
}

impl<const N: usize> FromStr for Hex<N> {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self> {
        let invalid = || Error::InvalidId(text.to_owned());
        if text.len() != N * 2 {
            return Err(invalid());
        }
        let mut bytes = [0; N];
        let (pairs, _) = text.as_bytes().as_chunks::<2>();
        for (byte, [high, low]) in bytes.iter_mut().zip(pairs) {
            let high = lowercase_hex_digit(*high).ok_or_else(invalid)?;
            let low = lowercase_hex_digit(*low).ok_or_else(invalid)?;
            *byte = (high << 4) | low;
        }
        Ok(Self(bytes))
    }
}

fn lowercase_hex_digit(digit: u8) -> Option<u8> {
    match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        _ => None,
    }
}

impl<const N: usize> Serialize for Hex<N> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de, const N: usize> Deserialize<'de> for Hex<N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_reads_back_from_its_spelling() {
        let id = ElementId::from_random(0x0123_4567_89ab_cdef);
        assert_eq!(id.to_string(), "00000000000000000123456789abcdef");
        assert_eq!(id.to_string().parse(), Ok(id));
    }

    #[test]
    fn an_id_has_no_other_spelling() {
        for text in [
            "00000000000000000123456789ABCDEF",
            "0123456789abcdef",
            "+0000000000000000123456789abcdef",
            "000000000000000000123456789abcdef",
        ] {
            assert_eq!(
                text.parse::<ElementId>(),
                Err(Error::InvalidId(text.to_owned()))
            );
        }
    }

    #[test]
    fn every_float_is_checked_for_nan() {
        let rect = Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        let point = Point { x: 0.0, y: 0.0 };
        let image = |frame, edits| ElementKind::Image {
            asset: AssetId::of(b""),
            frame,
            edits,
        };
        let arrow = |from, to| ElementKind::Arrow { from, to };
        let edits = ImageEdits::default();

        let valid = [
            image(rect, edits),
            image(
                rect,
                ImageEdits {
                    crop: Some(rect),
                    ..edits
                },
            ),
            arrow(point, point),
        ];
        assert!(valid.iter().all(ElementKind::is_finite));

        let nan = f64::NAN;
        let invalid = [
            image(Rect { x: nan, ..rect }, edits),
            image(Rect { y: nan, ..rect }, edits),
            image(Rect { width: nan, ..rect }, edits),
            image(
                Rect {
                    height: nan,
                    ..rect
                },
                edits,
            ),
            image(
                rect,
                ImageEdits {
                    crop: Some(Rect { x: nan, ..rect }),
                    ..edits
                },
            ),
            image(
                rect,
                ImageEdits {
                    rotation: nan,
                    ..edits
                },
            ),
            ElementKind::Note {
                frame: Rect { x: nan, ..rect },
                text: String::new(),
            },
            ElementKind::Shape {
                frame: Rect { x: nan, ..rect },
                shape: Shape::Rectangle,
            },
            arrow(Point { x: nan, ..point }, point),
            arrow(
                point,
                Point {
                    y: f64::INFINITY,
                    ..point
                },
            ),
        ];
        for kind in invalid {
            assert!(!kind.is_finite(), "{kind:?}");
        }
    }

    #[test]
    fn an_asset_is_named_by_its_sha256() {
        assert_eq!(
            AssetId::of(b"").to_string(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
