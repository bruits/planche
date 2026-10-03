//! Lines elements up on a side or the middle of their extent, or spaces them evenly, each by the
//! box that holds it upright, its groups' elements included.

use serde::Deserialize;

use crate::arrange::HAIR;
use crate::{Board, ElementId, Point, Rect};

/// Which side, or which middle, of their extent [`crate::Editor::align`] lines elements up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Alignment {
    Left,
    /// Between the left and right sides.
    Centre,
    Right,
    Top,
    /// Between the top and bottom.
    Middle,
    Bottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Axis {
    Horizontal,
    Vertical,
}

/// How far each element among `ids` moves, none for those that lie where they go already.
pub(crate) fn alignment(
    board: &Board,
    ids: &[ElementId],
    to: Alignment,
) -> Vec<(ElementId, Point)> {
    let boxes = boxes(board, ids);
    let Some(all) = board.extent(ids).filter(|_| boxes.len() > 1) else {
        return Vec::new();
    };
    boxes
        .into_iter()
        .map(|(id, area)| {
            let (x, y) = match to {
                Alignment::Left => (all.x - area.x, 0.0),
                Alignment::Centre => (all.centre().x - area.centre().x, 0.0),
                Alignment::Right => (all.x + all.width - area.x - area.width, 0.0),
                Alignment::Top => (0.0, all.y - area.y),
                Alignment::Middle => (0.0, all.centre().y - area.centre().y),
                Alignment::Bottom => (0.0, all.y + all.height - area.y - area.height),
            };
            moved(id, Point { x, y })
        })
        .collect()
}

/// As [`alignment`] does, with three or more elements, in the order of their middles. The first
/// and last stay, and the gaps between them all come alike, or where the elements are too wide
/// for gaps, their middles come evenly apart instead. A gap within a hair of none counts as none.
pub(crate) fn distribution(
    board: &Board,
    ids: &[ElementId],
    axis: Axis,
) -> Vec<(ElementId, Point)> {
    let along = |area: &Rect| match axis {
        Axis::Horizontal => (area.x, area.width),
        Axis::Vertical => (area.y, area.height),
    };
    let middle = |area: &Rect| {
        let (start, length) = along(area);
        start + length / 2.0
    };
    let mut boxes = boxes(board, ids);
    if boxes.len() < 3 {
        return Vec::new();
    }
    boxes.sort_by(|(a, first), (b, second)| {
        middle(first)
            .total_cmp(&middle(second))
            .then(along(first).0.total_cmp(&along(second).0))
            .then(a.cmp(b))
    });
    // Neither way moves these two, so the next time takes the same way.
    let (start, _) = along(&boxes[0].1);
    let (last, length) = along(&boxes[boxes.len() - 1].1);
    let end = last + length;
    let lengths: f64 = boxes.iter().map(|(_, area)| along(area).1).sum();
    let count = (boxes.len() - 1) as f64;
    let gap = (end - start - lengths) / count;
    let first = middle(&boxes[0].1);
    let step = (middle(&boxes[boxes.len() - 1].1) - first) / count;
    let mut next = start;
    boxes
        .iter()
        .enumerate()
        .map(|(at, (id, area))| {
            let (from, length) = along(area);
            let by = if gap < -HAIR {
                first + step * at as f64 - middle(area)
            } else {
                next - from
            };
            next += length + gap;
            let (x, y) = match axis {
                Axis::Horizontal => (by, 0.0),
                Axis::Vertical => (0.0, by),
            };
            moved(*id, Point { x, y })
        })
        .collect()
}

/// Each of `ids` that takes room on the board, with the box that holds it upright.
fn boxes(board: &Board, ids: &[ElementId]) -> Vec<(ElementId, Rect)> {
    ids.iter()
        .filter_map(|id| Some((*id, board.extent(&[*id])?)))
        .collect()
}

/// No move when `by` is within a hair of none, as the arithmetic leaves what lines up already a
/// hair off.
fn moved(id: ElementId, by: Point) -> (ElementId, Point) {
    let still = by.x.abs() <= HAIR && by.y.abs() <= HAIR;
    (id, if still { Point { x: 0.0, y: 0.0 } } else { by })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{arrow, board, element, id};
    use crate::{AssetId, Colour, Editor, ElementKind, Error, ImageEdits, Size, Text};

    fn image(x: f64, y: f64, width: f64, height: f64) -> ElementKind {
        turned(x, y, width, height, 0.0)
    }

    fn turned(x: f64, y: f64, width: f64, height: f64, rotation: f64) -> ElementKind {
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
        }
    }

    fn editor(kinds: impl IntoIterator<Item = (u128, Option<u128>, ElementKind)>) -> Editor {
        let elements = kinds
            .into_iter()
            .enumerate()
            .map(|(at, (bits, group, kind))| (bits, element(group, &format!("a{at}"), kind)));
        Editor::new(board(elements))
    }

    fn ids(bits: &[u128]) -> Vec<ElementId> {
        bits.iter().copied().map(id).collect()
    }

    fn kind(editor: &Editor, bits: u128) -> &ElementKind {
        &editor.board().elements[&id(bits)].kind
    }

    fn at(editor: &Editor, bits: u128) -> (f64, f64) {
        match kind(editor, bits) {
            ElementKind::Image { frame, .. } | ElementKind::Note { frame, .. } => {
                (frame.x, frame.y)
            }
            ElementKind::Comment { at, .. } => (at.x, at.y),
            other => panic!("no frame: {other:?}"),
        }
    }

    fn assert_near(found: (f64, f64), expected: (f64, f64)) {
        assert!(
            (found.0 - expected.0).abs() < 1e-9 && (found.1 - expected.1).abs() < 1e-9,
            "{found:?} is not {expected:?}"
        );
    }

    #[test]
    fn elements_line_up_on_each_side_and_middle_of_their_extent() {
        let three = || {
            editor([
                (1, None, image(0.0, 0.0, 10.0, 10.0)),
                (2, None, image(30.0, 5.0, 20.0, 10.0)),
                (3, None, image(10.0, 40.0, 40.0, 20.0)),
            ])
        };
        let expected = [
            (Alignment::Left, [(0.0, 0.0), (0.0, 5.0), (0.0, 40.0)]),
            (Alignment::Centre, [(20.0, 0.0), (15.0, 5.0), (5.0, 40.0)]),
            (Alignment::Right, [(40.0, 0.0), (30.0, 5.0), (10.0, 40.0)]),
            (Alignment::Top, [(0.0, 0.0), (30.0, 0.0), (10.0, 0.0)]),
            (Alignment::Middle, [(0.0, 25.0), (30.0, 25.0), (10.0, 20.0)]),
            (Alignment::Bottom, [(0.0, 50.0), (30.0, 50.0), (10.0, 40.0)]),
        ];
        for (to, corners) in expected {
            let mut editor = three();
            editor.align(&ids(&[1, 2, 3]), to).unwrap();
            for (bits, corner) in [1, 2, 3].into_iter().zip(corners) {
                assert_near(at(&editor, bits), corner);
            }
        }
    }

    #[test]
    fn a_turned_image_lines_up_by_its_upright_box_a_group_whole_and_a_comment_by_its_pin() {
        let mut editor = editor([
            // Upright, it covers 10 to 30 across.
            (1, None, turned(0.0, 0.0, 40.0, 20.0, 90.0)),
            (2, None, ElementKind::Group),
            (3, Some(2), image(100.0, 0.0, 10.0, 10.0)),
            (4, Some(2), image(120.0, 0.0, 10.0, 10.0)),
            (
                5,
                None,
                ElementKind::Comment {
                    at: Point { x: 60.0, y: 0.0 },
                    text: String::new(),
                    target: None,
                },
            ),
        ]);
        let touched = editor.align(&ids(&[1, 2, 5]), Alignment::Left).unwrap();
        assert_eq!(touched, ids(&[3, 4, 5]));
        assert_near(at(&editor, 3), (10.0, 0.0));
        assert_near(at(&editor, 4), (30.0, 0.0));
        assert_near(at(&editor, 5), (10.0, 0.0));
    }

    #[test]
    fn what_sticks_to_another_of_them_follows_it_and_counts_for_nothing() {
        let note = ElementKind::Note {
            frame: Rect {
                x: 10.0,
                y: 10.0,
                width: 20.0,
                height: 20.0,
            },
            rotation: 0.0,
            text: Text::new("On it".to_owned(), 10.0),
            target: Some(id(1)),
            colour: Colour::Ink,
        };
        let mut pointing = arrow();
        let [(from, from_target), (to, _)] = pointing.ends_mut().unwrap();
        (*from, *from_target, *to) = (
            Point { x: 50.0, y: 50.0 },
            Some(id(1)),
            Point { x: 300.0, y: 300.0 },
        );
        let mut editor = editor([
            (1, None, image(0.0, 0.0, 100.0, 100.0)),
            (2, None, note),
            (3, None, image(200.0, 150.0, 50.0, 50.0)),
            (4, None, pointing),
        ]);
        editor
            .align(&ids(&[1, 2, 3, 4]), Alignment::Bottom)
            .unwrap();
        assert_near(at(&editor, 1), (0.0, 100.0));
        assert_near(at(&editor, 2), (10.0, 110.0));
        assert_near(at(&editor, 3), (200.0, 150.0));
        assert_eq!(kind(&editor, 2).target(), Some(id(1)));
        let ends = kind(&editor, 4).ends().unwrap();
        assert_eq!(
            ends.map(|(point, _)| (point.x, point.y)),
            [(50.0, 150.0), (300.0, 300.0)]
        );
        assert_eq!(ends[0].1, Some(id(1)));
    }

    #[test]
    fn an_end_moved_off_what_it_sticks_to_comes_free() {
        let mut pointing = arrow();
        let [(from, from_target), (to, _)] = pointing.ends_mut().unwrap();
        (*from, *from_target, *to) = (
            Point { x: 50.0, y: 50.0 },
            Some(id(1)),
            Point { x: 150.0, y: 50.0 },
        );
        let mut editor = editor([
            (1, None, image(0.0, 0.0, 100.0, 100.0)),
            (2, None, pointing),
            (3, None, image(300.0, 0.0, 50.0, 50.0)),
        ]);
        editor.align(&ids(&[2, 3]), Alignment::Right).unwrap();
        let ends = kind(&editor, 2).ends().unwrap();
        assert_eq!(
            ends.map(|(point, target)| (point.x, target)),
            [(250.0, None), (350.0, None)]
        );
        assert_near(at(&editor, 1), (0.0, 0.0));
    }

    #[test]
    fn doing_it_again_changes_nothing_and_undoing_takes_it_all_back() {
        let mut editor = editor([
            (1, None, turned(3.0, 7.0, 40.0, 20.0, 30.0)),
            (2, None, image(100.0, 0.0, 10.0, 10.0)),
            (3, None, image(51.0, 33.0, 10.0, 10.0)),
            (4, None, image(17.0, 90.0, 30.0, 10.0)),
        ]);
        let before = editor.board().clone();
        let all = ids(&[1, 2, 3, 4]);
        assert!(!editor.align(&all, Alignment::Centre).unwrap().is_empty());
        assert!(!editor.distribute(&all, Axis::Vertical).unwrap().is_empty());
        assert!(editor.align(&all, Alignment::Centre).unwrap().is_empty());
        assert!(editor.distribute(&all, Axis::Vertical).unwrap().is_empty());
        editor.undo();
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn distributing_makes_the_gaps_alike_and_keeps_the_outermost() {
        let mut across = editor([
            (1, None, image(0.0, 0.0, 10.0, 10.0)),
            (2, None, image(12.0, 3.0, 30.0, 10.0)),
            (3, None, image(100.0, 0.0, 20.0, 10.0)),
            (4, None, image(50.0, 9.0, 10.0, 10.0)),
        ]);
        across
            .distribute(&ids(&[1, 2, 3, 4]), Axis::Horizontal)
            .unwrap();
        let gap = 50.0 / 3.0;
        assert_near(at(&across, 1), (0.0, 0.0));
        assert_near(at(&across, 2), (10.0 + gap, 3.0));
        assert_near(at(&across, 4), (40.0 + 2.0 * gap, 9.0));
        assert_near(at(&across, 3), (100.0, 0.0));

        let mut down = editor([
            (1, None, image(0.0, 0.0, 10.0, 10.0)),
            (2, None, image(5.0, 10.0, 10.0, 10.0)),
            (3, None, image(0.0, 100.0, 10.0, 10.0)),
        ]);
        down.distribute(&ids(&[1, 2, 3]), Axis::Vertical).unwrap();
        assert_near(at(&down, 2), (5.0, 50.0));
    }

    #[test]
    fn elements_too_wide_for_gaps_get_their_middles_evenly_apart() {
        let mut editor = editor([
            (1, None, image(0.0, 0.0, 100.0, 10.0)),
            (2, None, image(10.0, 0.0, 100.0, 10.0)),
            (3, None, image(100.0, 0.0, 20.0, 10.0)),
        ]);
        editor
            .distribute(&ids(&[1, 2, 3]), Axis::Horizontal)
            .unwrap();
        assert_near(at(&editor, 1), (0.0, 0.0));
        assert_near(at(&editor, 2), (30.0, 0.0));
        assert_near(at(&editor, 3), (100.0, 0.0));
    }

    #[test]
    fn too_few_elements_change_nothing_and_an_unknown_one_is_refused() {
        let mut editor = editor([
            (1, None, image(0.0, 0.0, 10.0, 10.0)),
            (2, None, image(30.0, 5.0, 20.0, 10.0)),
        ]);
        assert!(
            editor
                .align(&ids(&[1]), Alignment::Left)
                .unwrap()
                .is_empty()
        );
        assert!(
            editor
                .distribute(&ids(&[1, 2]), Axis::Horizontal)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            editor.align(&ids(&[1, 9]), Alignment::Left),
            Err(Error::UnknownElement(id(9)))
        );
        assert!(!editor.can_undo());
    }

    #[test]
    fn alignments_and_axes_read_as_the_web_app_writes_them() {
        let alignment = |json: &str| serde_json::from_str::<Alignment>(json);
        assert_eq!(alignment(r#""centre""#).unwrap(), Alignment::Centre);
        assert_eq!(alignment(r#""middle""#).unwrap(), Alignment::Middle);
        assert!(alignment(r#""center""#).is_err());
        assert_eq!(
            serde_json::from_str::<Axis>(r#""vertical""#).unwrap(),
            Axis::Vertical
        );
    }

    fn note(x: f64, target: u128) -> ElementKind {
        ElementKind::Note {
            frame: Rect {
                x,
                y: 40.0,
                width: 20.0,
                height: 20.0,
            },
            rotation: 0.0,
            text: Text::new("On it".to_owned(), 10.0),
            target: Some(id(target)),
            colour: Colour::Ink,
        }
    }

    /// From `from`, free, to `to`, stuck to `on`.
    fn pointing(from: (f64, f64), to: (f64, f64), on: u128) -> ElementKind {
        let mut kind = arrow();
        let [(start, _), (end, target)] = kind.ends_mut().unwrap();
        (*start, *end, *target) = (
            Point {
                x: from.0,
                y: from.1,
            },
            Point { x: to.0, y: to.1 },
            Some(id(on)),
        );
        kind
    }

    #[test]
    fn an_end_left_off_another_of_them_by_a_move_of_its_own_comes_free() {
        // Stuck to the image, then to the note that rides on it.
        for on in [1, 2] {
            let mut editor = editor([
                (1, None, image(0.0, 0.0, 100.0, 100.0)),
                (2, None, note(40.0, 1)),
                (3, None, ElementKind::Group),
                (4, Some(3), image(200.0, 0.0, 50.0, 50.0)),
                (5, Some(3), pointing((225.0, 25.0), (50.0, 50.0), on)),
            ]);
            editor.align(&ids(&[1, 3]), Alignment::Centre).unwrap();
            assert_near(at(&editor, 1), (75.0, 0.0));
            let [_, (end, target)] = kind(&editor, 5).ends().unwrap();
            assert_eq!((end.x, target), (25.0, None));
        }
    }

    #[test]
    fn a_group_all_stuck_to_another_of_them_follows_it_as_a_lone_note_does() {
        let mut editor = editor([
            (1, None, image(0.0, 0.0, 100.0, 100.0)),
            (2, None, image(300.0, 0.0, 50.0, 50.0)),
            (3, None, ElementKind::Group),
            (4, Some(3), note(10.0, 1)),
            (5, Some(3), note(40.0, 1)),
            (6, None, note(70.0, 1)),
        ]);
        editor.align(&ids(&[1, 2, 3, 6]), Alignment::Right).unwrap();
        for (bits, x) in [(4, 260.0), (5, 290.0), (6, 320.0)] {
            assert_near(at(&editor, bits), (x, 40.0));
            assert_eq!(kind(&editor, bits).target(), Some(id(1)));
        }
    }

    /// Side by side from `x`, each touching the next.
    fn touching(x: f64, widths: [f64; 3]) -> Editor {
        let mut left = x;
        editor((1..).zip(widths).map(|(bits, width)| {
            let kind = image(left, 0.0, width, 10.0);
            left += width;
            (bits, None, kind)
        }))
    }

    #[test]
    fn elements_touching_stay_whatever_their_widths_sum_to_in_floats() {
        let mut editor = touching(17.9, [133.37, 133.37, 3.3]);
        assert!(
            editor
                .distribute(&ids(&[1, 2, 3]), Axis::Horizontal)
                .unwrap()
                .is_empty()
        );
        for x in [0.0, 17.9, -250.7, 4096.1] {
            for a in 1..20 {
                for b in 1..20 {
                    let widths = [f64::from(a) * 3.37, f64::from(b) * 1.1, 3.3];
                    let mut editor = touching(x, widths);
                    let moved = editor
                        .distribute(&ids(&[1, 2, 3]), Axis::Horizontal)
                        .unwrap();
                    assert!(moved.is_empty(), "{x} {widths:?}");
                    // Made up for by the gap after, so that the gaps come to none in all.
                    editor.translate(&ids(&[2]), 0.7, 0.0).unwrap();
                    editor
                        .distribute(&ids(&[1, 2, 3]), Axis::Horizontal)
                        .unwrap();
                    let again = editor
                        .distribute(&ids(&[1, 2, 3]), Axis::Horizontal)
                        .unwrap();
                    assert!(again.is_empty(), "again {x} {widths:?}");
                }
            }
        }
    }

    #[test]
    fn elements_too_wide_for_gaps_keep_their_middles_apart_the_second_time() {
        let pin = |x| ElementKind::Comment {
            at: Point { x, y: 0.0 },
            text: String::new(),
            target: None,
        };
        let mut editor = editor([
            (1, None, image(71.67, 200.0, 13.27, 10.0)),
            (2, None, image(-63.45, 200.0, 149.63, 10.0)),
            (3, None, pin(-46.58)),
            (4, None, pin(46.30)),
        ]);
        let all = ids(&[1, 2, 3, 4]);
        assert!(
            !editor
                .distribute(&all, Axis::Horizontal)
                .unwrap()
                .is_empty()
        );
        assert!(
            editor
                .distribute(&all, Axis::Horizontal)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_first_and_last_by_their_middles_stay_though_another_reaches_further() {
        let mut editor = editor([
            (1, None, image(0.0, 0.0, 10.0, 10.0)),
            (2, None, image(-40.0, 0.0, 100.0, 10.0)),
            (3, None, image(90.0, 0.0, 10.0, 10.0)),
        ]);
        editor
            .distribute(&ids(&[1, 2, 3]), Axis::Horizontal)
            .unwrap();
        assert_near(at(&editor, 1), (0.0, 0.0));
        assert_near(at(&editor, 2), (0.0, 0.0));
        assert_near(at(&editor, 3), (90.0, 0.0));
    }

    /// Across, with what each end sticks to.
    fn ends(editor: &Editor, bits: u128) -> [(f64, Option<ElementId>); 2] {
        kind(editor, bits)
            .ends()
            .unwrap()
            .map(|(point, target)| (point.x, target))
    }

    /// Group 10 holds image 11 and an arrow from it to image 1, whose corner is `one`. Image 2
    /// lies below, at `two` across and as wide as it says.
    fn linked(one: (f64, f64), two: (f64, f64)) -> Editor {
        let mut arrow = pointing((25.0, 25.0), (one.0 + 25.0, one.1 + 25.0), 1);
        let [(_, from), _] = arrow.ends_mut().unwrap();
        *from = Some(id(11));
        editor([
            (10, None, ElementKind::Group),
            (11, Some(10), image(0.0, 0.0, 50.0, 50.0)),
            (12, Some(10), arrow),
            (1, None, image(one.0, one.1, 50.0, 50.0)),
            (2, None, image(two.0, 100.0, two.1, 50.0)),
        ])
    }

    #[test]
    fn a_group_that_stays_keeps_what_it_holds_as_one_that_moves_does() {
        let all = ids(&[10, 1, 2]);
        // Centred already, the group stays, and image 1 leaves the arrow's end.
        let mut editor = linked((400.0, 0.0), (-100.0, 625.0));
        editor.align(&all, Alignment::Centre).unwrap();
        assert_eq!(ends(&editor, 12), [(25.0, Some(id(11))), (425.0, None)]);
        assert!(editor.align(&all, Alignment::Centre).unwrap().is_empty());
        // Five off centre, it moves five, the arrow with it.
        let mut editor = linked((400.0, 0.0), (-100.0, 635.0));
        editor.align(&all, Alignment::Centre).unwrap();
        assert_eq!(ends(&editor, 12), [(30.0, Some(id(11))), (430.0, None)]);
        // First by its middle, it stays as image 1 comes between.
        let mut editor = linked((200.0, 100.0), (1000.0, 50.0));
        editor.distribute(&all, Axis::Horizontal).unwrap();
        assert_eq!(ends(&editor, 12), [(25.0, Some(id(11))), (225.0, None)]);
        assert!(
            editor
                .distribute(&all, Axis::Horizontal)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn what_stays_keeps_what_it_sticks_to_or_not() {
        let mut free = note(10.0, 1);
        *free.target_mut().unwrap() = None;
        let mut lone = editor([
            (1, None, image(0.0, 0.0, 100.0, 100.0)),
            (2, None, free.clone()),
            (3, None, image(50.0, 200.0, 50.0, 50.0)),
        ]);
        let touched = lone.align(&ids(&[2, 3]), Alignment::Left).unwrap();
        assert_eq!(touched, ids(&[3]));
        assert_eq!(kind(&lone, 2), &free);
        // The group stays, and its note comes free of the image going from under it.
        let mut grouped = editor([
            (1, None, image(0.0, 0.0, 100.0, 100.0)),
            (2, None, ElementKind::Group),
            (3, Some(2), image(0.0, 200.0, 50.0, 50.0)),
            (4, Some(2), note(10.0, 1)),
        ]);
        grouped.align(&ids(&[1, 2]), Alignment::Bottom).unwrap();
        assert_near(at(&grouped, 1), (0.0, 150.0));
        assert_near(at(&grouped, 4), (10.0, 40.0));
        assert_eq!(kind(&grouped, 4).target(), None);
    }
}
