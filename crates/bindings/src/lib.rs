//! The core for the web app, which every shell runs, from the browser to the desktop
//! webview. Boards cross as JSON and files as paths and bytes, since the shells do the I/O.

use std::collections::BTreeMap;
use std::ops::Range;

use board::{AssetId, Board, Element, ElementId};
use format::zip;
use js_sys::{Map, Uint8Array};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize)]
struct BoardJson {
    elements: BTreeMap<ElementId, Element>,
    #[serde(default, skip_deserializing)]
    draw_order: Vec<ElementId>,
}

/// Reads a board from its files, all but the assets, into JSON that also holds its draw
/// order.
#[wasm_bindgen(js_name = readBoard)]
pub fn read_board(paths: Vec<String>, contents: Vec<Uint8Array>) -> Result<String, JsError> {
    let files = paths
        .into_iter()
        .zip(contents)
        .map(|(path, bytes)| (path, bytes.to_vec()))
        .collect();
    let board = format::read(&files)?;
    let json = BoardJson {
        draw_order: board.draw_order(),
        elements: board.elements,
    };
    Ok(serde_json::to_string(&json)?)
}

/// The files of a board, all but the assets, from the JSON [`read_board`] gives.
#[wasm_bindgen(js_name = writeBoard)]
pub fn write_board(json: &str) -> Result<Map, JsError> {
    Ok(to_map(format::write(&board_of(json)?)?))
}

/// The files a new board folder starts with, besides those of [`write_board`].
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

/// The paths of a board's ZIP file in the order it holds them, from the JSON [`read_board`]
/// gives.
#[wasm_bindgen(js_name = zipPaths)]
pub fn zip_paths(json: &str) -> Result<Vec<String>, JsError> {
    Ok(zip::paths(&board_of(json)?)?)
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

fn board_of(json: &str) -> Result<Board, JsError> {
    let json: BoardJson = serde_json::from_str(json)?;
    Ok(Board {
        elements: json.elements,
    })
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
