//! What sticks to elements: the ends of arrows and lines, and notes, sticky notes, shapes,
//! strokes, and comments whole. Each keeps to the same point of what its element draws, which it
//! follows wherever the element goes: a pixel of the picture for an image, a point of the frame
//! for an end, and a point as far from the frame's top-left corner, in widths of it, for what
//! sticks whole, which turns, scales, and mirrors with it too, a stroke's drawing included.

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::{FRAC_1_SQRT_2, FRAC_PI_4};

use serde::Serialize;

use crate::geometry::{anchor, apart, covers, hits, holds, nearest_on_outline, surface_bounds};
use crate::grid::{pulled, pulled_along};
use crate::{Board, ElementId, ElementKind, Point, Rect, angle};

impl Board {
    /// Where an arrow's or a line's end let go at `point` lands. Within `reach`, when it sticks,
    /// it sticks to the topmost element it can stick to that draws there, onto its outline when
    /// within `reach` of it too, or when what the element fills leaves `point` out, otherwise the
    /// grid that shows at `pull`, a zoom, pulls it, when it pulls. Locked to the nearest multiple
    /// of 45° `around` the other end, it sticks only to what it lies on, as moving it onto an
    /// outline would turn it off its angle, and the grid pulls it along its way.
    pub fn land_end(
        &self,
        point: Point,
        around: Option<Point>,
        reach: Option<f64>,
        pull: Option<f64>,
    ) -> End {
        // Once for every place tried, and only when it sticks.
        let order = reach.map(|_| self.draw_order()).unwrap_or_default();
        let Some(around) = around else {
            if let Some((target, at)) = reach.and_then(|reach| self.stick_in(&order, point, reach))
            {
                return End {
                    at,
                    target: Some(target),
                };
            }
            let at = pull.map_or(point, |zoom| pulled(point, zoom));
            return End { at, target: None };
        };
        let lying_on = |at: Point| {
            reach
                .and_then(|_| self.stick_in(&order, at, 0.0))
                .map(|(target, _)| target)
        };
        let at = angled(point, around);
        let target = lying_on(at);
        match pull {
            Some(zoom) if target.is_none() => {
                let at = pulled_along(at, around, zoom);
                End {
                    at,
                    target: lying_on(at),
                }
            }
            _ => End { at, target },
        }
    }

    /// What the elements, with those of the groups among them, stick to whole, once each.
    pub fn targets_of(&self, ids: &[ElementId]) -> BTreeSet<ElementId> {
        self.with_descendants(ids)
            .into_iter()
            .filter_map(|id| self.elements[&id].kind.target())
            .collect()
    }

    /// The element, and what sticks to it whole, and so on.
    pub(crate) fn stuck_to(&self, id: ElementId) -> BTreeSet<ElementId> {
        stuck_to(&holding(self), id)
    }

    /// As [`Board::land_end`] sticks an end within `tolerance`, the elements drawing in `order`.
    fn stick_in(
        &self,
        order: &[ElementId],
        point: Point,
        tolerance: f64,
    ) -> Option<(ElementId, Point)> {
        let id = *order.iter().rev().find(|id| {
            let kind = &self.elements[id].kind;
            kind.is_target() && hits(kind, point, tolerance)
        })?;
        let kind = &self.elements[&id].kind;
        let reach = tolerance + kind.stroke_width() / 2.0;
        let outline = nearest_on_outline(kind, point)
            .filter(|on| apart(*on, point) <= reach || !covers(kind, point));
        Some((id, outline.unwrap_or(point)))
    }
}

/// Where an arrow's or a line's end lands, and what it sticks to there.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct End {
    pub at: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub target: Option<ElementId>,
}

/// Across, then by 45° each, clockwise as the board's y runs down, with no hair off an axis.
const DIRECTIONS: [(f64, f64); 8] = [
    (1.0, 0.0),
    (FRAC_1_SQRT_2, FRAC_1_SQRT_2),
    (0.0, 1.0),
    (-FRAC_1_SQRT_2, FRAC_1_SQRT_2),
    (-1.0, 0.0),
    (-FRAC_1_SQRT_2, -FRAC_1_SQRT_2),
    (0.0, -1.0),
    (FRAC_1_SQRT_2, -FRAC_1_SQRT_2),
];

/// `point` turned around `around` onto the nearest multiple of 45°, as far from it.
fn angled(point: Point, around: Point) -> Point {
    let (dx, dy) = (point.x - around.x, point.y - around.y);
    let length = dx.hypot(dy);
    if length == 0.0 {
        return point;
    }
    let eighth = (dy.atan2(dx) / FRAC_PI_4).round() as i64;
    let (x, y) = DIRECTIONS[eighth.rem_euclid(8) as usize];
    Point {
        x: around.x + x * length,
        y: around.y + y * length,
    }
}

/// Where notes, sticky notes, shapes, strokes, and comments land, one after another, each seeing
/// where those before it landed, so that none lands on what sticks to it.
pub(crate) struct Landing<'a> {
    board: &'a Board,
    /// With the bounds of each element's surface, which hold whatever lands on it.
    order: Vec<(ElementId, Option<Rect>)>,
    places: BTreeMap<ElementId, usize>,
    holding: Holding,
}

impl<'a> Landing<'a> {
    pub(crate) fn new(board: &'a Board) -> Self {
        let order: Vec<_> = board
            .draw_order()
            .into_iter()
            .map(|id| (id, surface_bounds(&board.elements[&id].kind)))
            .collect();
        let places = order
            .iter()
            .enumerate()
            .map(|(at, (id, _))| (*id, at))
            .collect();
        Self {
            board,
            order,
            places,
            holding: holding(board),
        }
    }

    /// What the element sticks to where it lies: the topmost element drawn below it, bar what
    /// sticks to it, whose surface holds it whole, or holds the pin of a comment, which shows
    /// above everything. `None` for what cannot stick whole. Each element must land once at most.
    pub(crate) fn land(&mut self, id: ElementId) -> Option<ElementId> {
        let board = self.board;
        let kind = &board.elements.get(&id)?.kind;
        let below = match kind {
            ElementKind::Comment { .. } => &self.order[..],
            ElementKind::Note { .. }
            | ElementKind::Sticky { .. }
            | ElementKind::Shape { .. }
            | ElementKind::Stroke { .. } => &self.order[..*self.places.get(&id)?],
            _ => return None,
        };
        let anchor = anchor(kind)?;
        let stuck = stuck_to(&self.holding, id);
        let target = below.iter().rev().find_map(|(other, bounds)| {
            (bounds.is_some_and(|bounds| bounds.contains(anchor))
                && !stuck.contains(other)
                && holds(&board.elements[other].kind, kind))
            .then_some(*other)
        });
        if let Some(held) = kind
            .target()
            .and_then(|before| self.holding.get_mut(&before))
        {
            held.remove(&id);
        }
        if let Some(target) = target {
            self.holding.entry(target).or_default().insert(id);
        }
        target
    }
}

/// What sticks to each element whole.
type Holding = BTreeMap<ElementId, BTreeSet<ElementId>>;

fn holding(board: &Board) -> Holding {
    let mut holding = Holding::new();
    for (id, element) in &board.elements {
        if let Some(target) = element.kind.target() {
            holding.entry(target).or_default().insert(*id);
        }
    }
    holding
}

fn stuck_to(holding: &Holding, id: ElementId) -> BTreeSet<ElementId> {
    let mut stuck = BTreeSet::from([id]);
    let mut pending = vec![id];
    while let Some(target) = pending.pop() {
        for held in holding.get(&target).into_iter().flatten() {
            if stuck.insert(*held) {
                pending.push(*held);
            }
        }
    }
    stuck
}

/// Within half a stroke, as float arithmetic leaves an end a hair off the outline it snapped
/// onto.
pub(crate) fn lands_on(target: &ElementKind, point: Point) -> bool {
    hits(target, point, target.stroke_width() / 2.0)
}

pub(crate) enum Motion {
    /// As a move alone gives exactly, so that what follows lands where moving it would.
    Shift(Point),
    Map {
        before: Surface,
        after: Surface,
    },
    /// As a side moves out or in, what sticks to it following in parts of its frame and keeping
    /// its size.
    Stretch {
        before: Surface,
        after: Surface,
    },
}

impl Motion {
    /// `None` when what sticks to it stays.
    pub(crate) fn of(before: &ElementKind, after: &ElementKind) -> Option<Self> {
        let (before, after) = (Surface::of(before)?, Surface::of(after)?);
        let shifted = Surface {
            frame: Rect {
                x: after.frame.x,
                y: after.frame.y,
                ..before.frame
            },
            ..before
        };
        if before == after {
            None
        } else if shifted == after {
            Some(Self::Shift(Point {
                x: after.frame.x - before.frame.x,
                y: after.frame.y - before.frame.y,
            }))
        } else {
            Some(Self::Map { before, after })
        }
    }

    /// `None` when what sticks to it stays.
    pub(crate) fn stretch(before: &ElementKind, after: &ElementKind) -> Option<Self> {
        let (before, after) = (Surface::of(before)?, Surface::of(after)?);
        (before != after).then_some(Self::Stretch { before, after })
    }

    /// Where an end at `point` goes. `None` when float arithmetic overflows.
    pub(crate) fn point(&self, point: Point) -> Option<Point> {
        self.map(point, false)
    }

    /// `whole` for what sticks whole, which a frame growing down to fit its text leaves where
    /// it is on the text, and which a stretch carries as it does ends.
    fn map(&self, point: Point, whole: bool) -> Option<Point> {
        match self {
            Self::Shift(by) => Some(Point {
                x: point.x + by.x,
                y: point.y + by.y,
            }),
            Self::Map { before, after } => after.to_board(before.to_content(point, whole)?, whole),
            Self::Stretch { before, after } => {
                after.to_board(before.to_content(point, false)?, false)
            }
        }
    }

    /// A note, a sticky note, a shape, a stroke, or a comment stuck to it whole, moved along.
    /// `None` when float arithmetic overflows.
    pub(crate) fn element(&self, kind: &ElementKind) -> Option<ElementKind> {
        let mut kind = kind.clone();
        match &mut kind {
            ElementKind::Note {
                frame,
                rotation,
                text,
                ..
            }
            | ElementKind::Sticky {
                frame,
                rotation,
                text,
                ..
            }
            | ElementKind::Shape {
                frame,
                rotation,
                text,
                ..
            } => text.font_size *= self.frame(frame, rotation)?,
            // Its points mirror as its picture flips, which a turn alone cannot do. Its width
            // stays, as scaling it alone leaves it.
            ElementKind::Stroke {
                frame,
                rotation,
                points,
                ..
            } => {
                self.frame(frame, rotation)?;
                let (across, down) = self.mirrors();
                for point in points {
                    if across {
                        point.x = 1.0 - point.x;
                    }
                    if down {
                        point.y = 1.0 - point.y;
                    }
                }
            }
            ElementKind::Comment { at, .. } => *at = self.map(*at, true)?,
            _ => return None,
        }
        // As mirrored points may stray from a hundred thousandth.
        let kind = kind.canonical();
        kind.is_valid().then_some(kind)
    }

    /// Whether what sticks to it mirrors, across and down, as its picture flips.
    fn mirrors(&self) -> (bool, bool) {
        let Self::Map { before, after } = self else {
            return (false, false);
        };
        let ((across, down), (now_across, now_down)) = (before.flips(), after.flips());
        (across != now_across, down != now_down)
    }

    /// Moves `frame` along, turning `rotation` with it, and gives how much it scaled. `None` when
    /// float arithmetic overflows.
    fn frame(&self, frame: &mut Rect, rotation: &mut f64) -> Option<f64> {
        let (before, after) = match self {
            Self::Shift(_) => {
                let at = self.point(Point {
                    x: frame.x,
                    y: frame.y,
                })?;
                (frame.x, frame.y) = (at.x, at.y);
                return Some(1.0);
            }
            Self::Stretch { .. } => {
                let centre = self.map(frame.centre(), true)?;
                frame.x = centre.x - frame.width / 2.0;
                frame.y = centre.y - frame.height / 2.0;
                return Some(1.0);
            }
            Self::Map { before, after } => (before, after),
        };
        let centre = self.map(frame.centre(), true)?;
        // Across only, so that what grows down to fit its text scales nothing on it.
        let scale = after.scale() / before.scale();
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        frame.width *= scale;
        frame.height *= scale;
        frame.x = centre.x - frame.width / 2.0;
        frame.y = centre.y - frame.height / 2.0;
        *rotation = after.turned(before, *rotation);
        Some(scale)
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct Surface {
    frame: Rect,
    rotation: f64,
    picture: Option<Picture>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Picture {
    crop: Rect,
    flip_horizontal: bool,
    flip_vertical: bool,
}

impl Surface {
    pub(crate) fn of(kind: &ElementKind) -> Option<Self> {
        match kind {
            ElementKind::Image {
                natural_size,
                frame,
                rotation,
                edits,
                ..
            } => Some(Self {
                frame: *frame,
                rotation: *rotation,
                picture: Some(Picture {
                    crop: edits.crop.unwrap_or(Rect {
                        x: 0.0,
                        y: 0.0,
                        width: natural_size.width.into(),
                        height: natural_size.height.into(),
                    }),
                    flip_horizontal: edits.flip_horizontal,
                    flip_vertical: edits.flip_vertical,
                }),
            }),
            ElementKind::Note {
                frame, rotation, ..
            }
            | ElementKind::Sticky {
                frame, rotation, ..
            }
            | ElementKind::Shape {
                frame, rotation, ..
            } => Some(Self {
                frame: *frame,
                rotation: *rotation,
                picture: None,
            }),
            _ => None,
        }
    }

    /// A pixel of the picture, or a point of the frame, in parts of it from its top-left corner
    /// before it turned.
    pub(crate) fn to_content(&self, point: Point, whole: bool) -> Option<Point> {
        let Self {
            frame,
            rotation,
            picture,
        } = self;
        let upright = point.turned(frame.centre(), -rotation);
        let parts = Point {
            x: part(upright.x - frame.x, frame.width),
            y: part(upright.y - frame.y, self.down(whole)),
        };
        let content = picture
            .as_ref()
            .map_or(parts, |picture| picture.pixel(parts));
        content.is_finite().then_some(content)
    }

    /// What a point's height on it is measured in: a picture's pixels, its frame's height for an
    /// end, and its width for what sticks whole.
    fn down(&self, whole: bool) -> f64 {
        if whole && self.picture.is_none() {
            self.frame.width
        } else {
            self.frame.height
        }
    }

    /// Board units per unit of what it draws, across.
    fn scale(&self) -> f64 {
        let content = self.picture.map_or(1.0, |picture| picture.crop.width.abs());
        self.frame.width.abs() / content
    }

    /// An angle turned as `before` turned into this, and mirrored with each flip of its picture,
    /// which keeps mirrored text the right way up.
    fn turned(&self, before: &Surface, degrees: f64) -> f64 {
        let mirrored = |surface: &Surface| {
            let (horizontally, vertically) = surface.flips();
            horizontally != vertically
        };
        if mirrored(before) == mirrored(self) {
            angle(degrees + self.rotation - before.rotation)
        } else {
            angle(self.rotation + before.rotation - degrees)
        }
    }

    fn flips(&self) -> (bool, bool) {
        self.picture.map_or((false, false), |picture| {
            (picture.flip_horizontal, picture.flip_vertical)
        })
    }

    pub(crate) fn to_board(&self, content: Point, whole: bool) -> Option<Point> {
        let Self {
            frame,
            rotation,
            picture,
        } = self;
        let parts = picture
            .as_ref()
            .map_or(content, |picture| picture.parts(content));
        let upright = Point {
            x: frame.x + parts.x * frame.width,
            y: frame.y + parts.y * self.down(whole),
        };
        let point = upright.turned(frame.centre(), *rotation);
        point.is_finite().then_some(point)
    }
}

/// A flat frame or crop keeps every point at its start, as an end stuck to a line drawn flat
/// lies on it, and turning it leaves only a hair of offset, which dividing would blow up.
fn part(offset: f64, extent: f64) -> f64 {
    if extent == 0.0 { 0.0 } else { offset / extent }
}

impl Picture {
    /// The pixel shown at `parts` of the frame, as the picture is cropped then flipped within
    /// the crop.
    fn pixel(&self, parts: Point) -> Point {
        let parts = self.flipped(parts);
        Point {
            x: self.crop.x + parts.x * self.crop.width,
            y: self.crop.y + parts.y * self.crop.height,
        }
    }

    fn parts(&self, pixel: Point) -> Point {
        self.flipped(Point {
            x: part(pixel.x - self.crop.x, self.crop.width),
            y: part(pixel.y - self.crop.y, self.crop.height),
        })
    }

    /// Flipping twice gives the same point back.
    fn flipped(&self, parts: Point) -> Point {
        Point {
            x: if self.flip_horizontal {
                1.0 - parts.x
            } else {
                parts.x
            },
            y: if self.flip_vertical {
                1.0 - parts.y
            } else {
                parts.y
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{board, element, id};
    use crate::{Colour, Dash, Fill, Heads, Shape, Text, Weight};

    fn area(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn shape(shape: Shape, frame: Rect, rotation: f64, content: &str) -> ElementKind {
        ElementKind::Shape {
            frame,
            rotation,
            shape,
            corners: Default::default(),
            text: Text::new(content.to_owned(), 20.0),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            fill: Fill::Hollow,
            dash: Dash::Solid,
            opacity: Default::default(),
        }
    }

    fn image(frame: Rect) -> ElementKind {
        ElementKind::Image {
            asset: crate::AssetId::of(b""),
            natural_size: crate::Size {
                width: 10,
                height: 10,
            },
            frame,
            rotation: 0.0,
            edits: crate::ImageEdits::default(),
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn stick(board: &Board, point: Point, tolerance: f64) -> Option<(ElementId, Point)> {
        let End { at, target } = board.land_end(point, None, Some(tolerance), None);
        target.map(|target| (target, at))
    }

    fn assert_at(stuck: Option<(ElementId, Point)>, bits: u128, x: f64, y: f64) {
        let (target, at) = stuck.expect("stuck");
        assert_eq!(target, id(bits));
        assert!(apart(at, point(x, y)) < 1e-9, "{at:?} is not ({x}, {y})");
    }

    #[test]
    fn an_end_sticks_to_the_topmost_element_that_takes_ends() {
        let arrow = ElementKind::Arrow {
            from: point(0.0, 50.0),
            to: point(100.0, 50.0),
            from_target: None,
            to_target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            heads: Heads::End,
            opacity: Default::default(),
        };
        let comment = ElementKind::Comment {
            at: point(50.0, 50.0),
            text: "Here".to_owned(),
            target: None,
        };
        let board = board([
            (1, element(None, "a0", image(area(0.0, 0.0, 100.0, 100.0)))),
            (2, element(None, "a1", ElementKind::Group)),
            (
                3,
                element(Some(2), "a0", image(area(50.0, 0.0, 100.0, 100.0))),
            ),
            (4, element(None, "a2", arrow)),
            (5, element(None, "a3", comment)),
        ]);
        // Through the arrow and the comment, onto the image within the group.
        assert_at(stick(&board, point(60.0, 50.0), 3.0), 3, 60.0, 50.0);
        assert_at(stick(&board, point(20.0, 50.0), 3.0), 1, 20.0, 50.0);
        assert_eq!(stick(&board, point(200.0, 50.0), 3.0), None);
    }

    #[test]
    fn an_end_sticks_through_what_a_shape_without_text_surrounds() {
        let board = board([
            (1, element(None, "a0", image(area(0.0, 0.0, 100.0, 100.0)))),
            (
                2,
                element(
                    None,
                    "a1",
                    shape(Shape::Rectangle, area(0.0, 0.0, 100.0, 100.0), 0.0, ""),
                ),
            ),
            (
                3,
                element(
                    None,
                    "a2",
                    shape(Shape::Rectangle, area(200.0, 0.0, 100.0, 100.0), 0.0, "A"),
                ),
            ),
        ]);
        assert_at(stick(&board, point(50.0, 50.0), 3.0), 1, 50.0, 50.0);
        assert_at(stick(&board, point(250.0, 50.0), 3.0), 3, 250.0, 50.0);
    }

    #[test]
    fn an_end_stays_where_let_go_within_a_filled_shape_but_not_a_filled_cross() {
        let filled = |kind, frame, fill| {
            let mut kind = shape(kind, frame, 0.0, "");
            if let ElementKind::Shape { fill: drawn, .. } = &mut kind {
                *drawn = fill;
            }
            kind
        };
        let board = board([
            (1, element(None, "a0", image(area(0.0, 0.0, 100.0, 100.0)))),
            (
                2,
                element(
                    None,
                    "a1",
                    filled(Shape::Rectangle, area(0.0, 0.0, 100.0, 100.0), Fill::Tint),
                ),
            ),
            (
                3,
                element(
                    None,
                    "a2",
                    filled(Shape::Ellipse, area(200.0, 0.0, 200.0, 100.0), Fill::Solid),
                ),
            ),
            (
                4,
                element(None, "a3", image(area(600.0, 0.0, 100.0, 100.0))),
            ),
            (
                5,
                element(
                    None,
                    "a4",
                    filled(Shape::Cross, area(600.0, 0.0, 100.0, 100.0), Fill::Solid),
                ),
            ),
        ]);
        assert_at(stick(&board, point(50.0, 50.0), 3.0), 2, 50.0, 50.0);
        assert_at(stick(&board, point(50.0, 98.0), 3.0), 2, 50.0, 100.0);
        assert_at(stick(&board, point(300.0, 50.0), 3.0), 3, 300.0, 50.0);
        // Between the cross's strokes, onto the image below it.
        assert_at(stick(&board, point(620.0, 50.0), 3.0), 4, 620.0, 50.0);
    }

    #[test]
    fn an_end_near_an_outline_snaps_onto_it() {
        let board = board([
            (1, element(None, "a0", image(area(0.0, 0.0, 100.0, 20.0)))),
            (
                2,
                element(
                    None,
                    "a1",
                    shape(Shape::Rectangle, area(200.0, 0.0, 100.0, 20.0), 90.0, ""),
                ),
            ),
            (
                3,
                element(
                    None,
                    "a2",
                    shape(Shape::Ellipse, area(400.0, 0.0, 200.0, 100.0), 30.0, ""),
                ),
            ),
            (
                4,
                element(
                    None,
                    "a3",
                    shape(Shape::Ellipse, area(0.0, 200.0, 100.0, 0.0), 0.0, ""),
                ),
            ),
            (
                5,
                element(
                    None,
                    "a4",
                    shape(Shape::Cross, area(200.0, 200.0, 100.0, 100.0), 0.0, "C"),
                ),
            ),
        ]);
        // Within reach of the image's bottom side, and away from its sides.
        assert_at(stick(&board, point(30.0, 18.0), 3.0), 1, 30.0, 20.0);
        assert_at(stick(&board, point(30.0, 10.0), 3.0), 1, 30.0, 10.0);
        assert_at(stick(&board, point(262.0, 0.0), 3.0), 2, 260.0, 0.0);
        // Just out of the ellipse's side, whose middle turned to (475, 93.3). Turned back
        // upright, its curve is where its equation gives 1, and the nearest point of it is
        // where the way to the end runs along its normal.
        let (target, on) = stick(&board, point(474.0, 95.0), 3.0).unwrap();
        assert_eq!(target, id(3));
        let upright = on.turned(point(500.0, 50.0), -30.0);
        let curve = ((upright.x - 500.0) / 100.0).hypot((upright.y - 50.0) / 50.0);
        assert!((curve - 1.0).abs() < 1e-9, "{curve}");
        let end = point(474.0, 95.0).turned(point(500.0, 50.0), -30.0);
        let normal = (
            (upright.x - 500.0) / (100.0 * 100.0),
            (upright.y - 50.0) / (50.0 * 50.0),
        );
        let aslant = (end.x - upright.x) * normal.1 - (end.y - upright.y) * normal.0;
        assert!(aslant.abs() < 1e-9, "{aslant}");
        assert_at(stick(&board, point(50.0, 202.0), 3.0), 4, 50.0, 200.0);
        assert_at(stick(&board, point(221.0, 219.0), 3.0), 5, 220.0, 220.0);
        assert_at(stick(&board, point(250.0, 220.0), 3.0), 5, 250.0, 220.0);
    }

    #[test]
    fn an_end_sticks_to_the_sides_of_a_triangle_and_not_to_a_star_s_dents() {
        let mut star = shape(Shape::Star, area(200.0, 0.0, 100.0, 100.0), 0.0, "");
        if let ElementKind::Shape { fill, .. } = &mut star {
            *fill = Fill::Solid;
        }
        let board = board([
            (
                1,
                element(
                    None,
                    "a0",
                    shape(Shape::Triangle, area(0.0, 0.0, 100.0, 100.0), 0.0, ""),
                ),
            ),
            (
                2,
                element(None, "a1", image(area(200.0, 0.0, 100.0, 100.0))),
            ),
            (3, element(None, "a2", star)),
        ]);
        // Just out of its right side, from (50, 0) to (100, 100), onto the nearest point of it.
        assert_at(stick(&board, point(77.0, 49.0), 3.0), 1, 75.0, 50.0);
        // In its frame's corner, away from its sides.
        assert_eq!(stick(&board, point(95.0, 10.0), 3.0), None);
        // In the dent between the star's bottom points, onto the image under it.
        assert_at(stick(&board, point(250.0, 90.0), 3.0), 2, 250.0, 90.0);
        assert_at(stick(&board, point(250.0, 50.0), 3.0), 3, 250.0, 50.0);
    }

    fn end(at: Point, target: Option<u128>) -> End {
        End {
            at,
            target: target.map(id),
        }
    }

    #[test]
    fn an_end_let_go_sticks_or_else_the_grid_pulls_it() {
        let board = board([(1, element(None, "a0", image(area(0.0, 0.0, 100.0, 100.0))))]);
        // At a zoom of 1, lines 20 apart pull from 5 away.
        let near = point(57.0, 102.0);
        assert_eq!(
            board.land_end(near, None, Some(5.0), Some(1.0)),
            end(point(57.0, 100.0), Some(1))
        );
        assert_eq!(
            board.land_end(near, None, None, Some(1.0)),
            end(point(60.0, 100.0), None)
        );
        assert_eq!(board.land_end(near, None, None, None), end(near, None));
        assert_eq!(
            board.land_end(point(157.0, 102.0), None, Some(5.0), Some(1.0)),
            end(point(160.0, 100.0), None)
        );
    }

    #[test]
    fn an_end_locked_around_the_other_keeps_to_its_angle() {
        let board = board([(1, element(None, "a0", image(area(90.0, 90.0, 40.0, 40.0))))]);
        let origin = point(0.0, 0.0);
        let aslant = 100.0_f64.hypot(90.0) * FRAC_1_SQRT_2;
        // On what it lies on, with no pull and no snap onto its outline.
        assert_eq!(
            board.land_end(point(100.0, 90.0), Some(origin), Some(5.0), Some(1.0)),
            end(point(aslant, aslant), Some(1))
        );
        // Along its way onto a line, which keeps it at 45°.
        assert_eq!(
            board.land_end(point(60.0, 54.0), Some(origin), Some(5.0), Some(1.0)),
            end(point(60.0, 60.0), None)
        );
        assert_eq!(
            board.land_end(point(57.0, 2.0), Some(point(0.0, 10.0)), None, Some(1.0)),
            end(point(60.0, 10.0), None)
        );
        // Never onto the other end's own line, nor past it.
        let short = point(3.0, 2.5);
        let around = point(0.0, 2.0);
        assert_eq!(
            board.land_end(short, Some(around), None, Some(1.0)),
            end(point(3.0_f64.hypot(0.5), 2.0), None)
        );
        assert_eq!(
            board.land_end(around, Some(around), None, Some(1.0)),
            end(around, None)
        );
    }

    #[test]
    fn the_targets_of_elements_are_what_they_stick_to_whole() {
        let stuck = |target: u128| {
            let mut kind = shape(Shape::Rectangle, area(10.0, 10.0, 5.0, 5.0), 0.0, "");
            *kind.target_mut().expect("sticks whole") = Some(id(target));
            kind
        };
        let arrow = ElementKind::Arrow {
            from: point(10.0, 10.0),
            to: point(50.0, 50.0),
            from_target: Some(id(1)),
            to_target: Some(id(2)),
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            heads: Heads::End,
            opacity: Default::default(),
        };
        let board = board([
            (1, element(None, "a0", image(area(0.0, 0.0, 100.0, 100.0)))),
            (2, element(None, "a1", image(area(0.0, 0.0, 100.0, 100.0)))),
            (3, element(None, "a2", ElementKind::Group)),
            (4, element(Some(3), "a0", stuck(1))),
            (5, element(Some(3), "a1", stuck(1))),
            (6, element(None, "a3", stuck(2))),
            (7, element(None, "a4", arrow)),
        ]);
        assert_eq!(board.targets_of(&[id(3)]), BTreeSet::from([id(1)]));
        assert_eq!(
            board.targets_of(&[id(5), id(6), id(7), id(9)]),
            BTreeSet::from([id(1), id(2)])
        );
        assert!(board.targets_of(&[id(1), id(7)]).is_empty());
    }

    #[test]
    fn an_end_near_the_curve_of_an_image_shown_as_an_ellipse_snaps_onto_it() {
        let mut shown = image(area(0.0, 0.0, 200.0, 100.0));
        if let ElementKind::Image { edits, .. } = &mut shown {
            edits.crop_shape = crate::CropShape::Ellipse;
        }
        let board = board([(1, element(None, "a0", shown))]);
        // Far from the frame's sides, within reach of the curve.
        let (target, on) = stick(&board, point(168.0, 17.0), 3.0).unwrap();
        assert_eq!(target, id(1));
        let curve = ((on.x - 100.0) / 100.0).hypot((on.y - 50.0) / 50.0);
        assert!((curve - 1.0).abs() < 1e-9, "{curve}");
        // In a corner of the frame, which shows nothing.
        assert_eq!(stick(&board, point(5.0, 5.0), 3.0), None);
    }

    #[test]
    fn an_end_keeps_to_the_same_point_of_what_it_sticks_to() {
        let before = image(area(0.0, 0.0, 100.0, 100.0));
        let ElementKind::Image {
            asset,
            natural_size,
            ..
        } = before
        else {
            unreachable!()
        };
        // Moved, doubled, turned a quarter, cropped to the picture's right half, and flipped
        // upside down within it.
        let after = ElementKind::Image {
            asset,
            natural_size,
            frame: area(100.0, 0.0, 100.0, 200.0),
            rotation: 90.0,
            edits: crate::ImageEdits {
                crop: Some(area(5.0, 0.0, 5.0, 10.0)),
                flip_vertical: true,
                ..crate::ImageEdits::default()
            },
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        };
        // At the picture's (7.5, 2.5), which lands at the crop's (0.5, 0.75) once flipped:
        // (150, 150) upright, turned a quarter around (150, 100).
        let followed = |before, after, point| Motion::of(before, after)?.point(point);
        let to = followed(&before, &after, point(75.0, 25.0)).unwrap();
        assert!(apart(to, point(100.0, 100.0)) < 1e-9, "{to:?}");
        assert!(Motion::of(&before, &before).is_none());
        // Flat, it keeps its points at its left side, which is all there is of it.
        let flat = image(area(0.0, 0.0, 0.0, 100.0));
        let to = followed(&flat, &before, point(0.0, 50.0)).unwrap();
        assert!(apart(to, point(0.0, 50.0)) < 1e-9, "{to:?}");
    }
}
