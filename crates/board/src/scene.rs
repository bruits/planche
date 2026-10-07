//! What a board's elements draw, as the renderer takes it: images, strokes, fills, and where
//! texts stack, which the shell lays out and rasterises.

use std::collections::BTreeSet;

use serde::{Serialize, Serializer};

use crate::geometry::{smoothed, stroke_points};
use crate::{
    AssetId, Board, Colour, CropShape, Dash, ElementId, ElementKind, Fill, Heads, ImageEdits,
    Paper, Point, Rect, Shape, Size, Text, Tip, Weight,
};

/// The longest an arrow's head is, in board units, then in widths of its stroke, and the most of
/// its arrow it takes.
const HEAD_LENGTH: f64 = 10.0;
const HEAD_WIDTHS: f64 = 3.0;
const HEAD_SHARE: f64 = 1.0 / 3.0;
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
    /// element and `crossed_out` alone, as shells keep it until the element changes. Elements
    /// stack in [`Board::draw_order`].
    pub fn drawn(&self, id: ElementId, crossed_out: &BTreeSet<AssetId>) -> Vec<Item> {
        let mut items = Vec::new();
        if let Some(element) = self.elements.get(&id) {
            drawn(id, &element.kind, crossed_out, &mut items);
        }
        items
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
        ElementKind::Comment { .. } | ElementKind::Group => {}
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
    use crate::tests::{board, element, id, stroke};
    use crate::{Corners, Opacity};

    const FRAME: Rect = Rect {
        x: 10.0,
        y: 20.0,
        width: 200.0,
        height: 100.0,
    };

    fn drawn(kind: ElementKind) -> Vec<Item> {
        board([(1, element(None, "a0", kind))]).drawn(id(1), &BTreeSet::new())
    }

    fn image(edits: ImageEdits) -> ElementKind {
        ElementKind::Image {
            asset: AssetId::of(b"dusk"),
            natural_size: Size {
                width: 400,
                height: 200,
            },
            frame: FRAME,
            rotation: 30.0,
            edits,
            source: None,
            filename: None,
            caption: None,
            opacity: Opacity::default(),
        }
    }

    fn note(content: &str) -> ElementKind {
        ElementKind::Note {
            frame: FRAME,
            rotation: 0.0,
            text: Text::new(content, 20.0),
            target: None,
            colour: Colour::Ink,
            opacity: Opacity::default(),
        }
    }

    fn shape(shape: Shape, fill: Fill) -> ElementKind {
        ElementKind::Shape {
            frame: FRAME,
            rotation: 45.0,
            shape,
            corners: Corners::new(7).unwrap(),
            text: Text::new("", 20.0),
            target: None,
            colour: Colour::Red,
            weight: Weight::Thick,
            dash: Dash::Dashed,
            fill,
            opacity: Opacity::default(),
        }
    }

    fn arrow(to: Point, weight: Weight, heads: Heads) -> ElementKind {
        ElementKind::Arrow {
            from: Point { x: 0.0, y: 0.0 },
            to,
            from_target: None,
            to_target: None,
            colour: Colour::Blue,
            weight,
            dash: Dash::Solid,
            heads,
            opacity: Opacity::default(),
        }
    }

    fn texture(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn groups_comments_blank_texts_and_unknown_ids_draw_nothing() {
        let comment = ElementKind::Comment {
            at: Point { x: 0.0, y: 0.0 },
            text: "Later".to_owned(),
            target: None,
        };
        let board = board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", comment)),
            (3, element(Some(1), "a1", note(" "))),
            (4, element(None, "a1", note("Dusk"))),
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
    fn an_image_shows_its_crop_flipped_within_it_greyed_and_cut_to_an_ellipse() {
        let shows = |edits| match &drawn(image(edits))[..] {
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
        assert_eq!(shows(whole), (texture(0.0, 0.0, 1.0, 1.0), false, false));
        let cropped = ImageEdits {
            crop: Some(texture(100.0, 50.0, 200.0, 100.0)),
            ..whole
        };
        assert_eq!(shows(cropped).0, texture(0.25, 0.25, 0.5, 0.5));
        let flipped = ImageEdits {
            flip_horizontal: true,
            flip_vertical: true,
            ..cropped
        };
        assert_eq!(shows(flipped).0, texture(0.75, 0.75, -0.5, -0.5));
        let greyed = ImageEdits {
            greyscale: true,
            crop_shape: CropShape::Ellipse,
            ..whole
        };
        assert_eq!(shows(greyed), (texture(0.0, 0.0, 1.0, 1.0), true, true));
    }

    #[test]
    fn an_image_whose_asset_does_not_show_is_crossed_out_where_it_lies() {
        let mut faded = image(ImageEdits::default());
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
        let head = |to, weight, heads| match &drawn(arrow(to, weight, heads))[..] {
            [Item::Arrow { head, heads, .. }] => (*head, *heads),
            drawn => panic!("{drawn:?}"),
        };
        let far = Point { x: 60.0, y: 80.0 };
        assert_eq!(head(far, Weight::Medium, Heads::End), (16.0, Heads::End));
        assert_eq!(head(far, Weight::Thick, Heads::Both), (22.0, Heads::Both));
        assert_eq!(
            head(Point { x: 30.0, y: 0.0 }, Weight::Thin, Heads::End),
            (10.0, Heads::End)
        );
    }

    #[test]
    fn an_arrow_without_length_draws_as_a_line() {
        let origin = Point { x: 0.0, y: 0.0 };
        assert_eq!(
            drawn(arrow(origin, Weight::Thin, Heads::Both)),
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
        let corners = |kind| match &drawn(shape(kind, Fill::Hollow))[..] {
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
        let fill = |kind, fill| match &drawn(shape(kind, fill))[..] {
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
            &[
                Point { x: 0.0, y: 0.0 },
                Point { x: 100.0, y: 0.0 },
                Point { x: 200.0, y: 30.0 },
            ],
            0.0,
        );
        let [Item::Stroke { points, .. }] = &drawn(bent)[..] else {
            panic!()
        };
        assert!(points.len() > 3, "{points:?}");
        assert_eq!(
            (points.first(), points.last()),
            (
                Some(&Point { x: 0.0, y: 0.0 }),
                Some(&Point { x: 200.0, y: 30.0 })
            )
        );
    }

    #[test]
    fn a_pen_stroke_draws_its_points_where_its_frame_turns_them_and_fades_whole() {
        let ElementKind::Stroke {
            colour,
            weight,
            points,
            ..
        } = stroke()
        else {
            unreachable!()
        };
        let turned = ElementKind::Stroke {
            tip: Tip::Pen,
            frame: FRAME,
            rotation: 180.0,
            points,
            target: None,
            colour,
            weight,
            opacity: Opacity::new(40).unwrap(),
        };
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
            assert!(
                (point.x - x).abs() < 1e-9 && (point.y - y).abs() < 1e-9,
                "{point:?}"
            );
        }
        assert_eq!(points.len(), 3);
        assert_eq!(
            (*width, *paint, *opacity),
            (2.0, Paint::Colour(Colour::Ink), 0.4)
        );
    }

    #[test]
    fn a_highlighter_draws_wide_and_see_through_in_its_bright_version_of_the_colour() {
        let ElementKind::Stroke {
            frame,
            rotation,
            points,
            ..
        } = stroke()
        else {
            unreachable!()
        };
        let highlighter = |colour| ElementKind::Stroke {
            tip: Tip::Highlighter,
            frame,
            rotation,
            points: points.clone(),
            target: None,
            colour,
            weight: Weight::Medium,
            opacity: Opacity::new(50).unwrap(),
        };
        let look = |colour| match &drawn(highlighter(colour))[..] {
            [
                Item::Stroke {
                    width,
                    paint,
                    opacity,
                    ..
                },
            ] => (*width, serde_json::to_value(paint).unwrap(), *opacity),
            drawn => panic!("{drawn:?}"),
        };
        assert_eq!(look(Colour::Ink), (16.0, "highlight-yellow".into(), 0.2));
        assert_eq!(look(Colour::Red).1, "highlight-red");
        assert_eq!(look(Colour::Rgb([1, 2, 254])).1, "#0102fe");
    }
}
