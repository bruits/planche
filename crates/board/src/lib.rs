//! A board as plain data. No I/O, clock, or randomness, so that it builds for
//! `wasm32-unknown-unknown`.
//!
//! Board space has y pointing down. A [`Rect`] is placed by its top-left corner before
//! rotation, and an element with a frame rotates clockwise, in degrees, around its centre.

mod align;
mod animation;
mod arrange;
mod copy;
mod crop;
mod edit;
mod geometry;
mod grid;
mod media;
mod scene;
mod stick;
mod style;
mod svg;
#[cfg(feature = "ts")]
mod typescript;
mod video;
mod z_index;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub use align::{Alignment, Axis};
pub use animation::frame_delay;
pub use arrange::{Order, Side};
pub use copy::Copied;
pub use edit::{Editor, Placement, Restack, Scaling, Sticking, Transform};
pub use grid::{GRID_SPACING, GRID_STEP, GridLevel, snap_scale_to_grid, snap_to_grid};
pub use media::{MEDIA_START, Media, media};
pub use scene::{Item, Paint};
pub use stick::End;
pub use style::{Setting, Style};
pub use svg::sized_svg;
pub(crate) use svg::svg_size;
#[cfg(feature = "ts")]
pub use typescript::typescript;
pub(crate) use video::video;
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
    #[error("nothing can stick to element {0}")]
    NotATarget(ElementId),
    #[error("element {0} would stick to what sticks to it")]
    StuckToItself(ElementId),
    #[error("element {0} cannot change kind")]
    KindChanged(ElementId),
    #[error(
        "element {0} would hold a NaN, an infinity, a font size that is not positive, or a stroke \
         with no point or one off its frame"
    )]
    Invalid(ElementId),
    #[error("only two elements or more of the same group can be grouped")]
    CannotGroup,
    #[error("elements only scale by a positive factor")]
    NotAScale,
    #[error("the elements take no room on the board")]
    NoRoom,
    #[error("element {0} is not an image")]
    NotAnImage(ElementId),
    #[error("a crop of image {id} must lie within its {width} by {height} pixels and show some")]
    OutsideImage {
        id: ElementId,
        width: u32,
        height: u32,
    },
    #[error("`{0}` is not a colour")]
    InvalidColour(String),
    #[error("element {0} of the copy has no new id")]
    Unnamed(ElementId),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Board {
    pub elements: BTreeMap<ElementId, Element>,
    pub background: Background,
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
    /// another branch deleted, or two groups inside each other, or something stuck to an element
    /// that another branch deleted, or two elements stuck to each other. Such elements move to
    /// the top level or come free where they are, and a cycle breaks at its smallest id, so that
    /// every client repairs alike.
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

        self.break_cycles(|element| element.group, |element| element.group = None);

        let targets: BTreeSet<ElementId> = self
            .elements
            .iter()
            .filter(|(_, element)| element.kind.is_target())
            .map(|(id, _)| *id)
            .collect();
        for element in self.elements.values_mut() {
            for target in element.kind.targets_mut() {
                target.take_if(|target| !targets.contains(target));
            }
        }
        self.break_cycles(
            |element| element.kind.target(),
            |element| {
                if let Some(target) = element.kind.target_mut() {
                    *target = None;
                }
            },
        );
    }

    fn break_cycles(
        &mut self,
        next: impl Fn(&Element) -> Option<ElementId>,
        cut: impl Fn(&mut Element),
    ) {
        let ids: Vec<ElementId> = self.elements.keys().copied().collect();
        for start in ids {
            let mut path = vec![start];
            while let Some(following) = self
                .elements
                .get(path.last().expect("never empty"))
                .and_then(&next)
            {
                if let Some(at) = path.iter().position(|&id| id == following) {
                    let smallest = *path[at..].iter().min().expect("never empty");
                    cut(self.elements.get_mut(&smallest).expect("on the path"));
                    break;
                }
                path.push(following);
            }
        }
    }

    fn detach(&mut self, id: ElementId) {
        if let Some(element) = self.elements.get_mut(&id) {
            element.group = None;
        }
    }

    fn members(&self, group: ElementId) -> impl Iterator<Item = ElementId> + '_ {
        self.elements
            .iter()
            .filter(move |(_, element)| element.group == Some(group))
            .map(|(id, _)| *id)
    }

    /// With the elements of the groups among them, all the way down. Unknown ids are left out.
    fn with_descendants(&self, ids: &[ElementId]) -> BTreeSet<ElementId> {
        let mut found = BTreeSet::new();
        let mut pending: Vec<ElementId> = ids
            .iter()
            .copied()
            .filter(|id| self.elements.contains_key(id))
            .collect();
        while let Some(id) = pending.pop() {
            if found.insert(id) && matches!(self.elements[&id].kind, ElementKind::Group) {
                pending.extend(self.members(id));
            }
        }
        found
    }
}

/// `removed` with the groups that removing it would empty, and those that removing them would,
/// and so on up.
pub(crate) fn with_emptied(
    elements: &BTreeMap<ElementId, Element>,
    mut removed: BTreeSet<ElementId>,
) -> BTreeSet<ElementId> {
    loop {
        let emptied: BTreeSet<ElementId> = removed
            .iter()
            .filter_map(|id| elements.get(id)?.group)
            .filter(|group| !removed.contains(group))
            .filter(|group| {
                elements
                    .iter()
                    .filter(|(_, element)| element.group == Some(*group))
                    .all(|(id, _)| removed.contains(id))
            })
            .collect();
        if emptied.is_empty() {
            return removed;
        }
        removed.extend(emptied);
    }
}

/// A board as the web app holds it.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "Board"))]
pub struct BoardView<'a> {
    #[cfg_attr(feature = "ts", ts(type = "Record<string, Element>"))]
    pub elements: &'a BTreeMap<ElementId, Element>,
    /// Back to front.
    pub draw_order: Vec<ElementId>,
    pub background: Background,
}

impl Board {
    pub fn view(&self) -> BoardView<'_> {
        BoardView {
            elements: &self.elements,
            draw_order: self.draw_order(),
            background: self.background,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Element {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub group: Option<ElementId>,
    pub z: ZIndex,
    pub kind: ElementKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum ElementKind {
    /// Draws its asset as displayed, with the asset's EXIF orientation applied, then crops
    /// it, flips it within the crop, stretches it to fill `frame`, and rotates it.
    Image {
        asset: AssetId,
        /// In pixels, as displayed, or as [`media`] reads them for an SVG.
        natural_size: Size,
        frame: Rect,
        #[serde(serialize_with = "without_negative_zero")]
        rotation: f64,
        edits: ImageEdits,
        /// Where the image came from, such as the address of a page, as whoever set it wrote it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        source: Option<String>,
        /// The name of the file it was added from. Shells keep the name alone, as its path
        /// would say too much about the disk of whoever added it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        caption: Option<String>,
        #[serde(default, skip_serializing_if = "is_default")]
        opacity: Opacity,
    },
    /// Text alone.
    Note {
        frame: Rect,
        #[serde(serialize_with = "without_negative_zero")]
        rotation: f64,
        text: Text,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        target: Option<ElementId>,
        #[serde(default, skip_serializing_if = "is_default")]
        colour: Colour,
        #[serde(default, skip_serializing_if = "is_default")]
        opacity: Opacity,
    },
    /// A sticky note, on its paper, whose colour stays whatever the theme.
    Sticky {
        frame: Rect,
        #[serde(serialize_with = "without_negative_zero")]
        rotation: f64,
        text: Text,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        target: Option<ElementId>,
        #[serde(default, skip_serializing_if = "is_default")]
        paper: Paper,
        #[serde(default, skip_serializing_if = "is_default")]
        opacity: Opacity,
    },
    /// Its outline, its fill, and its text in its `colour`. A cross fills nothing.
    Shape {
        frame: Rect,
        #[serde(serialize_with = "without_negative_zero")]
        rotation: f64,
        shape: Shape,
        text: Text,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        target: Option<ElementId>,
        #[serde(default, skip_serializing_if = "is_default")]
        colour: Colour,
        #[serde(default, skip_serializing_if = "is_default")]
        weight: Weight,
        #[serde(default, skip_serializing_if = "is_default")]
        dash: Dash,
        #[serde(default, skip_serializing_if = "is_default")]
        fill: Fill,
        #[serde(default, skip_serializing_if = "is_default")]
        opacity: Opacity,
    },
    /// Its head is at `to`, unless `heads` says otherwise.
    Arrow {
        from: Point,
        to: Point,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        from_target: Option<ElementId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        to_target: Option<ElementId>,
        #[serde(default, skip_serializing_if = "is_default")]
        colour: Colour,
        #[serde(default, skip_serializing_if = "is_default")]
        weight: Weight,
        #[serde(default, skip_serializing_if = "is_default")]
        dash: Dash,
        #[serde(default, skip_serializing_if = "is_default")]
        heads: Heads,
        #[serde(default, skip_serializing_if = "is_default")]
        opacity: Opacity,
    },
    Line {
        from: Point,
        to: Point,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        from_target: Option<ElementId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        to_target: Option<ElementId>,
        #[serde(default, skip_serializing_if = "is_default")]
        colour: Colour,
        #[serde(default, skip_serializing_if = "is_default")]
        weight: Weight,
        #[serde(default, skip_serializing_if = "is_default")]
        dash: Dash,
        #[serde(default, skip_serializing_if = "is_default")]
        opacity: Opacity,
    },
    /// Drawn freehand, through `points`, which lie within its frame from 0 to 1 across and down,
    /// so that moving, scaling, or turning it leaves them as they are. One point draws a dot.
    Stroke {
        #[serde(default, skip_serializing_if = "is_default")]
        tip: Tip,
        frame: Rect,
        #[serde(serialize_with = "without_negative_zero")]
        rotation: f64,
        #[serde(with = "flat_points")]
        #[cfg_attr(feature = "ts", ts(type = "number[]"))]
        points: Vec<Point>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        target: Option<ElementId>,
        #[serde(default, skip_serializing_if = "is_default")]
        colour: Colour,
        #[serde(default, skip_serializing_if = "is_default")]
        weight: Weight,
        #[serde(default, skip_serializing_if = "is_default")]
        opacity: Opacity,
    },
    /// Pinned at `at`, and shown at one size on screen, whatever the zoom, so it covers nothing
    /// on the board.
    Comment {
        at: Point,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        target: Option<ElementId>,
    },
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

    /// Whether the end of an arrow or a line can stick to it, or a note, a sticky note, a shape,
    /// a stroke, or a comment whole, which takes a frame.
    pub fn is_target(&self) -> bool {
        matches!(
            self,
            Self::Image { .. } | Self::Note { .. } | Self::Sticky { .. } | Self::Shape { .. }
        )
    }

    /// Whether it can stick whole to what it lies on.
    pub(crate) fn sticks_whole(&self) -> bool {
        matches!(
            self,
            Self::Note { .. }
                | Self::Sticky { .. }
                | Self::Shape { .. }
                | Self::Stroke { .. }
                | Self::Comment { .. }
        )
    }

    pub(crate) fn ends(&self) -> Option<[(Point, Option<ElementId>); 2]> {
        match self {
            Self::Arrow {
                from,
                to,
                from_target,
                to_target,
                ..
            }
            | Self::Line {
                from,
                to,
                from_target,
                to_target,
                ..
            } => Some([(*from, *from_target), (*to, *to_target)]),
            _ => None,
        }
    }

    /// How wide an arrow, a line, a shape, or a pen stroke draws, in board units. What draws no
    /// stroke is reached as a medium one would be.
    pub(crate) fn stroke_width(&self) -> f64 {
        match self {
            Self::Shape { weight, .. } | Self::Arrow { weight, .. } | Self::Line { weight, .. } => {
                weight.width()
            }
            Self::Stroke { tip, weight, .. } => tip.width(*weight),
            _ => Weight::Medium.width(),
        }
    }

    /// The element a note, a sticky note, a shape, a stroke, or a comment sticks to whole.
    pub(crate) fn target(&self) -> Option<ElementId> {
        match self {
            Self::Note { target, .. }
            | Self::Sticky { target, .. }
            | Self::Shape { target, .. }
            | Self::Stroke { target, .. }
            | Self::Comment { target, .. } => *target,
            _ => None,
        }
    }

    pub(crate) fn target_mut(&mut self) -> Option<&mut Option<ElementId>> {
        match self {
            Self::Note { target, .. }
            | Self::Sticky { target, .. }
            | Self::Shape { target, .. }
            | Self::Stroke { target, .. }
            | Self::Comment { target, .. } => Some(target),
            _ => None,
        }
    }

    pub(crate) fn targets(&self) -> impl Iterator<Item = ElementId> {
        let ends = self.ends().into_iter().flatten().map(|(_, target)| target);
        ends.chain([self.target()]).flatten()
    }

    pub(crate) fn targets_mut(&mut self) -> Vec<&mut Option<ElementId>> {
        match self {
            Self::Arrow {
                from_target,
                to_target,
                ..
            }
            | Self::Line {
                from_target,
                to_target,
                ..
            } => vec![from_target, to_target],
            _ => self.target_mut().into_iter().collect(),
        }
    }

    pub(crate) fn ends_mut(&mut self) -> Option<[(&mut Point, &mut Option<ElementId>); 2]> {
        match self {
            Self::Arrow {
                from,
                to,
                from_target,
                to_target,
                ..
            }
            | Self::Line {
                from,
                to,
                from_target,
                to_target,
                ..
            } => Some([(from, from_target), (to, to_target)]),
            _ => None,
        }
    }

    /// JSON cannot hold a NaN or an infinity, text of no size cannot be laid out, and a pen
    /// stroke draws at least one point, within its frame. Fields are destructured in full, so a
    /// new one fails to compile until it is checked here.
    pub fn is_valid(&self) -> bool {
        match self {
            Self::Image {
                asset: _,
                natural_size: _,
                frame,
                rotation,
                edits,
                source: _,
                filename: _,
                caption: _,
                opacity: _,
            } => frame.is_finite() && rotation.is_finite() && edits.is_finite(),
            Self::Note {
                frame,
                rotation,
                text,
                target: _,
                colour: _,
                opacity: _,
            }
            | Self::Sticky {
                frame,
                rotation,
                text,
                target: _,
                paper: _,
                opacity: _,
            }
            | Self::Shape {
                frame,
                rotation,
                shape: _,
                text,
                target: _,
                colour: _,
                weight: _,
                dash: _,
                fill: _,
                opacity: _,
            } => frame.is_finite() && rotation.is_finite() && text.is_valid(),
            // Whether their targets are there is up to the board.
            Self::Arrow {
                from,
                to,
                from_target: _,
                to_target: _,
                colour: _,
                weight: _,
                dash: _,
                heads: _,
                opacity: _,
            }
            | Self::Line {
                from,
                to,
                from_target: _,
                to_target: _,
                colour: _,
                weight: _,
                dash: _,
                opacity: _,
            } => from.is_finite() && to.is_finite(),
            // Ink off its frame would pass what the frame bounds.
            Self::Stroke {
                tip: _,
                frame,
                rotation,
                points,
                target: _,
                colour: _,
                weight: _,
                opacity: _,
            } => {
                let within = |part: f64| (0.0..=1.0).contains(&part);
                frame.is_finite()
                    && rotation.is_finite()
                    && !points.is_empty()
                    && points
                        .iter()
                        .all(|point| within(point.x) && within(point.y))
            }
            Self::Comment {
                at,
                text: _,
                target: _,
            } => at.is_finite(),
            Self::Group => true,
        }
    }
}

/// Applied when drawing. The asset's bytes never change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ImageEdits {
    /// In the asset's pixels, as displayed.
    pub crop: Option<Rect>,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub greyscale: bool,
    #[serde(default, skip_serializing_if = "is_default")]
    pub crop_shape: CropShape,
}

impl ImageEdits {
    fn is_finite(&self) -> bool {
        let Self {
            crop,
            flip_horizontal: _,
            flip_vertical: _,
            greyscale: _,
            crop_shape: _,
        } = self;
        crop.is_none_or(|crop| crop.is_finite())
    }
}

/// What an image shows of its crop, the whole of it or the ellipse that fills it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum CropShape {
    #[default]
    Rectangle,
    Ellipse,
}

/// Wraps to the width of what holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Text {
    pub content: String,
    /// In board units, which scaling what holds it scales too.
    #[serde(serialize_with = "without_negative_zero")]
    pub font_size: f64,
    #[serde(default, skip_serializing_if = "is_default")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_default")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_default")]
    pub strike: bool,
    /// `None` for what holds it to choose, centred in a shape and to the left elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub align: Option<Align>,
}

impl Text {
    /// Plain, and aligned as what holds it chooses.
    pub fn new(content: impl Into<String>, font_size: f64) -> Self {
        Self {
            content: content.into(),
            font_size,
            bold: false,
            italic: false,
            strike: false,
            align: None,
        }
    }

    /// Draws nothing.
    pub fn is_blank(&self) -> bool {
        self.content.trim().is_empty()
    }

    fn is_valid(&self) -> bool {
        let Self {
            content: _,
            font_size,
            bold: _,
            italic: _,
            strike: _,
            align: _,
        } = self;
        font_size.is_finite() && *font_size > 0.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Align {
    Left,
    Centre,
    Right,
}

/// A colour of the palette, which each theme draws its own way, or one of its own, which draws
/// alike in every theme. Written as the palette's name, or as `#rrggbb` in lowercase.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts",
    ts(type = r#""ink" | "red" | "orange" | "green" | "blue" | "violet" | `#${string}`"#)
)]
pub enum Colour {
    /// The colour of text.
    #[default]
    Ink,
    Red,
    Orange,
    Green,
    Blue,
    Violet,
    Rgb([u8; 3]),
}

impl Colour {
    const PALETTE: [(Self, &str); 6] = [
        (Self::Ink, "ink"),
        (Self::Red, "red"),
        (Self::Orange, "orange"),
        (Self::Green, "green"),
        (Self::Blue, "blue"),
        (Self::Violet, "violet"),
    ];
}

impl fmt::Display for Colour {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rgb(rgb) => write!(formatter, "#{}", Hex(*rgb)),
            named => {
                let (_, name) = Self::PALETTE
                    .iter()
                    .find(|(colour, _)| colour == named)
                    .expect("every other colour is named");
                formatter.write_str(name)
            }
        }
    }
}

impl FromStr for Colour {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self> {
        if let Some(hex) = text.strip_prefix('#') {
            let Hex(rgb) = hex
                .parse()
                .map_err(|_| Error::InvalidColour(text.to_owned()))?;
            return Ok(Self::Rgb(rgb));
        }
        Self::PALETTE
            .iter()
            .find(|(_, name)| *name == text)
            .map(|(colour, _)| *colour)
            .ok_or_else(|| Error::InvalidColour(text.to_owned()))
    }
}

impl Serialize for Colour {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Colour {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// How much of an element shows, a whole percent from 1 to 100, as none would leave nothing to
/// find it by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(type = "number"))]
pub struct Opacity(u8);

impl Opacity {
    pub const WHOLE: Self = Self(100);

    pub fn new(percent: u8) -> Option<Self> {
        (1..=100).contains(&percent).then_some(Self(percent))
    }

    pub fn percent(self) -> u8 {
        self.0
    }
}

impl Default for Opacity {
    fn default() -> Self {
        Self::WHOLE
    }
}

impl<'de> Deserialize<'de> for Opacity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let percent = u8::deserialize(deserializer)?;
        Self::new(percent).ok_or_else(|| {
            serde::de::Error::custom(format!(
                "an opacity is a percent from 1 to 100, not {percent}"
            ))
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Paper {
    #[default]
    Yellow,
    Pink,
    Orange,
    Green,
    Blue,
    Lilac,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Weight {
    Thin,
    #[default]
    Medium,
    Thick,
}

impl Weight {
    /// In board units, which scaling leaves alone.
    pub const fn width(self) -> f64 {
        match self {
            Self::Thin => 1.0,
            Self::Medium => 2.0,
            Self::Thick => 4.0,
        }
    }
}

/// What draws a stroke.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Tip {
    #[default]
    Pen,
    /// In bright colours of its own, the ink drawing yellow.
    Highlighter,
}

impl Tip {
    /// The widest any stroke draws, which reaching for one must cover.
    pub(crate) const WIDEST: f64 = Self::Highlighter.width(Weight::Thick);

    /// In board units, which scaling leaves alone.
    pub const fn width(self, weight: Weight) -> f64 {
        match self {
            Self::Pen => weight.width(),
            Self::Highlighter => weight.width() * 8.0,
        }
    }

    /// How much of what it draws shows, from 0 to 1, before its element's opacity scales it.
    pub const fn opacity(self) -> f64 {
        match self {
            Self::Pen => 1.0,
            Self::Highlighter => 0.4,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Dash {
    #[default]
    Solid,
    Dashed,
}

/// Which ends of an arrow draw a head, at least one, as one without is a line.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Heads {
    /// At `to`.
    #[default]
    End,
    Both,
}

/// What a rectangle or an ellipse draws within its outline, in its colour.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Fill {
    #[default]
    Hollow,
    /// See-through.
    Tint,
    Solid,
}

/// So that a style left as it comes writes nothing.
fn is_default<T: Default + PartialEq>(value: &T) -> bool {
    *value == T::default()
}

/// An angle has a single spelling, so that equal boards write the same bytes. Rounding can
/// bring a tiny negative angle up to 360.
pub(crate) fn angle(degrees: f64) -> f64 {
    let turned = degrees.rem_euclid(360.0);
    if turned < 360.0 { turned } else { 0.0 }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Shape {
    Rectangle,
    Ellipse,
    /// The two diagonals of its frame.
    Cross,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Background {
    #[default]
    Plain,
    /// The lines of the grid, as [`GridLevel`] tells which.
    Grid,
    /// A dot where those lines cross.
    Dots,
}

impl Background {
    pub fn is_plain(&self) -> bool {
        *self == Self::Plain
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(type = "string"))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(type = "string"))]
pub struct AssetId(Hex<32>);

impl AssetId {
    pub fn of(bytes: &[u8]) -> Self {
        let mut hasher = AssetHasher::new();
        hasher.update(bytes);
        hasher.finish()
    }
}

#[derive(Debug, Clone, Default)]
pub struct AssetHasher(Sha256);

impl AssetHasher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub fn finish(self) -> AssetId {
        AssetId(Hex(self.0.finalize().into()))
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

/// A pen stroke's points as one list of numbers, each point's across then down, as pretty JSON
/// writes each number on a line of its own.
mod flat_points {
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serializer};

    use crate::Point;

    pub fn serialize<S: Serializer>(points: &[Point], serializer: S) -> Result<S::Ok, S::Error> {
        // `-0.0` would write apart from `0.0`.
        serializer.collect_seq(
            points
                .iter()
                .flat_map(|point| [point.x + 0.0, point.y + 0.0]),
        )
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Point>, D::Error> {
        let numbers = Vec::<f64>::deserialize(deserializer)?;
        let (pairs, odd) = numbers.as_chunks::<2>();
        if !odd.is_empty() {
            return Err(D::Error::custom("a stroke's points are pairs of numbers"));
        }
        Ok(pairs.iter().map(|&[x, y]| Point { x, y }).collect())
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
    fn an_opacity_is_a_whole_percent_that_shows_something() {
        let read = |json: &str| serde_json::from_str::<Opacity>(json);
        assert_eq!(read("1").unwrap().percent(), 1);
        assert_eq!(read("100").unwrap(), Opacity::default());
        for json in ["0", "101", "-1", "0.5", "\"50\""] {
            assert!(read(json).is_err(), "{json}");
        }
        assert_eq!(serde_json::to_string(&Opacity::new(40)).unwrap(), "40");
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
    fn every_float_is_checked_for_nan_and_every_font_size_for_a_size() {
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
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        };
        let text = |font_size| Text::new(String::new(), font_size);
        let note = |frame, rotation| ElementKind::Note {
            frame,
            rotation,
            text: text(20.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        let sticky = |frame, rotation, font_size| ElementKind::Sticky {
            frame,
            rotation,
            text: text(font_size),
            target: None,
            paper: Paper::Yellow,
            opacity: Default::default(),
        };
        let shape = |frame, rotation, font_size| ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Rectangle,
            text: text(font_size),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            fill: Fill::Hollow,
            dash: Dash::Solid,
            opacity: Default::default(),
        };
        let arrow = |from, to| ElementKind::Arrow {
            from,
            to,
            from_target: None,
            to_target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            heads: Heads::End,
            opacity: Default::default(),
        };
        let line = |from, to| ElementKind::Line {
            from,
            to,
            from_target: None,
            to_target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            opacity: Default::default(),
        };
        let comment = |at| ElementKind::Comment {
            at,
            text: String::new(),
            target: None,
        };
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
            sticky(rect, 0.0, 20.0),
            shape(rect, 0.0, 20.0),
            arrow(point, point),
            line(point, point),
            comment(point),
        ];
        assert!(valid.iter().all(ElementKind::is_valid));

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
            sticky(Rect { x: nan, ..rect }, 0.0, 20.0),
            sticky(rect, nan, 20.0),
            sticky(rect, 0.0, nan),
            sticky(rect, 0.0, 0.0),
            shape(Rect { x: nan, ..rect }, 0.0, 20.0),
            shape(rect, nan, 20.0),
            shape(rect, 0.0, f64::INFINITY),
            shape(rect, 0.0, -1.0),
            arrow(Point { x: nan, ..point }, point),
            arrow(
                point,
                Point {
                    y: f64::INFINITY,
                    ..point
                },
            ),
            line(point, Point { x: nan, ..point }),
            comment(Point { y: nan, ..point }),
        ];
        for kind in invalid {
            assert!(!kind.is_valid(), "{kind:?}");
        }
    }

    #[test]
    fn a_pen_stroke_draws_at_least_one_point_within_its_frame() {
        let ElementKind::Stroke {
            frame,
            colour,
            weight,
            opacity,
            ..
        } = stroke()
        else {
            unreachable!()
        };
        let drawn = |frame, rotation, points| ElementKind::Stroke {
            tip: Tip::Pen,
            frame,
            rotation,
            points,
            target: None,
            colour,
            weight,
            opacity,
        };
        let at = |x, y| Point { x, y };
        let flat = Rect {
            height: 0.0,
            ..frame
        };
        assert!(drawn(frame, 0.0, vec![at(0.5, 0.5)]).is_valid());
        assert!(drawn(flat, 30.0, vec![at(0.0, 0.0), at(1.0, 0.0)]).is_valid());
        for kind in [
            drawn(frame, 0.0, vec![]),
            drawn(frame, 0.0, vec![at(1.5, 0.5)]),
            drawn(frame, 0.0, vec![at(0.5, -0.1)]),
            drawn(frame, 0.0, vec![at(f64::NAN, 0.5)]),
            drawn(frame, f64::INFINITY, vec![at(0.5, 0.5)]),
            drawn(
                Rect {
                    x: f64::NAN,
                    ..frame
                },
                0.0,
                vec![at(0.5, 0.5)],
            ),
        ] {
            assert!(!kind.is_valid(), "{kind:?}");
        }
    }

    #[test]
    fn a_pen_stroke_writes_its_points_as_one_list_of_numbers() {
        let mut written = serde_json::to_value(stroke()).unwrap();
        assert_eq!(
            written["points"],
            serde_json::json!([0.0, 1.0, 0.5, 0.0, 1.0, 1.0])
        );
        assert_eq!(
            serde_json::from_value::<ElementKind>(written.clone()).unwrap(),
            stroke()
        );
        written["points"] = serde_json::json!([0.0, 1.0, 0.5]);
        assert!(serde_json::from_value::<ElementKind>(written).is_err());
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
            from_target: None,
            to_target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            heads: Heads::End,
            opacity: Default::default(),
        }
    }

    pub(crate) fn stroke() -> ElementKind {
        ElementKind::Stroke {
            tip: Tip::Pen,
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 50.0,
            },
            rotation: 0.0,
            points: vec![
                Point { x: 0.0, y: 1.0 },
                Point { x: 0.5, y: 0.0 },
                Point { x: 1.0, y: 1.0 },
            ],
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            opacity: Default::default(),
        }
    }

    pub(crate) fn board(elements: impl IntoIterator<Item = (u128, Element)>) -> Board {
        Board {
            elements: elements
                .into_iter()
                .map(|(bits, element)| (id(bits), element))
                .collect(),
            ..Board::default()
        }
    }

    #[test]
    fn a_selection_takes_the_elements_of_its_groups_all_the_way_down() {
        let board = board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", ElementKind::Group)),
            (3, element(Some(2), "a0", arrow())),
            (4, element(Some(1), "a1", arrow())),
            (5, element(None, "a1", arrow())),
            (6, element(None, "a2", ElementKind::Group)),
        ]);
        let found = |bits: &[u128]| {
            board.with_descendants(&bits.iter().copied().map(id).collect::<Vec<_>>())
        };
        let set = |bits: &[u128]| bits.iter().copied().map(id).collect::<BTreeSet<_>>();
        assert_eq!(found(&[1]), set(&[1, 2, 3, 4]));
        // Each once, whether named, reached through a group, or both, and unknown ids left out.
        assert_eq!(found(&[3, 1, 2, 3, 9]), set(&[1, 2, 3, 4]));
        assert_eq!(found(&[5, 6]), set(&[5, 6]));
        assert!(found(&[9]).is_empty());
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
    fn an_end_stuck_to_what_is_gone_comes_free_on_repair() {
        let point = Point { x: 1.0, y: 2.0 };
        let line = |from_target: u128, to_target: u128| ElementKind::Line {
            from: point,
            to: point,
            from_target: Some(id(from_target)),
            to_target: Some(id(to_target)),
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            opacity: Default::default(),
        };
        let note = ElementKind::Note {
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            rotation: 0.0,
            text: Text::new(String::new(), 1.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        let mut broken = board([
            (1, element(None, "a0", note)),
            (2, element(None, "a1", ElementKind::Group)),
            (3, element(None, "a2", line(1, 9))),
            (4, element(None, "a3", line(2, 3))),
        ]);
        broken.repair();

        let ends = |bits| broken.elements[&id(bits)].kind.ends().unwrap();
        assert_eq!(ends(3), [(point, Some(id(1))), (point, None)]);
        assert_eq!(ends(4), [(point, None), (point, None)]);
    }

    #[test]
    fn what_sticks_whole_in_a_cycle_comes_free_at_its_smallest_id_on_repair() {
        let note = |target: u128| ElementKind::Note {
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            rotation: 0.0,
            text: Text::new(String::new(), 1.0),
            target: Some(id(target)),
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        let mut broken = board([
            (1, element(None, "a0", note(3))),
            (2, element(None, "a1", note(1))),
            (3, element(None, "a2", note(2))),
            (4, element(None, "a3", note(9))),
            (5, element(None, "a4", note(6))),
            (6, element(None, "a5", ElementKind::Group)),
        ]);
        broken.repair();
        let targets = [1, 2, 3, 4, 5].map(|bits| broken.elements[&id(bits)].kind.target());
        assert_eq!(targets, [None, Some(id(1)), Some(id(2)), None, None]);
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

    #[test]
    fn an_asset_has_one_name_in_whatever_pieces_it_comes() {
        assert_eq!(
            AssetId::of(b"abc").to_string(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let bytes: Vec<u8> = (0..1000_u32).map(|at| (at * 7 % 251) as u8).collect();
        for length in [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000] {
            let whole = AssetId::of(&bytes[..length]);
            for piece in [1, 3, 64, 100, 1000] {
                let mut hasher = AssetHasher::new();
                for chunk in bytes[..length].chunks(piece) {
                    hasher.update(chunk);
                }
                assert_eq!(hasher.finish(), whole, "{length} bytes by {piece}");
            }
        }
    }

    #[test]
    fn a_stroke_writes_its_tip_only_when_a_highlighter() {
        let ElementKind::Stroke {
            frame,
            rotation,
            points,
            colour,
            weight,
            opacity,
            ..
        } = stroke()
        else {
            unreachable!()
        };
        assert!(serde_json::to_value(stroke()).unwrap().get("tip").is_none());
        let highlighter = ElementKind::Stroke {
            tip: Tip::Highlighter,
            frame,
            rotation,
            points,
            target: None,
            colour,
            weight,
            opacity,
        };
        let written = serde_json::to_value(&highlighter).unwrap();
        assert_eq!(written["tip"], "highlighter");
        assert_eq!(
            serde_json::from_value::<ElementKind>(written).unwrap(),
            highlighter
        );
    }
}
