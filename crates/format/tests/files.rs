use std::collections::BTreeSet;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

use board::{
    Align, Alignment, AssetHasher, AssetId, Background, Board, Colour, CropShape, Dash, Editor,
    Element, ElementId, ElementKind, Fill, Heads, ImageEdits, Opacity, Paper, Point, Rect, Restack,
    Shape, Size, Speed, Text, Tip, Trim, Weight, ZIndex,
};
use format::save::{Known, Save};
use format::{Error, Files, zip};

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
                z: z("a0"),
                kind: ElementKind::Group,
            },
        ),
        (
            ElementId::from_random(2),
            Element {
                group: Some(group),
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
                z: z("a1"),
                kind: ElementKind::Shape {
                    frame: frame(100.0, 100.0),
                    rotation: -12.5,
                    shape: Shape::Ellipse,
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
                z: z("a5"),
                kind: ElementKind::Shape {
                    frame: frame(40.0, 40.0),
                    rotation: 0.0,
                    shape: Shape::Cross,
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
    let read = format::read(&files).unwrap();
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
    let order = format::read(&after).unwrap().draw_order();
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
    let cases: [(Edit, &[u128]); 27] = [
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
    assert_eq!(format::read(&after).unwrap(), *editor.board());

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
    let board = Board {
        elements: [(NOTE, shape), (ARROW, arrow), (STICKY, sticky)]
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
    assert_eq!(format::read(&files).unwrap(), board);
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
    assert_eq!(format::read(&files).unwrap(), *editor.board());
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
    assert_eq!(format::read(&files).unwrap(), *editor.board());
}

#[test]
fn a_colour_has_one_spelling() {
    for colour in ["\"crimson\"", "\"#EC8353\"", "\"#ec835\"", "\"Red\""] {
        let mut files = format::write(&sample()).unwrap();
        let path = format!("elements/{NOTE}.json");
        let note = String::from_utf8(files[&path].clone()).unwrap();
        let note = note.replace(
            "\"rotation\": 0.0,",
            &format!("\"rotation\": 0.0,\n    \"colour\": {colour},"),
        );
        files.insert(path.clone(), note.into_bytes());
        assert!(
            matches!(format::read(&files), Err(Error::Json { path: at, .. }) if at == path),
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
    let merged = format::read(&merged).unwrap();
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
    "rotation": 0.0,
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
    "rotation": 0.0,
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
    assert_eq!(format::read(&files).unwrap(), board);
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
    "rotation": 0.0,
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
    assert_eq!(format::read(&crlf).unwrap(), sample());
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
    let read = format::read(&negated).unwrap();
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
    files.insert(path, sizeless.into_bytes());
    assert!(matches!(format::read(&files), Err(Error::Invalid(NOTE))));
}

#[test]
fn an_opacity_that_would_hide_an_element_is_refused_on_read() {
    let mut files = format::write(&sample()).unwrap();
    let path = format!("elements/{NOTE}.json");
    let mut note: serde_json::Value = serde_json::from_slice(&files[&path]).unwrap();
    note["kind"]["opacity"] = serde_json::json!(0);
    files.insert(path.clone(), serde_json::to_vec(&note).unwrap());
    assert!(matches!(format::read(&files), Err(Error::Json { path: at, .. }) if at == path));
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
    assert_eq!(format::read(&files).unwrap(), board);
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
    assert_eq!(format::read(&files).unwrap(), board);
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
    assert_eq!(files, format::write(&board).unwrap());
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

    let save = known.overwrite(&ours).unwrap();
    let written: Vec<&str> = save.files.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(written, [format!("elements/{NOTE}.json")]);
    assert_eq!(save.deletions, [format!("elements/{added}.json")]);
}

#[test]
fn a_damaged_element_file_is_named() {
    let path = format!("elements/{NOTE}.json");
    let files = format::write(&sample()).unwrap();
    let good = String::from_utf8(files[&path].clone()).unwrap();
    let conflicted = format!("<<<<<<< ours\n{good}=======\n{good}>>>>>>> theirs\n");
    for damaged in [
        conflicted.as_bytes(),
        &good.as_bytes()[..good.len() / 2],
        b"",
    ] {
        let mut files = files.clone();
        files.insert(path.clone(), damaged.to_vec());
        assert!(
            matches!(format::read(&files), Err(Error::Json { path: named, .. }) if named == path)
        );
    }
}

#[test]
fn a_broken_structure_reads_back_repaired() {
    let mut board = sample();
    board.elements.get_mut(&NOTE).unwrap().group = Some(ElementId::from_random(99));
    // As another branch would delete it.
    board.elements.remove(&STICKY);
    let read = format::read(&format::write(&board).unwrap()).unwrap();
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
    let board = format::read(&files).unwrap();

    let written = format::write(&board).unwrap();
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
    let board = format::read(files)?;
    let written = format::write(&board)?;
    let mut writer = zip::Writer::new();
    let mut out = Vec::new();
    for path in zip::paths(&board)? {
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
        entry.check(bytes.len() as u64, zip::Crc32::of(bytes))?;
        files.insert(path.to_owned(), bytes.to_vec());
    }
    Ok(files)
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
    files.insert(".gitattributes".to_owned(), format::git_attributes().1);

    let unzipped = unzip(&zip_of(&files).unwrap()).unwrap();
    files.remove(&orphan);
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
        ".gitattributes",
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
fn a_compressed_or_encrypted_zip_is_refused() {
    for (at, value) in [(10, 8), (8, 1)] {
        let mut file = zip_entries(&[("board.json", b"{}")]);
        patch(&mut file, CENTRAL, at, &[value]);
        assert!(matches!(unzip(&file), Err(Error::Compressed(path)) if path == "board.json"));
    }
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
fn a_zip_never_needs_zip64() {
    let mut writer = zip::Writer::new();
    for at in 0..65_534 {
        header(&mut writer, &format!("{at:05}"), b"").unwrap();
    }
    assert!(matches!(
        header(&mut writer, "65534", b""),
        Err(Error::TooLarge)
    ));
    assert!(writer.finish().is_ok());

    for size in [u64::from(u32::MAX), 1 << 32, u64::MAX] {
        let mut writer = zip::Writer::new();
        assert!(matches!(
            writer.entry("big", size, 0, None),
            Err(Error::TooLarge)
        ));
    }

    let file = zip_entries(&[("board.json", b"{}")]);
    for (record, at) in [(END, 8), (CENTRAL, 20), (CENTRAL, 24), (CENTRAL, 42)] {
        let mut marked = file.clone();
        patch(&mut marked, record, at, &[0xff; 4]);
        assert!(matches!(unzip(&marked), Err(Error::UnsupportedZip)), "{at}");
    }
}

#[test]
fn the_largest_zip_that_needs_no_zip64_is_written() {
    // Offsets and sizes stop one short of 0xFFFFFFFF, which ZIP64 takes as its marker.
    let last = u64::from(u32::MAX) - 1;
    // A header is 30 bytes and its path, a directory record 46 and its path, its end 22.
    let largest = last - (30 + 3) - (46 + 3) - 22;
    let mut writer = zip::Writer::new();
    let header = writer.entry("big", largest, 0, None).unwrap();
    assert_eq!(get32(&header, 18), largest as u32);
    assert_eq!(get32(&header, 22), largest as u32);
    let end = writer.finish().unwrap();
    assert_eq!(get32(&end, end.len() - 6), (33 + largest) as u32);
    assert_eq!(33 + largest + end.len() as u64, last);

    let mut writer = zip::Writer::new();
    writer.entry("big", largest + 1, 0, None).unwrap();
    assert!(matches!(writer.finish(), Err(Error::TooLarge)));

    let mut writer = zip::Writer::new();
    writer.entry("big", last - 33, 0, None).unwrap();
    assert!(matches!(
        writer.entry("bigger", 0, 0, None),
        Err(Error::TooLarge)
    ));
    assert!(matches!(
        zip::Writer::new().entry("big", last - 32, 0, None),
        Err(Error::TooLarge)
    ));
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
fn a_board_missing_an_asset_its_images_show_is_refused() {
    let board = sample();
    let asset = format::asset_path(AssetId::of(IMAGE));
    let listed = ["board.json", "assets/0000", asset.as_str()];
    format::check_assets(&board, listed).unwrap();
    let error = format::check_assets(&board, ["board.json", "assets/0000"]).unwrap_err();
    assert!(matches!(error, Error::MissingAsset(missing) if missing == AssetId::of(IMAGE)));
    assert_eq!(
        error.to_string(),
        format!("asset {} is missing", AssetId::of(IMAGE))
    );
    format::check_assets(&Board::default(), []).unwrap();
}
