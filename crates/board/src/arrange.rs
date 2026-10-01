//! Packs images into rows, in the order people pick, and sizes them alike. The shell draws the
//! seed of a random order, as the core has no randomness of its own.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::iter::Peekable;
use std::str::Chars;

use serde::Deserialize;

use crate::geometry::{around, corners};
use crate::{Board, ElementId, ElementKind, GRID_SPACING, Point, Rect};

/// How [`crate::Editor::arrange`] orders the images it packs, row by row. Images that it cannot
/// tell apart keep the order they read in, from the top.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "by", rename_all = "snake_case")]
pub enum Order {
    /// By the name of the file each was added from, as people read names, case aside and numbers
    /// by their value. Those without one go last.
    Name,
    /// The largest on the board first.
    Size,
    /// Around the colour wheel from red, then greys from light to dark, then those without a
    /// colour. `colours` holds the mean colour that each image shows, in sRGB.
    Hue {
        colours: BTreeMap<ElementId, [u8; 3]>,
    },
    /// Shuffled alike for the same seed and images, wherever they lie.
    Random { seed: u32 },
}

/// Which side of what they cover [`crate::Editor::normalize`] makes alike.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Height,
    Width,
}

const GAP: f64 = GRID_SPACING;
/// How far apart, in board units, two positions count as one, so that arranging again changes
/// nothing.
const HAIR: f64 = 1e-6;
/// How far off 1 a scale may be and count as none, so that sizing alike again changes nothing.
const ALIKE: f64 = 1e-9;
/// The chroma, from 0 to 1, below which a colour reads as a grey.
const GREY: f64 = 0.05;

struct Packed<'a> {
    id: ElementId,
    kind: &'a ElementKind,
    bounds: Rect,
    row: usize,
    area: f64,
    filename: Option<&'a str>,
    greyscale: bool,
}

/// How far each image among `ids` moves, but for those that lie where they go already.
pub(crate) fn arrangement(
    board: &Board,
    ids: &[ElementId],
    order: &Order,
) -> Vec<(ElementId, Point)> {
    let mut images = images(board, ids);
    sort(&mut images, order);
    pack(&images)
}

/// Each image among `ids` scaled around its centre, but for those of the right size already.
pub(crate) fn normalization(
    board: &Board,
    ids: &[ElementId],
    side: Side,
) -> Vec<(ElementId, ElementKind)> {
    let images = images(board, ids);
    let measure = |image: &Packed| match side {
        Side::Height => image.bounds.height,
        Side::Width => image.bounds.width,
    };
    let target = images.iter().map(measure).sum::<f64>() / images.len() as f64;
    images
        .iter()
        .filter_map(|image| {
            let factor = target / measure(image);
            if !factor.is_finite() || (factor - 1.0).abs() <= ALIKE {
                return None;
            }
            let mut kind = image.kind.clone();
            if let ElementKind::Image { frame, .. } = &mut kind {
                let centre = frame.centre();
                frame.width *= factor;
                frame.height *= factor;
                frame.x = centre.x - frame.width / 2.0;
                frame.y = centre.y - frame.height / 2.0;
            }
            Some((image.id, kind))
        })
        .collect()
}

/// The images among `ids` themselves, once each, leaving out those of the groups among them.
fn images<'a>(board: &'a Board, ids: &[ElementId]) -> Vec<Packed<'a>> {
    ids.iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|id| {
            let kind = &board.elements.get(id)?.kind;
            let ElementKind::Image {
                frame,
                rotation,
                edits,
                filename,
                ..
            } = kind
            else {
                return None;
            };
            Some(Packed {
                id: *id,
                kind,
                bounds: around(&corners(frame, *rotation)).expect("a frame has corners"),
                row: 0,
                area: frame.width * frame.height,
                filename: filename.as_deref(),
                greyscale: edits.greyscale,
            })
        })
        .collect()
}

fn sort(images: &mut [Packed], order: &Order) {
    number_rows(images);
    let reading = |a: &Packed, b: &Packed| {
        (a.row.cmp(&b.row))
            .then(a.bounds.x.total_cmp(&b.bounds.x))
            .then(a.id.cmp(&b.id))
    };
    match order {
        Order::Name => images.sort_by(|a, b| by_name(a.filename, b.filename).then(reading(a, b))),
        Order::Size => images.sort_by(|a, b| b.area.total_cmp(&a.area).then(reading(a, b))),
        Order::Hue { colours } => images.sort_by(|a, b| {
            let ((a_rank, a_place), (b_rank, b_place)) = (tint(a, colours), tint(b, colours));
            (a_rank.cmp(&b_rank))
                .then(a_place.total_cmp(&b_place))
                .then(reading(a, b))
        }),
        Order::Random { seed } => {
            images.sort_by_key(|image| image.id);
            shuffle(images, *seed);
        }
    }
}

/// A row holds the images whose tops lie within a hair of its first one's, as float arithmetic
/// leaves the tops of a packed row a few ulps apart.
fn number_rows(images: &mut [Packed]) {
    images.sort_by(|a, b| a.bounds.y.total_cmp(&b.bounds.y).then(a.id.cmp(&b.id)));
    let (mut row, mut first) = (0, f64::NEG_INFINITY);
    for image in images {
        if image.bounds.y - first > HAIR {
            row += 1;
            first = image.bounds.y;
        }
        image.row = row;
    }
}

fn pack(images: &[Packed]) -> Vec<(ElementId, Point)> {
    let left = images
        .iter()
        .map(|image| image.bounds.x)
        .fold(f64::INFINITY, f64::min);
    let top = images
        .iter()
        .map(|image| image.bounds.y)
        .fold(f64::INFINITY, f64::min);
    let widest = images
        .iter()
        .map(|image| image.bounds.width)
        .fold(0.0, f64::max);
    let area: f64 = images
        .iter()
        .map(|image| (image.bounds.width + GAP) * (image.bounds.height + GAP))
        .sum();
    let width = area.sqrt().max(widest);
    let (mut x, mut y, mut row_height) = (left, top, 0.0_f64);
    images
        .iter()
        .filter_map(|Packed { id, bounds, .. }| {
            if x > left && x + bounds.width > left + width {
                (x, y, row_height) = (left, y + row_height + GAP, 0.0);
            }
            let by = Point {
                x: x - bounds.x,
                y: y - bounds.y,
            };
            x += bounds.width + GAP;
            row_height = row_height.max(bounds.height);
            (by.x.abs() > HAIR || by.y.abs() > HAIR).then_some((*id, by))
        })
        .collect()
}

fn by_name(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => natural(a, b),
        _ => b.is_some().cmp(&a.is_some()),
    }
}

fn natural(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        let ordering = match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (x, y) = (number(&mut a), number(&mut b));
                x.len().cmp(&y.len()).then_with(|| x.cmp(&y))
            }
            (Some(x), Some(y)) => {
                a.next();
                b.next();
                x.to_lowercase().cmp(y.to_lowercase())
            }
        };
        if ordering.is_ne() {
            return ordering;
        }
    }
}

/// A run of digits, without the zeros that lead it, so that a longer one is a larger number.
fn number(chars: &mut Peekable<Chars>) -> String {
    let mut digits = String::new();
    while let Some(digit) = chars.next_if(char::is_ascii_digit) {
        digits.push(digit);
    }
    digits.trim_start_matches('0').to_owned()
}

/// Which of the colours, the greys, or the unknown it goes among, and where among them.
fn tint(image: &Packed, colours: &BTreeMap<ElementId, [u8; 3]>) -> (u8, f64) {
    let Some(colour) = colours.get(&image.id) else {
        return (2, 0.0);
    };
    let [r, g, b] = colour.map(|channel| f64::from(channel) / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let chroma = max - min;
    if image.greyscale || chroma < GREY {
        // As the renderer greys an image.
        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return (1, 1.0 - luma);
    }
    // The hue, in sixths of a turn from red.
    let sixths = if max == r {
        (g - b) / chroma
    } else if max == g {
        (b - r) / chroma + 2.0
    } else {
        (r - g) / chroma + 4.0
    };
    (0, sixths.rem_euclid(6.0))
}

/// Fisher–Yates, drawing from SplitMix64, which gives the same numbers on every platform.
fn shuffle<T>(items: &mut [T], seed: u32) {
    let mut state = u64::from(seed);
    for at in (1..items.len()).rev() {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut drawn = (state ^ (state >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        drawn = (drawn ^ (drawn >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        drawn ^= drawn >> 31;
        // Its bias towards the first places is far too small to see.
        items.swap(at, (drawn % (at as u64 + 1)) as usize);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{board, element, id};
    use crate::{AssetId, Editor, Error, ImageEdits, Size, Text};

    fn image(x: f64, y: f64, width: f64, height: f64) -> ElementKind {
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
            rotation: 0.0,
            edits: ImageEdits::default(),
            source: None,
            filename: None,
            caption: None,
        }
    }

    fn named(name: Option<&str>, x: f64) -> ElementKind {
        let mut kind = image(x, 0.0, 100.0, 100.0);
        if let ElementKind::Image { filename, .. } = &mut kind {
            *filename = name.map(str::to_owned);
        }
        kind
    }

    fn note(x: f64, y: f64, target: Option<u128>) -> ElementKind {
        ElementKind::Note {
            frame: Rect {
                x,
                y,
                width: 40.0,
                height: 20.0,
            },
            rotation: 0.0,
            text: Text {
                content: "Note".to_owned(),
                font_size: 20.0,
            },
            target: target.map(id),
        }
    }

    /// The first element is 1, the next 2, and so on.
    fn editor(kinds: impl IntoIterator<Item = ElementKind>) -> Editor {
        let elements = kinds
            .into_iter()
            .zip(1..)
            .map(|(kind, bits)| (bits, element(None, &format!("a{bits}"), kind)));
        Editor::new(board(elements))
    }

    fn all(editor: &Editor) -> Vec<ElementId> {
        editor.board().elements.keys().copied().collect()
    }

    fn arranged(kinds: impl IntoIterator<Item = ElementKind>, order: Order) -> Editor {
        let mut editor = editor(kinds);
        editor.arrange(&all(&editor), &order).unwrap();
        editor
    }

    fn frame(editor: &Editor, bits: u128) -> Rect {
        match &editor.board().elements[&id(bits)].kind {
            ElementKind::Image { frame, .. } | ElementKind::Note { frame, .. } => *frame,
            _ => unreachable!(),
        }
    }

    fn at(editor: &Editor, bits: u128) -> (f64, f64) {
        let Rect { x, y, .. } = frame(editor, bits);
        (x, y)
    }

    fn reading(editor: &Editor) -> Vec<u128> {
        let mut found: Vec<(i64, i64, u128)> = (1..=editor.board().elements.len() as u128)
            .map(|bits| {
                let bounds = editor.board().bounds(&[id(bits)]).unwrap();
                (bounds.y.round() as i64, bounds.x.round() as i64, bits)
            })
            .collect();
        found.sort_unstable();
        found.into_iter().map(|(_, _, bits)| bits).collect()
    }

    #[test]
    fn images_pack_into_rows_from_their_top_left_a_grid_cell_apart() {
        let editor = arranged(
            [
                image(10.0, 400.0, 100.0, 100.0),
                image(300.0, 20.0, 100.0, 100.0),
                image(50.0, 50.0, 100.0, 100.0),
                image(700.0, 700.0, 100.0, 100.0),
            ],
            Order::Size,
        );

        assert_eq!(at(&editor, 2), (10.0, 20.0));
        assert_eq!(at(&editor, 3), (130.0, 20.0));
        assert_eq!(at(&editor, 1), (10.0, 140.0));
        assert_eq!(at(&editor, 4), (130.0, 140.0));
    }

    #[test]
    fn names_sort_as_people_read_them_and_the_unnamed_go_last() {
        let editor = arranged(
            [
                named(Some("img10.png"), 0.0),
                named(None, 200.0),
                named(Some("IMG2.png"), 400.0),
                named(Some("apple.jpg"), 600.0),
                named(Some("img02.png"), 800.0),
            ],
            Order::Name,
        );

        assert_eq!(reading(&editor), [4, 3, 5, 1, 2]);
    }

    #[test]
    fn sizes_go_largest_first_however_they_turn() {
        let mut turned = image(0.0, 0.0, 100.0, 200.0);
        if let ElementKind::Image { rotation, .. } = &mut turned {
            *rotation = 45.0;
        }
        let editor = arranged(
            [
                image(0.0, 0.0, 50.0, 50.0),
                image(100.0, 0.0, 300.0, 100.0),
                turned,
            ],
            Order::Size,
        );

        assert_eq!(reading(&editor), [2, 3, 1]);
    }

    #[test]
    fn colours_go_around_the_wheel_then_greys_from_light_to_dark_then_the_unknown() {
        let mut images: Vec<ElementKind> = (0..8)
            .map(|at| image(f64::from(at) * 100.0, 0.0, 100.0, 100.0))
            .collect();
        if let ElementKind::Image { edits, .. } = &mut images[4] {
            edits.greyscale = true;
        }
        let colours = [
            (1, [20, 30, 230]),
            (3, [40, 40, 40]),
            (4, [200, 30, 30]),
            (5, [0, 200, 0]),
            (6, [30, 180, 60]),
            (7, [250, 250, 250]),
            (8, [120, 128, 120]),
        ];
        let colours = colours.map(|(bits, colour)| (id(bits), colour));

        let editor = arranged(
            images,
            Order::Hue {
                colours: colours.into(),
            },
        );

        assert_eq!(reading(&editor), [4, 6, 1, 7, 5, 8, 3, 2]);
    }

    #[test]
    fn a_seed_shuffles_the_same_images_alike_wherever_they_lie() {
        let row = |step: f64| (0..6).map(move |at| image(f64::from(at) * step, 0.0, 10.0, 10.0));
        let shuffled = |step, seed| reading(&arranged(row(step), Order::Random { seed }));

        assert_eq!(shuffled(100.0, 7), shuffled(-30.0, 7));
        assert_ne!(shuffled(100.0, 7), shuffled(100.0, 8));
        let mut all = shuffled(100.0, 7);
        all.sort_unstable();
        assert_eq!(all, [1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn a_turned_image_takes_the_room_it_covers_and_keeps_its_size_and_turn() {
        let mut turned = image(0.0, 0.0, 200.0, 100.0);
        if let ElementKind::Image { rotation, .. } = &mut turned {
            *rotation = 90.0;
        }
        let editor = arranged(
            [turned.clone(), image(300.0, -50.0, 20.0, 20.0)],
            Order::Name,
        );

        assert_eq!(editor.board().elements[&id(1)].kind, turned);
        let (x, y) = at(&editor, 2);
        assert!(
            (x - 170.0).abs() < HAIR && (y + 50.0).abs() < HAIR,
            "{x}, {y}"
        );
    }

    #[test]
    fn other_elements_stay_but_what_sticks_to_an_image_follows_it() {
        let mut editor = editor([
            image(0.0, 0.0, 100.0, 100.0),
            image(500.0, 0.0, 100.0, 100.0),
            note(530.0, 40.0, Some(2)),
            note(900.0, 900.0, None),
        ]);

        let touched = editor.arrange(&all(&editor), &Order::Name).unwrap();

        assert_eq!(touched, [id(2), id(3)]);
        assert_eq!(at(&editor, 2), (0.0, 120.0));
        assert_eq!(at(&editor, 3), (30.0, 160.0));
        assert_eq!(at(&editor, 4), (900.0, 900.0));
    }

    #[test]
    fn arranging_undoes_in_one_step_and_again_changes_nothing() {
        let images = [
            image(0.0, 0.0, 100.0, 60.0),
            image(333.3, 77.7, 80.0, 120.0),
            image(-41.9, 500.1, 33.3, 33.3),
        ];
        let mut editor = editor(images);
        let before = editor.board().clone();
        let order = Order::Size;

        editor.arrange(&all(&editor), &order).unwrap();
        let after = editor.board().clone();

        assert_eq!(editor.arrange(&all(&editor), &order), Ok(Vec::new()));
        assert_eq!(editor.board(), &after);
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn images_alike_keep_the_order_they_read_in_and_arranging_again_changes_nothing() {
        let order = Order::Name;
        let turned = |x| {
            let mut kind = image(x, 0.1, 100.1, 70.3);
            if let ElementKind::Image { rotation, .. } = &mut kind {
                *rotation = 30.0;
            }
            kind
        };
        let stair = (0..5).map(|at| {
            image(
                0.7 + f64::from(at) * 150.0,
                0.7 - f64::from(at) * 0.1,
                100.1,
                70.3,
            )
        });

        let mut row = editor((0..4).map(|at| turned(0.1 + f64::from(at) * 150.0)));
        row.arrange(&all(&row), &order).unwrap();
        let mut stair = editor(stair);
        stair.arrange(&all(&stair), &order).unwrap();

        assert_eq!(stair.arrange(&all(&stair), &order), Ok(Vec::new()));
        assert_eq!(row.arrange(&all(&row), &order), Ok(Vec::new()));
        assert_eq!(reading(&row), [1, 2, 3, 4]);
    }

    #[test]
    fn a_row_packed_an_ulp_out_of_line_keeps_its_order_when_arranged_again() {
        // The turned image packs an ulp off the other's top, across a multiple of HAIR, so that
        // rounding each top to one would set them a row apart.
        let top = 15762.511666499999;
        let mut turned = image(700.0, 16063.0, 60.0, 1033.3);
        if let ElementKind::Image { rotation, .. } = &mut turned {
            *rotation = 180.0;
        }
        let mut editor = editor([image(0.0, top, 100.0, 1500.0), turned]);
        let order = Order::Name;

        editor.arrange(&all(&editor), &order).unwrap();

        assert_eq!(reading(&editor), [1, 2]);
        assert_eq!(editor.arrange(&all(&editor), &order), Ok(Vec::new()));
        assert_eq!(reading(&editor), [1, 2]);
    }

    #[test]
    fn an_order_reads_as_the_web_app_writes_it() {
        let read = |json: &str| serde_json::from_str::<Order>(json);

        assert_eq!(read(r#"{"by": "name"}"#).unwrap(), Order::Name);
        assert_eq!(read(r#"{"by": "size"}"#).unwrap(), Order::Size);
        assert_eq!(
            read(r#"{"by": "random", "seed": 4294967295}"#).unwrap(),
            Order::Random { seed: u32::MAX }
        );
        assert_eq!(
            read(&format!(
                r#"{{"by": "hue", "colours": {{"{}": [255, 0, 128]}}}}"#,
                id(1)
            ))
            .unwrap(),
            Order::Hue {
                colours: BTreeMap::from([(id(1), [255, 0, 128])])
            }
        );
        assert!(read(r#"{"by": "Name"}"#).is_err());
    }

    #[test]
    fn images_sized_alike_cover_their_mean_height_around_their_own_centres() {
        let mut editor = editor([
            image(0.0, 0.0, 100.0, 50.0),
            image(200.0, 0.0, 40.0, 150.0),
            note(500.0, 500.0, None),
        ]);

        editor.normalize(&all(&editor), Side::Height).unwrap();

        assert_eq!(
            frame(&editor, 1),
            Rect {
                x: -50.0,
                y: -25.0,
                width: 200.0,
                height: 100.0
            }
        );
        let Rect {
            x,
            y,
            width,
            height,
        } = frame(&editor, 2);
        assert!((x + width / 2.0 - 220.0).abs() < HAIR && (y - 25.0).abs() < HAIR);
        assert!((height - 100.0).abs() < HAIR && (width - 80.0 / 3.0).abs() < HAIR);
        assert_eq!(
            frame(&editor, 3),
            Rect {
                x: 500.0,
                y: 500.0,
                width: 40.0,
                height: 20.0
            }
        );
    }

    #[test]
    fn images_sized_alike_by_width_measure_what_they_cover_turned() {
        let mut turned = image(0.0, 0.0, 100.0, 50.0);
        if let ElementKind::Image { rotation, .. } = &mut turned {
            *rotation = 90.0;
        }
        let mut editor = editor([turned, image(300.0, 0.0, 150.0, 30.0)]);

        assert_eq!(
            editor
                .normalize(&all(&editor), Side::Width)
                .map(|ids| ids.len()),
            Ok(2)
        );
        for bits in [1, 2] {
            let width = editor.board().bounds(&[id(bits)]).unwrap().width;
            assert!((width - 100.0).abs() < HAIR, "{width}");
        }
        assert_eq!(editor.normalize(&all(&editor), Side::Width), Ok(Vec::new()));
    }

    #[test]
    fn an_unknown_element_is_refused_and_nothing_moves() {
        let mut editor = editor([image(0.0, 0.0, 10.0, 10.0), image(90.0, 90.0, 10.0, 10.0)]);
        let before = editor.board().clone();

        assert_eq!(
            editor.arrange(&[id(1), id(2), id(9)], &Order::Size),
            Err(Error::UnknownElement(id(9)))
        );
        assert_eq!(editor.board(), &before);
        assert!(!editor.can_undo());
    }
}
