//! Where elements draw, in board space: what a pointer or a selection rectangle meets, and
//! the outlines that show a selection.

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::{FRAC_1_SQRT_2, PI, TAU};

use crate::{
    Board, Corners, CropShape, ElementId, ElementKind, Fill, ImageEdits, Point, Rect, Shape, Text,
    Tip,
};

/// The most points [`Board::hit_along`] tries, so that however long the way, it stays quick.
const MOST_TRIES: f64 = 4096.0;
/// How far a stroke's line turns at a point, in degrees, beyond which [`smoothed`] keeps the
/// point a corner.
const CORNER: f64 = 70.0;
/// About how far each piece of a curve [`smoothed`] draws turns, in degrees.
const PIECE: f64 = 4.0;
/// So that a corner rounded near its limit costs the renderer little.
const MOST_PIECES: f64 = 16.0;
/// How far a group's panel reaches past what its elements draw, in parts of their mean side.
const PANEL_MARGIN: f64 = 0.05;
/// How far a star's inner corners are from its centre, in parts of its points' distance, as in a
/// five-pointed star whose edges line up. The renderer's `STAR` is the same.
const STAR_DEPTH: f64 = 0.381_966;

impl Board {
    /// The topmost element that draws at `point`, or within `tolerance` of it. A comment covers
    /// nothing on the board, nor does a group but for its panel, so neither is hit there, and a
    /// shape neither filled nor holding text only draws its outline, so what it surrounds stays
    /// within reach.
    pub fn hit(&self, point: Point, tolerance: f64) -> Option<ElementId> {
        let panels = self.all_panels();
        self.draw_order().into_iter().rev().find(|id| {
            hits(&self.elements[id].kind, point, tolerance)
                || panels
                    .get(id)
                    .is_some_and(|panel| grown(panel, tolerance).contains(point))
        })
    }

    /// What [`Board::hit`] finds, but through the locked elements, as a click goes.
    pub fn hit_unlocked(&self, point: Point, tolerance: f64) -> Option<ElementId> {
        let panels = self.all_panels();
        self.draw_order().into_iter().rev().find(|id| {
            (hits(&self.elements[id].kind, point, tolerance)
                || panels
                    .get(id)
                    .is_some_and(|panel| grown(panel, tolerance).contains(point)))
                && self.locked_by(*id).is_none()
        })
    }

    /// Every element that [`Board::hit_unlocked`] would find anywhere on the way from `from` to
    /// `to`, but for a group's panel, under others too, from back to front. The way is tried
    /// every `tolerance`, so that it misses nothing it passes over, or at most [`MOST_TRIES`]
    /// times, spread evenly along it.
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
        let reach = tolerance + Tip::WIDEST;
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
                    && hits_any(kind, &points, tolerance)
                    && self.locked_by(*id).is_none()
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

    /// Every element that draws something within `area`, a group's panel included, and every
    /// comment pinned in it, edges included, from back to front.
    pub fn touching(&self, area: Rect) -> Vec<ElementId> {
        let panels = self.all_panels();
        let area = corners(&area, 0.0);
        self.draw_order()
            .into_iter()
            .filter(|id| {
                touches(&self.elements[id].kind, &area)
                    || panels
                        .get(id)
                        .is_some_and(|panel| overlap(&corners(panel, 0.0), &area))
            })
            .collect()
    }

    /// The top-level elements and outermost groups of what [`Board::touching`] finds but for the
    /// locked elements, as a selection rectangle goes through them, once each, in the order it
    /// finds them.
    pub fn touching_top_level(&self, area: Rect) -> Vec<ElementId> {
        let mut seen = BTreeSet::new();
        self.touching(area)
            .into_iter()
            .filter(|id| self.locked_by(*id).is_none())
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

    /// The smallest upright rectangle around what the elements draw, their groups' elements and
    /// panels included. `None` when they draw nothing.
    pub fn bounds(&self, ids: &[ElementId]) -> Option<Rect> {
        let within = self.with_descendants(ids);
        let points: Vec<Point> = within
            .iter()
            .filter_map(|id| shape(&self.elements[id].kind))
            .flatten()
            .collect();
        self.around_panels(points, &within)
    }

    /// As [`Board::bounds`], with the points where the comments among them are pinned, which a
    /// view must show though they draw nothing on the board.
    pub fn extent(&self, ids: &[ElementId]) -> Option<Rect> {
        let within = self.with_descendants(ids);
        let points: Vec<Point> = within
            .iter()
            .filter_map(|id| match &self.elements[id].kind {
                ElementKind::Comment { at, .. } => Some(vec![*at]),
                kind => shape(kind),
            })
            .flatten()
            .collect();
        self.around_panels(points, &within)
    }

    fn around_panels(&self, mut points: Vec<Point>, within: &BTreeSet<ElementId>) -> Option<Rect> {
        let panels = self.panels(within);
        points.extend(panels.values().flat_map(|panel| corners(panel, 0.0)));
        around(&points)
    }

    pub(crate) fn panel(&self, id: ElementId) -> Option<Rect> {
        if !panelled(&self.elements.get(&id)?.kind) {
            return None;
        }
        let within = self.with_descendants(&[id]);
        let mut panels = BTreeMap::new();
        self.drawn_box(
            id,
            &self.membership(&within),
            &mut panels,
            &mut BTreeSet::new(),
        );
        panels.remove(&id)
    }

    /// The panel of each filled group `within`, which stands clear of what its elements draw, the
    /// panels within it included. A group whose elements draw nothing has none.
    fn panels(&self, within: &BTreeSet<ElementId>) -> BTreeMap<ElementId, Rect> {
        let mut panels = BTreeMap::new();
        if !within.iter().any(|id| panelled(&self.elements[id].kind)) {
            return panels;
        }
        let members = self.membership(within);
        let mut seen = BTreeSet::new();
        for id in within {
            if !self.elements[id]
                .group
                .is_some_and(|group| within.contains(&group))
            {
                self.drawn_box(*id, &members, &mut panels, &mut seen);
            }
        }
        panels
    }

    fn membership(&self, within: &BTreeSet<ElementId>) -> BTreeMap<ElementId, Vec<ElementId>> {
        let mut members: BTreeMap<ElementId, Vec<ElementId>> = BTreeMap::new();
        for id in within {
            if let Some(group) = self.elements[id]
                .group
                .filter(|group| within.contains(group))
            {
                members.entry(group).or_default().push(*id);
            }
        }
        members
    }

    /// The upright rectangle around what element `id` draws, its panel when a filled group, which
    /// joins `panels`. A group already `seen`, as in a cycle, draws nothing.
    fn drawn_box(
        &self,
        id: ElementId,
        members: &BTreeMap<ElementId, Vec<ElementId>>,
        panels: &mut BTreeMap<ElementId, Rect>,
        seen: &mut BTreeSet<ElementId>,
    ) -> Option<Rect> {
        let kind = &self.elements[&id].kind;
        if !matches!(kind, ElementKind::Group { .. }) {
            return shape(kind).and_then(|shape| around(&shape));
        }
        if !seen.insert(id) {
            return None;
        }
        let inner = members
            .get(&id)
            .into_iter()
            .flatten()
            .filter_map(|member| self.drawn_box(*member, members, panels, seen))
            .reduce(|all, drawn| union(&all, &drawn))?;
        if !panelled(kind) {
            return Some(inner);
        }
        let panel = padded(inner);
        panels.insert(id, panel);
        Some(panel)
    }

    fn all_panels(&self) -> BTreeMap<ElementId, Rect> {
        if !self
            .elements
            .values()
            .any(|element| panelled(&element.kind))
        {
            return BTreeMap::new();
        }
        self.panels(&self.elements.keys().copied().collect())
    }
}

fn panelled(kind: &ElementKind) -> bool {
    matches!(kind, ElementKind::Group { fill, .. } if *fill != Fill::Hollow)
}

fn padded(bounds: Rect) -> Rect {
    grown(&bounds, PANEL_MARGIN * (bounds.width + bounds.height) / 2.0)
}

fn grown(rect: &Rect, by: f64) -> Rect {
    Rect {
        x: rect.x - by,
        y: rect.y - by,
        width: rect.width + 2.0 * by,
        height: rect.height + 2.0 * by,
    }
}

fn union(a: &Rect, b: &Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    Rect {
        x,
        y,
        width: (a.x + a.width).max(b.x + b.width) - x,
        height: (a.y + a.height).max(b.y + b.height) - y,
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
        ElementKind::Stroke {
            frame,
            rotation,
            points,
            ..
        } => stroke_points(frame, *rotation, points).first().copied(),
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

/// What an element draws over, as a convex polygon or a segment, its frame for a pen stroke, whose
/// line would close into a polygon. `None` for a comment or a group.
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
        }
        | ElementKind::Stroke {
            frame, rotation, ..
        } => Some(corners(frame, *rotation).to_vec()),
        ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
            Some(vec![*from, *to])
        }
        ElementKind::Comment { .. } | ElementKind::Group { .. } => None,
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

/// The corners of a shape drawn as a polygon, as it lies on the board, `None` for any other.
fn polygon_of(kind: &ElementKind) -> Option<Vec<Point>> {
    let ElementKind::Shape {
        frame,
        rotation,
        shape,
        corners,
        ..
    } = kind
    else {
        return None;
    };
    let (count, star) = shape.polygon(*corners)?;
    Some(polygon(frame, *rotation, count, star))
}

/// The corners of a regular polygon of `count` corners, or of a star of `count` points, one
/// pointing up, stretched to touch every side of `frame` whichever way its size goes, then turned
/// clockwise by `degrees` around its centre.
fn polygon(frame: &Rect, degrees: f64, count: u8, star: bool) -> Vec<Point> {
    let unit = unit_polygon(count, star);
    let Some(bounds) = around(&unit) else {
        return Vec::new();
    };
    let centre = frame.centre();
    let (width, height) = (frame.width.abs(), frame.height.abs());
    unit.into_iter()
        .map(|corner| {
            Point {
                x: centre.x + ((corner.x - bounds.x) / bounds.width - 0.5) * width,
                y: centre.y + ((corner.y - bounds.y) / bounds.height - 0.5) * height,
            }
            .turned(centre, degrees)
        })
        .collect()
}

impl Shape {
    /// Where the corners of one drawn as a polygon lie, in parts of its frame before it turns,
    /// `None` for any other.
    pub fn corner_parts(self, corners: Corners) -> Option<Vec<Point>> {
        let (count, star) = self.polygon(corners)?;
        let whole = Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        Some(polygon(&whole, 0.0, count, star))
    }
}

/// As [`polygon`] draws it, around the unit circle's centre, its points on the circle.
fn unit_polygon(count: u8, star: bool) -> Vec<Point> {
    let steps = if star { count * 2 } else { count };
    (0..steps)
        .map(|step| {
            let (sin, cos) = (f64::from(step) / f64::from(steps) * TAU).sin_cos();
            let radius = if star && step % 2 == 1 {
                STAR_DEPTH
            } else {
                1.0
            };
            Point {
                x: radius * sin,
                y: -radius * cos,
            }
        })
        .collect()
}

impl ElementKind {
    /// Where a shape's text lies, in parts of its frame before it turns, the largest rectangle of
    /// the frame's proportions within the largest circle its outline holds, stretched with it, or
    /// the whole frame for a rectangle or a cross. `None` for anything but a shape.
    pub fn text_area(&self) -> Option<Rect> {
        let Self::Shape { shape, corners, .. } = self else {
            return None;
        };
        let (bounds, radius) = match shape.polygon(*corners) {
            // A star's circle runs through its inner corners.
            Some((count, star)) => (
                around(&unit_polygon(count, star))?,
                if star {
                    STAR_DEPTH
                } else {
                    (PI / f64::from(count)).cos()
                },
            ),
            None if *shape == Shape::Ellipse => (
                Rect {
                    x: -1.0,
                    y: -1.0,
                    width: 2.0,
                    height: 2.0,
                },
                1.0,
            ),
            None => {
                return Some(Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                });
            }
        };
        // Stretched, the circle is an ellipse whose half axes are these parts of the frame, and
        // the square of parts it holds meets it at its corners.
        let (across, down) = (radius / bounds.width, radius / bounds.height);
        let half = (across.powi(-2) + down.powi(-2)).sqrt().recip();
        let (x, y) = (-bounds.x / bounds.width, -bounds.y / bounds.height);
        Some(Rect {
            x: x - half,
            y: y - half,
            width: 2.0 * half,
            height: 2.0 * half,
        })
    }

    /// A stroke of `tip` through `points`, in board units, framed by them and styled as it comes,
    /// without the points that stray less than `tolerance` from the line through the others.
    pub fn stroke(tip: Tip, points: &[Point], tolerance: f64) -> Self {
        let kept = simplified(points, tolerance);
        let frame = around(&kept).unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });
        let part = |offset: f64, extent: f64| if extent == 0.0 { 0.0 } else { offset / extent };
        Self::Stroke {
            tip,
            frame,
            rotation: 0.0,
            points: kept
                .iter()
                .map(|point| Point {
                    x: part(point.x - frame.x, frame.width),
                    y: part(point.y - frame.y, frame.height),
                })
                .collect(),
            target: None,
            colour: Default::default(),
            weight: Default::default(),
            opacity: Default::default(),
        }
        .canonical()
    }
}

/// The ends of `points`, and each point further than `tolerance` from the line between those
/// kept around it (Ramer–Douglas–Peucker).
fn simplified(points: &[Point], tolerance: f64) -> Vec<Point> {
    let Some(last) = points.len().checked_sub(1) else {
        return Vec::new();
    };
    let mut kept = vec![false; points.len()];
    kept[0] = true;
    kept[last] = true;
    let mut pending = vec![(0, last)];
    while let Some((first, last)) = pending.pop() {
        let (far, off) = (first + 1..last)
            .map(|at| (at, distance(points[at], points[first], points[last])))
            .fold(
                (first, 0.0),
                |most, each| if each.1 > most.1 { each } else { most },
            );
        if off > tolerance {
            kept[far] = true;
            pending.extend([(first, far), (far, last)]);
        }
    }
    points
        .iter()
        .zip(kept)
        .filter_map(|(point, kept)| kept.then_some(*point))
        .collect()
}

/// A curve along `points`, which rounds each corner between the middles of its sides but those
/// it turns sharply at, so that it stays within what they surround, in pieces that turn little
/// enough to look round, though no more of them than its sides are long in `width`s, as more
/// would only thicken it. Where its ends meet, it rounds that corner too.
pub(crate) fn smoothed(points: &[Point], width: f64) -> Vec<Point> {
    let (Some(first), Some(last)) = (points.first(), points.last()) else {
        return Vec::new();
    };
    let middle = |a: Point, b: Point| Point {
        x: (a.x + b.x) / 2.0,
        y: (a.y + b.y) / 2.0,
    };
    let ring = (points.len() > 3 && first == last).then(|| &points[..points.len() - 1]);
    let (corners, ends): (Vec<[Point; 3]>, _) = match ring {
        Some(ring) => {
            let around = |at: usize| ring[at % ring.len()];
            let seam = middle(around(ring.len() - 1), around(0));
            (
                (0..ring.len())
                    .map(|at| [around(at + ring.len() - 1), around(at), around(at + 1)])
                    .collect(),
                (seam, seam),
            )
        }
        None => (
            points
                .windows(3)
                .map(|corner| [corner[0], corner[1], corner[2]])
                .collect(),
            (*first, *last),
        ),
    };
    let mut curve = vec![ends.0];
    let mut add = |point: Point| {
        // Where one corner's curve ends, the next one's begins.
        if curve.last() != Some(&point) {
            curve.push(point);
        }
    };
    for [before, at, after] in corners {
        let turning = turn(before, at, after);
        if turning > CORNER {
            add(at);
            continue;
        }
        let (from, to) = (middle(before, at), middle(at, after));
        let most = ((apart(from, at) + apart(at, to)) / width).floor();
        let pieces = (turning / PIECE).ceil();
        // In one piece where it overflows, which `clamp` would panic on.
        let pieces = if most.is_finite() && pieces.is_finite() {
            pieces.clamp(1.0, most.clamp(1.0, MOST_PIECES))
        } else {
            1.0
        };
        for piece in 0..=pieces as usize {
            let along = piece as f64 / pieces;
            let (leaving, staying, arriving) = (
                (1.0 - along) * (1.0 - along),
                2.0 * (1.0 - along) * along,
                along * along,
            );
            add(Point {
                x: leaving * from.x + staying * at.x + arriving * to.x,
                y: leaving * from.y + staying * at.y + arriving * to.y,
            });
        }
    }
    add(ends.1);
    curve
}

/// How far the way from `before` through `at` to `after` turns at `at`, in degrees, none where
/// two of them meet.
fn turn(before: Point, at: Point, after: Point) -> f64 {
    let (into, out) = (
        (at.x - before.x, at.y - before.y),
        (after.x - at.x, after.y - at.y),
    );
    let cross = into.0 * out.1 - into.1 * out.0;
    let dot = into.0 * out.0 + into.1 * out.1;
    if cross == 0.0 && dot == 0.0 {
        0.0
    } else {
        cross.atan2(dot).abs().to_degrees()
    }
}

/// Where a pen stroke's points lie on the board.
pub(crate) fn stroke_points(frame: &Rect, rotation: f64, points: &[Point]) -> Vec<Point> {
    upright(frame, points)
        .into_iter()
        .map(|point| point.turned(frame.centre(), rotation))
        .collect()
}

/// A pen stroke's points on the board before its frame turns.
fn upright(frame: &Rect, points: &[Point]) -> Vec<Point> {
    points
        .iter()
        .map(|part| Point {
            x: frame.x + part.x * frame.width,
            y: frame.y + part.y * frame.height,
        })
        .collect()
}

/// Each segment of the line through `line`, or its one point, as a dot draws.
fn pieces(line: &[Point]) -> impl Iterator<Item = &[Point]> {
    let dot = (line.len() == 1).then_some(line);
    dot.into_iter().chain(line.windows(2))
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
        ElementKind::Shape { .. } if let Some(outline) = polygon_of(kind) => {
            near_edges(&outline, point, reach) || covers(kind, point)
        }
        ElementKind::Shape {
            frame, rotation, ..
        } => near_edges(&corners(frame, *rotation), point, reach) || covers(kind, point),
        ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
            distance(point, *from, *to) <= reach
        }
        ElementKind::Stroke { .. } => hits_any(kind, &[point], tolerance),
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

/// Whether [`hits`] finds `kind` at any of `points`, the curve of a stroke drawn once for them
/// all, and each tried against its frame first, which holds its many points.
fn hits_any(kind: &ElementKind, points: &[Point], tolerance: f64) -> bool {
    let ElementKind::Stroke {
        frame,
        rotation,
        points: drawn,
        ..
    } = kind
    else {
        return points.iter().any(|point| hits(kind, *point, tolerance));
    };
    let width = kind.stroke_width();
    let reach = tolerance + width / 2.0;
    let outline = corners(frame, *rotation);
    let mut curve = None;
    points.iter().any(|point| {
        near(&outline, *point, reach) && {
            let curve = curve.get_or_insert_with(|| smoothed(&upright(frame, drawn), width));
            let point = point.turned(frame.centre(), -rotation);
            pieces(curve).any(|piece| distance(point, piece[0], piece[piece.len() - 1]) <= reach)
        }
    })
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
        ElementKind::Shape { .. } if let Some(outline) = polygon_of(kind) => {
            encloses(&outline, point)
        }
        ElementKind::Stroke { .. } => false,
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
        ElementKind::Shape { .. } if let Some(outline) = polygon_of(kind) => {
            nearest_on_segments(point, edges(&outline))
        }
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

pub(crate) fn filled(shape: Shape, fill: Fill, text: &Text) -> bool {
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
        // By its edges, as a star's dents keep it from being convex. An area that meets none lies
        // wholly within it or wholly out of it.
        ElementKind::Shape {
            shape, fill, text, ..
        } if let Some(outline) = polygon_of(kind) => {
            edges(&outline).any(|(a, b)| overlap(&[a, b], area))
                || (filled(*shape, *fill, text) && encloses(&outline, area[0]))
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
        // As `hits` reaches it.
        ElementKind::Stroke {
            frame,
            rotation,
            points,
            ..
        } => {
            let reach = kind.stroke_width() / 2.0;
            let grown = Rect {
                x: frame.x - reach,
                y: frame.y - reach,
                width: frame.width + 2.0 * reach,
                height: frame.height + 2.0 * reach,
            };
            overlap(&corners(&grown, *rotation), area) && {
                let area = area.map(|corner| corner.turned(frame.centre(), -rotation));
                pieces(&smoothed(&upright(frame, points), kind.stroke_width()))
                    .any(|piece| within(piece, &area, reach))
            }
        }
        ElementKind::Comment { at, .. } => {
            around(area).is_some_and(|upright| upright.contains(*at))
        }
        _ => shape(kind).is_some_and(|shape| overlap(&shape, area)),
    }
}

/// Whether what `target` covers holds the whole of what `kind` draws: its frame, the curve of an
/// ellipse, the corners of a polygon, the line of a stroke, or the pin of a comment.
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
                    // Close enough, as no cheap test tells whether an ellipse, or a star with its
                    // dents, holds an ellipse.
                    ElementKind::Shape {
                        shape: Shape::Ellipse | Shape::Star,
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
                    _ => polygon_of(target)
                        .or_else(|| shape(target))
                        .is_some_and(|polygon| ellipse_within(frame, *rotation, &polygon)),
                }
        }
        ElementKind::Shape { .. } if let Some(outline) = polygon_of(kind) => {
            outline.iter().all(|point| covers(target, *point))
                && clear_of_dents(target, edges(&outline))
        }
        ElementKind::Note {
            frame, rotation, ..
        }
        | ElementKind::Sticky {
            frame, rotation, ..
        }
        | ElementKind::Shape {
            frame, rotation, ..
        } => {
            let outline = corners(frame, *rotation);
            outline.iter().all(|point| covers(target, *point))
                && clear_of_dents(target, edges(&outline))
        }
        // By its points, as its frame may jut out of a target turned otherwise, and the curve it
        // draws stays within what they surround.
        ElementKind::Stroke {
            frame,
            rotation,
            points,
            ..
        } => {
            let line = stroke_points(frame, *rotation, points);
            line.iter().all(|point| covers(target, *point))
                && clear_of_dents(target, line.windows(2).map(|piece| (piece[0], piece[1])))
        }
        ElementKind::Comment { at, .. } => covers(target, *at),
        _ => false,
    }
}

/// Whether none of `segments` meets the outline of `target` when it is a star, whose dents may
/// reach in between points it covers.
fn clear_of_dents(
    target: &ElementKind,
    mut segments: impl Iterator<Item = (Point, Point)>,
) -> bool {
    let ElementKind::Shape {
        shape: Shape::Star, ..
    } = target
    else {
        return true;
    };
    let Some(star) = polygon_of(target) else {
        return true;
    };
    segments.all(|(a, b)| !edges(&star).any(|(c, d)| overlap(&[a, b], &[c, d])))
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

/// Whether the segment through `piece`, or its one point, comes within `reach` of `area`.
fn within(piece: &[Point], area: &[Point; 4], reach: f64) -> bool {
    let (a, b) = (piece[0], piece[piece.len() - 1]);
    // Apart, two segments are nearest at an end of one of them.
    overlap(piece, area)
        || edges(area).any(|(c, d)| {
            [
                distance(a, c, d),
                distance(b, c, d),
                distance(c, a, b),
                distance(d, a, b),
            ]
            .into_iter()
            .any(|apart| apart <= reach)
        })
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

/// Whether `point` is within `polygon`, convex or not.
fn encloses(polygon: &[Point], point: Point) -> bool {
    edges(polygon)
        .filter(|(a, b)| {
            (a.y > point.y) != (b.y > point.y)
                && point.x < a.x + (point.y - a.y) / (b.y - a.y) * (b.x - a.x)
        })
        .count()
        % 2
        == 1
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
    use crate::tests::{board, element, id, locked, stroke};
    use crate::{
        AssetId, Colour, Corners, Dash, Fill, Heads, ImageEdits, Paper, Size, Text, Weight,
    };

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

    fn pen(frame: Rect, rotation: f64, points: &[(f64, f64)]) -> ElementKind {
        let ElementKind::Stroke {
            colour,
            weight,
            opacity,
            ..
        } = stroke()
        else {
            unreachable!()
        };
        ElementKind::Stroke {
            tip: Tip::Pen,
            frame,
            rotation,
            points: points.iter().map(|&(x, y)| point(x, y)).collect(),
            target: None,
            colour,
            weight,
            opacity,
        }
    }

    const U: [(f64, f64); 4] = [(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0)];

    #[test]
    fn a_pen_stroke_is_framed_by_its_points_without_those_that_stray_too_little() {
        let through = |points: &[(f64, f64)], tolerance| {
            let points: Vec<Point> = points.iter().map(|&(x, y)| point(x, y)).collect();
            ElementKind::stroke(Tip::Pen, &points, tolerance)
        };
        assert_eq!(
            through(
                &[(10.0, 20.0), (60.0, 20.5), (110.0, 20.0), (110.0, 70.0)],
                1.0
            ),
            pen(
                area(10.0, 20.0, 100.0, 50.0),
                0.0,
                &[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]
            )
        );
        assert_eq!(
            through(&[(10.0, 20.0), (60.0, 20.5), (110.0, 20.0)], 0.1),
            pen(
                area(10.0, 20.0, 100.0, 0.5),
                0.0,
                &[(0.0, 0.0), (0.5, 1.0), (1.0, 0.0)]
            )
        );
        assert_eq!(
            through(&[(5.0, 5.0)], 1.0),
            pen(area(5.0, 5.0, 0.0, 0.0), 0.0, &[(0.0, 0.0)])
        );
        assert!(!through(&[], 1.0).is_valid());
    }

    #[test]
    fn a_pen_stroke_is_hit_along_its_line_but_neither_in_its_hollow_nor_across_its_opening() {
        let u = pen(area(0.0, 0.0, 100.0, 100.0), 0.0, &U);
        // Medium, so a unit either side.
        assert!(hits(&u, point(0.0, 50.0), 0.0));
        assert!(hits(&u, point(50.0, 101.0), 0.0));
        assert!(!hits(&u, point(50.0, 102.0), 0.0));
        assert!(!hits(&u, point(50.0, 50.0), 0.0));
        assert!(!hits(&u, point(50.0, 0.0), 3.0));
        assert!(!covers(&u, point(50.0, 50.0)));
    }

    #[test]
    fn a_pen_stroke_is_hit_where_it_draws_once_turned() {
        // The diagonal of a 100 by 20 frame, turned a quarter, runs from (60, -40) to (40, 60).
        let turned = pen(area(0.0, 0.0, 100.0, 20.0), 90.0, &[(0.0, 0.0), (1.0, 1.0)]);
        for drawn in [point(60.0, -40.0), point(50.0, 10.0), point(40.0, 60.0)] {
            assert!(hits(&turned, drawn, 0.0), "{drawn:?}");
        }
        for upright in [point(0.0, 0.0), point(100.0, 20.0)] {
            assert!(!hits(&turned, upright, 0.0), "{upright:?}");
        }
    }

    #[test]
    fn a_flat_pen_stroke_and_a_dot_are_hit_within_their_width() {
        let flat = pen(area(0.0, 50.0, 100.0, 0.0), 0.0, &[(0.0, 0.0), (1.0, 0.0)]);
        assert!(hits(&flat, point(50.0, 50.5), 0.0));
        assert!(!hits(&flat, point(50.0, 52.0), 0.0));
        let dot = pen(area(10.0, 10.0, 0.0, 0.0), 0.0, &[(0.0, 0.0)]);
        assert!(hits(&dot, point(10.9, 10.0), 0.0));
        assert!(!hits(&dot, point(12.0, 10.0), 0.0));
        assert!(touches(&dot, &corners(&area(5.0, 5.0, 10.0, 10.0), 0.0)));
    }

    #[test]
    fn an_area_touches_a_pen_stroke_by_its_line_only() {
        let board = board([(
            1,
            element(None, "a0", pen(area(0.0, 0.0, 100.0, 100.0), 0.0, &U)),
        )]);
        assert!(board.touching(area(40.0, 40.0, 20.0, 20.0)).is_empty());
        assert_eq!(board.touching(area(40.0, 90.0, 20.0, 20.0)), [id(1)]);
        // An eraser's way through its hollow, then across its bottom.
        assert!(
            board
                .hit_along(point(30.0, 30.0), point(70.0, 30.0), 2.0)
                .is_empty()
        );
        assert_eq!(
            board.hit_along(point(50.0, 80.0), point(50.0, 120.0), 2.0),
            [id(1)]
        );
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
            (2, element(None, "a1", ElementKind::group())),
            (3, element(Some(2), "a0", image(5.0, 0.0, 10.0, 10.0, 0.0))),
            (4, element(None, "a2", image(20.0, 0.0, 10.0, 10.0, 0.0))),
        ]);
        assert_eq!(board.hit(point(7.0, 5.0), 0.0), Some(id(3)));
        assert_eq!(board.hit(point(2.0, 5.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(17.0, 5.0), 0.0), None);
    }

    #[test]
    fn a_filled_group_draws_over_its_panel_which_bounds_it() {
        let filled = |fill| ElementKind::Group {
            colour: Colour::Blue,
            fill,
            title: None,
        };
        let board = board([
            (1, element(None, "a0", filled(Fill::Tint))),
            (
                2,
                element(Some(1), "a0", image(0.0, 0.0, 100.0, 100.0, 0.0)),
            ),
            (
                3,
                element(Some(1), "a1", image(300.0, 100.0, 100.0, 100.0, 0.0)),
            ),
            (4, element(None, "a1", filled(Fill::Hollow))),
            (
                5,
                element(Some(4), "a0", image(0.0, 500.0, 100.0, 100.0, 0.0)),
            ),
            (
                6,
                element(Some(4), "a1", image(300.0, 500.0, 100.0, 100.0, 0.0)),
            ),
        ]);
        // A twentieth of the mean side of (0, 0) to (400, 200) around it.
        let panel = area(-15.0, -15.0, 430.0, 230.0);

        assert_eq!(board.hit(point(200.0, 50.0), 0.0), Some(id(1)));
        assert_eq!(board.hit_unlocked(point(-10.0, 210.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(50.0, 50.0), 0.0), Some(id(2)));
        assert_eq!(board.hit(point(-20.0, 50.0), 0.0), None);
        assert_eq!(board.hit(point(-20.0, 50.0), 5.0), Some(id(1)));
        assert_eq!(board.hit(point(200.0, 550.0), 0.0), None);
        assert_eq!(board.touching(area(190.0, 40.0, 10.0, 10.0)), [id(1)]);
        assert_eq!(
            board.hit_along(point(150.0, 50.0), point(250.0, 50.0), 1.0),
            []
        );
        assert_eq!(board.bounds(&[id(1)]), Some(panel));
        assert_eq!(board.bounds(&[id(2)]), Some(area(0.0, 0.0, 100.0, 100.0)));
        assert_eq!(board.outline(id(1)), Some(corners(&panel, 0.0).to_vec()));
        assert_eq!(board.bounds(&[id(4)]), Some(area(0.0, 500.0, 400.0, 100.0)));
    }

    #[test]
    fn a_group_s_panel_stands_clear_of_the_panels_within_it() {
        let filled = || ElementKind::Group {
            colour: Colour::Blue,
            fill: Fill::Solid,
            title: None,
        };
        let board = board([
            (1, element(None, "a0", filled())),
            (2, element(Some(1), "a0", filled())),
            (
                3,
                element(Some(2), "a0", image(0.0, 0.0, 100.0, 100.0, 0.0)),
            ),
            (
                4,
                element(Some(2), "a1", image(300.0, 100.0, 100.0, 100.0, 0.0)),
            ),
            (
                5,
                element(Some(1), "a1", image(500.0, 100.0, 100.0, 100.0, 0.0)),
            ),
        ]);
        let inner = board.bounds(&[id(2)]).unwrap();
        let outer = board.bounds(&[id(1)]).unwrap();
        assert!(outer.x < inner.x && outer.y < inner.y);
        assert!(outer.y + outer.height > inner.y + inner.height);
        assert!(outer.x + outer.width > 600.0);
        assert_eq!(board.hit(point(200.0, 50.0), 0.0), Some(id(2)));
        assert_eq!(board.hit(point(450.0, 50.0), 0.0), Some(id(1)));
    }

    #[test]
    fn a_click_goes_through_what_is_locked_or_within_a_locked_group() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 10.0, 10.0, 0.0))),
            (2, locked(None, "a1", image(0.0, 0.0, 10.0, 10.0, 0.0))),
            (3, locked(None, "a2", ElementKind::group())),
            (4, element(Some(3), "a0", image(20.0, 0.0, 10.0, 10.0, 0.0))),
        ]);
        assert_eq!(board.hit(point(5.0, 5.0), 0.0), Some(id(2)));
        assert_eq!(board.hit_unlocked(point(5.0, 5.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(25.0, 5.0), 0.0), Some(id(4)));
        assert_eq!(board.hit_unlocked(point(25.0, 5.0), 0.0), None);
        assert_eq!(
            board.hit_along(point(5.0, 5.0), point(25.0, 5.0), 1.0),
            [id(1)]
        );
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

    fn counted(shape: Shape, frame: Rect, corners: u8, fill: Fill) -> ElementKind {
        let mut kind = framed(shape, frame, 0.0);
        if let ElementKind::Shape {
            corners: drawn,
            fill: filled,
            ..
        } = &mut kind
        {
            *drawn = Corners::new(corners).unwrap();
            *filled = fill;
        }
        kind
    }

    #[test]
    fn a_polygon_or_a_star_touches_every_side_of_its_frame() {
        let frame = area(10.0, 20.0, 300.0, 40.0);
        for count in Corners::FEWEST.count()..=Corners::MOST.count() {
            for star in [false, true] {
                let bounds = around(&polygon(&frame, 0.0, count, star)).unwrap();
                let off = [
                    bounds.x - frame.x,
                    bounds.y - frame.y,
                    bounds.width - frame.width,
                    bounds.height - frame.height,
                ];
                assert!(off.iter().all(|off| off.abs() < 1e-9), "{count} {star}");
                // One corner pointing up, at the middle of the top side.
                let top = polygon(&frame, 0.0, count, star)[0];
                assert!((top.x - 160.0).abs() < 1e-9 && (top.y - 20.0).abs() < 1e-9);
            }
        }
        // Turned over by a negative size, it draws the same.
        let over = area(310.0, 60.0, -300.0, -40.0);
        assert_eq!(
            polygon(&over, 0.0, 3, false),
            polygon(&frame, 0.0, 3, false)
        );
    }

    #[test]
    fn a_shape_s_text_lies_within_its_outline() {
        let part = |shape| {
            let area = framed(shape, area(0.0, 0.0, 1.0, 1.0), 0.0)
                .text_area()
                .unwrap();
            [area.x, area.y, area.width, area.height]
        };
        let near = |parts: [f64; 4], expected: [f64; 4]| {
            parts
                .iter()
                .zip(expected)
                .all(|(part, expected)| (part - expected).abs() < 1e-9)
        };
        assert_eq!(part(Shape::Rectangle), [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(part(Shape::Cross), [0.0, 0.0, 1.0, 1.0]);
        let corner = (1.0 - FRAC_1_SQRT_2) / 2.0;
        assert!(near(
            part(Shape::Ellipse),
            [corner, corner, FRAC_1_SQRT_2, FRAC_1_SQRT_2]
        ));
        assert!(near(part(Shape::Diamond), [0.25, 0.25, 0.5, 0.5]));
        // Low in a triangle, around the centre of its circle, a third of the way up.
        let [x, y, width, height] = part(Shape::Triangle);
        assert!(near(
            [x + width / 2.0, y + height / 2.0, 0.0, 0.0],
            [0.5, 2.0 / 3.0, 0.0, 0.0]
        ));
        let frame = area(10.0, 20.0, 300.0, 80.0);
        for count in Corners::FEWEST.count()..=Corners::MOST.count() {
            for shape in [Shape::Star, Shape::Polygon] {
                let kind = counted(shape, frame, count, Fill::Solid);
                let part = kind.text_area().unwrap();
                assert!((part.x + part.width / 2.0 - 0.5).abs() < 1e-9);
                // A hair within, as a four-pointed star's inner corners touch its corners.
                let text = Rect {
                    x: frame.x + (part.x + 1e-6) * frame.width,
                    y: frame.y + (part.y + 1e-6) * frame.height,
                    width: (part.width - 2e-6) * frame.width,
                    height: (part.height - 2e-6) * frame.height,
                };
                assert!(
                    corners(&text, 0.0)
                        .iter()
                        .all(|corner| covers(&kind, *corner)),
                    "{shape:?} {count}"
                );
            }
        }
        assert_eq!(arrow((0.0, 0.0), (1.0, 1.0)).text_area(), None);
    }

    #[test]
    fn a_triangle_a_diamond_or_a_polygon_is_hit_along_its_own_sides() {
        let board = board([
            (
                1,
                element(
                    None,
                    "a0",
                    framed(Shape::Triangle, area(0.0, 0.0, 100.0, 100.0), 0.0),
                ),
            ),
            (
                2,
                element(
                    None,
                    "a1",
                    framed(Shape::Diamond, area(200.0, 0.0, 100.0, 100.0), 0.0),
                ),
            ),
            // A hexagon, its corners at (650, 0), (700, 25), (700, 75), (650, 100), (600, 75), and
            // (600, 25).
            (
                3,
                element(
                    None,
                    "a2",
                    counted(
                        Shape::Polygon,
                        area(600.0, 0.0, 100.0, 100.0),
                        6,
                        Fill::Hollow,
                    ),
                ),
            ),
            // Turned upside down, pointing down at (50, 300).
            (
                4,
                element(
                    None,
                    "a3",
                    framed(Shape::Triangle, area(0.0, 200.0, 100.0, 100.0), 180.0),
                ),
            ),
        ]);
        // Along the triangle's right side, and in its frame's corners, out of it.
        assert_eq!(board.hit(point(75.0, 50.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(50.0, 99.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(5.0, 5.0), 3.0), None);
        assert_eq!(board.hit(point(50.0, 60.0), 3.0), None);
        assert_eq!(board.hit(point(225.0, 25.0), 3.0), Some(id(2)));
        assert_eq!(board.hit(point(205.0, 5.0), 3.0), None);
        assert_eq!(board.hit(point(700.0, 50.0), 3.0), Some(id(3)));
        assert_eq!(board.hit(point(602.0, 2.0), 3.0), None);
        assert_eq!(board.hit(point(50.0, 201.0), 3.0), Some(id(4)));
        assert_eq!(board.hit(point(50.0, 298.0), 3.0), Some(id(4)));
        assert_eq!(board.hit(point(5.0, 295.0), 3.0), None);
        // Over a frame's corner, out of what it surrounds.
        assert!(board.touching(area(0.0, 0.0, 10.0, 10.0)).is_empty());
        assert!(board.touching(area(200.0, 0.0, 10.0, 10.0)).is_empty());
        assert_eq!(board.touching(area(40.0, 40.0, 50.0, 10.0)), [id(1)]);
        // Within a hollow one, which only draws its outline.
        assert!(board.touching(area(240.0, 40.0, 20.0, 20.0)).is_empty());
    }

    #[test]
    fn a_star_covers_and_touches_none_of_its_dents() {
        // Five points, the two at the bottom at (419.1, 100) and (480.9, 100), the dent between
        // them at (450, 76.4).
        let star = |fill| counted(Shape::Star, area(400.0, 0.0, 100.0, 100.0), 5, fill);
        let filled = board([(1, element(None, "a0", star(Fill::Solid)))]);
        assert_eq!(filled.covering(point(450.0, 50.0)), [id(1)]);
        assert!(filled.covering(point(450.0, 90.0)).is_empty());
        assert_eq!(filled.hit(point(450.0, 90.0), 3.0), None);
        assert!(filled.touching(area(445.0, 85.0, 10.0, 10.0)).is_empty());
        assert_eq!(filled.touching(area(440.0, 40.0, 20.0, 20.0)), [id(1)]);
        let hollow = board([(1, element(None, "a0", star(Fill::Hollow)))]);
        assert_eq!(hollow.hit(point(450.0, 50.0), 3.0), None);
        assert_eq!(hollow.hit(point(450.0, 77.0), 3.0), Some(id(1)));
        assert!(hollow.touching(area(440.0, 40.0, 20.0, 20.0)).is_empty());
        assert_eq!(hollow.touching(area(445.0, 70.0, 10.0, 10.0)), [id(1)]);
    }

    #[test]
    fn what_lies_whole_on_a_triangle_lies_within_its_sides() {
        let triangle = counted(Shape::Triangle, area(0.0, 0.0, 100.0, 100.0), 5, Fill::Tint);
        let note = |x, y| ElementKind::Note {
            frame: area(x, y, 10.0, 10.0),
            rotation: 0.0,
            text: Text::new("A".to_owned(), 20.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        assert!(holds(&triangle, &note(45.0, 50.0)));
        // Within its frame, in a corner the triangle leaves out.
        assert!(!holds(&triangle, &note(2.0, 2.0)));
        // A triangle whose frame juts out of a diamond, though its corners do not.
        let diamond = counted(Shape::Diamond, area(0.0, 0.0, 100.0, 100.0), 5, Fill::Tint);
        let inner = framed(Shape::Triangle, area(30.0, 10.0, 40.0, 40.0), 0.0);
        assert!(holds(&diamond, &inner));
        assert!(!holds(
            &diamond,
            &framed(Shape::Rectangle, area(30.0, 10.0, 40.0, 40.0), 0.0)
        ));
        // An ellipse around a point of the triangle, within its frame but over its side.
        let round = framed(Shape::Ellipse, area(15.0, 50.0, 30.0, 30.0), 0.0);
        assert!(!holds(&triangle, &round));
        assert!(holds(
            &triangle,
            &framed(Shape::Ellipse, area(40.0, 60.0, 20.0, 20.0), 0.0)
        ));
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
            (4, element(None, "a3", ElementKind::group())),
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
            (1, element(None, "a0", ElementKind::group())),
            (2, element(Some(1), "a0", ElementKind::group())),
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
            (1, element(None, "a0", ElementKind::group())),
            (2, element(Some(1), "a0", ElementKind::group())),
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
            (1, element(Some(2), "a0", ElementKind::group())),
            (2, element(Some(1), "a0", ElementKind::group())),
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
            (1, element(None, "a0", ElementKind::group())),
            (2, element(Some(1), "a0", image(0.0, 0.0, 20.0, 20.0, 0.0))),
            (3, element(Some(1), "a1", ElementKind::group())),
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
    fn a_selection_rectangle_goes_through_what_is_locked() {
        let board = board([
            (1, element(None, "a0", ElementKind::group())),
            (2, locked(Some(1), "a0", image(0.0, 0.0, 20.0, 20.0, 0.0))),
            (3, element(Some(1), "a1", image(50.0, 0.0, 20.0, 20.0, 0.0))),
            (4, locked(None, "a1", comment(10.0, 10.0))),
        ]);
        let around_the_locked = area(5.0, 5.0, 10.0, 10.0);
        assert_eq!(board.touching(around_the_locked), [id(2), id(4)]);
        assert!(board.touching_top_level(around_the_locked).is_empty());
        assert_eq!(
            board.touching_top_level(area(0.0, 0.0, 60.0, 10.0)),
            [id(1)]
        );
    }

    #[test]
    fn the_extent_of_elements_holds_what_they_draw_and_where_their_comments_are_pinned() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 20.0, 10.0, 0.0))),
            (2, element(None, "a1", comment(50.0, -5.0))),
            (3, element(None, "a2", ElementKind::group())),
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
            (1, element(None, "a0", ElementKind::group())),
            (2, element(Some(1), "a0", image(0.0, 0.0, 10.0, 10.0, 0.0))),
            (3, element(Some(1), "a1", ElementKind::group())),
            (4, element(Some(3), "a0", arrow((30.0, -5.0), (20.0, 5.0)))),
            (5, element(None, "a1", ElementKind::group())),
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

    #[test]
    fn a_pen_stroke_outlines_its_frame_and_not_its_line() {
        let board = board([(
            1,
            element(None, "a0", pen(area(0.0, 0.0, 100.0, 100.0), 0.0, &U)),
        )]);
        let corners = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)];
        assert_eq!(
            board.outline(id(1)),
            Some(corners.map(|(x, y)| point(x, y)).to_vec())
        );
        assert_eq!(board.bounds(&[id(1)]), Some(area(0.0, 0.0, 100.0, 100.0)));
    }

    #[test]
    fn a_stroke_draws_round_along_its_points_within_them_where_its_ends_meet_too() {
        let mut around: Vec<Point> = (0..24)
            .map(|step| {
                let angle = f64::from(step) * 15f64.to_radians();
                point(100.0 * angle.cos(), 100.0 * angle.sin())
            })
            .collect();
        around.push(around[0]);
        let curve = smoothed(&around, 2.0);
        assert_eq!(curve.first(), curve.last());
        let mut closed = curve.clone();
        closed.push(curve[1]);
        for piece in closed.windows(3) {
            assert!(turn(piece[0], piece[1], piece[2]) <= PIECE, "{piece:?}");
        }
        // Between the circle and the middles of its sides.
        let inner = 100.0 * 7.5f64.to_radians().cos();
        for drawn in &curve {
            let off = apart(*drawn, point(0.0, 0.0));
            assert!((inner - 1e-9..=100.0 + 1e-9).contains(&off), "{drawn:?}");
        }
    }

    #[test]
    fn a_stroke_drawn_unevenly_stays_within_its_points() {
        let uneven = [
            point(0.0, 0.0),
            point(2.0, 1.0),
            point(60.0, 10.0),
            point(61.0, 12.0),
            point(120.0, 20.0),
        ];
        for drawn in smoothed(&uneven, 2.0) {
            assert!(
                (0.0..=120.0).contains(&drawn.x) && (0.0..=20.0).contains(&drawn.y),
                "{drawn:?}"
            );
        }
    }

    #[test]
    fn a_stroke_keeps_its_corners_its_straight_lines_and_its_dots() {
        let square = [point(0.0, 0.0), point(100.0, 0.0), point(100.0, 100.0)];
        assert_eq!(smoothed(&square, 2.0), square);
        let straight = [point(0.0, 0.0), point(30.0, 40.0)];
        assert_eq!(smoothed(&straight, 2.0), straight);
        assert_eq!(smoothed(&[point(5.0, 5.0)], 2.0), [point(5.0, 5.0)]);
        // As float arithmetic may leave two of its points as one once its frame is flat.
        let flat = [point(0.0, 0.0), point(0.0, 0.0), point(10.0, 0.0)];
        assert!(
            smoothed(&flat, 2.0)
                .iter()
                .all(|drawn| drawn.y == 0.0 && (0.0..=10.0).contains(&drawn.x))
        );
    }

    #[test]
    fn a_closed_stroke_keeps_its_sharp_corners_where_its_ends_meet_too() {
        let middle = point(50.0, 0.0);
        let square = [
            point(100.0, 0.0),
            point(100.0, 100.0),
            point(0.0, 100.0),
            point(0.0, 0.0),
            point(100.0, 0.0),
        ];
        assert_eq!(
            smoothed(&square, 2.0),
            [middle, square[0], square[1], square[2], square[3], middle]
        );
        // Its tip where it began and ends.
        let drop = [
            point(0.0, 0.0),
            point(60.0, 20.0),
            point(80.0, 50.0),
            point(60.0, 80.0),
            point(30.0, 70.0),
            point(0.0, 0.0),
        ];
        let curve = smoothed(&drop, 2.0);
        let seam = point(15.0, 35.0);
        assert_eq!((curve.first(), curve.last()), (Some(&seam), Some(&seam)));
        assert_eq!(curve[1], drop[0]);
    }

    #[test]
    fn a_stroke_overflowing_the_board_is_drawn_and_missed_without_panicking() {
        let far = pen(
            area(1e308, 0.0, 1e308, 10.0),
            0.0,
            &[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)],
        );
        let board = board([(1, element(None, "a0", far))]);
        assert_eq!(board.drawn(id(1), &BTreeSet::new()).len(), 1);
        // On the one edge of its frame that does not overflow, so that its curve is drawn.
        assert_eq!(board.hit(point(1e308, 5.0), 1.0), None);
    }

    #[test]
    fn a_small_curl_takes_no_more_pieces_than_its_sides_are_long_in_widths() {
        let curl = [point(0.0, 0.0), point(4.0, 1.0), point(5.0, 5.0)];
        // About 4.1 from the middle of one side to the corner, then the other's, its ends straight.
        let rounded = |width| smoothed(&curl, width).len() - 3;
        assert_eq!(rounded(2.0), 2);
        assert!(rounded(0.1) > 2);
    }

    #[test]
    fn a_stroke_is_hit_where_its_curve_draws_and_not_on_the_corner_it_rounds() {
        let bent = ElementKind::stroke(
            Tip::Pen,
            &[point(0.0, 0.0), point(100.0, 0.0), point(150.0, 86.6)],
            0.0,
        );
        let board = board([(1, element(None, "a0", bent))]);
        // Rounded from (50, 0) to (125, 43.3), through about (93.75, 10.8) at its middle.
        assert_eq!(board.hit(point(100.0, 0.0), 1.0), None);
        assert_eq!(board.hit(point(93.75, 10.8), 1.0), Some(id(1)));
        assert_eq!(board.touching(area(92.0, 9.0, 4.0, 4.0)), [id(1)]);
        assert!(board.touching(area(98.0, -2.0, 4.0, 4.0)).is_empty());
    }

    #[test]
    fn an_eraser_reaches_a_highlighter_across_its_whole_width() {
        let mut thick = pen(area(0.0, 50.0, 100.0, 0.0), 0.0, &[(0.0, 0.0), (1.0, 0.0)]);
        if let ElementKind::Stroke { tip, weight, .. } = &mut thick {
            *tip = Tip::Highlighter;
            *weight = Weight::Thick;
        }
        let board = board([(1, element(None, "a0", thick))]);
        // 32 wide, so 16 either side of its line.
        assert_eq!(
            board.hit_along(point(50.0, 64.0), point(60.0, 64.0), 1.0),
            [id(1)]
        );
        assert!(
            board
                .hit_along(point(50.0, 70.0), point(60.0, 70.0), 1.0)
                .is_empty()
        );
        assert_eq!(board.hit(point(20.0, 35.0), 0.0), Some(id(1)));
    }

    #[test]
    fn an_eraser_reaches_a_thick_highlighter_wherever_a_press_does_at_the_edge_of_its_reach() {
        let frame = area(
            -0.009023655283600718,
            1.5694030589546863,
            0.41477325621366834,
            0.7719154333905969,
        );
        let mut thick = pen(frame, 0.0, &[(0.0, 0.0), (1.0, 0.0)]);
        if let ElementKind::Stroke { tip, weight, .. } = &mut thick {
            *tip = Tip::Highlighter;
            *weight = Weight::Thick;
        }
        let board = board([(1, element(None, "a0", thick))]);
        // Exactly at its reach, where rounding may tip it either side.
        let (edge, tolerance) = (
            point(20.10508710353183, 1.5694030589546863),
            3.69933750260176,
        );
        assert_eq!(board.hit(edge, tolerance), Some(id(1)));
        assert_eq!(board.hit_along(edge, edge, tolerance), [id(1)]);
    }

    #[test]
    fn an_area_touches_a_highlighter_across_its_whole_width() {
        let mut medium = pen(area(0.0, 50.0, 100.0, 0.0), 0.0, &[(0.0, 0.0), (1.0, 0.0)]);
        if let ElementKind::Stroke { tip, .. } = &mut medium {
            *tip = Tip::Highlighter;
        }
        let board = board([(1, element(None, "a0", medium))]);
        // 16 wide, so 8 either side of its line.
        assert_eq!(board.touching(area(40.0, 53.0, 20.0, 4.0)), [id(1)]);
        assert!(board.touching(area(40.0, 59.0, 20.0, 4.0)).is_empty());
    }

    #[test]
    fn a_star_holds_what_lies_within_it_but_nothing_that_spans_one_of_its_dents() {
        // The two bottom points at (19.1, 100) and (80.9, 100), the dent between them at
        // (50, 76.4). Each corner of the note across it lies in a point, its middle in the dent.
        let star = counted(Shape::Star, area(0.0, 0.0, 100.0, 100.0), 5, Fill::Solid);
        let note = |frame| ElementKind::Note {
            frame,
            rotation: 0.0,
            text: Text::new("A".to_owned(), 20.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        let (within, across) = (
            note(area(45.0, 45.0, 10.0, 10.0)),
            note(area(25.0, 88.0, 50.0, 4.0)),
        );
        assert!(holds(&star, &within), "a note in its middle");
        assert!(!covers(&star, point(50.0, 90.0)));
        assert!(!holds(&star, &across), "a note across the dent");
        assert!(
            !holds(
                &star,
                &framed(Shape::Rectangle, area(25.0, 88.0, 50.0, 4.0), 0.0)
            ),
            "a rectangle across the dent"
        );
        let line = pen(area(25.0, 90.0, 50.0, 0.0), 0.0, &[(0.0, 0.0), (1.0, 0.0)]);
        assert!(!holds(&star, &line), "a stroke across the dent");
        let board = board([
            (1, element(None, "a0", star)),
            (2, element(None, "a1", across)),
            (3, element(None, "a2", within)),
        ]);
        let mut landing = crate::stick::Landing::new(&board);
        assert_eq!(landing.land(id(2)), None);
        assert_eq!(landing.land(id(3)), Some(id(1)));
    }

    #[test]
    fn a_flat_polygon_or_star_is_hit_and_touched_along_its_line() {
        let mut turned = counted(Shape::Star, area(600.0, 0.0, 100.0, 0.0), 5, Fill::Solid);
        if let ElementKind::Shape { rotation, .. } = &mut turned {
            // Upright, along x = 650 from y = -50 to 50.
            *rotation = 90.0;
        }
        let shapes = [
            counted(Shape::Triangle, area(0.0, 0.0, 100.0, 0.0), 5, Fill::Solid),
            counted(Shape::Star, area(200.0, 0.0, 0.0, 100.0), 7, Fill::Solid),
            counted(Shape::Polygon, area(400.0, 50.0, 0.0, 0.0), 6, Fill::Solid),
            turned,
        ];
        for kind in &shapes {
            let outline = polygon_of(kind).unwrap();
            assert!(outline.iter().all(|p| p.x.is_finite() && p.y.is_finite()));
        }
        let board = board(
            shapes
                .into_iter()
                .zip(["a0", "a1", "a2", "a3"])
                .enumerate()
                .map(|(at, (kind, key))| (at as u128 + 1, element(None, key, kind))),
        );
        assert_eq!(board.hit(point(50.0, 2.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(50.0, 10.0), 3.0), None);
        // On the line through it, beyond its ends.
        assert_eq!(board.hit(point(150.0, 0.0), 3.0), None);
        assert_eq!(board.hit(point(202.0, 50.0), 3.0), Some(id(2)));
        assert_eq!(board.hit(point(210.0, 50.0), 3.0), None);
        assert_eq!(board.hit(point(200.0, 150.0), 3.0), None);
        assert_eq!(board.hit(point(401.0, 50.0), 3.0), Some(id(3)));
        assert_eq!(board.hit(point(410.0, 50.0), 3.0), None);
        assert_eq!(board.hit(point(652.0, 0.0), 3.0), Some(id(4)));
        assert_eq!(board.hit(point(660.0, 0.0), 3.0), None);
        assert_eq!(board.hit(point(650.0, 80.0), 3.0), None);
        // Filled, it still covers nothing.
        assert!(board.covering(point(50.0, 0.0)).is_empty());
        assert!(board.covering(point(200.0, 50.0)).is_empty());
        assert!(board.covering(point(400.0, 50.0)).is_empty());
        assert_eq!(board.touching(area(40.0, -10.0, 20.0, 20.0)), [id(1)]);
        assert!(board.touching(area(40.0, 10.0, 20.0, 20.0)).is_empty());
        assert_eq!(board.touching(area(190.0, 40.0, 20.0, 20.0)), [id(2)]);
        assert!(board.touching(area(205.0, 40.0, 20.0, 20.0)).is_empty());
        assert_eq!(board.touching(area(395.0, 45.0, 10.0, 10.0)), [id(3)]);
        assert!(board.touching(area(405.0, 45.0, 10.0, 10.0)).is_empty());
        assert_eq!(board.touching(area(640.0, -10.0, 20.0, 20.0)), [id(4)]);
        assert!(board.touching(area(655.0, -10.0, 20.0, 20.0)).is_empty());
    }
}
