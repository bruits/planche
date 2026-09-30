//! Where elements draw, in board space: what a pointer or a selection rectangle meets, and
//! the outlines that show a selection.

use std::collections::BTreeSet;

use crate::{Board, ElementId, ElementKind, Point, Rect};

impl Board {
    /// The topmost element that draws at `point`, or within `tolerance` of it. A group draws
    /// nothing itself, so it is never the one hit.
    pub fn hit(&self, point: Point, tolerance: f64) -> Option<ElementId> {
        self.draw_order().into_iter().rev().find(|id| {
            shape(&self.elements[id].kind).is_some_and(|shape| near(&shape, point, tolerance))
        })
    }

    /// Every element that draws something within `area`, from back to front.
    pub fn touching(&self, area: Rect) -> Vec<ElementId> {
        let area = corners(&area, 0.0);
        self.draw_order()
            .into_iter()
            .filter(|id| shape(&self.elements[id].kind).is_some_and(|shape| overlap(&shape, &area)))
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
    /// top-left once rotated, an arrow's two ends, or the corners of the bounds of a group's
    /// elements, if they draw anything. `None` when there is no such element.
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
        | ElementKind::Shape {
            frame, rotation, ..
        } => Some(corners(frame, *rotation).to_vec()),
        ElementKind::Arrow { from, to } => Some(vec![*from, *to]),
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

fn near(shape: &[Point], point: Point, tolerance: f64) -> bool {
    inside(shape, point) || edges(shape).any(|(a, b)| distance(point, a, b) <= tolerance)
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
    use crate::{AssetId, ImageEdits, Size};

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

    #[test]
    fn an_arrow_is_hit_near_its_line() {
        let board = board([(1, element(None, "a0", arrow((0.0, 0.0), (100.0, 100.0))))]);
        assert_eq!(board.hit(point(52.0, 48.0), 3.0), Some(id(1)));
        assert_eq!(board.hit(point(60.0, 40.0), 3.0), None);
        assert_eq!(board.hit(point(102.0, 102.0), 3.0), Some(id(1)));
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
