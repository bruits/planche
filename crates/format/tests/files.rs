use std::collections::BTreeSet;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

use board::{
    Align, Alignment, AssetHasher, AssetId, Background, Board, Colour, Corners, CropShape, Dash,
    Editor, Element, ElementId, ElementKind, Fill, Heads, ImageEdits, Opacity, Paper, Point, Rect,
    Restack, Shape, Size, Speed, Text, Tip, Trim, Weight, ZIndex,
};
use format::save::{Known, Save};
use format::{Error, Files, LeftOut, zip};

const NOTE: ElementId = ElementId::from_random(3);
const ELLIPSE: ElementId = ElementId::from_random(4);
const ARROW: ElementId = ElementId::from_random(5);
const STICKY: ElementId = ElementId::from_random(6);
const STROKE: ElementId = ElementId::from_random(12);
const IMAGE: &[u8] = b"not really a PNG";

fn frame(width: f64, height: f64) -> Rect {
    Rect {
        x: 0.0,
        y: 0.0,
        width,
        height,
    }
}

fn z(key: &str) -> ZIndex {
    key.parse().unwrap()
}

fn note(group: Option<ElementId>, text: &str) -> Element {
    Element {
        group,
        locked: false,
        z: z("a0"),
        kind: ElementKind::Note {
            frame: frame(200.0, 80.0),
            rotation: 0.0,
            text: Text::new(text.to_owned(), 20.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        },
    }
}

fn sample() -> Board {
    let group = ElementId::from_random(1);
    let elements = [
        (
            group,
            Element {
                group: None,
                locked: false,
                z: z("a0"),
                kind: ElementKind::group(),
            },
        ),
        (
            ElementId::from_random(2),
            Element {
                group: Some(group),
                locked: false,
                z: z("a1"),
                kind: ElementKind::Image {
                    asset: AssetId::of(IMAGE),
                    natural_size: Size {
                        width: 1280,
                        height: 960,
                    },
                    frame: frame(640.0, 480.0),
                    rotation: 90.0,
                    edits: ImageEdits {
                        crop: Some(frame(320.0, 240.0)),
                        flip_horizontal: true,
                        flip_vertical: false,
                        greyscale: true,
                        crop_shape: CropShape::Rectangle,
                        trim: None,
                        speed: Speed::NORMAL,
                    },
                    source: Some("https://example.com/harbour".to_owned()),
                    filename: Some("harbour.png".to_owned()),
                    // Quotes, a line break and accents, which JSON escapes or keeps as they are.
                    caption: Some("The \"old\" harbour\nlumière rasante".to_owned()),
                    opacity: Default::default(),
                },
            },
        ),
        (NOTE, note(Some(group), "Warm light from the left")),
        (
            ELLIPSE,
            Element {
                group: None,
                locked: false,
                z: z("a1"),
                kind: ElementKind::Shape {
                    frame: frame(100.0, 100.0),
                    rotation: -12.5,
                    shape: Shape::Ellipse,
                    corners: Default::default(),
                    text: Text::new("Key light".to_owned(), 16.0),
                    target: None,
                    colour: Colour::Ink,
                    weight: Weight::Medium,
                    fill: Fill::Hollow,
                    dash: Dash::Solid,
                    opacity: Default::default(),
                },
            },
        ),
        (
            ARROW,
            Element {
                group: None,
                locked: false,
                z: z("a2"),
                kind: ElementKind::Arrow {
                    from: Point { x: 0.0, y: 0.0 },
                    // Without serde_json's `float_roundtrip`, these read back one bit off.
                    to: Point {
                        x: 1.0 / 11.0,
                        y: 2.0 / 13.0,
                    },
                    from_target: Some(ELLIPSE),
                    to_target: Some(STICKY),
                    colour: Colour::Ink,
                    weight: Weight::Medium,
                    dash: Dash::Solid,
                    heads: Heads::End,
                    opacity: Default::default(),
                },
            },
        ),
        (
            STICKY,
            Element {
                group: None,
                locked: false,
                z: z("a3"),
                kind: ElementKind::Sticky {
                    frame: frame(160.0, 160.0),
                    rotation: 5.0,
                    text: Text::new("Try a warmer grade\nfor the dusk shots".to_owned(), 20.0),
                    target: None,
                    paper: Paper::Yellow,
                    opacity: Default::default(),
                },
            },
        ),
        (
            ElementId::from_random(7),
            Element {
                group: None,
                locked: false,
                z: z("a4"),
                kind: ElementKind::Line {
                    from: Point { x: -10.0, y: 5.0 },
                    to: Point { x: 30.0, y: 5.0 },
                    from_target: None,
                    to_target: None,
                    colour: Colour::Ink,
                    weight: Weight::Medium,
                    dash: Dash::Solid,
                    opacity: Default::default(),
                },
            },
        ),
        (
            ElementId::from_random(9),
            Element {
                group: None,
                locked: false,
                z: z("a6"),
                kind: ElementKind::Comment {
                    at: Point { x: 12.5, y: -3.0 },
                    text: "Too dark\nfor the mood".to_owned(),
                    target: Some(ELLIPSE),
                },
            },
        ),
        (
            ElementId::from_random(8),
            Element {
                group: None,
                locked: false,
                z: z("a5"),
                kind: ElementKind::Shape {
                    frame: frame(40.0, 40.0),
                    rotation: 0.0,
                    shape: Shape::Cross,
                    corners: Default::default(),
                    text: Text::new(String::new(), 20.0),
                    target: None,
                    colour: Colour::Ink,
                    weight: Weight::Medium,
                    fill: Fill::Hollow,
                    dash: Dash::Solid,
                    opacity: Default::default(),
                },
            },
        ),
        (
            STROKE,
            Element {
                group: None,
                locked: false,
                z: z("a7"),
                kind: ElementKind::Stroke {
                    tip: Tip::Pen,
                    frame: frame(60.0, 20.0),
                    rotation: 0.0,
                    points: vec![
                        Point { x: 0.0, y: 1.0 },
                        Point { x: 0.25, y: 0.0 },
                        Point { x: 1.0, y: 0.5 },
                    ],
                    target: None,
                    colour: Colour::Blue,
                    weight: Weight::Thin,
                    opacity: Default::default(),
                },
            },
        ),
    ];
    Board {
        elements: elements.into_iter().collect(),
        ..Board::default()
    }
}

fn changed(before: &Files, after: &Files) -> Vec<String> {
    let paths: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    paths
        .into_iter()
        .filter(|path| before.get(*path) != after.get(*path))
        .cloned()
        .collect()
}

#[test]
fn a_board_reads_back_as_written() {
    let board = sample();
    let files = format::write(&board).unwrap();
    let read = format::read(&files).unwrap().board;
    assert_eq!(read, board);
    assert_eq!(format::write(&read).unwrap(), files);
}

#[test]
fn an_edit_rewrites_one_file() {
    let mut board = sample();
    let before = format::write(&board).unwrap();
    if let ElementKind::Note { text, .. } = &mut board.elements.get_mut(&NOTE).unwrap().kind {
        text.content.push('!');
    }
    let after = format::write(&board).unwrap();

    assert!(before.keys().eq(after.keys()));
    assert_eq!(changed(&before, &after), [format!("elements/{NOTE}.json")]);
}

#[test]
fn restacking_rewrites_one_file() {
    let mut board = sample();
    let before = format::write(&board).unwrap();
    // Above the image, its only sibling in the group.
    board.elements.get_mut(&NOTE).unwrap().z = ZIndex::between(Some(&z("a1")), None).unwrap();
    let after = format::write(&board).unwrap();

    assert_eq!(changed(&before, &after), [format!("elements/{NOTE}.json")]);
    let order = format::read(&after).unwrap().board.draw_order();
    assert_eq!(
        order,
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map(ElementId::from_random)
    );
}

#[test]
fn every_edit_rewrites_its_own_files_and_undoes_to_the_same_bytes() {
    type Edit = fn(&mut Editor) -> board::Result<Vec<ElementId>>;
    fn id(bits: u128) -> ElementId {
        ElementId::from_random(bits)
    }
    let cases: [(Edit, &[u128]); 28] = [
        (
            |editor| editor.add(id(10), None, note(None, "New").kind),
            &[10],
        ),
        (
            |editor| editor.update(NOTE, note(None, "Cool light").kind),
            &[3],
        ),
        (|editor| editor.translate(&[id(1)], 8.0, -8.0), &[2, 3]),
        (
            |editor| editor.scale(&[id(1)], Point { x: 0.0, y: 0.0 }, 1.5),
            &[2, 3],
        ),
        (
            |editor| editor.rotate(&[id(1)], Point { x: 5.0, y: 5.0 }, 90.0),
            &[2, 3],
        ),
        // The note cannot flip.
        (|editor| editor.flip(&[id(1)], true), &[2]),
        (|editor| editor.restack(&[ELLIPSE], Restack::Front), &[4]),
        (
            |editor| editor.group(id(10), &[ELLIPSE, ARROW]),
            &[4, 5, 10],
        ),
        (|editor| editor.ungroup(id(1)), &[1, 2, 3]),
        (|editor| editor.set_locked(&[id(1)], true), &[1]),
        (|editor| editor.remove(&[ARROW]), &[5]),
        // The arrow's ends stick to the ellipse and the sticky note, and the comment to the
        // ellipse.
        (|editor| editor.translate(&[ELLIPSE], 8.0, -8.0), &[4, 5, 9]),
        (
            |editor| {
                let mut kind = editor.board().elements[&ELLIPSE].kind.clone();
                if let ElementKind::Shape { text, .. } = &mut kind {
                    text.content.push('!');
                }
                editor.update(ELLIPSE, kind)
            },
            &[4],
        ),
        (
            |editor| {
                let mut kind = editor.board().elements[&id(2)].kind.clone();
                if let ElementKind::Image { caption, .. } = &mut kind {
                    *caption = Some("The new harbour".to_owned());
                }
                editor.update(id(2), kind)
            },
            &[2],
        ),
        (
            |editor| editor.set_crop_shape(&[id(1)], CropShape::Ellipse),
            &[2],
        ),
        (|editor| editor.reset_crop(&[id(2)]), &[2]),
        (
            |editor| {
                let trim = Trim {
                    start: 0.25,
                    end: 1.5,
                };
                editor.set_trim(&[id(1)], Some(trim))
            },
            &[2],
        ),
        (
            |editor| editor.set_speed(&[id(2)], Speed::new(0.5).unwrap()),
            &[2],
        ),
        (|editor| editor.remove(&[STICKY]), &[5, 6]),
        (|editor| editor.remove(&[ELLIPSE]), &[4, 5, 9]),
        (|editor| editor.unstick(&[id(9)]), &[9]),
        // The ellipse comes to the sticky note's right side, the arrow and the comment with it.
        (
            |editor| editor.align(&[ELLIPSE, STICKY], Alignment::Right),
            &[4, 5, 9],
        ),
        // The cross lies whole on the note, and the comment off the ellipse it sticks to, on
        // the sticky note.
        (|editor| editor.land(&[id(8), id(9)]), &[8, 9]),
        // The stroke lies whole on the note.
        (|editor| editor.land(&[STROKE]), &[12]),
        (|editor| editor.translate(&[STROKE], 8.0, -8.0), &[12]),
        (
            |editor| editor.scale(&[STROKE], Point { x: 0.0, y: 0.0 }, 1.5),
            &[12],
        ),
        (
            |editor| editor.rotate(&[STROKE], Point { x: 5.0, y: 5.0 }, 90.0),
            &[12],
        ),
        (
            |editor| {
                let mut kind = editor.board().elements[&STROKE].kind.clone();
                if let ElementKind::Stroke { points, .. } = &mut kind {
                    points.push(Point { x: 1.0, y: 1.0 });
                }
                editor.update(STROKE, kind)
            },
            &[12],
        ),
    ];
    for (edit, touched) in cases {
        let mut editor = Editor::new(sample());
        let before = format::write(editor.board()).unwrap();
        let reported = edit(&mut editor).unwrap();
        let after = format::write(editor.board()).unwrap();
        let touched: Vec<ElementId> = touched.iter().copied().map(id).collect();
        assert_eq!(reported, touched);
        let expected: Vec<String> = touched
            .iter()
            .map(|id| format!("elements/{id}.json"))
            .collect();
        assert_eq!(changed(&before, &after), expected);

        assert_eq!(editor.undo(), reported);
        assert_eq!(format::write(editor.board()).unwrap(), before);
        assert_eq!(editor.redo(), reported);
        assert_eq!(format::write(editor.board()).unwrap(), after);
    }
}

#[test]
fn the_background_lives_in_the_manifest_and_only_once_chosen() {
    let mut editor = Editor::new(sample());
    let before = format::write(editor.board()).unwrap();
    assert_eq!(before["board.json"], b"{\n  \"version\": 1\n}\n");

    editor.set_background(Background::Dots);
    let after = format::write(editor.board()).unwrap();
    assert_eq!(changed(&before, &after), ["board.json"]);
    assert_eq!(
        after["board.json"],
        b"{\n  \"version\": 1,\n  \"background\": \"dots\"\n}\n"
    );
    assert_eq!(format::read(&after).unwrap().board, *editor.board());

    editor.undo();
    assert_eq!(format::write(editor.board()).unwrap(), before);
}

#[test]
fn an_unknown_background_is_refused() {
    let mut files = format::write(&sample()).unwrap();
    files.insert(
        "board.json".to_owned(),
        br#"{ "version": 1, "background": "stripes" }"#.to_vec(),
    );
    assert!(matches!(
        format::read(&files),
        Err(Error::Json { path, .. }) if path == "board.json"
    ));
}

#[test]
fn a_style_writes_only_what_differs_from_the_plain_one_and_reads_back() {
    let styled = |kind| Element {
        group: None,
        locked: false,
        z: z("a0"),
        kind,
    };
    let mut text = Text::new("Key light", 20.0);
    text.bold = true;
    text.align = Some(Align::Right);
    let shape = ElementKind::Shape {
        frame: frame(100.0, 50.0),
        rotation: 0.0,
        shape: Shape::Ellipse,
        corners: Default::default(),
        text,
        target: None,
        colour: Colour::Red,
        weight: Weight::Thick,
        dash: Dash::Dashed,
        fill: Fill::Tint,
        opacity: Default::default(),
    };
    let arrow = ElementKind::Arrow {
        from: Point { x: 0.0, y: 0.0 },
        to: Point { x: 10.0, y: 0.0 },
        from_target: None,
        to_target: None,
        colour: Colour::Rgb([0xec, 0x83, 0x53]),
        weight: Weight::Medium,
        dash: Dash::Dashed,
        heads: Heads::Both,
        opacity: Opacity::new(50).unwrap(),
    };
    let sticky = ElementKind::Sticky {
        frame: frame(160.0, 150.0),
        rotation: 0.0,
        text: Text::new("Try a warmer grade", 20.0),
        target: None,
        paper: Paper::Pink,
        opacity: Default::default(),
    };
    let group = ElementKind::Group {
        colour: Colour::Blue,
        fill: Fill::Tint,
        title: Some("Moods".to_owned()),
    };
    let framed = ElementId::from_random(9);
    let board = Board {
        elements: [
            (NOTE, shape),
            (ARROW, arrow),
            (STICKY, sticky),
            (framed, group),
        ]
        .into_iter()
        .map(|(id, kind)| (id, styled(kind)))
        .collect(),
        ..Board::default()
    };
    let files = format::write(&board).unwrap();
    let written = |id: ElementId| {
        let bytes = &files[&format!("elements/{id}.json")];
        serde_json::from_slice::<serde_json::Value>(bytes).unwrap()["kind"].clone()
    };
    let shape = written(NOTE);
    assert_eq!(shape["colour"], "red");
    assert_eq!(shape["weight"], "thick");
    assert_eq!(shape["dash"], "dashed");
    assert_eq!(shape["fill"], "tint");
    assert_eq!(
        shape["text"],
        serde_json::json!({
            "content": "Key light",
            "font_size": 20.0,
            "bold": true,
            "align": "right"
        })
    );
    let arrow = written(ARROW);
    assert_eq!(arrow["colour"], "#ec8353");
    assert_eq!(arrow["dash"], "dashed");
    assert_eq!(arrow["heads"], "both");
    assert!(arrow.get("weight").is_none());
    assert_eq!(arrow["opacity"], 50);
    assert!(shape.get("opacity").is_none());
    assert_eq!(written(STICKY)["paper"], "pink");
    assert_eq!(
        written(framed),
        serde_json::json!({
            "type": "group",
            "colour": "blue",
            "fill": "tint",
            "title": "Moods"
        })
    );
    assert_eq!(format::read(&files).unwrap().board, board);
}

#[test]
fn a_crop_shape_is_written_only_once_not_a_rectangle_and_reads_back() {
    let image = ElementId::from_random(2);
    let mut editor = Editor::new(sample());
    let shape = |files: &Files| {
        let bytes = &files[&format!("elements/{image}.json")];
        serde_json::from_slice::<serde_json::Value>(bytes).unwrap()["kind"]["edits"]
            .get("crop_shape")
            .cloned()
    };
    assert_eq!(shape(&format::write(editor.board()).unwrap()), None);

    editor.set_crop_shape(&[image], CropShape::Ellipse).unwrap();

    let files = format::write(editor.board()).unwrap();
    assert_eq!(shape(&files), Some("ellipse".into()));
    assert_eq!(format::read(&files).unwrap().board, *editor.board());
}

#[test]
fn a_lock_is_written_only_once_set_and_reads_back() {
    let mut editor = Editor::new(sample());
    let locked = |files: &Files| {
        let bytes = &files[&format!("elements/{NOTE}.json")];
        serde_json::from_slice::<serde_json::Value>(bytes).unwrap()["locked"].as_bool()
    };
    assert_eq!(locked(&format::write(editor.board()).unwrap()), None);

    editor.set_locked(&[NOTE], true).unwrap();

    let files = format::write(editor.board()).unwrap();
    assert_eq!(locked(&files), Some(true));
    assert_eq!(format::read(&files).unwrap().board, *editor.board());
}

#[test]
fn a_trim_and_a_speed_are_written_only_once_set_and_read_back() {
    let image = ElementId::from_random(2);
    let mut editor = Editor::new(sample());
    let edits = |files: &Files| {
        let bytes = &files[&format!("elements/{image}.json")];
        let edits = &serde_json::from_slice::<serde_json::Value>(bytes).unwrap()["kind"]["edits"];
        (edits.get("trim").cloned(), edits.get("speed").cloned())
    };
    assert_eq!(edits(&format::write(editor.board()).unwrap()), (None, None));

    let trim = Trim {
        start: 0.25,
        end: 1.5,
    };
    editor.set_trim(&[image], Some(trim)).unwrap();
    editor
        .set_speed(&[image], Speed::new(1.5).unwrap())
        .unwrap();

    let files = format::write(editor.board()).unwrap();
    assert_eq!(
        edits(&files),
        (
            Some(serde_json::json!({ "start": 0.25, "end": 1.5 })),
            Some(1.5.into())
        )
    );
    assert_eq!(format::read(&files).unwrap().board, *editor.board());
}

#[test]
fn a_colour_has_one_spelling() {
    for colour in ["\"crimson\"", "\"#EC8353\"", "\"#ec835\"", "\"Red\""] {
        let mut files = format::write(&sample()).unwrap();
        let path = format!("elements/{NOTE}.json");
        let note = String::from_utf8(files[&path].clone()).unwrap();
        let note = note.replace(
            "\"type\": \"note\",",
            &format!("\"type\": \"note\",\n    \"colour\": {colour},"),
        );
        files.insert(path.clone(), note.into_bytes());
        let reading = format::read(&files).unwrap();
        assert!(!reading.board.elements.contains_key(&NOTE));
        assert!(
            matches!(&reading.left_out[..], [LeftOut { path: at, error: Error::Json { .. } }] if *at == path),
            "{colour}"
        );
    }
}

#[test]
fn concurrent_additions_merge_cleanly() {
    let base = sample();
    let mut ours = base.clone();
    let mut theirs = base.clone();
    let (mine, yours) = (ElementId::from_random(10), ElementId::from_random(11));
    ours.elements.insert(mine, note(None, "Mine"));
    theirs.elements.insert(yours, note(None, "Yours"));
    let before = format::write(&base).unwrap();
    let ours = format::write(&ours).unwrap();
    let theirs = format::write(&theirs).unwrap();

    // Git merges file by file, so disjoint changes take the union of both sides.
    assert_eq!(changed(&before, &ours), [format!("elements/{mine}.json")]);
    assert_eq!(
        changed(&before, &theirs),
        [format!("elements/{yours}.json")]
    );
    let mut merged = ours;
    merged.extend(theirs);
    let merged = format::read(&merged).unwrap().board;
    assert!(merged.elements.contains_key(&mine) && merged.elements.contains_key(&yours));
}

#[test]
fn a_deletion_drops_one_element_file() {
    let mut board = sample();
    let before = format::write(&board).unwrap();
    board.elements.remove(&NOTE);
    let after = format::write(&board).unwrap();

    let dropped: Vec<&str> = before
        .keys()
        .filter(|path| !after.contains_key(*path))
        .map(String::as_str)
        .collect();
    assert_eq!(dropped, [format!("elements/{NOTE}.json")]);
    assert!(dropped.iter().all(|path| format::is_element_file(path)));
}

#[test]
fn an_element_is_plain_json() {
    let files = format::write(&sample()).unwrap();
    let note = String::from_utf8(files[&format!("elements/{NOTE}.json")].clone()).unwrap();
    assert_eq!(
        note,
        r#"{
  "group": "00000000000000000000000000000001",
  "z": "a0",
  "kind": {
    "type": "note",
    "frame": {
      "x": 0.0,
      "y": 0.0,
      "width": 200.0,
      "height": 80.0
    },
    "text": {
      "content": "Warm light from the left",
      "font_size": 20.0
    }
  }
}
"#
    );
}

#[test]
fn an_image_neither_turned_nor_edited_writes_neither() {
    let mut board = sample();
    let image = ElementId::from_random(2);
    let ElementKind::Image {
        rotation, edits, ..
    } = &mut board.elements.get_mut(&image).unwrap().kind
    else {
        unreachable!()
    };
    (*rotation, *edits) = (-0.0, ImageEdits::default());
    let mut files = format::write(&board).unwrap();
    let path = format!("elements/{image}.json");
    let written = String::from_utf8(files[&path].clone()).unwrap();
    assert!(!written.contains("rotation") && !written.contains("edits"));

    // As written by hand.
    let spelled = written.replace(
        "\"type\": \"image\",",
        "\"type\": \"image\",\n    \"rotation\": 0.0,\n    \"edits\": {},",
    );
    files.insert(path, spelled.into_bytes());
    assert_eq!(format::read(&files).unwrap().board, board);
}

#[test]
fn a_pen_stroke_writes_each_number_of_its_points_on_a_line() {
    let files = format::write(&sample()).unwrap();
    let stroke = String::from_utf8(files[&format!("elements/{STROKE}.json")].clone()).unwrap();
    assert_eq!(
        stroke,
        r#"{
  "z": "a7",
  "kind": {
    "type": "stroke",
    "frame": {
      "x": 0.0,
      "y": 0.0,
      "width": 60.0,
      "height": 20.0
    },
    "points": [
      0.0,
      1.0,
      0.25,
      0.0,
      1.0,
      0.5
    ],
    "colour": "blue",
    "weight": "thin"
  }
}
"#
    );
}

#[test]
fn a_stroke_names_what_it_sticks_to_after_its_points_and_reads_back() {
    let mut board = sample();
    if let ElementKind::Stroke { target, .. } = &mut board.elements.get_mut(&STROKE).unwrap().kind {
        *target = Some(NOTE);
    }
    let files = format::write(&board).unwrap();
    assert_eq!(format::read(&files).unwrap().board, board);
    let stroke = String::from_utf8(files[&format!("elements/{STROKE}.json")].clone()).unwrap();
    assert_eq!(
        stroke,
        r#"{
  "z": "a7",
  "kind": {
    "type": "stroke",
    "frame": {
      "x": 0.0,
      "y": 0.0,
      "width": 60.0,
      "height": 20.0
    },
    "points": [
      0.0,
      1.0,
      0.25,
      0.0,
      1.0,
      0.5
    ],
    "target": "00000000000000000000000000000003",
    "colour": "blue",
    "weight": "thin"
  }
}
"#
    );
}

#[test]
fn an_arrow_names_what_its_ends_stick_to() {
    let files = format::write(&sample()).unwrap();
    let arrow = String::from_utf8(files[&format!("elements/{ARROW}.json")].clone()).unwrap();
    assert_eq!(
        arrow,
        r#"{
  "z": "a2",
  "kind": {
    "type": "arrow",
    "from": {
      "x": 0.0,
      "y": 0.0
    },
    "to": {
      "x": 0.09090909090909091,
      "y": 0.15384615384615385
    },
    "from_target": "00000000000000000000000000000004",
    "to_target": "00000000000000000000000000000006"
  }
}
"#
    );
}

#[test]
fn an_image_says_where_it_came_from_and_what_it_shows() {
    let image = ElementId::from_random(2);
    let files = format::write(&sample()).unwrap();
    let written = String::from_utf8(files[&format!("elements/{image}.json")].clone()).unwrap();
    assert_eq!(
        written,
        r#"{
  "group": "00000000000000000000000000000001",
  "z": "a1",
  "kind": {
    "type": "image",
    "asset": "ASSET",
    "natural_size": {
      "width": 1280,
      "height": 960
    },
    "frame": {
      "x": 0.0,
      "y": 0.0,
      "width": 640.0,
      "height": 480.0
    },
    "rotation": 90.0,
    "edits": {
      "crop": {
        "x": 0.0,
        "y": 0.0,
        "width": 320.0,
        "height": 240.0
      },
      "flip_horizontal": true,
      "flip_vertical": false,
      "greyscale": true
    },
    "source": "https://example.com/harbour",
    "filename": "harbour.png",
    "caption": "The \"old\" harbour\nlumière rasante"
  }
}
"#
        .replace("ASSET", &AssetId::of(IMAGE).to_string())
    );
}

#[test]
fn line_endings_are_kept_out_of_git() {
    let (path, attributes) = format::git_attributes();
    assert_eq!(path, ".gitattributes");
    assert!(attributes.starts_with(b"* -text\n"));
    let files = format::write(&sample()).unwrap();

    // What Git checks out on Windows unless told otherwise.
    let crlf: Files = files
        .iter()
        .map(|(path, bytes)| {
            let text = String::from_utf8(bytes.clone()).unwrap();
            (path.clone(), text.replace('\n', "\r\n").into_bytes())
        })
        .collect();
    assert_eq!(format::read(&crlf).unwrap().board, sample());
}

#[test]
fn equal_boards_write_the_same_bytes() {
    // Zero in every float field that the sample leaves non-zero.
    let mut board = sample();
    let zero = frame(0.0, 0.0);
    let image = ElementKind::Image {
        asset: AssetId::of(IMAGE),
        natural_size: Size {
            width: 1,
            height: 1,
        },
        frame: zero,
        rotation: 0.0,
        edits: ImageEdits {
            crop: Some(zero),
            ..ImageEdits::default()
        },
        source: None,
        filename: None,
        caption: None,
        opacity: Default::default(),
    };
    let shape = ElementKind::Shape {
        frame: zero,
        rotation: 0.0,
        shape: Shape::Rectangle,
        corners: Default::default(),
        text: Text::new(String::new(), 1.0),
        target: None,
        colour: Colour::Ink,
        weight: Weight::Medium,
        fill: Fill::Hollow,
        dash: Dash::Solid,
        opacity: Default::default(),
    };
    for (bits, kind) in [(20, image), (21, shape)] {
        let element = Element {
            group: None,
            locked: false,
            z: z("a0"),
            kind,
        };
        board.elements.insert(ElementId::from_random(bits), element);
    }
    let files = format::write(&board).unwrap();
    let negated: Files = files
        .iter()
        .map(|(path, bytes)| {
            let text = String::from_utf8(bytes.clone()).unwrap();
            let text = text
                .replace(": 0.0,", ": -0.0,")
                .replace(": 0.0\n", ": -0.0\n");
            (path.clone(), text.into_bytes())
        })
        .collect();
    assert_ne!(negated, files);
    let read = format::read(&negated).unwrap().board;
    assert_eq!(read, board);
    assert_eq!(format::write(&read).unwrap(), files);
}

#[test]
fn a_nan_is_refused_on_write() {
    let mut board = sample();
    if let ElementKind::Arrow { to, .. } = &mut board.elements.get_mut(&ARROW).unwrap().kind {
        to.x = f64::NAN;
    }
    assert!(matches!(format::write(&board), Err(Error::Invalid(ARROW))));
}

#[test]
fn text_of_no_size_is_refused_on_read() {
    let mut files = format::write(&sample()).unwrap();
    let path = format!("elements/{NOTE}.json");
    let note = String::from_utf8(files[&path].clone()).unwrap();
    let sizeless = note.replace(r#""font_size": 20.0"#, r#""font_size": 0.0"#);
    assert_ne!(sizeless, note);
    files.insert(path.clone(), sizeless.into_bytes());
    let reading = format::read(&files).unwrap();
    assert!(!reading.board.elements.contains_key(&NOTE));
    assert!(
        matches!(&reading.left_out[..], [LeftOut { path: at, error: Error::Invalid(NOTE) }] if *at == path)
    );
}

#[test]
fn an_opacity_that_would_hide_an_element_is_refused_on_read() {
    let mut files = format::write(&sample()).unwrap();
    let path = format!("elements/{NOTE}.json");
    let mut note: serde_json::Value = serde_json::from_slice(&files[&path]).unwrap();
    note["kind"]["opacity"] = serde_json::json!(0);
    files.insert(path.clone(), serde_json::to_vec(&note).unwrap());
    let reading = format::read(&files).unwrap();
    assert!(
        matches!(&reading.left_out[..], [LeftOut { path: at, error: Error::Json { .. } }] if *at == path)
    );
}

#[test]
fn a_star_or_a_polygon_writes_its_corners_only_when_not_five_and_reads_back() {
    let drawn = [
        (Shape::Star, 7),
        (Shape::Star, 5),
        (Shape::Polygon, 3),
        (Shape::Polygon, 12),
        (Shape::Triangle, 5),
        (Shape::Diamond, 5),
    ];
    let board = Board {
        elements: drawn
            .iter()
            .zip(1..)
            .map(|(&(shape, corners), bits)| {
                let kind = ElementKind::Shape {
                    frame: frame(100.0, 80.0),
                    rotation: 0.0,
                    shape,
                    corners: Corners::new(corners).unwrap(),
                    text: Text::new(String::new(), 20.0),
                    target: None,
                    colour: Colour::Ink,
                    weight: Weight::Medium,
                    fill: Fill::Solid,
                    dash: Dash::Solid,
                    opacity: Default::default(),
                };
                let element = Element {
                    group: None,
                    locked: false,
                    z: z("a0"),
                    kind,
                };
                (ElementId::from_random(bits), element)
            })
            .collect(),
        ..Board::default()
    };
    let files = format::write(&board).unwrap();
    let written: Vec<serde_json::Value> = (1..=6)
        .map(|bits| {
            let bytes = &files[&format!("elements/{}.json", ElementId::from_random(bits))];
            serde_json::from_slice::<serde_json::Value>(bytes).unwrap()["kind"].clone()
        })
        .collect();
    let corners: Vec<Option<u64>> = written
        .iter()
        .map(|kind| kind.get("corners").map(|corners| corners.as_u64().unwrap()))
        .collect();
    assert_eq!(corners, [Some(7), None, Some(3), Some(12), None, None]);
    assert_eq!(written[0]["shape"], "star");
    assert_eq!(written[3]["shape"], "polygon");
    assert_eq!(written[4]["shape"], "triangle");
    assert_eq!(written[5]["shape"], "diamond");
    assert_eq!(format::read(&files).unwrap().board, board);
    assert_eq!(
        format::write(&format::read(&files).unwrap().board).unwrap(),
        files
    );
}

#[test]
fn corners_a_star_or_a_polygon_cannot_have_are_refused_on_read() {
    for corners in [2, 13] {
        let mut files = format::write(&sample()).unwrap();
        let path = format!("elements/{ELLIPSE}.json");
        let mut shape: serde_json::Value = serde_json::from_slice(&files[&path]).unwrap();
        shape["kind"]["shape"] = serde_json::json!("star");
        shape["kind"]["corners"] = serde_json::json!(corners);
        files.insert(path.clone(), serde_json::to_vec(&shape).unwrap());
        let reading = format::read(&files).unwrap();
        assert!(
            matches!(&reading.left_out[..], [LeftOut { path: at, error: Error::Json { .. } }] if *at == path),
            "{corners}"
        );
    }
}

#[test]
fn only_this_version_of_the_format_is_read() {
    assert!(matches!(
        format::read(&Files::new()),
        Err(Error::MissingManifest)
    ));
    let mut files = format::write(&sample()).unwrap();
    files.insert("board.json".to_owned(), br#"{ "version": 2 }"#.to_vec());
    assert!(matches!(
        format::read(&files),
        Err(Error::UnsupportedVersion(2))
    ));
}

#[test]
fn stray_files_are_not_part_of_the_board() {
    let board = sample();
    let mut files = format::write(&board).unwrap();
    for stray in [
        ".gitattributes".to_owned(),
        "elements/".to_owned(),
        "elements/.DS_Store".to_owned(),
        "elements/.trash/00000000000000000000000000000009.json".to_owned(),
        format!("elements/{NOTE}.json.orig"),
        "assets/Thumbs.db".to_owned(),
    ] {
        assert!(!format::is_element_file(&stray), "{stray}");
        assert!(!format::is_asset_file(&stray), "{stray}");
        files.insert(stray, vec![0]);
    }
    assert_eq!(format::read(&files).unwrap().board, board);
}

#[test]
fn only_a_file_named_after_its_digest_is_an_asset() {
    let asset = format::asset_path(AssetId::of(IMAGE));
    assert!(format::is_asset_file(&asset));
    for stray in [
        "assets/js/app.js".to_owned(),
        "assets/".to_owned(),
        asset.to_uppercase().replace("ASSETS/", "assets/"),
        format!("{asset}/inside"),
    ] {
        assert!(!format::is_asset_file(&stray), "{stray}");
    }
}

#[test]
fn a_conflicted_copy_is_left_out_and_told_apart() {
    let board = sample();
    let mut files = format::write(&board).unwrap();
    let copy = format!("elements/{NOTE} (conflicted copy).json");
    assert!(!format::is_board_file(&copy));
    assert!(format::is_stray_element(&copy));
    assert!(!format::is_stray_element(&format!("elements/{NOTE}.json")));
    files.insert(copy, files[&format!("elements/{NOTE}.json")].clone());
    assert_eq!(format::read(&files).unwrap().board, board);
}

#[test]
fn a_save_writes_only_the_files_whose_bytes_changed() {
    let mut editor = Editor::new(sample());
    let files = format::write(editor.board()).unwrap();
    let mut listed: Vec<String> = files.keys().cloned().collect();
    listed.push(format::asset_path(AssetId::of(IMAGE)));
    let mut known = Known::new(listed, files);
    let everything: Vec<ElementId> = editor.board().elements.keys().copied().collect();
    assert_eq!(
        known.save(editor.board(), everything.clone()).unwrap(),
        Save::default()
    );

    let mut touched = editor.translate(&[ELLIPSE], 8.0, -8.0).unwrap();
    touched.extend(editor.remove(&[STICKY]).unwrap());
    // Touched, but back as it was.
    touched.extend(editor.translate(&[NOTE], 1.0, 0.0).unwrap());
    touched.extend(editor.translate(&[NOTE], -1.0, 0.0).unwrap());
    editor.set_background(Background::Grid);
    let save = known.save(editor.board(), touched).unwrap();

    let after = format::write(editor.board()).unwrap();
    let written: Vec<&str> = save.files.iter().map(|(path, _)| path.as_str()).collect();
    let mut expected: Vec<String> = [ELLIPSE, ARROW, ElementId::from_random(9)]
        .map(|id| format!("elements/{id}.json"))
        .into();
    expected.push("board.json".to_owned());
    assert_eq!(written, expected);
    assert!(save.files.iter().all(|(path, bytes)| after[path] == *bytes));
    assert_eq!(save.deletions, [format!("elements/{STICKY}.json")]);
    assert!(save.assets.is_empty());

    for (path, bytes) in save.files {
        known.wrote(&path, bytes);
    }
    for path in &save.deletions {
        known.deleted(path);
    }
    assert_eq!(
        known.save(editor.board(), everything).unwrap(),
        Save::default()
    );
}

#[test]
fn a_first_save_copies_the_images_then_writes_the_manifest_before_every_element() {
    let board = sample();
    let save = Known::default()
        .save(&board, board.elements.keys().copied())
        .unwrap();
    assert_eq!(save.assets, [format::asset_path(AssetId::of(IMAGE))]);
    // Cut after any of them, the folder still reads as a board.
    assert_eq!(save.files.first().unwrap().0, "board.json");
    let files: Files = save.files.into_iter().collect();
    let mut written = format::write(&board).unwrap();
    // The shell's to write, and only into a folder that lacks it.
    written.remove(".gitattributes");
    assert_eq!(files, written);
    assert!(save.deletions.is_empty());
}

#[test]
fn a_save_deletes_only_the_element_files_it_knew() {
    let board = sample();
    let files = format::write(&board).unwrap();
    let known = Known::new(files.keys().cloned().collect::<Vec<_>>(), files);
    // Added by another program since the board was read, and so not on this board.
    let theirs = ElementId::from_random(42);
    assert!(known.save(&board, [theirs]).unwrap().deletions.is_empty());
}

#[test]
fn an_overwrite_leaves_the_folder_holding_this_board_alone() {
    let ours = sample();
    // Read again once another program moved the note and added an element.
    let mut theirs = sample();
    theirs.elements.get_mut(&NOTE).unwrap().z = z("a9");
    let added = ElementId::from_random(42);
    theirs.elements.insert(added, note(None, "Theirs"));
    let files = format::write(&theirs).unwrap();
    let known = Known::new(files.keys().cloned().collect::<Vec<_>>(), files);

    let save = known.overwrite(&ours, []).unwrap();
    let written: Vec<&str> = save.files.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(written, [format!("elements/{NOTE}.json")]);
    assert_eq!(save.deletions, [format!("elements/{added}.json")]);
}

#[test]
fn a_damaged_element_file_is_left_out_and_named() {
    let path = format!("elements/{NOTE}.json");
    let files = format::write(&sample()).unwrap();
    let good = String::from_utf8(files[&path].clone()).unwrap();
    let conflicted = format!("<<<<<<< ours\n{good}=======\n{good}>>>>>>> theirs\n");
    for (damaged, conflict) in [
        (conflicted.as_bytes(), true),
        (&good.as_bytes()[..good.len() / 2], false),
        (b"", false),
    ] {
        let mut files = files.clone();
        files.insert(path.clone(), damaged.to_vec());
        let reading = format::read(&files).unwrap();
        let [left_out] = &reading.left_out[..] else {
            panic!("{:?}", reading.left_out)
        };
        assert_eq!(left_out.path, path);
        assert_eq!(matches!(left_out.error, Error::Conflict(_)), conflict);
        assert!(!reading.board.elements.contains_key(&NOTE));
        assert_eq!(reading.board.elements.len(), sample().elements.len() - 1);
    }
}

#[test]
fn a_board_file_that_cannot_be_read_refuses_the_board() {
    let files = format::write(&sample()).unwrap();
    let good = String::from_utf8(files["board.json"].clone()).unwrap();
    let conflicted = format!("<<<<<<< ours\n{good}=======\n{good}>>>>>>> theirs\n");
    for (manifest, text) in [
        (
            conflicted.as_str(),
            "`board.json` holds an unresolved Git conflict",
        ),
        (
            r#"{ "version": 1, "unknown": 1 }"#,
            "unknown field `unknown`",
        ),
        (r#"{ "version": 1"#, "EOF"),
    ] {
        let mut files = files.clone();
        files.insert("board.json".to_owned(), manifest.as_bytes().to_vec());
        let error = format::read(&files).unwrap_err();
        assert!(error.to_string().contains(text), "{error}");
    }
    // A later version may hold keys this one refuses.
    let mut files = files;
    files.insert(
        "board.json".to_owned(),
        br#"{ "version": 2, "future": true }"#.to_vec(),
    );
    assert!(matches!(
        format::read(&files),
        Err(Error::UnsupportedVersion(2))
    ));
}

#[test]
fn an_unknown_key_leaves_the_file_out_and_names_the_key() {
    let group = ElementId::from_random(1);
    // Deep in a note, and in a group.
    for (id, at) in [(NOTE, &["kind", "text"][..]), (group, &["kind"])] {
        let path = format!("elements/{id}.json");
        let mut files = format::write(&sample()).unwrap();
        let mut element: serde_json::Value = serde_json::from_slice(&files[&path]).unwrap();
        let held = at.iter().fold(&mut element, |value, key| &mut value[*key]);
        held["glow"] = serde_json::json!("red");
        files.insert(path.clone(), serde_json::to_vec(&element).unwrap());
        let reading = format::read(&files).unwrap();
        let [left_out] = &reading.left_out[..] else {
            panic!("{:?}", reading.left_out)
        };
        let error = left_out.error.to_string();
        assert!(
            error.contains("unknown field `glow`") && error.contains(&path),
            "{error}"
        );
    }
}

#[test]
fn an_overwrite_never_deletes_a_file_that_is_left_out() {
    let ours = sample();
    let mut theirs = sample();
    let added = ElementId::from_random(42);
    theirs.elements.insert(added, note(None, "Theirs"));
    // Left out when read, and fixed since.
    let fixed = ElementId::from_random(44);
    theirs.elements.insert(fixed, note(None, "Resolved"));
    let mut files = format::write(&theirs).unwrap();
    // Left out if read now.
    let conflicted = ElementId::from_random(43);
    files.insert(
        format!("elements/{conflicted}.json"),
        b"<<<<<<< ours\n".to_vec(),
    );
    let known = Known::new(files.keys().cloned().collect::<Vec<_>>(), files);

    let left_out = format!("elements/{fixed}.json");
    let save = known.overwrite(&ours, [left_out.as_str()]).unwrap();
    assert_eq!(save.deletions, [format!("elements/{added}.json")]);
}

#[test]
fn what_repair_cut_from_files_left_out_keeps_its_links_until_an_edit_changes_them() {
    let group = ElementId::from_random(1);
    let whole = format::write(&sample()).unwrap();
    let mut files = whole.clone();
    for id in [group, STICKY] {
        files.insert(format!("elements/{id}.json"), b"<<<<<<< ours\n".to_vec());
    }
    let reading = format::read(&files).unwrap();
    // Out of the group and free of the sticky note in memory, though not in their files.
    assert_eq!(reading.board.elements[&NOTE].group, None);
    assert!(!reading.board.repaired.is_empty());
    let written = format::write(&reading.board).unwrap();
    for id in reading.board.elements.keys() {
        let path = format!("elements/{id}.json");
        assert_eq!(written[&path], files[&path], "{path}");
    }
    let known = Known::new(files.keys().cloned().collect::<Vec<_>>(), files.clone());
    let left_out = reading.left_out.iter().map(|left| left.path.as_str());
    let kept = known.overwrite(&reading.board, left_out).unwrap();
    assert!(kept.files.is_empty() && kept.deletions.is_empty());

    let file = |board: &Board, id: ElementId| {
        let files = format::write(board).unwrap();
        serde_json::from_slice::<serde_json::Value>(&files[&format!("elements/{id}.json")]).unwrap()
    };
    let id = |id: ElementId| serde_json::to_value(id).unwrap();
    let mut edited = reading.board.clone();
    edited.elements.get_mut(&NOTE).unwrap().z = z("a9");
    let ElementKind::Arrow { from, to, .. } = &mut edited.elements.get_mut(&ARROW).unwrap().kind
    else {
        unreachable!()
    };
    from.x += 5.0;
    let moved = *to;
    assert_eq!(file(&edited, NOTE)["group"], id(group));
    assert_eq!(file(&edited, ARROW)["kind"]["to_target"], id(STICKY));
    let mut fixed = format::write(&edited).unwrap();
    for id in [group, STICKY] {
        let path = format!("elements/{id}.json");
        fixed.insert(path.clone(), whole[&path].clone());
    }
    let back = format::read(&fixed).unwrap().board;
    assert_eq!(back.elements[&NOTE].group, Some(group));
    assert!(back.repaired.is_empty());

    let regroup = ElementId::from_random(60);
    edited.elements.insert(
        regroup,
        Element {
            z: z("a8"),
            ..sample().elements[&group].clone()
        },
    );
    edited.elements.get_mut(&NOTE).unwrap().group = Some(regroup);
    if let ElementKind::Arrow { to, .. } = &mut edited.elements.get_mut(&ARROW).unwrap().kind {
        to.x = moved.x + 5.0;
    }
    assert_eq!(file(&edited, NOTE)["group"], id(regroup));
    assert!(file(&edited, ARROW)["kind"].get("to_target").is_none());
}

#[test]
fn a_cycle_broken_on_read_reads_back_as_edited() {
    let [first, second, gone] = [50, 51, 52].map(ElementId::from_random);
    let mut board = Board::default();
    for (id, target) in [(first, second), (second, first)] {
        let mut stuck = note(Some(gone), "Stuck");
        if let ElementKind::Note { target: to, .. } = &mut stuck.kind {
            *to = Some(target);
        }
        board.elements.insert(id, stuck);
    }
    let target = |board: &Board, id| match &board.elements[&id].kind {
        ElementKind::Note { target, .. } => *target,
        _ => unreachable!(),
    };
    // In a group whose file is left out, which they stay in once written.
    let mut files = format::write(&board).unwrap();
    files.insert(format!("elements/{gone}.json"), b"<<<<<<< ours\n".to_vec());
    let mut read = format::read(&files).unwrap().board;
    assert_eq!(target(&read, first), None);
    if let ElementKind::Note { target, .. } = &mut read.elements.get_mut(&second).unwrap().kind {
        *target = None;
    }
    let written = format::write(&read).unwrap();
    assert!(String::from_utf8_lossy(&written[&format!("elements/{first}.json")]).contains("group"));
    let again = format::read(&written).unwrap().board;
    for id in [first, second] {
        assert_eq!(target(&again, id), None, "{id}");
    }
}

#[test]
fn a_link_to_what_another_branch_deleted_goes_once_written() {
    let mut board = sample();
    let gone = ElementId::from_random(53);
    board.elements.get_mut(&NOTE).unwrap().group = Some(gone);
    if let ElementKind::Arrow { from_target, .. } =
        &mut board.elements.get_mut(&ARROW).unwrap().kind
    {
        *from_target = Some(gone);
    }
    let mut files = format::write(&board).unwrap();
    files.insert(
        format!("elements/{STICKY}.json"),
        b"<<<<<<< ours\n".to_vec(),
    );
    let read = format::read(&files).unwrap().board;
    let written = format::write(&read).unwrap();
    let file = |id: ElementId| {
        serde_json::from_slice::<serde_json::Value>(&written[&format!("elements/{id}.json")])
            .unwrap()
    };
    assert!(file(NOTE).get("group").is_none());
    let arrow = file(ARROW)["kind"].clone();
    assert!(arrow.get("from_target").is_none());
    assert_eq!(arrow["to_target"], serde_json::to_value(STICKY).unwrap());
}

#[test]
fn a_broken_structure_reads_back_repaired() {
    let mut board = sample();
    board.elements.get_mut(&NOTE).unwrap().group = Some(ElementId::from_random(99));
    // As another branch would delete it.
    board.elements.remove(&STICKY);
    let read = format::read(&format::write(&board).unwrap()).unwrap().board;
    assert_eq!(read.elements[&NOTE].group, None);
    let ElementKind::Arrow { to_target, .. } = &read.elements[&ARROW].kind else {
        unreachable!()
    };
    assert_eq!(*to_target, None);
}

#[test]
fn an_asset_cloned_without_git_lfs_is_refused() {
    let asset = AssetId::of(IMAGE);
    assert_eq!(format::asset_path(asset), format!("assets/{asset}"),);
    assert!(format::verify_asset(asset, AssetId::of(IMAGE)).is_ok());
    let pointer = b"version https://git-lfs.github.com/spec/v1\n";
    assert!(matches!(
        format::verify_asset(asset, AssetId::of(pointer)),
        Err(Error::CorruptAsset(corrupt)) if corrupt == asset
    ));
}

fn samples() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples")
}

fn load(folder: &Path) -> Files {
    let mut files = Files::new();
    let mut pending = vec![folder.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            // Skipped by `format::read` too, like the `.DS_Store` that Finder leaves behind.
            if path.file_name().unwrap().to_str().unwrap().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                pending.push(path);
            } else {
                let relative = path.strip_prefix(folder).unwrap().components();
                let name: Vec<_> = relative
                    .map(|part| part.as_os_str().to_str().unwrap())
                    .collect();
                files.insert(name.join("/"), fs::read(&path).unwrap());
            }
        }
    }
    files
}

#[test]
fn the_demo_board_reads_back_as_written() {
    let files = load(&samples().join("demo"));
    let board = format::read(&files).unwrap().board;

    let mut written = format::write(&board).unwrap();
    let (path, bytes) = format::git_attributes();
    assert_eq!(written.remove(path), Some(bytes));
    let (assets, rest): (Files, Files) = files
        .into_iter()
        .partition(|(path, _)| format::is_asset_file(path));
    assert_eq!(written, rest);
    assert!(rest.keys().all(|path| format::is_board_file(path)));
    let deepest = |path: &String| path.split('/').count();
    assert!(written.keys().chain(assets.keys()).map(deepest).max() <= Some(format::DEPTH));

    for element in board.elements.values() {
        let ElementKind::Image {
            asset,
            natural_size,
            ..
        } = &element.kind
        else {
            continue;
        };
        let bytes = &assets[&format::asset_path(*asset)];
        assert!(format::verify_asset(*asset, AssetId::of(bytes)).is_ok());
        // Only PNG sizes are checked, since they sit at a fixed offset.
        if let Some(header) = bytes.strip_prefix(b"\x89PNG\r\n\x1a\n") {
            let width = u32::from_be_bytes(header[8..12].try_into().unwrap());
            let height = u32::from_be_bytes(header[12..16].try_into().unwrap());
            assert_eq!(*natural_size, Size { width, height });
        }
    }
}

/// Zips a board the way a shell does: its files from `format::write`, its assets from
/// `files`.
fn zip_of(files: &Files) -> format::Result<Vec<u8>> {
    let board = format::read(files)?.board;
    let written = format::write(&board)?;
    let mut writer = zip::Writer::new();
    let mut out = Vec::new();
    for path in zip::paths(&board, [], [])? {
        let bytes = written.get(&path).unwrap_or_else(|| &files[&path]);
        out.extend(header(&mut writer, &path, bytes)?);
        out.extend_from_slice(bytes);
    }
    out.extend(writer.finish()?);
    Ok(out)
}

/// Takes the checksums in pieces, as a shell does.
fn header(writer: &mut zip::Writer, path: &str, bytes: &[u8]) -> format::Result<Vec<u8>> {
    let mut crc = zip::Crc32::new();
    let mut hasher = AssetHasher::new();
    for piece in bytes.chunks(7) {
        crc.update(piece);
        hasher.update(piece);
    }
    let asset = format::is_asset_file(path).then(|| hasher.finish());
    writer.entry(path, bytes.len() as u64, crc.finish(), asset)
}

fn zip_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::Writer::new();
    let mut out = Vec::new();
    for (path, bytes) in entries {
        out.extend(header(&mut writer, path, bytes).unwrap());
        out.extend_from_slice(bytes);
    }
    out.extend(writer.finish().unwrap());
    out
}

/// Unzips every file the way a shell does, reading only the ranges the core asks for.
fn unzip(file: &[u8]) -> format::Result<Files> {
    let length = file.len() as u64;
    let tail = &file[at(length - zip::tail_length(length)..length)];
    let directory = zip::locate(length, tail)?;
    let index = zip::Index::read(directory.start, &file[at(directory)])?;
    let mut files = Files::new();
    for path in index.paths() {
        let entry = index.entry(path).unwrap();
        let bytes = &file[at(entry.data(&file[at(entry.header())])?)];
        let bytes = match entry.method() {
            zip::Method::Stored => bytes.to_vec(),
            zip::Method::Deflated => inflated(bytes),
        };
        entry.check(bytes.len() as u64, zip::Crc32::of(&bytes))?;
        files.insert(path.to_owned(), bytes);
    }
    Ok(files)
}

/// A deflate stream of stored blocks, which any inflater reads.
fn deflated(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut blocks = bytes.chunks(usize::from(u16::MAX)).peekable();
    if bytes.is_empty() {
        return vec![1, 0, 0, 0xff, 0xff];
    }
    while let Some(block) = blocks.next() {
        out.push(u8::from(blocks.peek().is_none()));
        let len = block.len() as u16;
        out.extend(len.to_le_bytes());
        out.extend((!len).to_le_bytes());
        out.extend_from_slice(block);
    }
    out
}

/// What [`deflated`] took, as a shell's inflater gives it back.
fn inflated(mut bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let len = usize::from(u16::from_le_bytes([bytes[1], bytes[2]]));
        out.extend_from_slice(&bytes[5..5 + len]);
        if bytes[0] & 1 == 1 {
            return out;
        }
        bytes = &bytes[5 + len..];
    }
}

/// Zips `entries` deflated, as another tool does.
fn deflated_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let packed: Vec<Vec<u8>> = entries.iter().map(|(_, bytes)| deflated(bytes)).collect();
    let listed: Vec<(&str, &[u8])> = entries
        .iter()
        .zip(&packed)
        .map(|((path, _), packed)| (*path, packed.as_slice()))
        .collect();
    let mut file = zip_entries(&listed);
    for (path, bytes) in entries {
        let (crc, size) = (zip::Crc32::of(bytes), bytes.len() as u32);
        for (signature, method_at, crc_at, size_at) in [(LOCAL, 8, 14, 22), (CENTRAL, 10, 16, 24)] {
            let at = record(&file, signature, path);
            file[at + method_at..at + method_at + 2].copy_from_slice(&8_u16.to_le_bytes());
            file[at + crc_at..at + crc_at + 4].copy_from_slice(&crc.to_le_bytes());
            file[at + size_at..at + size_at + 4].copy_from_slice(&size.to_le_bytes());
        }
    }
    file
}

/// Where the local header or the directory record for `path` starts.
fn record(file: &[u8], signature: &[u8; 4], path: &str) -> usize {
    let (name_len_at, name_at) = if signature == LOCAL {
        (26, 30)
    } else {
        (28, 46)
    };
    (0..file.len() - name_at)
        .find(|&at| {
            file[at..].starts_with(signature)
                && usize::from(u16::from_le_bytes([
                    file[at + name_len_at],
                    file[at + name_len_at + 1],
                ])) == path.len()
                && file[at + name_at..].starts_with(path.as_bytes())
        })
        .unwrap()
}

fn rename(file: &mut [u8], from: &[u8], to: &[u8]) {
    while let Some(at) = file.windows(from.len()).position(|window| window == from) {
        file[at..at + from.len()].copy_from_slice(to);
    }
}

fn at(range: Range<u64>) -> Range<usize> {
    range.start as usize..range.end as usize
}

/// Overwrites the bytes at `at` in the first record with this signature.
fn patch(file: &mut [u8], signature: &[u8; 4], at: usize, bytes: &[u8]) {
    let record = file
        .windows(4)
        .position(|window| window == signature)
        .unwrap();
    file[record + at..record + at + bytes.len()].copy_from_slice(bytes);
}

fn get32(file: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(file[at..at + 4].try_into().unwrap())
}

const LOCAL: &[u8; 4] = b"PK\x03\x04";
const CENTRAL: &[u8; 4] = b"PK\x01\x02";
const END: &[u8; 4] = b"PK\x05\x06";
const END64: &[u8; 4] = b"PK\x06\x06";
const LOCATOR: &[u8; 4] = b"PK\x06\x07";

#[test]
fn the_demo_board_zips_as_its_sample() {
    let zipped = zip_of(&load(&samples().join("demo"))).unwrap();
    assert!(zipped == fs::read(samples().join("demo.zip")).unwrap());
}

#[test]
fn a_zip_reads_back_as_its_folder() {
    let files = load(&samples().join("demo"));
    let zipped = zip_of(&files).unwrap();
    let unzipped = unzip(&zipped).unwrap();
    assert_eq!(unzipped, files);
    assert!(zip_of(&unzipped).unwrap() == zipped);
}

#[test]
fn a_zip_holds_only_the_board_and_the_assets_it_draws() {
    let board = sample();
    let mut files = format::write(&board).unwrap();
    files.insert(format::asset_path(AssetId::of(IMAGE)), IMAGE.to_vec());
    let orphan = format::asset_path(AssetId::of(b"drawn by nothing"));
    files.insert(orphan.clone(), b"drawn by nothing".to_vec());
    // First, so that Git reads it before any file it applies to.
    assert_eq!(zip::paths(&board, [], []).unwrap()[0], ".gitattributes");

    let unzipped = unzip(&zip_of(&files).unwrap()).unwrap();
    files.remove(&orphan);
    // Left out like any dot file, though the ZIP file holds it for whoever unzips it.
    files.remove(".gitattributes");
    assert_eq!(unzipped, files);
}

#[test]
fn a_checksum_is_the_same_in_whatever_pieces_it_comes() {
    assert_eq!(zip::Crc32::of(b""), 0);
    assert_eq!(zip::Crc32::of(b"123456789"), 0xcbf4_3926);
    let fox = b"The quick brown fox jumps over the lazy dog";
    assert_eq!(zip::Crc32::of(fox), 0x414f_a339);
    let bytes: Vec<u8> = (0..300_u32).map(|at| (at * 7 % 251) as u8).collect();
    for length in [0, 1, 15, 16, 17, 31, 32, 33, 64, 299, 300] {
        let whole = zip::Crc32::of(&bytes[..length]);
        for piece in [1, 3, 16, 17, 100] {
            let mut crc = zip::Crc32::new();
            for chunk in bytes[..length].chunks(piece) {
                crc.update(chunk);
            }
            assert_eq!(crc.finish(), whole, "{length} bytes by {piece}");
        }
    }
}

#[test]
fn a_corrupt_asset_is_not_zipped() {
    let asset = AssetId::of(IMAGE);
    let mut writer = zip::Writer::new();
    assert!(matches!(
        header(&mut writer, &format::asset_path(asset), b"version https://git-lfs.github.com/spec/v1\n"),
        Err(Error::CorruptAsset(corrupt)) if corrupt == asset
    ));
    let named = format::asset_path(asset);
    assert!(matches!(
        zip::Writer::new().entry(&named, 1, 0, None),
        Err(Error::CorruptAsset(corrupt)) if corrupt == asset
    ));
}

#[test]
fn zip_entries_come_in_path_order_once() {
    let mut writer = zip::Writer::new();
    header(&mut writer, "elements/b", b"").unwrap();
    for path in ["elements/a", "elements/b"] {
        assert!(
            matches!(header(&mut writer, path, b""), Err(Error::OutOfOrder(named)) if named == path)
        );
    }
}

#[test]
fn a_path_out_of_the_board_is_neither_zipped_nor_unzipped() {
    let mut writer = zip::Writer::new();
    for path in [
        "../board.json",
        "elements//a",
        "a\\b",
        "c:a",
        ".DS_Store",
        "elements/.gitattributes",
        "a~b",
    ] {
        assert!(
            matches!(header(&mut writer, path, b""), Err(Error::UnsafePath(named)) if named == path)
        );
    }

    let mut file = zip_entries(&[("inside/a", b"")]);
    let escaping = b"../../ab";
    for record in [LOCAL, CENTRAL] {
        let name = if record == CENTRAL { 46 } else { 30 };
        patch(&mut file, record, name, escaping);
    }
    assert!(matches!(unzip(&file), Err(Error::UnsafePath(path)) if path == "../../ab"));
}

#[test]
fn folders_dot_files_and_backups_are_left_out_of_a_zip() {
    let mut file = zip_entries(&[
        ("board.json", b"{}"),
        ("board.jsonx", b"old"),
        ("elements.", b""),
        ("xDS_Store", b""),
    ]);
    // Renamed in the central directory, as another tool may name entries.
    for (from, to) in [
        (b"board.jsonx".as_slice(), b"board.json~".as_slice()),
        (b"elements.", b"elements/"),
        (b"xDS_Store", b".DS_Store"),
    ] {
        let at = file
            .windows(from.len())
            .rposition(|window| window == from)
            .unwrap();
        file[at..at + from.len()].copy_from_slice(to);
    }
    assert_eq!(
        unzip(&file).unwrap().into_keys().collect::<Vec<_>>(),
        ["board.json"]
    );
}

#[test]
fn an_encrypted_zip_or_one_compressed_otherwise_is_refused() {
    let file = zip_entries(&[("board.json", b"{}")]);
    let mut compressed = file.clone();
    // Bzip2, which no shell inflates.
    patch(&mut compressed, CENTRAL, 10, &[12]);
    assert!(matches!(unzip(&compressed), Err(Error::Compressed(path)) if path == "board.json"));
    for flag in [1, 1 << 6] {
        let mut encrypted = file.clone();
        patch(&mut encrypted, CENTRAL, 8, &[flag]);
        assert!(matches!(unzip(&encrypted), Err(Error::Encrypted(path)) if path == "board.json"));
    }
}

#[test]
fn a_board_zipped_here_reads_its_files_in_one_range() {
    let file = zip_of(&load(&samples().join("demo"))).unwrap();
    let directory = zip::locate(file.len() as u64, &file).unwrap();
    let index = zip::Index::read(directory.start, &file[at(directory.clone())]).unwrap();
    let board: Vec<&str> = index
        .paths()
        .filter(|path| format::is_board_file(path))
        .collect();
    let runs = index.runs(board.iter().copied());
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].end, directory.start);
    for path in &board {
        let entry = index.entry(path).unwrap();
        let data = entry.data(&file[at(entry.header())]).unwrap();
        assert!(runs[0].start <= entry.header().start && data.end <= runs[0].end);
    }
    assert!(index.runs([]).is_empty());
    assert!(index.runs(["elements/none.json"]).is_empty());
}

#[test]
fn files_far_apart_read_in_ranges_of_their_own() {
    let big = vec![7; 70_000];
    let file = zip_entries(&[("a", b"1"), ("b", &big), ("c", b"3")]);
    let directory = zip::locate(file.len() as u64, &file).unwrap();
    let index = zip::Index::read(directory.start, &file[at(directory)]).unwrap();
    assert_eq!(index.runs(["a", "c"]).len(), 2);
    assert_eq!(index.runs(["c", "b", "a"]).len(), 1);

    // Past 32 MiB, a range ends.
    let size = 20 << 20;
    let mut writer = zip::Writer::new();
    for path in ["a", "b", "c"] {
        writer.entry(path, size, 0, None).unwrap();
    }
    let end = writer.finish().unwrap();
    let index = zip::Index::read(3 * (31 + size), &end[..end.len() - 22]).unwrap();
    let runs = index.runs(["a", "b", "c"]);
    assert_eq!(runs.len(), 3);
    assert!(runs.windows(2).all(|pair| pair[0].end <= pair[1].start));
}

#[test]
fn a_board_zipped_again_by_another_tool_opens() {
    let files = load(&samples().join("demo"));
    // Deflated in the folder zipped, with each file's resource fork apart, as Finder does.
    let mut wrapped: Vec<(String, &[u8])> = files
        .iter()
        .map(|(path, bytes)| (format!("demo/{path}"), bytes.as_slice()))
        .collect();
    wrapped.push(("__MACOSX/demo/x_board.json".to_owned(), b"a fork"));
    wrapped.sort();
    let entries: Vec<(&str, &[u8])> = wrapped
        .iter()
        .map(|(path, bytes)| (path.as_str(), *bytes))
        .collect();
    let mut finder = deflated_zip(&entries);
    rename(&mut finder, b"x_board.json", b"._board.json");
    assert_eq!(unzip(&finder).unwrap(), files);

    // Stored, as `zip -0 -r` gives.
    let mut stored = zip_entries(&entries);
    rename(&mut stored, b"x_board.json", b"._board.json");
    assert_eq!(unzip(&stored).unwrap(), files);
}

#[test]
fn only_a_folder_holding_every_entry_and_the_manifest_is_left_out() {
    for paths in [
        ["board.json", "demo/board.json"].as_slice(),
        &["a/board.json", "b/elements/x"],
        &["a/board.json", "x"],
        &["a/b/board.json"],
    ] {
        let entries: Vec<(&str, &[u8])> =
            paths.iter().map(|path| (*path, b"{}".as_slice())).collect();
        let unzipped = unzip(&zip_entries(&entries)).unwrap();
        assert_eq!(unzipped.keys().collect::<Vec<_>>(), paths, "{paths:?}");
    }
}

#[test]
fn a_deflated_entry_claiming_more_than_deflate_gives_is_refused() {
    let mut file = deflated_zip(&[("board.json", b"{}")]);
    let at = record(&file, CENTRAL, "board.json");
    // Two bytes take seven once deflated as a stored block.
    file[at + 24..at + 28].copy_from_slice(&(7 * 1032 + 1_u32).to_le_bytes());
    assert!(
        matches!(unzip(&file), Err(Error::DamagedZip(reason)) if reason.contains("board.json"))
    );
}

#[test]
fn an_entry_with_its_sizes_after_its_bytes_opens() {
    let mut file = deflated_zip(&[("board.json", b"{}")]);
    // Its local header then holds no checksum or size, which a record after its bytes does.
    patch(&mut file, LOCAL, 6, &[1 << 3]);
    patch(&mut file, LOCAL, 14, &[0; 12]);
    assert_eq!(unzip(&file).unwrap()["board.json"], b"{}");
}

#[test]
fn a_zip_from_another_tool_opens() {
    // Info-ZIP's `zip -0` gives each entry timestamps and owner ids, 28 bytes in its local
    // header and 24 in the directory, and other tools add comments to entries and to files.
    let (local, central, comment) = ([7; 28], [9; 24], b"a comment");
    let mut file = zip_entries(&[("board.json", b"{}")]);
    let end = file.len() - 22;
    let (size, start) = (get32(&file, end + 12), get32(&file, end + 16));
    file.splice(end..end, central.iter().chain(comment).copied());
    file.splice(30 + 10..30 + 10, local);
    patch(&mut file, LOCAL, 28, &(local.len() as u16).to_le_bytes());
    patch(
        &mut file,
        CENTRAL,
        30,
        &(central.len() as u16).to_le_bytes(),
    );
    patch(
        &mut file,
        CENTRAL,
        32,
        &(comment.len() as u16).to_le_bytes(),
    );
    let grown = size + (central.len() + comment.len()) as u32;
    patch(&mut file, END, 12, &grown.to_le_bytes());
    patch(
        &mut file,
        END,
        16,
        &(start + local.len() as u32).to_le_bytes(),
    );
    patch(&mut file, END, 20, &(comment.len() as u16).to_le_bytes());
    file.extend_from_slice(comment);

    assert_eq!(unzip(&file).unwrap()["board.json"], b"{}");
}

#[test]
fn a_zip_holding_a_path_twice_is_refused() {
    let mut file = zip_entries(&[("elements/a", b"[1]"), ("elements/b", b"[2]")]);
    // Renamed in its header and in the directory alike, so that either copy would read.
    while let Some(name) = file.windows(10).position(|window| window == b"elements/b") {
        file[name..name + 10].copy_from_slice(b"elements/a");
    }
    assert!(
        matches!(unzip(&file), Err(Error::DamagedZip(reason)) if reason.contains("elements/a"))
    );
}

#[test]
fn entries_sharing_bytes_are_refused() {
    let mut file = zip_entries(&[("elements/a", b"[1]"), ("elements/b", b"[2]")]);
    let second = file
        .windows(4)
        .rposition(|window| window == CENTRAL)
        .unwrap();
    file[second + 42..second + 46].copy_from_slice(&0u32.to_le_bytes());
    let directory = zip::locate(file.len() as u64, &file).unwrap();
    assert!(matches!(
        zip::Index::read(directory.start, &file[at(directory)]),
        Err(Error::DamagedZip(reason)) if reason.contains("runs into")
    ));
}

#[test]
fn a_damaged_zip_is_refused() {
    let file = zip_entries(&[("board.json", b"{}"), ("elements/a", b"[1, 2]")]);
    for damaged in [&file[..file.len() - 1], b"PK".as_slice(), b"".as_slice()] {
        assert!(matches!(unzip(damaged), Err(Error::NotAZip)));
    }

    let mut flipped = file.clone();
    let data = flipped
        .windows(6)
        .position(|window| window == b"[1, 2]")
        .unwrap();
    flipped[data + 1] = b'3';
    assert!(
        matches!(unzip(&flipped), Err(Error::DamagedZip(reason)) if reason.contains("elements/a"))
    );

    let mut past_the_end = file.clone();
    patch(
        &mut past_the_end,
        END,
        16,
        &(file.len() as u32).to_le_bytes(),
    );
    assert!(matches!(unzip(&past_the_end), Err(Error::DamagedZip(_))));

    let mut misplaced = file.clone();
    patch(&mut misplaced, CENTRAL, 42, &4u32.to_le_bytes());
    assert!(
        matches!(unzip(&misplaced), Err(Error::DamagedZip(reason)) if reason.contains("board.json"))
    );

    // Refused before a shell reads a header past the directory.
    for fields in [&[42][..], &[20, 24]] {
        let mut past = file.clone();
        for &at in fields {
            patch(&mut past, CENTRAL, at, &1_000_000u32.to_le_bytes());
        }
        assert!(
            matches!(unzip(&past), Err(Error::DamagedZip(reason)) if reason.contains("board.json"))
        );
    }

    // Refused before a shell reads bytes that a header's extra field moves past the directory,
    // where they could still match their checksum.
    for extra in [50u16, u16::MAX] {
        let mut moved = file.clone();
        patch(&mut moved, LOCAL, 28, &extra.to_le_bytes());
        let runs_into = |reason: &str| reason == "`board.json` runs into its directory";
        assert!(
            matches!(unzip(&moved), Err(Error::DamagedZip(reason)) if runs_into(&reason)),
            "{extra}"
        );
    }
}

#[test]
fn a_zip_holding_more_entries_than_plain_records_count_takes_zip64() {
    let names: Vec<String> = (0..65_535).map(|at| format!("{at:05}")).collect();
    let entries: Vec<(&str, &[u8])> = names
        .iter()
        .map(|name| (name.as_str(), b"".as_slice()))
        .collect();

    let plain = zip_entries(&entries[..65_534]);
    assert!(!plain.windows(4).any(|window| window == END64));
    assert_eq!(unzip(&plain).unwrap().len(), 65_534);

    let many = zip_entries(&entries);
    let end = many.len() - 22;
    assert_eq!(&many[end - 20..end - 16], LOCATOR);
    assert_eq!(&many[end + 8..end + 12], &[0xff; 4]);
    assert_eq!(unzip(&many).unwrap().len(), 65_535);
}

#[test]
fn an_entry_past_4_gib_takes_zip64_fields() {
    let big = 5_u64 << 30;
    let mut writer = zip::Writer::new();
    let first = writer.entry("big", big, 7, None).unwrap();
    // Both sizes, wide, in a field after its path, and the plain ones as markers.
    assert_eq!(first.len(), 30 + 3 + 20);
    assert_eq!(&first[18..26], &[0xff; 8]);
    assert_eq!(&first[33..37], &[1, 0, 16, 0]);
    assert_eq!(&first[37..45], &big.to_le_bytes());
    assert_eq!(&first[45..53], &big.to_le_bytes());
    // Its offset is past 4 GiB, which only the directory says.
    let second = writer.entry("bigger", 1, 9, None).unwrap();
    assert_eq!(second.len(), 30 + 6);
    let end = writer.finish().unwrap();
    assert!(end.windows(4).any(|window| window == END64));

    // Read from the file's end alone, as its bytes would take 5 GiB.
    let start = first.len() as u64 + big + second.len() as u64 + 1;
    let length = start + end.len() as u64;
    let mut tail = vec![0; zip::tail_length(length) as usize - end.len()];
    tail.extend(&end);
    let directory = zip::locate(length, &tail).unwrap();
    assert_eq!(directory.start, start);
    let index = zip::Index::read(start, &end[..(directory.end - start) as usize]).unwrap();
    let entry = index.entry("big").unwrap();
    assert_eq!(entry.header(), 0..33);
    assert_eq!(entry.data(&first[..33]).unwrap(), 53..53 + big);
    assert!(entry.check(big, 7).is_ok());
    let entry = index.entry("bigger").unwrap();
    let offset = 53 + big;
    assert_eq!(entry.header(), offset..offset + 36);
    assert_eq!(entry.data(&second).unwrap(), offset + 36..offset + 37);
    assert!(entry.check(1, 9).is_ok());
}

#[test]
fn zip64_comes_where_plain_fields_would_hold_their_marker() {
    let largest = u64::from(u32::MAX) - 1;
    assert_eq!(
        zip::Writer::new()
            .entry("big", largest, 0, None)
            .unwrap()
            .len(),
        33
    );
    assert_eq!(
        zip::Writer::new()
            .entry("big", largest + 1, 0, None)
            .unwrap()
            .len(),
        53
    );

    // The directory may start at the last offset short of the marker, and an entry too.
    let mut writer = zip::Writer::new();
    writer.entry("big", largest - 33, 0, None).unwrap();
    assert!(
        !writer
            .finish()
            .unwrap()
            .windows(4)
            .any(|window| window == END64)
    );
    let mut writer = zip::Writer::new();
    writer.entry("big", largest - 33, 0, None).unwrap();
    assert_eq!(writer.entry("bigger", 0, 0, None).unwrap().len(), 36);
    assert!(
        writer
            .finish()
            .unwrap()
            .windows(4)
            .any(|window| window == END64)
    );
}

/// A file ending in ZIP64 records. An end record 10 bytes in with `fields`, its disk, the
/// directory's, its entries on this disk and in all, then the directory's size and start, and
/// a locator on `disk` of `disks` that says it lies `at`.
fn zip64_ended(fields: [u64; 6], at: u64, disk: u32, disks: u32) -> Vec<u8> {
    let mut file = vec![0; 10];
    file.extend(END64);
    file.extend(44_u64.to_le_bytes());
    file.extend([45, 0, 45, 0]);
    file.extend((fields[0] as u32).to_le_bytes());
    file.extend((fields[1] as u32).to_le_bytes());
    fields[2..]
        .iter()
        .for_each(|value| file.extend(value.to_le_bytes()));
    file.extend(LOCATOR);
    file.extend(disk.to_le_bytes());
    file.extend(at.to_le_bytes());
    file.extend(disks.to_le_bytes());
    file.extend(END);
    // Marked counts, then no size, start, or comment.
    file.extend([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    file.extend([0; 10]);
    file
}

#[test]
fn a_zip64_end_out_of_place_or_on_other_disks_is_refused() {
    let located = |file: &[u8]| zip::locate(file.len() as u64, file);
    let empty = [0, 0, 0, 0, 10, 0];
    assert_eq!(located(&zip64_ended(empty, 10, 0, 1)).unwrap(), 0..10);

    // Where no record is, past any file, past this one, into its locator, short of it.
    for at in [
        u64::MAX - 1,
        u64::MAX - 55,
        u64::from(u32::MAX) - 1,
        1000,
        11,
        9,
    ] {
        let refused = located(&zip64_ended(empty, at, 0, 1));
        assert!(matches!(refused, Err(Error::DamagedZip(_))), "{at}");
    }
    // Before the bytes read from the end.
    let file = zip64_ended(empty, 10, 0, 1);
    let refused = zip::locate(file.len() as u64, &file[20..]);
    assert!(matches!(refused, Err(Error::DamagedZip(_))));
    // A directory running past it.
    for (size, start) in [(11, 0), (u64::MAX, 5), (1, u64::MAX)] {
        let refused = located(&zip64_ended([0, 0, 0, 0, size, start], 10, 0, 1));
        assert!(
            matches!(refused, Err(Error::DamagedZip(_))),
            "{size} {start}"
        );
    }
    for (fields, disk, disks) in [
        (empty, 1, 1),
        (empty, 0, 2),
        ([1, 0, 0, 0, 10, 0], 0, 1),
        ([0, 1, 0, 0, 10, 0], 0, 1),
        ([0, 0, 1, 2, 10, 0], 0, 1),
    ] {
        let refused = located(&zip64_ended(fields, 10, disk, disks));
        assert!(matches!(refused, Err(Error::UnsupportedZip)), "{fields:?}");
    }
}

#[test]
fn an_entry_said_to_lie_past_any_file_is_refused() {
    let mut writer = zip::Writer::new();
    let first = writer.entry("big", u64::from(u32::MAX), 0, None).unwrap();
    writer.entry("bigger", 0, 0, None).unwrap();
    let mut end = writer.finish().unwrap();
    // Its offset, in the ZIP64 field after its name.
    let at = end.windows(6).rposition(|name| name == b"bigger").unwrap() + 6 + 4;
    end[at..at + 8].copy_from_slice(&(u64::MAX - 10).to_le_bytes());
    let size = end.windows(4).position(|window| window == END64).unwrap();
    let start = first.len() as u64 + u64::from(u32::MAX) + 36;
    assert!(matches!(
        zip::Index::read(start, &end[..size]),
        Err(Error::DamagedZip(reason)) if reason.contains("bigger")
    ));
}

#[test]
fn a_zip_marking_sizes_it_does_not_give_is_refused() {
    let file = zip_entries(&[("board.json", b"{}")]);
    for at in [20, 24, 42] {
        let mut marked = file.clone();
        patch(&mut marked, CENTRAL, at, &[0xff; 4]);
        assert!(
            matches!(unzip(&marked), Err(Error::DamagedZip(reason)) if reason.contains("ZIP64")),
            "{at}"
        );
    }
    // Another tool may count that many entries with no ZIP64 records.
    let mut counted = file.clone();
    patch(&mut counted, END, 8, &[0xff; 4]);
    assert_eq!(unzip(&counted).unwrap()["board.json"], b"{}");

    let mut spanning = file.clone();
    patch(&mut spanning, END, 4, &[1]);
    assert!(matches!(unzip(&spanning), Err(Error::UnsupportedZip)));
}

#[test]
fn bytes_of_another_size_are_refused_even_with_their_checksum() {
    let file = zip_entries(&[("board.json", b"{}")]);
    let directory = zip::locate(file.len() as u64, &file).unwrap();
    let index = zip::Index::read(directory.start, &file[at(directory)]).unwrap();
    let entry = index.entry("board.json").unwrap();
    let crc = zip::Crc32::of(b"{}");
    assert!(entry.check(2, crc).is_ok());
    for size in [0, 1, 3, (1 << 32) + 2] {
        let checked = entry.check(size, crc);
        assert!(
            matches!(checked, Err(Error::DamagedZip(reason)) if reason.contains("board.json")),
            "{size}"
        );
    }
}

#[test]
fn an_asset_the_folder_lacks_is_missing() {
    let board = sample();
    let asset = format::asset_path(AssetId::of(IMAGE));
    let listed = ["board.json", "assets/0000", asset.as_str()];
    assert!(format::missing_assets(&board, listed).is_empty());
    assert_eq!(
        format::missing_assets(&board, ["board.json", "assets/0000"]),
        [AssetId::of(IMAGE)]
    );
    assert!(format::missing_assets(&Board::default(), []).is_empty());
}

#[test]
fn a_zip_carries_what_the_board_left_out_byte_for_byte() {
    let board = sample();
    let mut files = format::write(&board).unwrap();
    let asset = format::asset_path(AssetId::of(IMAGE));
    let pointer = b"version https://git-lfs.github.com/spec/v1\n".to_vec();
    files.insert(asset.clone(), pointer.clone());
    let conflicted = format!("elements/{}.json", ElementId::from_random(43));
    files.insert(conflicted.clone(), b"<<<<<<< ours\n".to_vec());

    let carried = [asset.as_str(), conflicted.as_str()];
    let paths = zip::paths(&board, carried, []).unwrap();
    assert!(paths.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(paths.contains(&conflicted) && paths.contains(&asset));

    let mut writer = zip::Writer::new();
    let mut out = Vec::new();
    for path in &paths {
        let bytes = files.get(path).unwrap();
        let crc = zip::Crc32::of(bytes);
        let header = if carried.contains(&path.as_str()) {
            writer.carried(path, bytes.len() as u64, crc)
        } else {
            writer.entry(path, bytes.len() as u64, crc, None)
        };
        out.extend(header.unwrap());
        out.extend_from_slice(bytes);
    }
    out.extend(writer.finish().unwrap());
    let unzipped = unzip(&out).unwrap();
    assert_eq!(unzipped[&conflicted], b"<<<<<<< ours\n");
    assert_eq!(unzipped[&asset], pointer);

    let mut writer = zip::Writer::new();
    assert!(matches!(
        writer.entry(&asset, 1, 0, Some(AssetId::of(&pointer))),
        Err(Error::CorruptAsset(_))
    ));
    assert!(
        !zip::paths(&board, [], [asset.as_str()])
            .unwrap()
            .contains(&asset)
    );
    assert!(matches!(
        zip::paths(&board, ["../board.json"], []),
        Err(Error::UnsafePath(_))
    ));
    assert!(matches!(
        zip::Writer::new().carried("assets/not-a-digest", 0, 0),
        Err(Error::InvalidName(_))
    ));
}
