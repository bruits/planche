use std::fs;
use std::path::Path;

use board::{
    AssetId, Board, Element, ElementId, ElementKind, ImageEdits, Point, Rect, Shape, Size, ZIndex,
};
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
            text: text.to_owned(),
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
                    },
                },
            },
        ),
        (NOTE, note(Some(group), "Warm light from the left")),
        (
            ElementId::from_random(4),
            Element {
                group: None,
                z: z("a1"),
                kind: ElementKind::Shape {
                    frame: frame(100.0, 100.0),
                    rotation: -12.5,
                    shape: Shape::Ellipse,
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
                },
            },
        ),
    ];
    Board {
        elements: elements.into_iter().collect(),
    }
}

fn changed<'a>(before: &Files, after: &'a Files) -> Vec<&'a str> {
    after
        .iter()
        .filter(|(path, bytes)| before.get(*path) != Some(*bytes))
        .map(|(path, _)| path.as_str())
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
        text.push('!');
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
    assert_eq!(order, [1, 2, 3, 4, 5].map(ElementId::from_random));
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
    "text": "Warm light from the left"
  }
}
"#
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
    };
    let shape = ElementKind::Shape {
        frame: zero,
        rotation: 0.0,
        shape: Shape::Rectangle,
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
    let read = format::read(&format::write(&board).unwrap()).unwrap();
    assert_eq!(read.elements[&NOTE].group, None);
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
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples/demo");
    let files = load(&folder);
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
        assert!(format::verify_asset(*asset, bytes).is_ok());
        // Only PNG sizes are checked, since they sit at a fixed offset.
        if let Some(header) = bytes.strip_prefix(b"\x89PNG\r\n\x1a\n") {
            let width = u32::from_be_bytes(header[8..12].try_into().unwrap());
            let height = u32::from_be_bytes(header[12..16].try_into().unwrap());
            assert_eq!(*natural_size, Size { width, height });
        }
    }
}
