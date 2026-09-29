//! The core for the web app, which every shell runs, from the browser to the desktop
//! webview. Boards cross as JSON and files as paths and bytes, since the shells do the I/O.

use std::collections::BTreeMap;

use board::{AssetId, Board, Element, ElementId};
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
    let json: BoardJson = serde_json::from_str(json)?;
    let files = format::write(&Board {
        elements: json.elements,
    })?;
    Ok(to_map(files))
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

fn to_map(files: impl IntoIterator<Item = (String, Vec<u8>)>) -> Map {
    let map = Map::new();
    for (path, bytes) in files {
        map.set(&path.into(), &Uint8Array::from(bytes.as_slice()).into());
    }
    map
}
