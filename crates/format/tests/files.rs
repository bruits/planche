use std::collections::BTreeSet;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

use board::{
    AssetId, Board, Editor, Element, ElementId, ElementKind, ImageEdits, Point, Rect, Restack,
    Shape, Size, Text, ZIndex,
};
use format::{Error, Files, zip};

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
            text: Text {
                content: text.to_owned(),
                font_size: 20.0,
            },
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
                    text: Text {
                        content: "Key light".to_owned(),
                        font_size: 16.0,
                    },
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
        (
            ElementId::from_random(6),
            Element {
                group: None,
                z: z("a3"),
                kind: ElementKind::Sticky {
                    frame: frame(160.0, 160.0),
                    rotation: 5.0,
                    text: Text {
                        content: "Try a warmer grade\nfor the dusk shots".to_owned(),
                        font_size: 20.0,
                    },
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
                    text: Text {
                        content: String::new(),
                        font_size: 20.0,
                    },
                },
            },
        ),
    ];
    Board {
        elements: elements.into_iter().collect(),
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
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map(ElementId::from_random)
    );
}

#[test]
fn every_edit_rewrites_its_own_files_and_undoes_to_the_same_bytes() {
    type Edit = fn(&mut Editor) -> board::Result<Vec<ElementId>>;
    fn id(bits: u128) -> ElementId {
        ElementId::from_random(bits)
    }
    let cases: [(Edit, &[u128]); 10] = [
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
        (|editor| editor.restack(&[id(4)], Restack::Front), &[4]),
        (|editor| editor.group(id(10), &[id(4), ARROW]), &[4, 5, 10]),
        (|editor| editor.ungroup(id(1)), &[1, 2, 3]),
        (|editor| editor.remove(&[ARROW]), &[5]),
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
        text: Text {
            content: String::new(),
            font_size: 1.0,
        },
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
        assert!(format::verify_asset(*asset, bytes).is_ok());
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
        out.extend(writer.entry(&path, bytes)?);
        out.extend_from_slice(bytes);
    }
    out.extend(writer.finish()?);
    Ok(out)
}

fn zip_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::Writer::new();
    let mut out = Vec::new();
    for (path, bytes) in entries {
        out.extend(writer.entry(path, bytes).unwrap());
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
        entry.check(bytes)?;
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
fn a_corrupt_asset_is_not_zipped() {
    let asset = AssetId::of(IMAGE);
    let mut writer = zip::Writer::new();
    assert!(matches!(
        writer.entry(&format::asset_path(asset), b"version https://git-lfs.github.com/spec/v1\n"),
        Err(Error::CorruptAsset(corrupt)) if corrupt == asset
    ));
}

#[test]
fn zip_entries_come_in_path_order_once() {
    let mut writer = zip::Writer::new();
    writer.entry("elements/b", b"").unwrap();
    for path in ["elements/a", "elements/b"] {
        assert!(matches!(writer.entry(path, b""), Err(Error::OutOfOrder(named)) if named == path));
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
        assert!(matches!(writer.entry(path, b""), Err(Error::UnsafePath(named)) if named == path));
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
        writer.entry(&format!("{at:05}"), b"").unwrap();
    }
    assert!(matches!(writer.entry("65534", b""), Err(Error::TooLarge)));
    assert!(writer.finish().is_ok());

    let file = zip_entries(&[("board.json", b"{}")]);
    for (record, at) in [(END, 8), (CENTRAL, 20), (CENTRAL, 24), (CENTRAL, 42)] {
        let mut marked = file.clone();
        patch(&mut marked, record, at, &[0xff; 4]);
        assert!(matches!(unzip(&marked), Err(Error::UnsupportedZip)), "{at}");
    }
}
