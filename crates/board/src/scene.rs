//! What a board's elements draw, as the renderer takes it: images, strokes, fills, and where
//! texts stack, which the shell lays out and rasterises.

use std::collections::BTreeSet;

use serde::{Serialize, Serializer};

use crate::geometry::{around, corners, polygon, smoothed, stroke_points};
use crate::{
    Annotations, AssetId, Board, Colour, CropShape, Dash, ElementId, ElementKind, Fill, Heads,
    ImageEdits, Paper, Point, Rect, Shape, Size, Text, Tip, Weight,
};

/// The longest an arrow's head is, in board units, then in widths of its stroke, and the most of
/// its arrow it takes.
const HEAD_LENGTH: f64 = 10.0;
const HEAD_WIDTHS: f64 = 3.0;
const HEAD_SHARE: f64 = 1.0 / 3.0;
/// How far each stroke of an arrow's head turns back from its shaft, in degrees. The renderer's
/// shader draws them so, as it knows nothing of boards.
const BARB: f64 = 30.0;
/// How much of its colour a tinted shape fills with.
const TINT: f64 = 0.18;

/// One thing to draw, with `opacity` from 0 to 1. Rotations are clockwise, in degrees, around the
/// frame's centre, and stroke widths in board units.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Item {
    Image {
        asset: AssetId,
        frame: Rect,
        rotation: f64,
        /// The part of the asset it shows, from 0 to 1 across and down, which a negative size
        /// flips.
        texture: Rect,
        greyscale: bool,
        /// Whether it shows only the ellipse that fills its frame.
        elliptical: bool,
        opacity: f64,
    },
    /// Where the text of element `id` stacks, which the shell lays out.
    Text { id: ElementId, opacity: f64 },
    Line {
        from: Point,
        to: Point,
        width: f64,
        paint: Paint,
        dashed: bool,
        opacity: f64,
    },
    /// Its heads `head` long, never dashed.
    Arrow {
        from: Point,
        to: Point,
        width: f64,
        paint: Paint,
        dashed: bool,
        head: f64,
        heads: Heads,
        opacity: f64,
    },
    /// `fill` how much of its paint fills it, and `corners` how many a polygon goes round, a star's
    /// points alone, none for other shapes.
    Outline {
        shape: Shape,
        corners: u8,
        frame: Rect,
        rotation: f64,
        width: f64,
        paint: Paint,
        dashed: bool,
        fill: f64,
        opacity: f64,
    },
    Fill {
        frame: Rect,
        rotation: f64,
        paint: Paint,
        opacity: f64,
    },
    /// A pen stroke through `points`, round at its ends and joins, which shades each pixel once
    /// however it crosses itself.
    Stroke {
        points: Vec<Point>,
        width: f64,
        paint: Paint,
        opacity: f64,
    },
}

/// A colour, or a sticky note's paper, which stays whatever the theme, or a highlighter's bright
/// version of a colour of the palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts",
    ts(
        type = r#"Colour | `paper-${Paper}` | `highlight-${"yellow" | Exclude<Colour, "ink" | `#${string}`>}`"#
    )
)]
pub enum Paint {
    Colour(Colour),
    Paper(Paper),
    Highlight(Colour),
}

impl Serialize for Paint {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Colour(colour) => serializer.collect_str(colour),
            Self::Paper(paper) => {
                let name = match paper {
                    Paper::Yellow => "yellow",
                    Paper::Pink => "pink",
                    Paper::Orange => "orange",
                    Paper::Green => "green",
                    Paper::Blue => "blue",
                    Paper::Lilac => "lilac",
                };
                serializer.collect_str(&format_args!("paper-{name}"))
            }
            Self::Highlight(Colour::Ink) => serializer.collect_str("highlight-yellow"),
            Self::Highlight(colour @ Colour::Rgb(_)) => serializer.collect_str(colour),
            Self::Highlight(colour) => serializer.collect_str(&format_args!("highlight-{colour}")),
        }
    }
}

impl Board {
    /// What element `id` draws itself, back to front, nothing when it is unknown. Its images, when
    /// their asset is among `crossed_out`, draw where they lie, crossed out. It depends on that
    /// element and `crossed_out` alone, as shells keep it until the element changes, but for a
    /// group's panel, which follows what its elements draw. Elements stack in
    /// [`Board::draw_order`].
    pub fn drawn(&self, id: ElementId, crossed_out: &BTreeSet<AssetId>) -> Vec<Item> {
        let mut items = Vec::new();
        match self.elements.get(&id).map(|element| &element.kind) {
            Some(ElementKind::Group { colour, fill, .. }) => {
                if let Some(frame) = self.panel(id) {
                    items.push(Item::Fill {
                        frame,
                        rotation: 0.0,
                        paint: Paint::Colour(*colour),
                        opacity: if *fill == Fill::Solid { 1.0 } else { TINT },
                    });
                }
            }
            Some(kind) => drawn(id, kind, crossed_out, &mut items),
            None => {}
        }
        items
    }
}

impl Board {
    /// The smallest upright rectangle around what the elements draw, as [`Board::drawn`] has it,
    /// strokes as wide as they are and arrows' heads included, with their groups' elements and
    /// panels. `None` when they draw nothing.
    pub fn drawn_bounds(
        &self,
        ids: &[ElementId],
        crossed_out: &BTreeSet<AssetId>,
        annotations: Annotations,
    ) -> Option<Rect> {
        let mut points = Vec::new();
        for id in self.with_descendants(ids) {
            if annotations.hides(&self.elements[&id].kind) {
                continue;
            }
            for item in self.drawn(id, crossed_out) {
                self.reach(&item, &mut points);
            }
        }
        around(&points)
    }

    fn reach(&self, item: &Item, points: &mut Vec<Point>) {
        match item {
            Item::Image {
                frame,
                rotation,
                elliptical: true,
                ..
            } => points.extend(oval(frame, *rotation, 0.0)),
            Item::Image {
                frame, rotation, ..
            }
            | Item::Fill {
                frame, rotation, ..
            } => points.extend(corners(frame, *rotation)),
            // As far as the frame it lies in, which the margin of its texture passes, but within a
            // shape's outline when that holds it, as all but a rectangle's or a cross's do.
            Item::Text { id, .. } => match &self.elements[id].kind {
                kind if kind.text_area().is_some_and(|area| area.width < 1.0) => {}
                ElementKind::Note {
                    frame, rotation, ..
                }
                | ElementKind::Sticky {
                    frame, rotation, ..
                }
                | ElementKind::Shape {
                    frame, rotation, ..
                } => points.extend(corners(frame, *rotation)),
                _ => {}
            },
            Item::Line {
                from, to, width, ..
            } => widened(points, [*from, *to], *width),
            Item::Arrow {
                from,
                to,
                width,
                head,
                heads,
                ..
            } => widened(
                points,
                [*from, *to]
                    .into_iter()
                    .chain(barbs(*from, *to, *head, *heads)),
                *width,
            ),
            Item::Stroke {
                points: line,
                width,
                ..
            } => widened(points, line.iter().copied(), *width),
            Item::Outline {
                shape,
                corners: count,
                frame,
                rotation,
                width,
                ..
            } => {
                // An outline straddles the line it draws.
                let half = width / 2.0;
                if *shape == Shape::Ellipse {
                    points.extend(oval(frame, *rotation, half));
                } else if *count > 0 {
                    let polygon = polygon(frame, *rotation, *count, *shape == Shape::Star);
                    widened(points, polygon, *width);
                } else {
                    points.extend(corners(&outset(frame, half), *rotation));
                }
            }
        }
    }
}

/// Where the strokes of an arrow's heads end.
fn barbs(from: Point, to: Point, head: f64, heads: Heads) -> Vec<Point> {
    let span = (to.x - from.x).hypot(to.y - from.y);
    if span == 0.0 {
        return Vec::new();
    }
    let along = Point {
        x: (to.x - from.x) / span,
        y: (to.y - from.y) / span,
    };
    let (sin, cos) = BARB.to_radians().sin_cos();
    let (back, across) = (head * cos, head * sin);
    let ends = |tip: Point, way: f64| {
        [1.0, -1.0].map(|side| Point {
            x: tip.x - way * along.x * back - side * along.y * across,
            y: tip.y - way * along.y * back + side * along.x * across,
        })
    };
    match heads {
        Heads::End => ends(to, 1.0).to_vec(),
        Heads::Both => [ends(to, 1.0), ends(from, -1.0)].concat(),
    }
}

fn widened(points: &mut Vec<Point>, line: impl IntoIterator<Item = Point>, width: f64) {
    let half = width / 2.0;
    for point in line {
        points.push(Point {
            x: point.x - half,
            y: point.y - half,
        });
        points.push(Point {
            x: point.x + half,
            y: point.y + half,
        });
    }
}

/// Two opposite corners of the upright box around the ellipse that fills `frame`, turned clockwise
/// by `degrees` around its centre, grown by `by` all round.
fn oval(frame: &Rect, degrees: f64, by: f64) -> [Point; 2] {
    let centre = frame.centre();
    let (sin, cos) = degrees.to_radians().sin_cos();
    let (across, down) = (frame.width / 2.0, frame.height / 2.0);
    let half = Point {
        x: (across * cos).hypot(down * sin) + by,
        y: (across * sin).hypot(down * cos) + by,
    };
    [
        Point {
            x: centre.x - half.x,
            y: centre.y - half.y,
        },
        Point {
            x: centre.x + half.x,
            y: centre.y + half.y,
        },
    ]
}

fn outset(frame: &Rect, by: f64) -> Rect {
    let centre = frame.centre();
    let (across, down) = (frame.width.abs() / 2.0 + by, frame.height.abs() / 2.0 + by);
    Rect {
        x: centre.x - across,
        y: centre.y - down,
        width: 2.0 * across,
        height: 2.0 * down,
    }
}

impl ElementKind {
    /// What it draws, as [`Board::drawn`] says, as element `id`.
    pub fn drawn(&self, id: ElementId) -> Vec<Item> {
        let mut items = Vec::new();
        drawn(id, self, &BTreeSet::new(), &mut items);
        items
    }
}

fn drawn(
    id: ElementId,
    kind: &ElementKind,
    crossed_out: &BTreeSet<AssetId>,
    items: &mut Vec<Item>,
) {
    let opacity = kind
        .opacity()
        .map_or(1.0, |opacity| f64::from(opacity.percent()) / 100.0);
    let text = |items: &mut Vec<Item>, text: &Text| {
        if !text.is_blank() {
            items.push(Item::Text { id, opacity });
        }
    };
    match kind {
        ElementKind::Image {
            asset,
            natural_size,
            frame,
            rotation,
            edits,
            ..
        } => {
            if crossed_out.contains(asset) {
                for shape in [Shape::Rectangle, Shape::Cross] {
                    items.push(Item::Outline {
                        shape,
                        corners: 0,
                        frame: *frame,
                        rotation: *rotation,
                        width: Weight::default().width(),
                        paint: Paint::Colour(Colour::Ink),
                        dashed: false,
                        fill: 0.0,
                        opacity,
                    });
                }
            } else {
                items.push(Item::Image {
                    asset: *asset,
                    frame: *frame,
                    rotation: *rotation,
                    texture: shown(*natural_size, edits),
                    greyscale: edits.greyscale,
                    elliptical: edits.crop_shape == CropShape::Ellipse,
                    opacity,
                });
            }
        }
        ElementKind::Note { text: written, .. } => text(items, written),
        ElementKind::Sticky {
            frame,
            rotation,
            text: written,
            paper,
            ..
        } => {
            items.push(Item::Fill {
                frame: *frame,
                rotation: *rotation,
                paint: Paint::Paper(*paper),
                opacity,
            });
            text(items, written);
        }
        ElementKind::Shape {
            frame,
            rotation,
            shape,
            corners,
            text: written,
            colour,
            weight,
            dash,
            fill,
            ..
        } => {
            // A cross takes no fill, though one written before crosses took none may hold one.
            let fill = match (shape, fill) {
                (Shape::Cross, _) | (_, Fill::Hollow) => 0.0,
                (_, Fill::Tint) => TINT,
                (_, Fill::Solid) => 1.0,
            };
            // One item with its fill, as an outline over a fill of its own would show darker once
            // faded.
            items.push(Item::Outline {
                shape: *shape,
                corners: shape.polygon(*corners).map_or(0, |(count, _)| count),
                frame: *frame,
                rotation: *rotation,
                width: weight.width(),
                paint: Paint::Colour(*colour),
                dashed: *dash == Dash::Dashed,
                fill,
                opacity,
            });
            text(items, written);
        }
        ElementKind::Arrow {
            from,
            to,
            colour,
            weight,
            dash,
            heads,
            ..
        } => {
            let width = weight.width();
            let span = (to.x - from.x).hypot(to.y - from.y);
            // One item, as heads drawn apart from their shaft would overlap it, which fading shows.
            items.push(if span == 0.0 {
                line(*from, *to, *colour, *weight, *dash, opacity)
            } else {
                Item::Arrow {
                    from: *from,
                    to: *to,
                    width,
                    paint: Paint::Colour(*colour),
                    dashed: *dash == Dash::Dashed,
                    head: (HEAD_LENGTH + HEAD_WIDTHS * width).min(span * HEAD_SHARE),
                    heads: *heads,
                    opacity,
                }
            });
        }
        ElementKind::Line {
            from,
            to,
            colour,
            weight,
            dash,
            ..
        } => items.push(line(*from, *to, *colour, *weight, *dash, opacity)),
        ElementKind::Stroke {
            tip,
            frame,
            rotation,
            points,
            colour,
            weight,
            ..
        } => items.push(Item::Stroke {
            points: smoothed(&stroke_points(frame, *rotation, points), tip.width(*weight)),
            width: tip.width(*weight),
            paint: match tip {
                Tip::Pen => Paint::Colour(*colour),
                Tip::Highlighter => Paint::Highlight(*colour),
            },
            opacity: opacity * tip.opacity(),
        }),
        ElementKind::Comment { .. } | ElementKind::Group { .. } => {}
    }
}

fn line(from: Point, to: Point, colour: Colour, weight: Weight, dash: Dash, opacity: f64) -> Item {
    Item::Line {
        from,
        to,
        width: weight.width(),
        paint: Paint::Colour(colour),
        dashed: dash == Dash::Dashed,
        opacity,
    }
}

/// The part of the asset an image shows, from 0 to 1, flipped within its crop.
fn shown(natural: Size, edits: &ImageEdits) -> Rect {
    let (width, height) = (f64::from(natural.width), f64::from(natural.height));
    let crop = edits.crop.unwrap_or(Rect {
        x: 0.0,
        y: 0.0,
        width,
        height,
    });
    let (mut x, mut across) = (crop.x / width, crop.width / width);
    let (mut y, mut down) = (crop.y / height, crop.height / height);
    if edits.flip_horizontal {
        (x, across) = (x + across, -across);
    }
    if edits.flip_vertical {
        (y, down) = (y + down, -down);
    }
    Rect {
        x,
        y,
        width: across,
        height: down,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{
        area, assert_at, board, comment, counted, element, highlighted, id, image_of, near, note,
        pen, point, stroke, stuck, turned,
    };
    use crate::{Opacity, Style};

    const FRAME: Rect = area(10.0, 20.0, 200.0, 100.0);

    fn drawn(kind: ElementKind) -> Vec<Item> {
        board([(1, element(None, "a0", kind))]).drawn(id(1), &BTreeSet::new())
    }

    fn dusk(edits: ImageEdits) -> ElementKind {
        let mut kind = turned(image_of(b"dusk", edits), 30.0);
        if let ElementKind::Image {
            natural_size,
            frame,
            ..
        } = &mut kind
        {
            (*natural_size, *frame) = (
                Size {
                    width: 400,
                    height: 200,
                },
                FRAME,
            );
        }
        kind
    }

    fn saying(content: &str) -> ElementKind {
        let mut kind = note(FRAME.x, FRAME.y, FRAME.width, FRAME.height);
        if let ElementKind::Note { text, .. } = &mut kind {
            *text = Text::new(content, 20.0);
        }
        kind
    }

    fn painted(shape: Shape, fill: Fill) -> ElementKind {
        turned(counted(shape, FRAME, 7, fill), 45.0).with_style(&Style {
            colour: Some(Colour::Red),
            weight: Some(Weight::Thick),
            dash: Some(Dash::Dashed),
            ..Style::default()
        })
    }

    fn pointing(to: Point, weight: Weight, heads: Heads) -> ElementKind {
        stuck((0.0, 0.0), None, (to.x, to.y), None).with_style(&Style {
            colour: Some(Colour::Blue),
            weight: Some(weight),
            heads: Some(heads),
            ..Style::default()
        })
    }

    #[test]
    fn groups_comments_blank_texts_and_unknown_ids_draw_nothing() {
        let comment = comment(0.0, 0.0);
        let board = board([
            (1, element(None, "a0", ElementKind::group())),
            (2, element(Some(1), "a0", comment)),
            (3, element(Some(1), "a1", saying(" "))),
            (4, element(None, "a1", saying("Dusk"))),
        ]);
        let drawn = |bits| board.drawn(id(bits), &BTreeSet::new());
        for bits in [1, 2, 3, 9] {
            assert_eq!(drawn(bits), []);
        }
        assert_eq!(
            drawn(4),
            [Item::Text {
                id: id(4),
                opacity: 1.0
            }]
        );
    }

    #[test]
    fn a_filled_group_draws_a_panel_around_its_elements_and_its_title_nothing() {
        let at = |x, y| {
            let mut kind = saying("Dusk");
            if let ElementKind::Note { frame, .. } = &mut kind {
                (frame.x, frame.y) = (x, y);
            }
            kind
        };
        let group = |fill, title: &str| ElementKind::Group {
            colour: Colour::Red,
            fill,
            title: Some(title.to_owned()),
        };
        let board = board([
            (1, element(None, "a0", group(Fill::Tint, "Moods"))),
            (2, element(Some(1), "a0", at(0.0, 0.0))),
            (3, element(Some(1), "a1", at(300.0, 100.0))),
            (4, element(None, "a1", group(Fill::Hollow, "Later"))),
            (5, element(Some(4), "a0", at(0.0, 0.0))),
            (6, element(Some(4), "a1", at(300.0, 100.0))),
        ]);
        let drawn = |bits| board.drawn(id(bits), &BTreeSet::new());

        // A twentieth of their mean side around what they draw, (0, 0) to (500, 200).
        assert_eq!(
            drawn(1),
            [Item::Fill {
                frame: area(-17.5, -17.5, 535.0, 235.0),
                rotation: 0.0,
                paint: Paint::Colour(Colour::Red),
                opacity: TINT,
            }]
        );
        assert_eq!(drawn(4), []);
    }

    #[test]
    fn an_image_shows_its_crop_flipped_within_it_greyed_and_cut_to_an_ellipse() {
        let shows = |edits| match &drawn(dusk(edits))[..] {
            [
                Item::Image {
                    texture,
                    greyscale,
                    elliptical,
                    frame,
                    rotation,
                    ..
                },
            ] => {
                assert_eq!((*frame, *rotation), (FRAME, 30.0));
                (*texture, *greyscale, *elliptical)
            }
            drawn => panic!("{drawn:?}"),
        };
        let whole = ImageEdits::default();
        assert_eq!(shows(whole), (area(0.0, 0.0, 1.0, 1.0), false, false));
        let cropped = ImageEdits {
            crop: Some(area(100.0, 50.0, 200.0, 100.0)),
            ..whole
        };
        assert_eq!(shows(cropped).0, area(0.25, 0.25, 0.5, 0.5));
        let flipped = ImageEdits {
            flip_horizontal: true,
            flip_vertical: true,
            ..cropped
        };
        assert_eq!(shows(flipped).0, area(0.75, 0.75, -0.5, -0.5));
        let greyed = ImageEdits {
            greyscale: true,
            crop_shape: CropShape::Ellipse,
            ..whole
        };
        assert_eq!(shows(greyed), (area(0.0, 0.0, 1.0, 1.0), true, true));
    }

    #[test]
    fn an_image_whose_asset_does_not_show_is_crossed_out_where_it_lies() {
        let mut faded = dusk(ImageEdits::default());
        if let ElementKind::Image { opacity, .. } = &mut faded {
            *opacity = Opacity::new(50).unwrap();
        }
        let board = board([(1, element(None, "a0", faded))]);
        let crossed_out = BTreeSet::from([AssetId::of(b"dusk")]);
        let outline = |shape| Item::Outline {
            shape,
            corners: 0,
            frame: FRAME,
            rotation: 30.0,
            width: 2.0,
            paint: Paint::Colour(Colour::Ink),
            dashed: false,
            fill: 0.0,
            opacity: 0.5,
        };
        assert_eq!(
            board.drawn(id(1), &crossed_out),
            [outline(Shape::Rectangle), outline(Shape::Cross)]
        );
        assert!(matches!(
            board.drawn(id(1), &BTreeSet::from([AssetId::of(b"dawn")]))[..],
            [Item::Image { .. }]
        ));
    }

    #[test]
    fn an_arrow_heads_as_its_stroke_asks_but_never_past_a_third_of_it() {
        let head = |to, weight, heads| match &drawn(pointing(to, weight, heads))[..] {
            [Item::Arrow { head, heads, .. }] => (*head, *heads),
            drawn => panic!("{drawn:?}"),
        };
        let far = point(60.0, 80.0);
        assert_eq!(head(far, Weight::Medium, Heads::End), (16.0, Heads::End));
        assert_eq!(head(far, Weight::Thick, Heads::Both), (22.0, Heads::Both));
        assert_eq!(
            head(point(30.0, 0.0), Weight::Thin, Heads::End),
            (10.0, Heads::End)
        );
    }

    #[test]
    fn an_arrow_head_turns_back_thirty_degrees_from_its_shaft() {
        // As the renderer's shader spells it.
        let (back, across) = (0.866_025_4, 0.5);
        let ends = barbs(point(0.0, 0.0), point(100.0, 0.0), 10.0, Heads::Both);
        let expected = [
            (100.0 - 10.0 * back, 10.0 * across),
            (100.0 - 10.0 * back, -10.0 * across),
            (10.0 * back, 10.0 * across),
            (10.0 * back, -10.0 * across),
        ];
        assert_eq!(ends.len(), expected.len());
        for (end, (x, y)) in ends.iter().zip(expected) {
            assert!(
                (end.x - x).abs() < 1e-6 && (end.y - y).abs() < 1e-6,
                "{end:?}"
            );
        }
    }

    #[test]
    fn what_elements_draw_reaches_as_far_as_their_strokes_and_heads() {
        let to = point(100.0, 0.0);
        let board = board([
            (
                1,
                element(None, "a0", pointing(to, Weight::Medium, Heads::Both)),
            ),
            (2, element(None, "a1", ElementKind::group())),
            (3, element(Some(2), "a0", dusk(ImageEdits::default()))),
            (4, element(Some(2), "a1", saying("Dusk"))),
            (5, element(None, "a2", saying(""))),
        ]);
        let none = BTreeSet::new();
        // A medium arrow's heads are 16 long, so they spread 8 across, and its stroke 1 more.
        let across = 16.0 * 0.5 + 1.0;
        let bounds = board.drawn_bounds(&[id(1)], &none, Annotations::Shown);
        assert!(
            bounds.is_some_and(|bounds| near(
                &bounds,
                &Rect {
                    x: -1.0,
                    y: -across,
                    width: 102.0,
                    height: 2.0 * across
                }
            )),
            "{bounds:?}"
        );
        let image = board.drawn_bounds(&[id(3)], &none, Annotations::Shown);
        let note = board.drawn_bounds(&[id(4)], &none, Annotations::Shown);
        assert_eq!(
            board.drawn_bounds(&[id(2)], &none, Annotations::Hidden),
            image
        );
        assert_eq!(note, Some(FRAME));
        assert_eq!(
            board.drawn_bounds(&[id(5), id(9)], &none, Annotations::Shown),
            None
        );
        // Crossed out, an image draws its outline, which straddles its frame, turned by 30°.
        let crossed_out = BTreeSet::from([AssetId::of(b"dusk")]);
        let outlined = board.drawn_bounds(&[id(3)], &crossed_out, Annotations::Shown);
        let (sin, cos) = 30_f64.to_radians().sin_cos();
        let grown = sin + cos;
        assert!(
            outlined.zip(image).is_some_and(|(outlined, image)| near(
                &outlined,
                &Rect {
                    x: image.x - grown,
                    y: image.y - grown,
                    width: image.width + 2.0 * grown,
                    height: image.height + 2.0 * grown,
                }
            )),
            "{outlined:?} {image:?}"
        );
    }

    #[test]
    fn a_rectangle_or_cross_outline_on_a_frame_turned_over_by_a_negative_size_reaches_as_far() {
        let turned = area(110.0, 20.0, -100.0, 50.0);
        for kind in [Shape::Rectangle, Shape::Cross] {
            let mut shape = painted(kind, Fill::Hollow);
            if let ElementKind::Shape {
                frame,
                rotation,
                dash,
                ..
            } = &mut shape
            {
                (*frame, *rotation, *dash) = (turned, 0.0, Dash::Solid);
            }
            let board = board([(1, element(None, "a0", shape))]);
            let bounds = board.drawn_bounds(&[id(1)], &BTreeSet::new(), Annotations::Shown);
            // A thick outline straddles the frame's edge by 2, as the shader draws it about the
            // centre whichever way the size goes.
            assert_eq!(
                bounds,
                Some(Rect {
                    x: 8.0,
                    y: 18.0,
                    width: 104.0,
                    height: 54.0
                }),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn an_arrow_without_length_draws_as_a_line() {
        let origin = point(0.0, 0.0);
        assert_eq!(
            drawn(pointing(origin, Weight::Thin, Heads::Both)),
            [Item::Line {
                from: origin,
                to: origin,
                width: 1.0,
                paint: Paint::Colour(Colour::Blue),
                dashed: false,
                opacity: 1.0,
            }]
        );
    }

    #[test]
    fn a_shape_drawn_as_a_polygon_tells_how_many_corners_it_goes_round() {
        let corners = |kind| match &drawn(painted(kind, Fill::Hollow))[..] {
            [Item::Outline { corners, .. }] => *corners,
            drawn => panic!("{drawn:?}"),
        };
        assert_eq!(corners(Shape::Triangle), 3);
        assert_eq!(corners(Shape::Diamond), 4);
        assert_eq!(corners(Shape::Star), 7);
        assert_eq!(corners(Shape::Polygon), 7);
        assert_eq!(corners(Shape::Rectangle), 0);
        assert_eq!(corners(Shape::Ellipse), 0);
    }

    #[test]
    fn a_shape_outlines_its_frame_with_its_fill_but_a_cross_fills_nothing() {
        let fill = |kind, fill| match &drawn(painted(kind, fill))[..] {
            [
                Item::Outline {
                    shape,
                    frame,
                    rotation,
                    width,
                    paint,
                    dashed,
                    fill,
                    ..
                },
            ] => {
                assert_eq!(*shape, kind);
                assert_eq!((*frame, *rotation, *width), (FRAME, 45.0, 4.0));
                assert_eq!((*paint, *dashed), (Paint::Colour(Colour::Red), true));
                *fill
            }
            drawn => panic!("{drawn:?}"),
        };
        assert_eq!(fill(Shape::Rectangle, Fill::Hollow), 0.0);
        assert_eq!(fill(Shape::Rectangle, Fill::Tint), TINT);
        assert_eq!(fill(Shape::Ellipse, Fill::Solid), 1.0);
        assert_eq!(fill(Shape::Cross, Fill::Solid), 0.0);
        assert_eq!(fill(Shape::Star, Fill::Solid), 1.0);
    }

    #[test]
    fn a_sticky_note_lays_its_paper_under_its_text_and_fades_both() {
        let sticky = ElementKind::Sticky {
            frame: FRAME,
            rotation: 0.0,
            text: Text::new("Dusk", 20.0),
            target: None,
            paper: Paper::Pink,
            opacity: Opacity::new(25).unwrap(),
        };
        assert_eq!(
            drawn(sticky),
            [
                Item::Fill {
                    frame: FRAME,
                    rotation: 0.0,
                    paint: Paint::Paper(Paper::Pink),
                    opacity: 0.25,
                },
                Item::Text {
                    id: id(1),
                    opacity: 0.25,
                },
            ]
        );
    }

    #[test]
    fn a_paint_is_written_as_its_colour_or_as_its_paper() {
        let written = |paint| serde_json::to_value(paint).unwrap();
        for paper in [
            Paper::Yellow,
            Paper::Pink,
            Paper::Orange,
            Paper::Green,
            Paper::Blue,
            Paper::Lilac,
        ] {
            let name = serde_json::to_value(paper).unwrap();
            assert_eq!(
                written(Paint::Paper(paper)),
                format!("paper-{}", name.as_str().unwrap())
            );
        }
        assert_eq!(written(Paint::Colour(Colour::Violet)), "violet");
        assert_eq!(written(Paint::Colour(Colour::Rgb([1, 2, 254]))), "#0102fe");
    }

    #[test]
    fn a_stroke_draws_round_where_it_bends_gently() {
        let bent = ElementKind::stroke(
            Tip::Pen,
            &[point(0.0, 0.0), point(100.0, 0.0), point(200.0, 30.0)],
            0.0,
        );
        let [Item::Stroke { points, .. }] = &drawn(bent)[..] else {
            panic!()
        };
        assert!(points.len() > 3, "{points:?}");
        assert_eq!(
            (points.first(), points.last()),
            (Some(&point(0.0, 0.0)), Some(&point(200.0, 30.0)))
        );
    }

    #[test]
    fn a_pen_stroke_draws_its_points_where_its_frame_turns_them_and_fades_whole() {
        let turned = pen(FRAME, 180.0, &[(0.0, 1.0), (0.5, 0.0), (1.0, 1.0)]).with_style(&Style {
            opacity: Opacity::new(40),
            ..Style::default()
        });
        let [
            Item::Stroke {
                points,
                width,
                paint,
                opacity,
            },
        ] = &drawn(turned)[..]
        else {
            panic!()
        };
        // Upright at (10, 120), (110, 20), and (210, 120), half turned around (110, 70).
        let expected = [(210.0, 20.0), (110.0, 120.0), (10.0, 20.0)];
        for (point, (x, y)) in points.iter().zip(expected) {
            assert_at(*point, x, y);
        }
        assert_eq!(points.len(), 3);
        assert_eq!(
            (*width, *paint, *opacity),
            (2.0, Paint::Colour(Colour::Ink), 0.4)
        );
    }

    #[test]
    fn a_highlighter_draws_wide_and_see_through_in_its_bright_version_of_the_colour() {
        let look = |colour| {
            let kind = highlighted(stroke()).with_style(&Style {
                colour: Some(colour),
                opacity: Opacity::new(50),
                ..Style::default()
            });
            match &drawn(kind)[..] {
                [
                    Item::Stroke {
                        width,
                        paint,
                        opacity,
                        ..
                    },
                ] => (*width, serde_json::to_value(paint).unwrap(), *opacity),
                drawn => panic!("{drawn:?}"),
            }
        };
        assert_eq!(look(Colour::Ink), (16.0, "highlight-yellow".into(), 0.2));
        assert_eq!(look(Colour::Red).1, "highlight-red");
        assert_eq!(look(Colour::Rgb([1, 2, 254])).1, "#0102fe");
    }
}
