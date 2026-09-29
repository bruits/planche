use board::{AssetId, Board, Element, ElementId, ElementKind, ImageEdits, Point, Rect, Shape};
use format::{Error, Files};

const NOTE: ElementId = ElementId::from_random(3);
const ARROW: ElementId = ElementId::from_random(5);
const IMAGE: &[u8] = b"not really a PNG";

fn frame(width: f64, height: f64) -> Rect {
    Rect {
        x: 0.0,
        y: 0.0,
        width,
        height,
    }
}

fn sample() -> Board {
    let group = ElementId::from_random(1);
    let elements = [
        (
            group,
            Element {
                group: None,
                kind: ElementKind::Group,
            },
        ),
        (
            ElementId::from_random(2),
            Element {
                group: Some(group),
                kind: ElementKind::Image {
                    asset: AssetId::of(IMAGE),
                    frame: frame(640.0, 480.0),
                    edits: ImageEdits {
                        crop: Some(frame(320.0, 240.0)),
                        rotation: 90.0,
                        flip_horizontal: true,
                        flip_vertical: false,
                        greyscale: true,
                    },
                },
            },
        ),
        (
            NOTE,
            Element {
                group: Some(group),
                kind: ElementKind::Note {
                    frame: frame(200.0, 80.0),
                    text: "Warm light from the left".to_owned(),
                },
            },
        ),
        (
            ElementId::from_random(4),
            Element {
                group: None,
                kind: ElementKind::Shape {
                    frame: frame(100.0, 100.0),
                    shape: Shape::Ellipse,
                },
            },
        ),
        (
            ARROW,
            Element {
                group: None,
                kind: ElementKind::Arrow {
                    from: Point { x: 0.0, y: 0.0 },
                    // Without serde_json's `float_roundtrip`, these read back one bit off.
                    to: Point {
                        x: 1.0 / 11.0,
                        y: 2.0 / 13.0,
                    },
                },
            },
        ),
    ];
    Board {
        elements: elements.into_iter().collect(),
    }
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
        text.push('!');
    }
    let after = format::write(&board).unwrap();

    assert!(before.keys().eq(after.keys()));
    let changed: Vec<&str> = before
        .iter()
        .filter(|(path, bytes)| after[*path] != **bytes)
        .map(|(path, _)| path.as_str())
        .collect();
    assert_eq!(changed, [format!("elements/{NOTE}.json")]);
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
  "kind": {
    "type": "note",
    "frame": {
      "x": 0.0,
      "y": 0.0,
      "width": 200.0,
      "height": 80.0
    },
    "text": "Warm light from the left"
  }
}
"#
    );
}

#[test]
fn a_nan_is_refused_on_write() {
    let mut board = sample();
    if let ElementKind::Arrow { to, .. } = &mut board.elements.get_mut(&ARROW).unwrap().kind {
        to.x = f64::NAN;
    }
    assert!(matches!(
        format::write(&board),
        Err(Error::NotFinite(ARROW))
    ));
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
        files.insert(stray, vec![0]);
    }
    assert_eq!(format::read(&files).unwrap(), board);
}

#[test]
fn a_conflicted_copy_is_refused() {
    let mut files = format::write(&sample()).unwrap();
    let copy = format!("elements/{NOTE} (conflicted copy).json");
    assert!(!format::is_element_file(&copy));
    files.insert(
        copy.clone(),
        files[&format!("elements/{NOTE}.json")].clone(),
    );
    assert!(matches!(format::read(&files), Err(Error::InvalidName(name)) if name == copy));
}

#[test]
fn an_asset_cloned_without_git_lfs_is_refused() {
    let asset = AssetId::of(IMAGE);
    assert_eq!(format::asset_path(asset), format!("assets/{asset}"),);
    assert!(format::verify_asset(asset, IMAGE).is_ok());
    let pointer = b"version https://git-lfs.github.com/spec/v1\n";
    assert!(matches!(
        format::verify_asset(asset, pointer),
        Err(Error::CorruptAsset(corrupt)) if corrupt == asset
    ));
}
