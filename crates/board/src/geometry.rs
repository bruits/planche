//! Where elements draw, in board space: what a pointer or a selection rectangle meets, and
//! the outlines that show a selection.

use std::collections::BTreeSet;
use std::f64::consts::{FRAC_1_SQRT_2, TAU};

use crate::{
    Board, CropShape, ElementId, ElementKind, Fill, ImageEdits, Point, Rect, Shape, Text, Weight,
};

/// The most points [`Board::hit_along`] tries, so that however long the way, it stays quick.
const MOST_TRIES: f64 = 4096.0;

impl Board {
    /// The topmost element that draws at `point`, or within `tolerance` of it. A group or a
    /// comment covers nothing on the board, so it is never the one hit, and a shape neither
    /// filled nor holding text only draws its outline, so what it surrounds stays within reach.
    pub fn hit(&self, point: Point, tolerance: f64) -> Option<ElementId> {
        self.draw_order()
            .into_iter()
            .rev()
            .find(|id| hits(&self.elements[id].kind, point, tolerance))
    }

    /// Every element that [`Board::hit`] would find anywhere on the way from `from` to `to`,
    /// under others too, from back to front. The way is tried every `tolerance`, so that it
    /// misses nothing it passes over, or at most [`MOST_TRIES`] times, spread evenly along it.
    pub fn hit_along(&self, from: Point, to: Point, tolerance: f64) -> Vec<ElementId> {
        // With no tolerance, only its ends.
        let steps = (apart(from, to) / tolerance).ceil();
        let steps = if steps.is_finite() {
            steps.clamp(1.0, MOST_TRIES)
        } else {
            1.0
        };
        let points: Vec<Point> = (0..=steps as usize)
            .map(|step| {
                let along = step as f64 / steps;
                Point {
                    x: from.x + (to.x - from.x) * along,
                    y: from.y + (to.y - from.y) * along,
                }
            })
            .collect();
        // What `hits` finds lies within reach of the frame or the segment, and a whole stroke
        // keeps rounding at the edge from dropping it.
        let reach = tolerance + Weight::WIDEST;
        let around = Rect {
            x: from.x.min(to.x) - reach,
            y: from.y.min(to.y) - reach,
            width: (to.x - from.x).abs() + 2.0 * reach,
            height: (to.y - from.y).abs() + 2.0 * reach,
        };
        let around = corners(&around, 0.0);
        self.draw_order()
            .into_iter()
            .filter(|id| {
                let kind = &self.elements[id].kind;
                shape(kind).is_some_and(|shape| overlap(&shape, &around))
                    && points.iter().any(|point| hits(kind, *point, tolerance))
            })
            .collect()
    }

    /// Every element whose area holds `point`, besides its outline, from back to front.
    pub fn covering(&self, point: Point) -> Vec<ElementId> {
        self.draw_order()
            .into_iter()
            .filter(|id| covers(&self.elements[id].kind, point))
            .collect()
    }

    /// Every element that draws something within `area`, and every comment pinned in it, edges
    /// included, from back to front.
    pub fn touching(&self, area: Rect) -> Vec<ElementId> {
        let area = corners(&area, 0.0);
        self.draw_order()
            .into_iter()
            .filter(|id| touches(&self.elements[id].kind, &area))
            .collect()
    }

    /// The top-level elements and outermost groups of what [`Board::touching`] finds, once
    /// each, in the order it finds them.
    pub fn touching_top_level(&self, area: Rect) -> Vec<ElementId> {
        let mut seen = BTreeSet::new();
        self.touching(area)
            .into_iter()
            .filter_map(|id| self.top_level(id))
            .filter(|id| seen.insert(*id))
            .collect()
    }

    /// The element itself when at the top level, otherwise its outermost group.
    pub fn top_level(&self, id: ElementId) -> Option<ElementId> {
        let mut top = id;
        let mut seen = BTreeSet::from([id]);
        while let Some(group) = self.elements.get(&top)?.group {
            // A board fresh from a merge may hold a cycle until repaired.
            if !seen.insert(group) {
                break;
            }
            top = group;
        }
        Some(top)
    }

    /// The element itself when in `group`, otherwise its group that is. `None` when it is not
    /// within `group`.
    pub fn member(&self, group: ElementId, id: ElementId) -> Option<ElementId> {
        let mut member = id;
        let mut seen = BTreeSet::from([id]);
        loop {
            let parent = self.elements.get(&member)?.group?;
            if parent == group {
                return Some(member);
            }
            // A cycle would loop forever.
            if !seen.insert(parent) {
                return None;
            }
            member = parent;
        }
    }

    /// The closed outline of what an element draws: a frame's corners, clockwise from its
    /// top-left once rotated, an arrow's or a line's two ends, or the corners of the bounds of
    /// a group's elements, if they draw anything. `None` when there is no such element.
    pub fn outline(&self, id: ElementId) -> Option<Vec<Point>> {
        let element = self.elements.get(&id)?;
        Some(match shape(&element.kind) {
            Some(shape) => shape,
            None => self
                .bounds(&[id])
                .map_or_else(Vec::new, |bounds| corners(&bounds, 0.0).to_vec()),
        })
    }

    /// The smallest upright rectangle around what the elements draw, their groups' elements
    /// included. `None` when they draw nothing.
    pub fn bounds(&self, ids: &[ElementId]) -> Option<Rect> {
        let points: Vec<Point> = self
            .with_descendants(ids)
            .into_iter()
            .filter_map(|id| shape(&self.elements[&id].kind))
            .flatten()
            .collect();
        around(&points)
    }

    /// As [`Board::bounds`], with the points where the comments among them are pinned, which a
    /// view must show though they draw nothing on the board.
    pub fn extent(&self, ids: &[ElementId]) -> Option<Rect> {
        let points: Vec<Point> = self
            .with_descendants(ids)
            .into_iter()
            .filter_map(|id| match &self.elements[&id].kind {
                ElementKind::Comment { at, .. } => Some(vec![*at]),
                kind => shape(kind),
            })
            .flatten()
            .collect();
        around(&points)
    }
}

pub(crate) fn around(points: &[Point]) -> Option<Rect> {
    let (first, rest) = points.split_first()?;
    let (mut left, mut top, mut right, mut bottom) = (first.x, first.y, first.x, first.y);
    for point in rest {
        left = left.min(point.x);
        top = top.min(point.y);
        right = right.max(point.x);
        bottom = bottom.max(point.y);
    }
    Some(Rect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

/// The upright rectangle around what an element can hold, a stroke wider so that float
/// arithmetic never leaves out what [`holds`] keeps. `None` for what holds nothing.
pub(crate) fn surface_bounds(kind: &ElementKind) -> Option<Rect> {
    let bounds = around(&shape(kind).filter(|_| kind.is_target())?)?;
    let margin = kind.stroke_width();
    Some(Rect {
        x: bounds.x - margin,
        y: bounds.y - margin,
        width: bounds.width + 2.0 * margin,
        height: bounds.height + 2.0 * margin,
    })
}

/// A point that any surface that [`holds`] `kind` covers, which is therefore within its
/// [`surface_bounds`].
pub(crate) fn anchor(kind: &ElementKind) -> Option<Point> {
    match kind {
        ElementKind::Note { frame, .. }
        | ElementKind::Sticky { frame, .. }
        | ElementKind::Shape { frame, .. } => Some(frame.centre()),
        ElementKind::Comment { at, .. } => Some(*at),
        _ => None,
    }
}

impl Rect {
    pub(crate) fn contains(&self, point: Point) -> bool {
        (self.x..=self.x + self.width).contains(&point.x)
            && (self.y..=self.y + self.height).contains(&point.y)
    }
}

/// What an element draws over, as a convex polygon or a segment. `None` for a comment or a
/// group.
fn shape(kind: &ElementKind) -> Option<Vec<Point>> {
    match kind {
        ElementKind::Image {
            frame, rotation, ..
        }
        | ElementKind::Note {
            frame, rotation, ..
        }
        | ElementKind::Sticky {
            frame, rotation, ..
        }
        | ElementKind::Shape {
            frame, rotation, ..
        } => Some(corners(frame, *rotation).to_vec()),
        ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
            Some(vec![*from, *to])
        }
        ElementKind::Comment { .. } | ElementKind::Group => None,
    }
}

impl Point {
    /// Turned clockwise by `degrees` around `pivot`, as y points down.
    pub(crate) fn turned(self, pivot: Point, degrees: f64) -> Point {
        let (sin, cos) = degrees.to_radians().sin_cos();
        let (x, y) = (self.x - pivot.x, self.y - pivot.y);
        Point {
            x: pivot.x + x * cos - y * sin,
            y: pivot.y + x * sin + y * cos,
        }
    }
}

impl Rect {
    pub(crate) fn centre(&self) -> Point {
        Point {
            x: self.x + self.width / 2.0,
            y: self.y + self.height / 2.0,
        }
    }
}

/// Clockwise from the top-left, once turned clockwise by `degrees` around the centre.
pub(crate) fn corners(rect: &Rect, degrees: f64) -> [Point; 4] {
    let (left, top) = (rect.x, rect.y);
    let (right, bottom) = (left + rect.width, top + rect.height);
    [(left, top), (right, top), (right, bottom), (left, bottom)]
        .map(|(x, y)| Point { x, y }.turned(rect.centre(), degrees))
}

/// Strokes reach half their width beyond the line they follow, and a shape's fill or text fills
/// it.
pub(crate) fn hits(kind: &ElementKind, point: Point, tolerance: f64) -> bool {
    let reach = tolerance + kind.stroke_width() / 2.0;
    match kind {
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Ellipse,
            ..
        } => near_ellipse(frame, *rotation, point, reach) || covers(kind, point),
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Cross,
            ..
        } => {
            diagonals(&corners(frame, *rotation)).any(|(a, b)| distance(point, a, b) <= reach)
                || covers(kind, point)
        }
        ElementKind::Shape {
            frame, rotation, ..
        } => near_edges(&corners(frame, *rotation), point, reach) || covers(kind, point),
        ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
            distance(point, *from, *to) <= reach
        }
        ElementKind::Image {
            frame,
            rotation,
            edits:
                ImageEdits {
                    crop_shape: CropShape::Ellipse,
                    ..
                },
            ..
        } => near_ellipse(frame, *rotation, point, tolerance) || covers(kind, point),
        _ => shape(kind).is_some_and(|shape| near(&shape, point, tolerance)),
    }
}

/// Whether `point` is within the area an element fills, besides its outline: an image's, a
/// note's, a sticky note's, or a shape's once filled or holding text.
pub(crate) fn covers(kind: &ElementKind, point: Point) -> bool {
    match kind {
        ElementKind::Shape {
            shape, fill, text, ..
        } if !filled(*shape, *fill, text) => false,
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Ellipse,
            ..
        }
        | ElementKind::Image {
            frame,
            rotation,
            edits:
                ImageEdits {
                    crop_shape: CropShape::Ellipse,
                    ..
                },
            ..
        } => within_ellipse(frame, *rotation, point),
        _ => shape(kind).is_some_and(|shape| inside(&shape, point)),
    }
}

pub(crate) fn nearest_on_outline(kind: &ElementKind, point: Point) -> Option<Point> {
    match kind {
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Ellipse,
            ..
        }
        | ElementKind::Image {
            frame,
            rotation,
            edits:
                ImageEdits {
                    crop_shape: CropShape::Ellipse,
                    ..
                },
            ..
        } if frame.width != 0.0 && frame.height != 0.0 => {
            Some(nearest_on_ellipse(frame, *rotation, point))
        }
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Cross,
            ..
        } => nearest_on_segments(point, diagonals(&corners(frame, *rotation))),
        _ if kind.is_target() => nearest_on_segments(point, edges(&shape(kind)?)),
        _ => None,
    }
}

fn nearest_on_segments(
    point: Point,
    segments: impl Iterator<Item = (Point, Point)>,
) -> Option<Point> {
    segments
        .map(|(a, b)| closest(point, a, b))
        .min_by(|a, b| apart(*a, point).total_cmp(&apart(*b, point)))
}

fn filled(shape: Shape, fill: Fill, text: &Text) -> bool {
    (shape != Shape::Cross && fill != Fill::Hollow) || !text.is_blank()
}

/// As [`hits`], a shape neither filled nor holding text only draws its strokes, so an area
/// between them touches none of it. A comment, which draws nothing, touches it by its pin.
fn touches(kind: &ElementKind, area: &[Point; 4]) -> bool {
    match kind {
        ElementKind::Shape {
            frame,
            rotation,
            shape: shape @ Shape::Ellipse,
            fill,
            text,
            ..
        } if frame.width != 0.0 && frame.height != 0.0 => {
            ellipse_touches(frame, *rotation, area, filled(*shape, *fill, text))
        }
        ElementKind::Shape {
            frame,
            rotation,
            shape: shape @ Shape::Cross,
            fill,
            text,
            ..
        } => {
            let outline = corners(frame, *rotation);
            if filled(*shape, *fill, text) {
                overlap(&outline, area)
            } else {
                diagonals(&outline).any(|(a, b)| overlap(&[a, b], area))
            }
        }
        ElementKind::Shape {
            frame,
            rotation,
            shape,
            fill,
            text,
            ..
        } => {
            let outline = corners(frame, *rotation);
            overlap(&outline, area)
                && (filled(*shape, *fill, text)
                    || !area.iter().all(|corner| inside(&outline, *corner)))
        }
        ElementKind::Image {
            frame,
            rotation,
            edits:
                ImageEdits {
                    crop_shape: CropShape::Ellipse,
                    ..
                },
            ..
        } if frame.width != 0.0 && frame.height != 0.0 => {
            ellipse_touches(frame, *rotation, area, true)
        }
        ElementKind::Comment { at, .. } => {
            around(area).is_some_and(|upright| upright.contains(*at))
        }
        _ => shape(kind).is_some_and(|shape| overlap(&shape, area)),
    }
}

/// Whether what `target` covers holds the whole of what `kind` draws: its frame, the curve of an
/// ellipse, or the pin of a comment.
pub(crate) fn holds(target: &ElementKind, kind: &ElementKind) -> bool {
    match kind {
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Ellipse,
            ..
        } if frame.width != 0.0 && frame.height != 0.0 => {
            covers(target, frame.centre())
                && match target {
                    // Close enough, as no cheap test tells whether one ellipse holds another.
                    ElementKind::Shape {
                        shape: Shape::Ellipse,
                        ..
                    }
                    | ElementKind::Image {
                        edits:
                            ImageEdits {
                                crop_shape: CropShape::Ellipse,
                                ..
                            },
                        ..
                    } => (0..64).all(|step| {
                        let turn = f64::from(step) / 64.0 * TAU;
                        let centre = frame.centre();
                        let upright = Point {
                            x: centre.x + frame.width / 2.0 * turn.cos(),
                            y: centre.y + frame.height / 2.0 * turn.sin(),
                        };
                        covers(target, upright.turned(centre, *rotation))
                    }),
                    _ => shape(target)
                        .is_some_and(|polygon| ellipse_within(frame, *rotation, &polygon)),
                }
        }
        ElementKind::Note {
            frame, rotation, ..
        }
        | ElementKind::Sticky {
            frame, rotation, ..
        }
        | ElementKind::Shape {
            frame, rotation, ..
        } => corners(frame, *rotation)
            .iter()
            .all(|point| covers(target, *point)),
        ElementKind::Comment { at, .. } => covers(target, *at),
        _ => false,
    }
}

/// Where the ellipse is the unit circle, it lies within a convex polygon that holds its centre
/// when every edge of the polygon is at least a radius away.
fn ellipse_within(frame: &Rect, degrees: f64, polygon: &[Point]) -> bool {
    let centre = frame.centre();
    let (radius_x, radius_y) = ((frame.width / 2.0).abs(), (frame.height / 2.0).abs());
    let unit: Vec<Point> = polygon
        .iter()
        .map(|corner| {
            let upright = corner.turned(centre, -degrees);
            Point {
                x: (upright.x - centre.x) / radius_x,
                y: (upright.y - centre.y) / radius_y,
            }
        })
        .collect();
    let origin = Point { x: 0.0, y: 0.0 };
    edges(&unit).all(|(a, b)| distance(origin, a, b) >= 1.0)
}

/// Where the ellipse is the unit circle, the area meets its curve when the circle's centre is
/// within the area or near an edge of it, unless the whole area lies within the circle and
/// the ellipse is not `filled`.
fn ellipse_touches(frame: &Rect, degrees: f64, area: &[Point; 4], filled: bool) -> bool {
    let centre = frame.centre();
    let (radius_x, radius_y) = ((frame.width / 2.0).abs(), (frame.height / 2.0).abs());
    let unit = area.map(|corner| {
        let upright = corner.turned(centre, -degrees);
        Point {
            x: (upright.x - centre.x) / radius_x,
            y: (upright.y - centre.y) / radius_y,
        }
    });
    let origin = Point { x: 0.0, y: 0.0 };
    let reaches = inside(&unit, origin) || edges(&unit).any(|(a, b)| distance(origin, a, b) <= 1.0);
    reaches && (filled || !unit.iter().all(|corner| corner.x.hypot(corner.y) < 1.0))
}

fn diagonals(corners: &[Point; 4]) -> impl Iterator<Item = (Point, Point)> + '_ {
    [(0, 2), (1, 3)]
        .into_iter()
        .map(|(a, b)| (corners[a], corners[b]))
}

fn near(shape: &[Point], point: Point, tolerance: f64) -> bool {
    inside(shape, point) || near_edges(shape, point, tolerance)
}

fn near_edges(shape: &[Point], point: Point, tolerance: f64) -> bool {
    edges(shape).any(|(a, b)| distance(point, a, b) <= tolerance)
}

/// Near the ellipse that fills `frame`, turned clockwise by `degrees` around its centre.
fn near_ellipse(frame: &Rect, degrees: f64, point: Point, tolerance: f64) -> bool {
    let (radius_x, radius_y) = ((frame.width / 2.0).abs(), (frame.height / 2.0).abs());
    // Flat, it is the line across its frame.
    if radius_x == 0.0 || radius_y == 0.0 {
        return near_edges(&corners(frame, degrees), point, tolerance);
    }
    let centre = frame.centre();
    let upright = point.turned(centre, -degrees);
    let (x, y) = (upright.x - centre.x, upright.y - centre.y);
    // The curve's implicit equation over its gradient, exact on the curve and close near it.
    let scaled = (x / radius_x).hypot(y / radius_y);
    let gradient = (x / (radius_x * radius_x)).hypot(y / (radius_y * radius_y));
    let mut away = if gradient == 0.0 {
        f64::INFINITY
    } else {
        (scaled * (scaled - 1.0) / gradient).abs()
    };
    // Inside a thin ellipse the estimate overshoots, while straight across to the curve,
    // along either axis, never does.
    if scaled < 1.0 {
        let across = radius_y * (1.0 - (x / radius_x).powi(2)).sqrt() - y.abs();
        let along = radius_x * (1.0 - (y / radius_y).powi(2)).sqrt() - x.abs();
        away = away.min(across).min(along);
    } else {
        // Outside, it falls short, but the curve stays within its frame, so is never nearer.
        away = away.max(
            (x.abs() - radius_x)
                .max(0.0)
                .hypot((y.abs() - radius_y).max(0.0)),
        );
    }
    away <= tolerance
}

/// On the curve of the ellipse that fills `frame`, which has an area, turned clockwise by
/// `degrees` around its centre.
fn nearest_on_ellipse(frame: &Rect, degrees: f64, point: Point) -> Point {
    let (radius_x, radius_y) = ((frame.width / 2.0).abs(), (frame.height / 2.0).abs());
    let centre = frame.centre();
    let upright = point.turned(centre, -degrees);
    let (x, y) = ((upright.x - centre.x).abs(), (upright.y - centre.y).abs());
    // In the quarter holding the point, each step goes from the centre of curvature at the
    // last guess towards the point, as far as the curve is from that centre, which lands
    // within a hair of the nearest point in a few steps.
    let (mut cos, mut sin) = (FRAC_1_SQRT_2, FRAC_1_SQRT_2);
    for _ in 0..4 {
        let pull = radius_x * radius_x - radius_y * radius_y;
        let (from_x, from_y) = (
            pull * cos.powi(3) / radius_x,
            -pull * sin.powi(3) / radius_y,
        );
        let curvature = (radius_x * cos - from_x).hypot(radius_y * sin - from_y);
        let (to_x, to_y) = (x - from_x, y - from_y);
        let to = to_x.hypot(to_y);
        // From the centre of curvature itself, every way is as near.
        if to == 0.0 {
            break;
        }
        let next = (
            ((from_x + to_x * curvature / to) / radius_x).clamp(0.0, 1.0),
            ((from_y + to_y * curvature / to) / radius_y).clamp(0.0, 1.0),
        );
        let length = next.0.hypot(next.1);
        if length == 0.0 {
            break;
        }
        (cos, sin) = (next.0 / length, next.1 / length);
    }
    Point {
        x: centre.x + (radius_x * cos).copysign(upright.x - centre.x),
        y: centre.y + (radius_y * sin).copysign(upright.y - centre.y),
    }
    .turned(centre, degrees)
}

fn within_ellipse(frame: &Rect, degrees: f64, point: Point) -> bool {
    let (radius_x, radius_y) = ((frame.width / 2.0).abs(), (frame.height / 2.0).abs());
    let centre = frame.centre();
    let upright = point.turned(centre, -degrees);
    ((upright.x - centre.x) / radius_x).hypot((upright.y - centre.y) / radius_y) <= 1.0
}

/// Whichever way the polygon winds, as a negative width or height turns it over. A polygon
/// with no area holds no point: every side would say the point is on it.
fn inside(polygon: &[Point], point: Point) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let sides: Vec<f64> = edges(polygon)
        .map(|(a, b)| (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x))
        .collect();
    sides.iter().any(|side| *side != 0.0)
        && (sides.iter().all(|side| *side >= 0.0) || sides.iter().all(|side| *side <= 0.0))
}

/// From `point` to the segment from `a` to `b`.
fn distance(point: Point, a: Point, b: Point) -> f64 {
    apart(point, closest(point, a, b))
}

/// The point of the segment from `a` to `b` nearest to `point`.
fn closest(point: Point, a: Point, b: Point) -> Point {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let length = dx * dx + dy * dy;
    let along = if length == 0.0 {
        0.0
    } else {
        (((point.x - a.x) * dx + (point.y - a.y) * dy) / length).clamp(0.0, 1.0)
    };
    Point {
        x: a.x + along * dx,
        y: a.y + along * dy,
    }
}

pub(crate) fn apart(a: Point, b: Point) -> f64 {
    (a.x - b.x).hypot(a.y - b.y)
}

/// Two convex polygons, or segments, overlap unless one of their edges' normals separates
/// them.
fn overlap(a: &[Point], b: &[Point]) -> bool {
    edges(a).chain(edges(b)).all(|(start, end)| {
        let normal = (start.y - end.y, end.x - start.x);
        let project = |shape: &[Point]| {
            shape
                .iter()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), point| {
                    let at = point.x * normal.0 + point.y * normal.1;
                    (low.min(at), high.max(at))
                })
        };
        let ((a_low, a_high), (b_low, b_high)) = (project(a), project(b));
        a_low <= b_high && b_low <= a_high
    })
}

/// Each side of a closed polygon, or a segment once.
fn edges(shape: &[Point]) -> impl Iterator<Item = (Point, Point)> + '_ {
    let closing = (shape.len() > 2).then(|| (shape[shape.len() - 1], shape[0]));
    shape
        .windows(2)
        .map(|pair| (pair[0], pair[1]))
        .chain(closing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{board, element, id};
    use crate::{AssetId, Colour, Dash, Fill, Heads, ImageEdits, Paper, Size, Text};

    fn image(x: f64, y: f64, width: f64, height: f64, rotation: f64) -> ElementKind {
        ElementKind::Image {
            asset: AssetId::of(b""),
            natural_size: Size {
                width: 1,
                height: 1,
            },
            frame: Rect {
                x,
                y,
                width,
                height,
            },
            rotation,
            edits: ImageEdits::default(),
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        }
    }

    fn arrow(from: (f64, f64), to: (f64, f64)) -> ElementKind {
        ElementKind::Arrow {
            from: point(from.0, from.1),
            to: point(to.0, to.1),
            from_target: None,
            to_target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            heads: Heads::End,
            opacity: Default::default(),
        }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn area(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn an_image_is_hit_where_it_draws_once_rotated() {
        // Turned a quarter, 100 by 20 around (50, 10) spans x 40 to 60 and y -40 to 60.
        let board = board([(1, element(None, "a0", image(0.0, 0.0, 100.0, 20.0, 90.0)))]);
        assert_eq!(board.hit(point(50.0, 55.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(50.0, -35.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(90.0, 10.0), 0.0), None);
        assert_eq!(board.hit(point(62.0, 0.0), 0.0), None);
        assert_eq!(board.hit(point(62.0, 0.0), 3.0), Some(id(1)));
    }

    #[test]
    fn an_image_shown_as_an_ellipse_is_hit_and_touched_within_it_only() {
        let mut shown = image(0.0, 0.0, 200.0, 100.0, 90.0);
        if let ElementKind::Image { edits, .. } = &mut shown {
            edits.crop_shape = CropShape::Ellipse;
        }
        // Turned a quarter around (100, 50), its long axis runs from (100, -50) to (100, 150),
        // and its frame spans x 50 to 150.
        let board = board([(1, element(None, "a0", shown))]);
        assert_eq!(board.hit(point(100.0, -45.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(100.0, -52.0), 3.0), Some(id(1)));
        // In a corner of its frame, out of the ellipse.
        assert_eq!(board.hit(point(55.0, -40.0), 0.0), None);
        assert!(board.covering(point(55.0, -40.0)).is_empty());
        assert!(board.touching(area(50.0, -50.0, 10.0, 10.0)).is_empty());
        assert_eq!(board.touching(area(95.0, -55.0, 10.0, 10.0)), [id(1)]);
    }

    #[test]
    fn a_frame_turned_over_by_a_negative_size_is_hit_all_the_same() {
        let board = board([(
            1,
            element(None, "a0", image(100.0, 0.0, -100.0, 20.0, 30.0)),
        )]);
        assert_eq!(board.hit(point(50.0, 10.0), 0.0), Some(id(1)));
    }

    #[test]
    fn a_frame_with_no_area_is_hit_only_near_where_it_draws() {
        let board = board([
            (1, element(None, "a0", image(10.0, 10.0, 0.0, 0.0, 0.0))),
            (2, element(None, "a1", image(200.0, 0.0, 0.0, 20.0, 0.0))),
        ]);
        assert_eq!(board.hit(point(500.0, -300.0), 3.0), None);
        assert_eq!(board.hit(point(12.0, 10.0), 3.0), Some(id(1)));
        // On the line through the zero-width frame, far beyond its ends.
        assert_eq!(board.hit(point(200.0, 500.0), 3.0), None);
        assert_eq!(board.hit(point(202.0, 10.0), 3.0), Some(id(2)));
    }

    #[test]
    fn the_topmost_element_is_hit_and_never_a_group() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 10.0, 10.0, 0.0))),
            (2, element(None, "a1", ElementKind::Group)),
            (3, element(Some(2), "a0", image(5.0, 0.0, 10.0, 10.0, 0.0))),
            (4, element(None, "a2", image(20.0, 0.0, 10.0, 10.0, 0.0))),
        ]);
        assert_eq!(board.hit(point(7.0, 5.0), 0.0), Some(id(3)));
        assert_eq!(board.hit(point(2.0, 5.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(17.0, 5.0), 0.0), None);
    }

    #[test]
    fn a_way_hits_everything_it_passes_over_even_under_others() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 10.0, 10.0, 0.0))),
            (2, element(None, "a1", image(5.0, 0.0, 10.0, 10.0, 0.0))),
            (3, element(None, "a2", image(0.0, 50.0, 10.0, 10.0, 0.0))),
            (4, element(None, "a3", image(40.0, 0.0, 10.0, 10.0, 0.0))),
        ]);
        let way = board.hit_along(point(2.0, 5.0), point(45.0, 5.0), 2.0);
        assert_eq!(way, [id(1), id(2), id(4)]);
    }

    #[test]
    fn a_way_misses_nothing_narrow_between_its_tries() {
        for tenth in 1..1000 {
            let x = f64::from(tenth) / 10.0;
            let board = board([(1, element(None, "a0", image(x, -10.0, 0.1, 20.0, 0.0)))]);
            assert_eq!(
                board.hit_along(point(0.0, 0.0), point(100.0, 0.0), 1.0),
                [id(1)],
                "across x = {x}"
            );
            assert!(
                board
                    .hit_along(point(0.0, 12.0), point(100.0, 12.0), 1.0)
                    .is_empty()
            );
        }
    }

    #[test]
    fn a_way_finds_a_thin_ellipse_near_the_corner_of_its_frame() {
        let board = board([(
            1,
            element(
                None,
                "a0",
                framed(Shape::Ellipse, area(0.0, 0.0, 2000.0, 16.0), 0.0),
            ),
        )]);
        let near = point(2000.0, 16.0);
        assert_eq!(board.hit(near, 4.0), Some(id(1)));
        assert_eq!(board.hit_along(near, near, 4.0), [id(1)]);
    }

    #[test]
    fn a_way_far_longer_than_its_tolerance_is_tried_a_bounded_number_of_times() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 10.0, 10.0, 0.0))),
            (
                2,
                element(None, "a1", image(1e12 - 5.0, 0.0, 10.0, 10.0, 0.0)),
            ),
        ]);
        let way = board.hit_along(point(5.0, 5.0), point(1e12, 5.0), 1e-6);
        assert_eq!(way, [id(1), id(2)]);
    }

    #[test]
    fn a_way_that_goes_nowhere_hits_what_is_under_it() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 10.0, 10.0, 0.0))),
            (2, element(None, "a1", image(5.0, 0.0, 10.0, 10.0, 0.0))),
        ]);
        let under = point(7.0, 5.0);
        assert_eq!(board.hit_along(under, under, 0.0), [id(1), id(2)]);
        assert_eq!(board.hit_along(under, under, 2.0), [id(1), id(2)]);
    }

    #[test]
    fn only_what_fills_an_area_covers_a_point() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 100.0, 100.0, 0.0))),
            (2, element(None, "a1", arrow((10.0, 50.0), (90.0, 50.0)))),
            (
                3,
                element(
                    None,
                    "a2",
                    framed(Shape::Rectangle, area(20.0, 20.0, 60.0, 60.0), 0.0),
                ),
            ),
            (
                4,
                element(
                    None,
                    "a3",
                    labelled(Shape::Rectangle, area(40.0, 40.0, 20.0, 20.0), 0.0, "text"),
                ),
            ),
        ]);
        assert_eq!(board.covering(point(50.0, 50.0)), [id(1), id(4)]);
        assert!(board.covering(point(150.0, 50.0)).is_empty());
    }

    fn framed(shape: Shape, frame: Rect, rotation: f64) -> ElementKind {
        labelled(shape, frame, rotation, "")
    }

    fn labelled(shape: Shape, frame: Rect, rotation: f64, content: &str) -> ElementKind {
        ElementKind::Shape {
            frame,
            rotation,
            shape,
            text: Text::new(content.to_owned(), 20.0),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            fill: Fill::Hollow,
            dash: Dash::Solid,
            opacity: Default::default(),
        }
    }

    #[test]
    fn a_shape_is_hit_near_its_outline_only() {
        let board = board([
            (
                1,
                element(
                    None,
                    "a0",
                    framed(Shape::Rectangle, area(0.0, 0.0, 100.0, 100.0), 0.0),
                ),
            ),
            (
                2,
                element(
                    None,
                    "a1",
                    framed(Shape::Ellipse, area(200.0, 0.0, 100.0, 50.0), 0.0),
                ),
            ),
            // Turned upright, 50 wide and 100 tall around (50, 225).
            (
                3,
                element(
                    None,
                    "a2",
                    framed(Shape::Ellipse, area(0.0, 200.0, 100.0, 50.0), 90.0),
                ),
            ),
        ]);
        assert_eq!(board.hit(point(50.0, 50.0), 3.0), None);
        assert_eq!(board.hit(point(2.0, 50.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(250.0, 25.0), 3.0), None);
        // Inside the ellipse's frame, but outside the ellipse.
        assert_eq!(board.hit(point(205.0, 5.0), 3.0), None);
        assert_eq!(board.hit(point(201.0, 25.0), 3.0), Some(id(2)));
        assert_eq!(board.hit(point(250.0, 1.0), 3.0), Some(id(2)));
        assert_eq!(board.hit(point(50.0, 176.0), 3.0), Some(id(3)));
        assert_eq!(board.hit(point(2.0, 225.0), 3.0), None);
    }

    #[test]
    fn what_a_shape_surrounds_stays_within_reach() {
        let board = board([
            (1, element(None, "a0", image(40.0, 40.0, 20.0, 20.0, 0.0))),
            (
                2,
                element(
                    None,
                    "a1",
                    framed(Shape::Rectangle, area(0.0, 0.0, 100.0, 100.0), 0.0),
                ),
            ),
            // Turned a quarter, 100 by 20 around (250, 10) spans x 240 to 260 and y -40 to 60.
            (
                3,
                element(
                    None,
                    "a2",
                    framed(Shape::Rectangle, area(200.0, 0.0, 100.0, 20.0), 90.0),
                ),
            ),
        ]);
        assert_eq!(board.hit(point(50.0, 50.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(2.0, 50.0), 3.0), Some(id(2)));
        assert_eq!(board.hit(point(241.0, -30.0), 3.0), Some(id(3)));
        assert_eq!(board.hit(point(205.0, 1.0), 3.0), None);
    }

    #[test]
    fn a_selection_rectangle_within_a_shape_touches_none_of_it() {
        let board = board([
            (
                1,
                element(
                    None,
                    "a0",
                    framed(Shape::Rectangle, area(0.0, 0.0, 100.0, 100.0), 0.0),
                ),
            ),
            (2, element(None, "a1", image(40.0, 40.0, 10.0, 10.0, 0.0))),
            (
                3,
                element(
                    None,
                    "a2",
                    framed(Shape::Ellipse, area(200.0, 0.0, 100.0, 100.0), 0.0),
                ),
            ),
        ]);
        assert_eq!(board.touching(area(30.0, 30.0, 30.0, 30.0)), [id(2)]);
        // Over the ellipse's frame, but outside its curve.
        assert!(board.touching(area(200.0, 0.0, 5.0, 5.0)).is_empty());
        assert!(board.touching(area(230.0, 30.0, 40.0, 40.0)).is_empty());
        // Across their outline, or around them whole.
        assert_eq!(board.touching(area(90.0, 40.0, 20.0, 20.0)), [id(1)]);
        assert_eq!(
            board.touching(area(-10.0, -10.0, 320.0, 120.0)),
            [1, 2, 3].map(id)
        );
        assert_eq!(board.touching(area(190.0, 40.0, 20.0, 20.0)), [id(3)]);
    }

    #[test]
    fn a_shape_with_text_is_hit_and_touched_over_its_area() {
        let board = board([
            (
                1,
                element(
                    None,
                    "a0",
                    labelled(Shape::Rectangle, area(0.0, 0.0, 100.0, 100.0), 0.0, "A"),
                ),
            ),
            (
                2,
                element(
                    None,
                    "a1",
                    labelled(Shape::Ellipse, area(200.0, 0.0, 100.0, 100.0), 0.0, "B"),
                ),
            ),
            (
                3,
                element(
                    None,
                    "a2",
                    labelled(Shape::Rectangle, area(400.0, 0.0, 100.0, 100.0), 0.0, " \n"),
                ),
            ),
        ]);
        assert_eq!(board.hit(point(50.0, 50.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(250.0, 50.0), 0.0), Some(id(2)));
        // Over the ellipse's frame, but outside its curve.
        assert_eq!(board.hit(point(205.0, 5.0), 0.0), None);
        assert_eq!(board.hit(point(450.0, 50.0), 0.0), None);
        assert_eq!(board.touching(area(30.0, 30.0, 30.0, 30.0)), [id(1)]);
        assert_eq!(board.touching(area(230.0, 30.0, 40.0, 40.0)), [id(2)]);
        assert!(board.touching(area(200.0, 0.0, 5.0, 5.0)).is_empty());
        assert!(board.touching(area(430.0, 30.0, 40.0, 40.0)).is_empty());
    }

    #[test]
    fn a_sticky_note_is_hit_and_touched_over_its_area() {
        let text = Text::new(String::new(), 20.0);
        let sticky = ElementKind::Sticky {
            frame: area(0.0, 0.0, 100.0, 100.0),
            rotation: 45.0,
            text,
            target: None,
            paper: Paper::Yellow,
            opacity: Default::default(),
        };
        let board = board([(1, element(None, "a0", sticky))]);
        assert_eq!(board.hit(point(50.0, 50.0), 0.0), Some(id(1)));
        // Within its frame, before it turned.
        assert_eq!(board.hit(point(2.0, 2.0), 0.0), None);
        assert_eq!(board.touching(area(40.0, 40.0, 20.0, 20.0)), [id(1)]);
    }

    #[test]
    fn a_turned_ellipse_is_hit_and_touched_where_it_draws() {
        // Turned 30° clockwise, 200 by 50 around (100, 25) has its long axis end near
        // (186.6, 75), where turning it the other way would put it near (186.6, -25).
        let board = board([(
            1,
            element(
                None,
                "a0",
                framed(Shape::Ellipse, area(0.0, 0.0, 200.0, 50.0), 30.0),
            ),
        )]);
        assert_eq!(board.hit(point(186.6, 75.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(186.6, -25.0), 3.0), None);
        assert_eq!(board.touching(area(180.0, 70.0, 10.0, 10.0)), [id(1)]);
        assert!(board.touching(area(180.0, -30.0, 10.0, 10.0)).is_empty());
    }

    #[test]
    fn a_flat_ellipse_is_hit_and_touched_along_its_line() {
        let board = board([
            (
                1,
                element(
                    None,
                    "a0",
                    framed(Shape::Ellipse, area(0.0, 0.0, 100.0, 0.0), 0.0),
                ),
            ),
            (
                2,
                element(
                    None,
                    "a1",
                    framed(Shape::Ellipse, area(200.0, 0.0, 0.0, 100.0), 0.0),
                ),
            ),
        ]);
        assert_eq!(board.hit(point(50.0, 2.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(50.0, 10.0), 3.0), None);
        // On the line through it, far beyond its ends.
        assert_eq!(board.hit(point(150.0, 0.0), 3.0), None);
        assert_eq!(board.hit(point(202.0, 50.0), 3.0), Some(id(2)));
        assert_eq!(board.touching(area(40.0, -10.0, 20.0, 20.0)), [id(1)]);
        assert_eq!(board.touching(area(190.0, 40.0, 20.0, 20.0)), [id(2)]);
        assert!(board.touching(area(40.0, 10.0, 20.0, 20.0)).is_empty());
    }

    #[test]
    fn a_thin_ellipse_is_hit_along_its_long_axis() {
        // At x = 50 its curve is 1.73 from the axis.
        let board = board([(
            1,
            element(
                None,
                "a0",
                framed(Shape::Ellipse, area(0.0, 0.0, 200.0, 4.0), 0.0),
            ),
        )]);
        assert_eq!(board.hit(point(50.0, 2.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(50.0, 2.1), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(100.0, 2.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(50.0, 10.0), 3.0), None);
    }

    #[test]
    fn a_thin_ellipse_is_not_hit_far_beyond_its_tips() {
        // These are 30 to 95 from its curve.
        let board = board([(
            1,
            element(
                None,
                "a0",
                framed(Shape::Ellipse, area(0.0, 0.0, 200.0, 4.0), 0.0),
            ),
        )]);
        assert_eq!(board.hit(point(250.0, 7.0), 4.0), None);
        assert_eq!(board.hit(point(280.0, 5.5), 4.0), None);
        assert_eq!(board.hit(point(295.0, 5.2), 4.0), None);
        assert_eq!(board.hit(point(230.0, 8.0), 4.0), None);
        // Just off its tip, it still is.
        assert_eq!(board.hit(point(204.0, 2.0), 4.0), Some(id(1)));
    }

    #[test]
    fn a_stroke_is_hit_across_its_width() {
        let board = board([
            (
                1,
                element(
                    None,
                    "a0",
                    framed(Shape::Rectangle, area(0.0, 0.0, 100.0, 100.0), 0.0),
                ),
            ),
            (2, element(None, "a1", arrow((200.0, 0.0), (300.0, 0.0)))),
            (3, element(None, "a2", image(400.0, 0.0, 100.0, 100.0, 0.0))),
        ]);
        let half = Weight::Medium.width() / 2.0;
        assert_eq!(board.hit(point(-half + 0.1, 50.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(250.0, half - 0.1), 0.0), Some(id(2)));
        assert_eq!(board.hit(point(400.0 - half + 0.1, 50.0), 0.0), None);
    }

    #[test]
    fn a_thick_stroke_is_hit_further_than_a_thin_one() {
        let weighed = |weight| {
            let mut kind = arrow((0.0, 0.0), (100.0, 0.0));
            if let ElementKind::Arrow { weight: drawn, .. } = &mut kind {
                *drawn = weight;
            }
            kind
        };
        let (thin, thick) = (weighed(Weight::Thin), weighed(Weight::Thick));
        let between = point(50.0, 1.5);
        assert!(!hits(&thin, between, 0.0));
        assert!(hits(&thick, between, 0.0));
    }

    #[test]
    fn a_filled_shape_covers_what_it_surrounds_but_a_filled_cross_does_not() {
        let filled = |shape, frame, fill| {
            let mut kind = framed(shape, frame, 0.0);
            if let ElementKind::Shape { fill: drawn, .. } = &mut kind {
                *drawn = fill;
            }
            kind
        };
        let board = board([
            (1, element(None, "a0", image(40.0, 40.0, 20.0, 20.0, 0.0))),
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
                    filled(Shape::Ellipse, area(200.0, 0.0, 100.0, 50.0), Fill::Solid),
                ),
            ),
            (
                4,
                element(
                    None,
                    "a3",
                    filled(Shape::Cross, area(400.0, 0.0, 100.0, 100.0), Fill::Solid),
                ),
            ),
        ]);
        assert_eq!(board.hit(point(50.0, 50.0), 3.0), Some(id(2)));
        assert_eq!(board.covering(point(50.0, 50.0)), [id(1), id(2)]);
        assert_eq!(board.hit(point(250.0, 25.0), 3.0), Some(id(3)));
        assert_eq!(board.hit(point(205.0, 5.0), 3.0), None);
        assert_eq!(board.hit(point(450.0, 20.0), 3.0), None);
        assert_eq!(board.touching(area(20.0, 20.0, 10.0, 10.0)), [id(2)]);
        assert!(board.touching(area(440.0, 10.0, 8.0, 8.0)).is_empty());
    }

    #[test]
    fn an_arrow_or_a_line_is_hit_near_its_line() {
        let (from, to) = (point(0.0, 0.0), point(100.0, 100.0));
        for kind in [
            ElementKind::Arrow {
                from,
                to,
                from_target: None,
                to_target: None,
                colour: Colour::Ink,
                weight: Weight::Medium,
                dash: Dash::Solid,
                heads: Heads::End,
                opacity: Default::default(),
            },
            ElementKind::Line {
                from,
                to,
                from_target: None,
                to_target: None,
                colour: Colour::Ink,
                weight: Weight::Medium,
                dash: Dash::Solid,
                opacity: Default::default(),
            },
        ] {
            let board = board([(1, element(None, "a0", kind))]);
            assert_eq!(board.hit(point(52.0, 48.0), 3.0), Some(id(1)));
            assert_eq!(board.hit(point(60.0, 40.0), 3.0), None);
            assert_eq!(board.hit(point(102.0, 102.0), 3.0), Some(id(1)));
            assert_eq!(board.touching(area(40.0, 40.0, 5.0, 5.0)), [id(1)]);
        }
    }

    #[test]
    fn a_cross_is_hit_and_touched_along_its_diagonals_until_it_holds_text() {
        let board = board([
            (
                1,
                element(
                    None,
                    "a0",
                    framed(Shape::Cross, area(0.0, 0.0, 100.0, 100.0), 0.0),
                ),
            ),
            (
                2,
                element(
                    None,
                    "a1",
                    labelled(Shape::Cross, area(200.0, 0.0, 100.0, 100.0), 0.0, "C"),
                ),
            ),
            // Turned a quarter, so that it stands 100 wide and 200 tall around (100, 250).
            (
                3,
                element(
                    None,
                    "a2",
                    framed(Shape::Cross, area(0.0, 200.0, 200.0, 100.0), 90.0),
                ),
            ),
        ]);
        assert_eq!(board.hit(point(50.0, 50.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(22.0, 78.0), 3.0), Some(id(1)));
        // Between its arms, and on its frame away from them.
        assert_eq!(board.hit(point(50.0, 20.0), 3.0), None);
        assert_eq!(board.hit(point(50.0, 1.0), 3.0), None);
        assert!(board.touching(area(40.0, 5.0, 20.0, 20.0)).is_empty());
        assert_eq!(board.touching(area(0.0, 0.0, 10.0, 10.0)), [id(1)]);
        assert_eq!(board.hit(point(250.0, 20.0), 0.0), Some(id(2)));
        assert_eq!(board.touching(area(240.0, 5.0, 20.0, 20.0)), [id(2)]);
        assert_eq!(board.hit(point(75.0, 200.0), 3.0), Some(id(3)));
        assert_eq!(board.hit(point(50.0, 200.0), 3.0), None);
    }

    #[test]
    fn a_selection_rectangle_touches_what_it_overlaps() {
        let board = board([
            // Its upright bounds reach the rectangle, but its corner does not.
            (1, element(None, "a0", image(0.0, 0.0, 100.0, 100.0, 45.0))),
            (2, element(None, "a1", image(200.0, 0.0, 10.0, 10.0, 0.0))),
            // It crosses the rectangle without an end inside.
            (
                3,
                element(None, "a2", arrow((105.0, -50.0), (105.0, 150.0))),
            ),
            (4, element(None, "a3", ElementKind::Group)),
        ]);
        assert_eq!(
            board.touching(area(100.0, -10.0, 105.0, 15.0)),
            [2, 3].map(id)
        );
        assert!(board.touching(area(90.0, 90.0, 5.0, 5.0)).is_empty());
    }

    #[test]
    fn an_element_lifts_to_its_outermost_group() {
        let board = board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", ElementKind::Group)),
            (3, element(Some(2), "a0", image(0.0, 0.0, 1.0, 1.0, 0.0))),
            (4, element(None, "a1", image(0.0, 0.0, 1.0, 1.0, 0.0))),
        ]);
        assert_eq!(board.top_level(id(3)), Some(id(1)));
        assert_eq!(board.top_level(id(4)), Some(id(4)));
        assert_eq!(board.top_level(id(9)), None);
    }

    #[test]
    fn an_element_lifts_to_the_member_of_a_group_holding_it() {
        let board = board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", ElementKind::Group)),
            (3, element(Some(2), "a0", image(0.0, 0.0, 1.0, 1.0, 0.0))),
            (4, element(None, "a1", image(0.0, 0.0, 1.0, 1.0, 0.0))),
        ]);
        assert_eq!(board.member(id(1), id(3)), Some(id(2)));
        assert_eq!(board.member(id(2), id(3)), Some(id(3)));
        assert_eq!(board.member(id(1), id(4)), None);
        assert_eq!(board.member(id(1), id(1)), None);
        assert_eq!(board.member(id(1), id(9)), None);
    }

    #[test]
    fn a_cycle_holds_no_member_of_a_group_outside_it() {
        // Unrepaired, as fresh from a merge.
        let board = board([
            (1, element(Some(2), "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", ElementKind::Group)),
        ]);
        assert_eq!(board.member(id(9), id(1)), None);
    }

    #[test]
    fn a_comment_covers_nothing_on_the_board() {
        let comment = ElementKind::Comment {
            at: point(10.0, 10.0),
            text: "Too dark".to_owned(),
            target: None,
        };
        let board = board([(1, element(None, "a0", comment))]);
        assert_eq!(board.hit(point(10.0, 10.0), 3.0), None);
        assert_eq!(board.outline(id(1)), Some(Vec::new()));
        assert_eq!(board.bounds(&[id(1)]), None);
    }

    fn comment(x: f64, y: f64) -> ElementKind {
        ElementKind::Comment {
            at: point(x, y),
            text: "Too dark".to_owned(),
            target: None,
        }
    }

    #[test]
    fn an_area_touches_the_comments_pinned_in_it_edges_included() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 20.0, 20.0, 0.0))),
            (2, element(None, "a1", comment(30.0, 10.0))),
            (3, element(None, "a2", image(25.0, 0.0, 20.0, 20.0, 0.0))),
        ]);
        assert_eq!(
            board.touching(area(10.0, 5.0, 20.0, 5.0)),
            [id(1), id(2), id(3)]
        );
        assert_eq!(board.touching(area(28.0, 10.0, 2.0, 5.0)), [id(2), id(3)]);
        assert_eq!(board.touching(area(32.0, 12.0, -4.0, -4.0)), [id(2), id(3)]);
        assert!(board.touching(area(30.5, 21.0, 5.0, 5.0)).is_empty());
    }

    #[test]
    fn an_area_touches_the_outermost_groups_of_what_it_touches_once_each() {
        let board = board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", image(0.0, 0.0, 20.0, 20.0, 0.0))),
            (3, element(Some(1), "a1", ElementKind::Group)),
            (4, element(Some(3), "a0", comment(10.0, 10.0))),
            (5, element(None, "a1", image(0.0, 0.0, 20.0, 20.0, 0.0))),
        ]);
        assert_eq!(
            board.touching(area(5.0, 5.0, 10.0, 10.0)),
            [id(2), id(4), id(5)]
        );
        assert_eq!(
            board.touching_top_level(area(5.0, 5.0, 10.0, 10.0)),
            [id(1), id(5)]
        );
        assert!(
            board
                .touching_top_level(area(50.0, 5.0, 10.0, 10.0))
                .is_empty()
        );
    }

    #[test]
    fn the_extent_of_elements_holds_what_they_draw_and_where_their_comments_are_pinned() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 20.0, 10.0, 0.0))),
            (2, element(None, "a1", comment(50.0, -5.0))),
            (3, element(None, "a2", ElementKind::Group)),
            (4, element(Some(3), "a0", comment(-10.0, 30.0))),
            (5, element(Some(3), "a1", arrow((0.0, 0.0), (5.0, 5.0)))),
        ]);
        assert_eq!(board.extent(&[id(2)]), Some(area(50.0, -5.0, 0.0, 0.0)));
        assert_eq!(
            board.extent(&[id(1), id(2)]),
            Some(area(0.0, -5.0, 50.0, 15.0))
        );
        assert_eq!(board.extent(&[id(3)]), Some(area(-10.0, 0.0, 15.0, 30.0)));
        assert_eq!(board.bounds(&[id(3)]), Some(area(0.0, 0.0, 5.0, 5.0)));
        assert_eq!(board.extent(&[]), None);
        assert_eq!(board.extent(&[id(9)]), None);
    }

    #[test]
    fn a_group_outlines_the_bounds_of_its_elements() {
        let board = board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", image(0.0, 0.0, 10.0, 10.0, 0.0))),
            (3, element(Some(1), "a1", ElementKind::Group)),
            (4, element(Some(3), "a0", arrow((30.0, -5.0), (20.0, 5.0)))),
            (5, element(None, "a1", ElementKind::Group)),
        ]);
        let corners = [(0.0, -5.0), (30.0, -5.0), (30.0, 10.0), (0.0, 10.0)];
        assert_eq!(
            board.outline(id(1)),
            Some(corners.map(|(x, y)| point(x, y)).to_vec())
        );
        assert_eq!(
            board.outline(id(4)),
            Some(vec![point(30.0, -5.0), point(20.0, 5.0)])
        );
        assert_eq!(board.outline(id(5)), Some(Vec::new()));
        assert_eq!(board.outline(id(9)), None);
        assert_eq!(board.bounds(&[id(5)]), None);
    }
}
