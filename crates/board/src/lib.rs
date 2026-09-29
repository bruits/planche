//! A board as plain data. No I/O, clock, or randomness, so that it builds for
//! `wasm32-unknown-unknown`.
//!
//! Board space has y pointing down. A [`Rect`] is placed by its top-left corner before
//! rotation, and an element with a frame rotates clockwise, in degrees, around its centre.

mod edit;
mod z_index;

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub use edit::{Editor, Restack};
pub use z_index::ZIndex;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("`{0}` is not a valid id")]
    InvalidId(String),
    #[error("`{0}` is not a valid z-index")]
    InvalidZIndex(String),
    #[error("element {0} does not exist")]
    UnknownElement(ElementId),
    #[error("element {0} already exists")]
    TakenId(ElementId),
    #[error("element {0} is not a group")]
    NotAGroup(ElementId),
    #[error("element {0} cannot change kind")]
    KindChanged(ElementId),
    #[error("element {0} would hold a NaN or an infinity")]
    NotFinite(ElementId),
    #[error("only two elements or more of the same group can be grouped")]
    CannotGroup,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Board {
    pub elements: BTreeMap<ElementId, Element>,
}

impl Board {
    /// Every element from back to front: siblings by z-index then id, and each group's
    /// elements right after the group. Elements out of reach of the top level, such as a
    /// group cycle, are left out, which [`Board::repair`] prevents.
    pub fn draw_order(&self) -> Vec<ElementId> {
        let mut children: BTreeMap<Option<ElementId>, Vec<(&ZIndex, ElementId)>> = BTreeMap::new();
        for (id, element) in &self.elements {
            children
                .entry(element.group)
                .or_default()
                .push((&element.z, *id));
        }
        let mut order = Vec::with_capacity(self.elements.len());
        let mut pending = Vec::new();
        let mut push_children = |pending: &mut Vec<ElementId>, parent| {
            if let Some(siblings) = children.get_mut(&parent) {
                siblings.sort_unstable();
                pending.extend(siblings.iter().rev().map(|(_, id)| *id));
            }
        };
        push_children(&mut pending, None);
        while let Some(id) = pending.pop() {
            order.push(id);
            push_children(&mut pending, Some(id));
        }
        order
    }

    /// Git merges two branches file by file, so it can leave an element in a group that
    /// another branch deleted, or two groups inside each other. Such elements move to the top
    /// level, and a cycle breaks at its smallest id, so that every client repairs alike.
    pub fn repair(&mut self) {
        let misplaced: Vec<ElementId> = self
            .elements
            .iter()
            .filter(|(id, element)| {
                element.group.is_some_and(|group| {
                    group == **id
                        || !matches!(
                            self.elements.get(&group),
                            Some(Element {
                                kind: ElementKind::Group,
                                ..
                            })
                        )
                })
            })
            .map(|(id, _)| *id)
            .collect();
        for id in misplaced {
            self.detach(id);
        }

        let ids: Vec<ElementId> = self.elements.keys().copied().collect();
        for start in ids {
            let mut path = vec![start];
            while let Some(group) = self.elements[path.last().expect("never empty")].group {
                if let Some(at) = path.iter().position(|&id| id == group) {
                    let smallest = *path[at..].iter().min().expect("never empty");
                    self.detach(smallest);
                    break;
                }
                path.push(group);
            }
        }
    }

    fn detach(&mut self, id: ElementId) {
        if let Some(element) = self.elements.get_mut(&id) {
            element.group = None;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Element {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<ElementId>,
    pub z: ZIndex,
    pub kind: ElementKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ElementKind {
    /// Draws its asset as displayed, with the asset's EXIF orientation applied, then crops
    /// it, flips it within the crop, stretches it to fill `frame`, and rotates it.
    Image {
        asset: AssetId,
        /// In pixels, as displayed.
        natural_size: Size,
        frame: Rect,
        #[serde(serialize_with = "without_negative_zero")]
        rotation: f64,
        edits: ImageEdits,
    },
    /// Its text wraps to the width of its frame.
    Note {
        frame: Rect,
        #[serde(serialize_with = "without_negative_zero")]
        rotation: f64,
        text: String,
    },
    Shape {
        frame: Rect,
        #[serde(serialize_with = "without_negative_zero")]
        rotation: f64,
        shape: Shape,
    },
    /// Its head is at `to`.
    Arrow { from: Point, to: Point },
    /// Draws nothing itself. Its elements are those whose `group` it is.
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
                natural_size: _,
                frame,
                rotation,
                edits,
            } => frame.is_finite() && rotation.is_finite() && edits.is_finite(),
            Self::Note {
                frame,
                rotation,
                text: _,
            }
            | Self::Shape {
                frame,
                rotation,
                shape: _,
            } => frame.is_finite() && rotation.is_finite(),
            Self::Arrow { from, to } => from.is_finite() && to.is_finite(),
            Self::Group => true,
        }
    }
}

/// Applied when drawing. The asset's bytes never change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ImageEdits {
    /// In the asset's pixels, as displayed.
    pub crop: Option<Rect>,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub greyscale: bool,
}

impl ImageEdits {
    fn is_finite(&self) -> bool {
        let Self {
            crop,
            flip_horizontal: _,
            flip_vertical: _,
            greyscale: _,
        } = self;
        crop.is_none_or(|crop| crop.is_finite())
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
    #[serde(serialize_with = "without_negative_zero")]
    pub x: f64,
    #[serde(serialize_with = "without_negative_zero")]
    pub y: f64,
}

impl Point {
    fn is_finite(&self) -> bool {
        let Self { x, y } = self;
        x.is_finite() && y.is_finite()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    #[serde(serialize_with = "without_negative_zero")]
    pub x: f64,
    #[serde(serialize_with = "without_negative_zero")]
    pub y: f64,
    #[serde(serialize_with = "without_negative_zero")]
    pub width: f64,
    #[serde(serialize_with = "without_negative_zero")]
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

/// `-0.0` equals `0.0` but would write differently, so that equal boards would not write the
/// same bytes.
fn without_negative_zero<S: Serializer>(
    value: &f64,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_f64(value + 0.0)
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
        let image = |frame, rotation, edits| ElementKind::Image {
            asset: AssetId::of(b""),
            natural_size: Size {
                width: 1,
                height: 1,
            },
            frame,
            rotation,
            edits,
        };
        let note = |frame, rotation| ElementKind::Note {
            frame,
            rotation,
            text: String::new(),
        };
        let shape = |frame, rotation| ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Rectangle,
        };
        let arrow = |from, to| ElementKind::Arrow { from, to };
        let edits = ImageEdits::default();

        let valid = [
            image(rect, 0.0, edits),
            image(
                rect,
                90.0,
                ImageEdits {
                    crop: Some(rect),
                    ..edits
                },
            ),
            note(rect, -45.0),
            shape(rect, 0.0),
            arrow(point, point),
        ];
        assert!(valid.iter().all(ElementKind::is_finite));

        let nan = f64::NAN;
        let invalid = [
            image(Rect { x: nan, ..rect }, 0.0, edits),
            image(Rect { y: nan, ..rect }, 0.0, edits),
            image(Rect { width: nan, ..rect }, 0.0, edits),
            image(
                Rect {
                    height: nan,
                    ..rect
                },
                0.0,
                edits,
            ),
            image(
                rect,
                0.0,
                ImageEdits {
                    crop: Some(Rect { x: nan, ..rect }),
                    ..edits
                },
            ),
            image(rect, nan, edits),
            note(Rect { x: nan, ..rect }, 0.0),
            note(rect, f64::INFINITY),
            shape(Rect { x: nan, ..rect }, 0.0),
            shape(rect, nan),
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

    pub(crate) fn id(bits: u128) -> ElementId {
        ElementId::from_random(bits)
    }

    pub(crate) fn z(key: &str) -> ZIndex {
        key.parse().unwrap()
    }

    pub(crate) fn element(group: Option<u128>, key: &str, kind: ElementKind) -> Element {
        Element {
            group: group.map(id),
            z: z(key),
            kind,
        }
    }

    pub(crate) fn arrow() -> ElementKind {
        let point = Point { x: 0.0, y: 0.0 };
        ElementKind::Arrow {
            from: point,
            to: point,
        }
    }

    pub(crate) fn board(elements: impl IntoIterator<Item = (u128, Element)>) -> Board {
        Board {
            elements: elements
                .into_iter()
                .map(|(bits, element)| (id(bits), element))
                .collect(),
        }
    }

    #[test]
    fn z_indices_stack_siblings_and_ids_break_ties() {
        let board = board([
            (1, element(None, "a2", arrow())),
            (2, element(None, "a1", ElementKind::Group)),
            (3, element(Some(2), "a0V", arrow())),
            (4, element(Some(2), "a0", arrow())),
            (5, element(None, "a0", arrow())),
            (6, element(None, "a0", arrow())),
        ]);
        assert_eq!(board.draw_order(), [5, 6, 2, 4, 3, 1].map(id));
    }

    #[test]
    fn a_broken_structure_is_repaired_alike_everywhere() {
        let mut broken = board([
            (1, element(Some(9), "a0", arrow())),
            (2, element(Some(2), "a0", ElementKind::Group)),
            (3, element(Some(1), "a0", arrow())),
            // Walking up from 4 enters the cycle 5, 6, 7 at 7, not at its smallest id.
            (4, element(Some(7), "a0", arrow())),
            (5, element(Some(6), "a0", ElementKind::Group)),
            (6, element(Some(7), "a0", ElementKind::Group)),
            (7, element(Some(5), "a0", ElementKind::Group)),
        ]);
        broken.repair();

        let groups: Vec<(ElementId, Option<ElementId>)> = broken
            .elements
            .iter()
            .map(|(id, element)| (*id, element.group))
            .collect();
        let expected = [
            (1, None),
            (2, None),
            (3, None),
            (4, Some(7)),
            (5, None),
            (6, Some(7)),
            (7, Some(5)),
        ]
        .map(|(element, group)| (id(element), group.map(id)));
        assert_eq!(groups, expected);
        assert_eq!(broken.draw_order().len(), broken.elements.len());
    }

    #[test]
    fn a_z_index_fits_between_any_two() {
        let mut stack = vec![ZIndex::between(None, None).unwrap()];
        for _ in 0..1000 {
            let top = ZIndex::between(stack.last(), None).unwrap();
            let bottom = ZIndex::between(None, stack.first()).unwrap();
            stack.push(top);
            stack.insert(0, bottom);
        }
        let (mut low, high) = (stack[999].clone(), stack[1000].clone());
        for _ in 0..200 {
            let middle = ZIndex::between(Some(&low), Some(&high)).unwrap();
            assert!(low < middle && middle < high, "{low} {middle} {high}");
            low = middle.clone();
            stack.push(middle);
        }
        for key in &stack {
            assert_eq!(key.to_string().parse(), Ok(key.clone()));
        }
        assert!(stack[..2001].windows(2).all(|pair| pair[0] < pair[1]));
        assert!(stack[..2001].iter().all(|key| key.to_string().len() <= 3));
    }

    #[test]
    fn z_indices_match_the_reference_implementation() {
        let cases = [
            (None, None, "a0"),
            (None, Some("a0"), "Zz"),
            (None, Some("Zz"), "Zy"),
            (Some("a0"), None, "a1"),
            (Some("a1"), None, "a2"),
            (Some("a0"), Some("a1"), "a0V"),
            (Some("a1"), Some("a2"), "a1V"),
            (Some("a0V"), Some("a1"), "a0l"),
            (Some("Zz"), Some("a0"), "ZzV"),
            (Some("Zz"), Some("a1"), "a0"),
            (None, Some("Y00"), "Xzzz"),
            (Some("bzz"), None, "c000"),
            (Some("a0"), Some("a0V"), "a0G"),
            (Some("a0"), Some("a0G"), "a08"),
            (Some("b125"), Some("b129"), "b127"),
            (Some("a0"), Some("a1V"), "a1"),
            (Some("Zz"), Some("a01"), "a0"),
            (None, Some("a0V"), "a0"),
            (None, Some("b999"), "b99"),
            (
                None,
                Some("A000000000000000000000000001"),
                "A000000000000000000000000000V",
            ),
            // The reference would return the smallest integer, which is not a key.
            (
                None,
                Some("A00000000000000000000000001"),
                "A00000000000000000000000000V",
            ),
            (
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzzy"),
                None,
                "zzzzzzzzzzzzzzzzzzzzzzzzzzz",
            ),
            (
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzzz"),
                None,
                "zzzzzzzzzzzzzzzzzzzzzzzzzzzV",
            ),
        ];
        for (below, above, expected) in cases {
            let (below, above) = (below.map(z), above.map(z));
            let key = ZIndex::between(below.as_ref(), above.as_ref());
            assert_eq!(key, Some(z(expected)), "{below:?} {above:?}");
        }
        assert_eq!(ZIndex::between(Some(&z("a1")), Some(&z("a0"))), None);
        assert_eq!(ZIndex::between(Some(&z("a1")), Some(&z("a1"))), None);
    }

    #[test]
    fn a_z_index_has_no_other_spelling() {
        for text in [
            "",
            "a",
            "a00",
            "b0",
            "0",
            "a0 ",
            "a0\u{e9}",
            "A00000000000000000000000000",
        ] {
            assert_eq!(
                text.parse::<ZIndex>(),
                Err(Error::InvalidZIndex(text.to_owned()))
            );
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
