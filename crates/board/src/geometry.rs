//! Where elements draw, in board space: what a pointer or a selection rectangle meets, and
//! the outlines that show a selection.

use std::collections::BTreeSet;

use crate::{Board, ElementId, ElementKind, Point, Rect, STROKE_WIDTH, Shape};

impl Board {
    /// The topmost element that draws at `point`, or within `tolerance` of it. A group draws
    /// nothing itself, so it is never the one hit, and a shape without text only draws its
    /// outline, so what it surrounds stays within reach.
    pub fn hit(&self, point: Point, tolerance: f64) -> Option<ElementId> {
        self.draw_order()
            .into_iter()
            .rev()
            .find(|id| hits(&self.elements[id].kind, point, tolerance))
    }

    /// Every element that draws something within `area`, from back to front.
    pub fn touching(&self, area: Rect) -> Vec<ElementId> {
        let area = corners(&area, 0.0);
        self.draw_order()
            .into_iter()
            .filter(|id| touches(&self.elements[id].kind, &area))
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
}

/// What an element draws over, as a convex polygon or a segment. `None` for a group.
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
        ElementKind::Arrow { from, to } | ElementKind::Line { from, to } => Some(vec![*from, *to]),
        ElementKind::Group => None,
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
fn corners(rect: &Rect, degrees: f64) -> [Point; 4] {
    let (left, top) = (rect.x, rect.y);
    let (right, bottom) = (left + rect.width, top + rect.height);
    [(left, top), (right, top), (right, bottom), (left, bottom)]
        .map(|(x, y)| Point { x, y }.turned(rect.centre(), degrees))
}

/// Strokes reach half their width beyond the line they follow, and a shape's text fills it.
fn hits(kind: &ElementKind, point: Point, tolerance: f64) -> bool {
    let reach = tolerance + STROKE_WIDTH / 2.0;
    match kind {
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Ellipse,
            text,
        } => {
            near_ellipse(frame, *rotation, point, reach)
                || (!text.is_blank() && within_ellipse(frame, *rotation, point))
        }
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Cross,
            text,
        } => {
            let outline = corners(frame, *rotation);
            diagonals(&outline).any(|(a, b)| distance(point, a, b) <= reach)
                || (!text.is_blank() && inside(&outline, point))
        }
        ElementKind::Shape {
            frame,
            rotation,
            text,
            ..
        } => {
            let outline = corners(frame, *rotation);
            near_edges(&outline, point, reach) || (!text.is_blank() && inside(&outline, point))
        }
        ElementKind::Arrow { from, to } | ElementKind::Line { from, to } => {
            distance(point, *from, *to) <= reach
        }
        _ => shape(kind).is_some_and(|shape| near(&shape, point, tolerance)),
    }
}

/// As [`hits`], a shape without text only draws its strokes, so an area between them touches
/// none of it.
fn touches(kind: &ElementKind, area: &[Point; 4]) -> bool {
    match kind {
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Ellipse,
            text,
        } if frame.width != 0.0 && frame.height != 0.0 => {
            ellipse_touches(frame, *rotation, area, !text.is_blank())
        }
        ElementKind::Shape {
            frame,
            rotation,
            shape: Shape::Cross,
            text,
        } => {
            let outline = corners(frame, *rotation);
            if text.is_blank() {
                diagonals(&outline).any(|(a, b)| overlap(&[a, b], area))
            } else {
                overlap(&outline, area)
            }
        }
        ElementKind::Shape {
            frame,
            rotation,
            text,
            ..
        } => {
            let outline = corners(frame, *rotation);
            overlap(&outline, area)
                && (!text.is_blank() || !area.iter().all(|corner| inside(&outline, *corner)))
        }
        _ => shape(kind).is_some_and(|shape| overlap(&shape, area)),
    }
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
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let length = dx * dx + dy * dy;
    let along = if length == 0.0 {
        0.0
    } else {
        (((point.x - a.x) * dx + (point.y - a.y) * dy) / length).clamp(0.0, 1.0)
    };
    (point.x - a.x - along * dx).hypot(point.y - a.y - along * dy)
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
    use crate::{AssetId, ImageEdits, Size, Text};

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
        }
    }

    fn arrow(from: (f64, f64), to: (f64, f64)) -> ElementKind {
        ElementKind::Arrow {
            from: point(from.0, from.1),
            to: point(to.0, to.1),
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

    fn framed(shape: Shape, frame: Rect, rotation: f64) -> ElementKind {
        labelled(shape, frame, rotation, "")
    }

    fn labelled(shape: Shape, frame: Rect, rotation: f64, content: &str) -> ElementKind {
        ElementKind::Shape {
            frame,
            rotation,
            shape,
            text: Text {
                content: content.to_owned(),
                font_size: 20.0,
            },
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
        let text = Text {
            content: String::new(),
            font_size: 20.0,
        };
        let sticky = ElementKind::Sticky {
            frame: area(0.0, 0.0, 100.0, 100.0),
            rotation: 45.0,
            text,
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
        let half = STROKE_WIDTH / 2.0;
        assert_eq!(board.hit(point(-half + 0.1, 50.0), 0.0), Some(id(1)));
        assert_eq!(board.hit(point(250.0, half - 0.1), 0.0), Some(id(2)));
        assert_eq!(board.hit(point(400.0 - half + 0.1, 50.0), 0.0), None);
    }

    #[test]
    fn an_arrow_or_a_line_is_hit_near_its_line() {
        let (from, to) = (point(0.0, 0.0), point(100.0, 100.0));
        for kind in [
            ElementKind::Arrow { from, to },
            ElementKind::Line { from, to },
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
