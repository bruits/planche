//! The ends of arrows and lines that stick to elements. Each end keeps to the same point of what
//! its element draws: a pixel of the picture for an image, and a point of the frame otherwise,
//! which it follows wherever the element goes.

use crate::geometry::{apart, covers, hits, nearest_on_outline};
use crate::{Board, ElementId, ElementKind, Point, Rect, STROKE_WIDTH};

impl Board {
    /// Where an arrow's or a line's end let go at `point` sticks: to the topmost element it can
    /// stick to that draws there, or within `tolerance` of it, and onto its outline when within
    /// `tolerance` of it too, or when what the element fills leaves `point` out. `None` when
    /// there is no such element.
    pub fn stick(&self, point: Point, tolerance: f64) -> Option<(ElementId, Point)> {
        let id = self.draw_order().into_iter().rev().find(|id| {
            let kind = &self.elements[id].kind;
            kind.is_target() && hits(kind, point, tolerance)
        })?;
        let kind = &self.elements[&id].kind;
        let reach = tolerance + STROKE_WIDTH / 2.0;
        let outline = nearest_on_outline(kind, point)
            .filter(|on| apart(*on, point) <= reach || !covers(kind, point));
        Some((id, outline.unwrap_or(point)))
    }
}

/// Within half a stroke, as float arithmetic leaves an end a hair off the outline it snapped
/// onto.
pub(crate) fn lands_on(target: &ElementKind, point: Point) -> bool {
    hits(target, point, STROKE_WIDTH / 2.0)
}

pub(crate) fn moves_ends(before: &ElementKind, after: &ElementKind) -> bool {
    Surface::of(before) != Surface::of(after)
}

/// `None` when float arithmetic overflows.
pub(crate) fn followed(before: &ElementKind, after: &ElementKind, point: Point) -> Option<Point> {
    Surface::of(after)?.to_board(Surface::of(before)?.to_content(point)?)
}

#[derive(Debug, PartialEq)]
struct Surface {
    frame: Rect,
    rotation: f64,
    picture: Option<Picture>,
}

#[derive(Debug, PartialEq)]
struct Picture {
    crop: Rect,
    flip_horizontal: bool,
    flip_vertical: bool,
}

impl Surface {
    fn of(kind: &ElementKind) -> Option<Self> {
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
    fn to_content(&self, point: Point) -> Option<Point> {
        let Self {
            frame,
            rotation,
            picture,
        } = self;
        let upright = point.turned(frame.centre(), -rotation);
        let parts = Point {
            x: part(upright.x - frame.x, frame.width),
            y: part(upright.y - frame.y, frame.height),
        };
        let content = picture
            .as_ref()
            .map_or(parts, |picture| picture.pixel(parts));
        content.is_finite().then_some(content)
    }

    fn to_board(&self, content: Point) -> Option<Point> {
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
            y: frame.y + parts.y * frame.height,
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
    use crate::{Shape, Text};

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
            text: Text {
                content: content.to_owned(),
                font_size: 20.0,
            },
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
        }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
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
        };
        let comment = ElementKind::Comment {
            at: point(50.0, 50.0),
            text: "Here".to_owned(),
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
        assert_at(board.stick(point(60.0, 50.0), 3.0), 3, 60.0, 50.0);
        assert_at(board.stick(point(20.0, 50.0), 3.0), 1, 20.0, 50.0);
        assert_eq!(board.stick(point(200.0, 50.0), 3.0), None);
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
        assert_at(board.stick(point(50.0, 50.0), 3.0), 1, 50.0, 50.0);
        assert_at(board.stick(point(250.0, 50.0), 3.0), 3, 250.0, 50.0);
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
        assert_at(board.stick(point(30.0, 18.0), 3.0), 1, 30.0, 20.0);
        assert_at(board.stick(point(30.0, 10.0), 3.0), 1, 30.0, 10.0);
        assert_at(board.stick(point(262.0, 0.0), 3.0), 2, 260.0, 0.0);
        // Just out of the ellipse's side, whose middle turned to (475, 93.3). Turned back
        // upright, its curve is where its equation gives 1, and the nearest point of it is
        // where the way to the end runs along its normal.
        let (target, on) = board.stick(point(474.0, 95.0), 3.0).unwrap();
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
        assert_at(board.stick(point(50.0, 202.0), 3.0), 4, 50.0, 200.0);
        assert_at(board.stick(point(221.0, 219.0), 3.0), 5, 220.0, 220.0);
        assert_at(board.stick(point(250.0, 220.0), 3.0), 5, 250.0, 220.0);
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
        };
        // At the picture's (7.5, 2.5), which lands at the crop's (0.5, 0.75) once flipped:
        // (150, 150) upright, turned a quarter around (150, 100).
        let to = followed(&before, &after, point(75.0, 25.0)).unwrap();
        assert!(apart(to, point(100.0, 100.0)) < 1e-9, "{to:?}");
        assert!(moves_ends(&before, &after));
        assert!(!moves_ends(&before, &before));
        // Flat, it keeps its points at its left side, which is all there is of it.
        let flat = image(area(0.0, 0.0, 0.0, 100.0));
        let to = followed(&flat, &before, point(0.0, 50.0)).unwrap();
        assert!(apart(to, point(0.0, 50.0)) < 1e-9, "{to:?}");
    }
}
