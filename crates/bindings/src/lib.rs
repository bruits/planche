//! The core for the web app, which every shell runs, from the browser to the desktop
//! webview. Elements cross as JSON, ids as strings, and files as paths and bytes, since the
//! shells do the I/O.

use std::collections::BTreeMap;
use std::ops::Range;

use board::{
    Animation, AssetId, Background, Board, Element, ElementId, ElementKind, GRID_STEP, GridLevel,
    Point, Rect, Restack, Size,
};
use format::zip;
use js_sys::{Map, Uint8Array};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct BoardJson<'a> {
    elements: &'a BTreeMap<ElementId, Element>,
    draw_order: Vec<ElementId>,
    background: Background,
}

#[derive(Serialize)]
struct Stuck {
    target: ElementId,
    at: Point,
}

/// A board being edited, and the history of its edits. Every edit, undo, and redo returns the
/// ids of the elements it touched, which leaves out the background.
#[wasm_bindgen]
#[derive(Default)]
pub struct Editor(board::Editor);

#[wasm_bindgen]
impl Editor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads a board from its files, all but the assets.
    pub fn read(paths: Vec<String>, contents: Vec<Uint8Array>) -> Result<Editor, JsError> {
        let files = paths
            .into_iter()
            .zip(contents)
            .map(|(path, bytes)| (path, bytes.to_vec()))
            .collect();
        Ok(Self(board::Editor::new(format::read(&files)?)))
    }

    /// The board's elements by id, its draw order, and its background.
    pub fn json(&self) -> Result<String, JsError> {
        let board = self.0.board();
        let json = BoardJson {
            elements: &board.elements,
            draw_order: board.draw_order(),
            background: board.background,
        };
        Ok(serde_json::to_string(&json)?)
    }

    /// As JSON, as in [`Editor::json`].
    pub fn background(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.0.board().background)?)
    }

    /// `background` as JSON.
    #[wasm_bindgen(js_name = setBackground)]
    pub fn set_background(&mut self, background: &str) -> Result<(), JsError> {
        self.0.set_background(serde_json::from_str(background)?);
        Ok(())
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

    /// Puts `members`, two or more elements of the same group, into a new group.
    pub fn group(&mut self, group: &str, members: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.group(group.parse()?, &parse(members)?)?))
    }

    pub fn ungroup(&mut self, group: &str) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.ungroup(group.parse()?)?))
    }

    /// On top of `group`, or of the top level, `kind` as JSON.
    pub fn add(
        &mut self,
        id: &str,
        group: Option<String>,
        kind: &str,
    ) -> Result<Vec<String>, JsError> {
        let kind: ElementKind = serde_json::from_str(kind)?;
        let group = group.map(|group| group.parse()).transpose()?;
        Ok(strings(self.0.add(id.parse()?, group, kind)?))
    }

    /// `kind` as JSON, of the kind the element has.
    pub fn update(&mut self, id: &str, kind: &str) -> Result<Vec<String>, JsError> {
        let kind: ElementKind = serde_json::from_str(kind)?;
        Ok(strings(self.0.update(id.parse()?, kind)?))
    }

    pub fn scale(
        &mut self,
        ids: Vec<String>,
        x: f64,
        y: f64,
        factor: f64,
    ) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.scale(
            &parse(ids)?,
            Point { x, y },
            factor,
        )?))
    }

    pub fn rotate(
        &mut self,
        ids: Vec<String>,
        x: f64,
        y: f64,
        degrees: f64,
    ) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.rotate(
            &parse(ids)?,
            Point { x, y },
            degrees,
        )?))
    }

    /// Once moved or scaled onto the grid, so that what is on it writes as it reads.
    #[wasm_bindgen(js_name = settleOnGrid)]
    pub fn settle_on_grid(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.settle_on_grid(&parse(ids)?)?))
    }

    pub fn land(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.land(&parse(ids)?)?))
    }

    pub fn unstick(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.unstick(&parse(ids)?)?))
    }

    pub fn flip(&mut self, ids: Vec<String>, horizontally: bool) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.flip(&parse(ids)?, horizontally)?))
    }

    /// `to` is `forward`, `backward`, `front`, or `back`.
    pub fn restack(&mut self, ids: Vec<String>, to: &str) -> Result<Vec<String>, JsError> {
        let to = match to {
            "forward" => Restack::Forward,
            "backward" => Restack::Backward,
            "front" => Restack::Front,
            "back" => Restack::Back,
            _ => return Err(JsError::new(&format!("`{to}` is not a way to restack"))),
        };
        Ok(strings(self.0.restack(&parse(ids)?, to)?))
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

    /// Takes the open gesture's edits back and keeps it open.
    #[wasm_bindgen(js_name = rewindGesture)]
    pub fn rewind_gesture(&mut self) -> Vec<String> {
        strings(self.0.rewind_gesture())
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

    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.0.can_undo()
    }

    #[wasm_bindgen(js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.0.can_redo()
    }

    /// The topmost element that draws at a point, or within `tolerance` of it.
    pub fn hit(&self, x: f64, y: f64, tolerance: f64) -> Option<String> {
        let hit = self.0.board().hit(Point { x, y }, tolerance);
        hit.as_ref().map(ElementId::to_string)
    }

    /// Every element that draws within `tolerance` of the way from one point to another, under
    /// others too, from back to front.
    #[wasm_bindgen(js_name = hitAlong)]
    pub fn hit_along(
        &self,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        tolerance: f64,
    ) -> Vec<String> {
        let (from, to) = (
            Point {
                x: from_x,
                y: from_y,
            },
            Point { x: to_x, y: to_y },
        );
        strings(self.0.board().hit_along(from, to, tolerance))
    }

    /// Every element whose area holds a point, besides its outline, from back to front.
    pub fn covering(&self, x: f64, y: f64) -> Vec<String> {
        strings(self.0.board().covering(Point { x, y }))
    }

    /// Where an arrow's or a line's end let go at a point sticks, as JSON: the element it
    /// sticks to, and where, onto its outline when within `tolerance` of it. `undefined` when
    /// nothing there takes ends.
    pub fn stick(&self, x: f64, y: f64, tolerance: f64) -> Result<Option<String>, JsError> {
        let stuck = self.0.board().stick(Point { x, y }, tolerance);
        let json = stuck.map(|(target, at)| serde_json::to_string(&Stuck { target, at }));
        Ok(json.transpose()?)
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

    /// The element itself when in `group`, otherwise its group that is, `undefined` when it is
    /// not within `group`.
    #[wasm_bindgen(js_name = memberOf)]
    pub fn member_of(&self, group: &str, id: &str) -> Result<Option<String>, JsError> {
        let member = self.0.board().member(group.parse()?, id.parse()?);
        Ok(member.as_ref().map(ElementId::to_string))
    }

    /// Each point's x then y, empty when the element draws nothing or is gone.
    pub fn outline(&self, id: &str) -> Result<Vec<f64>, JsError> {
        let outline = self.0.board().outline(id.parse()?).unwrap_or_default();
        Ok(outline
            .iter()
            .flat_map(|point| [point.x, point.y])
            .collect())
    }

    /// The x, y, width, and height of what the elements draw, their groups' elements included,
    /// `undefined` when they draw nothing.
    pub fn bounds(&self, ids: Vec<String>) -> Result<Option<Vec<f64>>, JsError> {
        let bounds = self.0.board().bounds(&parse(ids)?);
        Ok(bounds.map(|bounds| vec![bounds.x, bounds.y, bounds.width, bounds.height]))
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

/// How wide arrows, lines, and shapes draw, in board units, as the core hits them.
#[wasm_bindgen(js_name = strokeWidth)]
pub fn stroke_width() -> f64 {
    board::STROKE_WIDTH
}

/// The grid's finest lines that show at `zoom`, CSS pixels per board unit. How far apart they
/// are in board units, how much they show from 0 to 1, and how far apart are those that show in
/// full.
#[wasm_bindgen(js_name = gridLevel)]
pub fn grid_level(zoom: f64) -> Vec<f64> {
    let GridLevel { spacing, fade } = GridLevel::at(zoom);
    vec![spacing, fade, spacing * GRID_STEP]
}

/// How far to move along one axis for the nearest of `values` to land on a line of the grid
/// that shows at `zoom`, `undefined` when none is near enough.
#[wasm_bindgen(js_name = snapToGrid)]
pub fn snap_to_grid(values: &[f64], zoom: f64) -> Option<f64> {
    board::snap_to_grid(values, zoom)
}

/// The factor near `factor` that scales the corner around the origin onto a line of the grid
/// that shows at `zoom`, `undefined` when none is near enough.
#[wasm_bindgen(js_name = snapScaleToGrid)]
pub fn snap_scale_to_grid(
    origin_x: f64,
    origin_y: f64,
    corner_x: f64,
    corner_y: f64,
    factor: f64,
    zoom: f64,
) -> Option<f64> {
    let origin = Point {
        x: origin_x,
        y: origin_y,
    };
    let corner = Point {
        x: corner_x,
        y: corner_y,
    };
    board::snap_scale_to_grid(origin, corner, factor, zoom)
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

#[wasm_bindgen(js_name = assetId)]
pub fn asset_id(bytes: &[u8]) -> String {
    AssetId::of(bytes).to_string()
}

#[wasm_bindgen(js_name = verifyAsset)]
pub fn verify_asset(asset: &str, bytes: &[u8]) -> Result<(), JsError> {
    Ok(format::verify_asset(asset.parse()?, bytes)?)
}

/// An SVG's natural size in CSS pixels, width then height, `undefined` when `bytes` are not
/// an SVG document.
#[wasm_bindgen(js_name = svgSize)]
pub fn svg_size(bytes: &[u8]) -> Option<Vec<u32>> {
    board::svg_size(bytes).map(|size| vec![size.width, size.height])
}

/// The SVG with its root sized to `width` by `height`, for every host to draw it at that size,
/// `undefined` when `bytes` are not an SVG document.
#[wasm_bindgen(js_name = sizedSvg)]
pub fn sized_svg(bytes: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    board::sized_svg(bytes, Size { width, height })
}

/// How many times an animated image plays through, 0 for ever, `undefined` when `bytes` do not
/// move.
#[wasm_bindgen(js_name = animationPlays)]
pub fn animation_plays(bytes: &[u8]) -> Option<u32> {
    board::animation(bytes).map(|animation| match animation {
        Animation::Forever => 0,
        Animation::Plays(times) => times.get(),
    })
}

/// How long a frame that asks for `milliseconds` shows.
#[wasm_bindgen(js_name = frameDelay)]
pub fn frame_delay(milliseconds: f64) -> f64 {
    board::frame_delay(milliseconds)
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
