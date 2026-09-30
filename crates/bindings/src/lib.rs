//! The core for the web app, which every shell runs, from the browser to the desktop
//! webview. Elements cross as JSON, ids as strings, and files as paths and bytes, since the
//! shells do the I/O.

use std::collections::BTreeMap;
use std::ops::Range;

use board::{AssetId, Board, Element, ElementId, Point, Rect};
use format::zip;
use js_sys::{Map, Uint8Array};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct BoardJson<'a> {
    elements: &'a BTreeMap<ElementId, Element>,
    draw_order: Vec<ElementId>,
}

/// A board being edited, and the history of its edits. Every edit, undo, and redo returns the
/// ids of the elements it touched.
#[wasm_bindgen]
pub struct Editor(board::Editor);

#[wasm_bindgen]
impl Editor {
    /// Reads a board from its files, all but the assets.
    pub fn read(paths: Vec<String>, contents: Vec<Uint8Array>) -> Result<Editor, JsError> {
        let files = paths
            .into_iter()
            .zip(contents)
            .map(|(path, bytes)| (path, bytes.to_vec()))
            .collect();
        Ok(Self(board::Editor::new(format::read(&files)?)))
    }

    /// The board's elements by id, and its draw order.
    pub fn json(&self) -> Result<String, JsError> {
        let board = self.0.board();
        let json = BoardJson {
            elements: &board.elements,
            draw_order: board.draw_order(),
        };
        Ok(serde_json::to_string(&json)?)
    }

    pub fn element(&self, id: &str) -> Result<Option<String>, JsError> {
        let element = self.0.board().elements.get(&id.parse()?);
        Ok(element.map(serde_json::to_string).transpose()?)
    }

    /// Back to front.
    #[wasm_bindgen(js_name = drawOrder)]
    pub fn draw_order(&self) -> Vec<String> {
        strings(self.0.board().draw_order())
    }

    pub fn translate(
        &mut self,
        ids: Vec<String>,
        dx: f64,
        dy: f64,
    ) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.translate(&parse(ids)?, dx, dy)?))
    }

    pub fn remove(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.remove(&parse(ids)?)?))
    }

    /// Whether the board is as it was when read or last saved, however it got back there.
    #[wasm_bindgen(js_name = isSaved)]
    pub fn is_saved(&self) -> bool {
        self.0.is_saved()
    }

    /// The board as it is now, to write while editing goes on.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot(self.0.board().clone())
    }

    /// Once the board is written from `snapshot`, so that edits made since stay unsaved.
    #[wasm_bindgen(js_name = markSaved)]
    pub fn mark_saved(&mut self, snapshot: &Snapshot) {
        self.0.mark_saved(&snapshot.0);
    }

    #[wasm_bindgen(js_name = beginGesture)]
    pub fn begin_gesture(&mut self) {
        self.0.begin_gesture();
    }

    #[wasm_bindgen(js_name = endGesture)]
    pub fn end_gesture(&mut self) {
        self.0.end_gesture();
    }

    pub fn undo(&mut self) -> Vec<String> {
        strings(self.0.undo())
    }

    pub fn redo(&mut self) -> Vec<String> {
        strings(self.0.redo())
    }

    /// The topmost element that draws at a point, or within `tolerance` of it.
    pub fn hit(&self, x: f64, y: f64, tolerance: f64) -> Option<String> {
        let hit = self.0.board().hit(Point { x, y }, tolerance);
        hit.as_ref().map(ElementId::to_string)
    }

    /// Every element that draws something within the rectangle, from back to front.
    pub fn touching(&self, x: f64, y: f64, width: f64, height: f64) -> Vec<String> {
        let area = Rect {
            x,
            y,
            width,
            height,
        };
        strings(self.0.board().touching(area))
    }

    /// The element itself when at the top level, otherwise its outermost group.
    #[wasm_bindgen(js_name = topLevel)]
    pub fn top_level(&self, id: &str) -> Result<Option<String>, JsError> {
        let top = self.0.board().top_level(id.parse()?);
        Ok(top.as_ref().map(ElementId::to_string))
    }

    /// Each point's x then y, empty when the element draws nothing or is gone.
    pub fn outline(&self, id: &str) -> Result<Vec<f64>, JsError> {
        let outline = self.0.board().outline(id.parse()?).unwrap_or_default();
        Ok(outline
            .iter()
            .flat_map(|point| [point.x, point.y])
            .collect())
    }

    /// The x, y, width, and height of what the whole board draws, `undefined` when it draws
    /// nothing.
    pub fn bounds(&self) -> Option<Vec<f64>> {
        let board = self.0.board();
        let ids: Vec<ElementId> = board.elements.keys().copied().collect();
        let bounds = board.bounds(&ids)?;
        Some(vec![bounds.x, bounds.y, bounds.width, bounds.height])
    }
}

/// A board as it was when taken, which its files are written from.
#[wasm_bindgen]
pub struct Snapshot(Board);

#[wasm_bindgen]
impl Snapshot {
    /// Every file of the board but the assets.
    pub fn write(&self) -> Result<Map, JsError> {
        Ok(to_map(format::write(&self.0)?))
    }

    /// The paths of the board's ZIP file in the order it holds them, the assets its images
    /// show included.
    #[wasm_bindgen(js_name = zipPaths)]
    pub fn zip_paths(&self) -> Result<Vec<String>, JsError> {
        Ok(zip::paths(&self.0)?)
    }
}

/// The files a new board folder starts with, besides those of [`Snapshot::write`].
#[wasm_bindgen(js_name = newBoardFiles)]
pub fn new_board_files() -> Map {
    let (path, bytes) = format::git_attributes();
    to_map([(path.to_owned(), bytes)])
}

/// How many segments deep board files go, so that shells list no further.
#[wasm_bindgen(js_name = fileDepth)]
pub fn file_depth() -> usize {
    format::DEPTH
}

#[wasm_bindgen(js_name = isBoardFile)]
pub fn is_board_file(path: &str) -> bool {
    format::is_board_file(path)
}

#[wasm_bindgen(js_name = isAssetFile)]
pub fn is_asset_file(path: &str) -> bool {
    format::is_asset_file(path)
}

#[wasm_bindgen(js_name = assetPath)]
pub fn asset_path(asset: &str) -> Result<String, JsError> {
    Ok(format::asset_path(asset.parse::<AssetId>()?))
}

#[wasm_bindgen(js_name = verifyAsset)]
pub fn verify_asset(asset: &str, bytes: &[u8]) -> Result<(), JsError> {
    Ok(format::verify_asset(asset.parse()?, bytes)?)
}

/// Writes a board's ZIP file one entry at a time.
#[wasm_bindgen]
#[derive(Default)]
pub struct ZipWriter(zip::Writer);

#[wasm_bindgen]
impl ZipWriter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// The header to write right before `bytes`.
    pub fn entry(&mut self, path: &str, bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        Ok(self.0.entry(path, bytes)?)
    }

    /// What ends the file, after the last entry.
    pub fn finish(self) -> Result<Vec<u8>, JsError> {
        Ok(self.0.finish()?)
    }
}

/// Offsets and lengths cross as numbers rather than `BigInt`s, like a `Blob`'s.
#[wasm_bindgen(js_name = zipTailLength)]
pub fn zip_tail_length(length: f64) -> Result<f64, JsError> {
    Ok(zip::tail_length(offset(length)?) as f64)
}

/// Where the central directory lies, from the file's last `zipTailLength` bytes.
#[wasm_bindgen(js_name = locateZipDirectory)]
pub fn locate_zip_directory(length: f64, tail: &[u8]) -> Result<Vec<f64>, JsError> {
    Ok(span(zip::locate(offset(length)?, tail)?))
}

/// A ZIP file's entries, from its central directory.
#[wasm_bindgen]
pub struct ZipIndex(zip::Index);

#[wasm_bindgen]
impl ZipIndex {
    #[wasm_bindgen(constructor)]
    pub fn new(start: f64, directory: &[u8]) -> Result<ZipIndex, JsError> {
        Ok(Self(zip::Index::read(offset(start)?, directory)?))
    }

    pub fn paths(&self) -> Vec<String> {
        self.0.paths().map(str::to_owned).collect()
    }

    /// Where the entry's header lies, which says where its bytes start.
    pub fn header(&self, path: &str) -> Result<Vec<f64>, JsError> {
        Ok(span(self.entry(path)?.header()))
    }

    /// Where the entry's bytes lie, from the bytes at `header`.
    pub fn data(&self, path: &str, header: &[u8]) -> Result<Vec<f64>, JsError> {
        Ok(span(self.entry(path)?.data(header)?))
    }

    /// Checks the bytes read at `data` against their checksum.
    pub fn check(&self, path: &str, bytes: &[u8]) -> Result<(), JsError> {
        Ok(self.entry(path)?.check(bytes)?)
    }

    fn entry(&self, path: &str) -> Result<&zip::Entry, JsError> {
        self.0
            .entry(path)
            .ok_or_else(|| JsError::new(&format!("`{path}` is not in the ZIP file")))
    }
}

fn parse(ids: Vec<String>) -> Result<Vec<ElementId>, JsError> {
    Ok(ids
        .iter()
        .map(|id| id.parse())
        .collect::<Result<_, board::Error>>()?)
}

fn strings(ids: Vec<ElementId>) -> Vec<String> {
    ids.iter().map(ElementId::to_string).collect()
}

/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn offset(value: f64) -> Result<u64, JsError> {
    if value >= 0.0 && value.fract() == 0.0 && value <= MAX_SAFE_INTEGER {
        Ok(value as u64)
    } else {
        Err(JsError::new(&format!("{value} is not an offset in a file")))
    }
}

fn span(range: Range<u64>) -> Vec<f64> {
    vec![range.start as f64, range.end as f64]
}

fn to_map(files: impl IntoIterator<Item = (String, Vec<u8>)>) -> Map {
    let map = Map::new();
    for (path, bytes) in files {
        map.set(&path.into(), &Uint8Array::from(bytes.as_slice()).into());
    }
    map
}
