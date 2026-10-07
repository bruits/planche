//! The core for the web app, which every shell runs, from the browser to the desktop
//! webview. Elements cross as JSON, ids as strings, and files as paths and bytes, since the
//! shells do the I/O. Bytes named as an asset or checksummed for a ZIP file cross in slices, as
//! the core's memory never shrinks.

use std::collections::BTreeMap;
use std::ops::Range;

use board::{
    Alignment, AssetId, Axis, Board, Colour, Copied, Corners, ElementId, ElementKind, GRID_STEP,
    GridLevel, MovieIndex, Order, Point, Rect, Restack, Scale, Shape, Side, Size, Speed, Style,
    Tip, Transform, Weight,
};
use format::{save, zip};
use js_sys::{Map, Uint8Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = include_str!(concat!(env!("OUT_DIR"), "/types.d.ts"));

/// A board being edited, and the history of its edits. Every edit, undo, and redo returns the
/// ids of the elements it touched, which leaves out the background.
#[wasm_bindgen]
#[derive(Default)]
pub struct Editor(board::Editor, Vec<format::LeftOut>);

#[wasm_bindgen]
impl Editor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// The assets that images show and `listed`, the paths of its folder, lacks, in draw order.
    #[wasm_bindgen(js_name = missingAssets)]
    pub fn missing_assets(&self, listed: Vec<String>) -> Vec<String> {
        let missing = format::missing_assets(self.0.board(), listed.iter().map(String::as_str));
        missing.into_iter().map(|asset| asset.to_string()).collect()
    }

    /// Reads a board from its files, all but the assets.
    pub fn read(paths: Vec<String>, contents: Vec<Uint8Array>) -> Result<Editor, JsError> {
        let files = paths
            .into_iter()
            .zip(contents)
            .map(|(path, bytes)| (path, bytes.to_vec()))
            .collect();
        let format::Reading { board, left_out } = format::read(&files)?;
        Ok(Self(board::Editor::new(board), left_out))
    }

    /// The element files that reading left out, by path, each with why.
    #[wasm_bindgen(js_name = leftOut)]
    pub fn left_out(&self) -> Map {
        let map = Map::new();
        for format::LeftOut { path, error } in &self.1 {
            map.set(&path.into(), &error.to_string().into());
        }
        map
    }

    /// The board's elements by id, its draw order, and its background.
    pub fn json(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.0.board().view())?)
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

    pub fn drawn(&self, ids: Vec<String>, crossed_out: Vec<String>) -> Result<String, JsError> {
        let crossed_out = crossed_out
            .iter()
            .map(|asset| asset.parse())
            .collect::<Result<_, board::Error>>()?;
        let board = self.0.board();
        let drawn: Vec<_> = parse(ids)?
            .into_iter()
            .map(|id| board.drawn(id, &crossed_out))
            .collect();
        Ok(serde_json::to_string(&drawn)?)
    }

    pub fn translate(
        &mut self,
        ids: Vec<String>,
        dx: f64,
        dy: f64,
    ) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.translate(&parse(ids)?, dx, dy)?))
    }

    /// `transform` as JSON. Sets down what it moves, and is refused as a whole when any part of it
    /// is.
    pub fn transform(&mut self, ids: Vec<String>, transform: &str) -> Result<Vec<String>, JsError> {
        let transform: Transform = serde_json::from_str(transform)?;
        Ok(strings(self.0.transform(&parse(ids)?, &transform)?))
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

    /// The elements, with all that their groups hold, as JSON for `paste`.
    pub fn copy(&self, ids: Vec<String>) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.0.board().copy(&parse(ids)?))?)
    }

    /// On top of `group`, or of the top level, `copied` as `copy` gives it, each element under
    /// the id that `ids`, as JSON, maps its own to.
    pub fn paste(
        &mut self,
        copied: &str,
        ids: &str,
        group: Option<String>,
    ) -> Result<Vec<String>, JsError> {
        let copied: Copied = serde_json::from_str(copied)?;
        let ids: BTreeMap<ElementId, ElementId> = serde_json::from_str(ids)?;
        let group = group.map(|group| group.parse()).transpose()?;
        Ok(strings(self.0.paste(&copied, &ids, group)?))
    }

    /// `kind` as JSON, of the kind the element has.
    pub fn update(&mut self, id: &str, kind: &str) -> Result<Vec<String>, JsError> {
        let kind: ElementKind = serde_json::from_str(kind)?;
        Ok(strings(self.0.update(id.parse()?, kind)?))
    }

    /// `kind` as JSON, of the kind the element has, as moving a side of its frame gives it.
    pub fn stretch(&mut self, id: &str, kind: &str) -> Result<Vec<String>, JsError> {
        let kind: ElementKind = serde_json::from_str(kind)?;
        Ok(strings(self.0.stretch(id.parse()?, kind)?))
    }

    pub fn land(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.land(&parse(ids)?)?))
    }

    pub fn flip(&mut self, ids: Vec<String>, horizontally: bool) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.flip(&parse(ids)?, horizontally)?))
    }

    /// `to` is `forward`, `backward`, `front`, or `back`.
    pub fn restack(&mut self, ids: Vec<String>, to: String) -> Result<Vec<String>, JsError> {
        let to: Restack = serde_json::from_value(to.into())?;
        Ok(strings(self.0.restack(&parse(ids)?, to)?))
    }

    /// `order` is JSON, by `name`, `size`, `hue` with `colours` by id, or `random` with a `seed`.
    pub fn arrange(&mut self, ids: Vec<String>, order: &str) -> Result<Vec<String>, JsError> {
        let order: Order = serde_json::from_str(order)?;
        Ok(strings(self.0.arrange(&parse(ids)?, &order)?))
    }

    /// `side` is `height` or `width`.
    pub fn normalize(&mut self, ids: Vec<String>, side: String) -> Result<Vec<String>, JsError> {
        let side: Side = serde_json::from_value(side.into())?;
        Ok(strings(self.0.normalize(&parse(ids)?, side)?))
    }

    /// `to` is `left`, `centre`, `right`, `top`, `middle`, or `bottom`.
    pub fn align(&mut self, ids: Vec<String>, to: String) -> Result<Vec<String>, JsError> {
        let to: Alignment = serde_json::from_value(to.into())?;
        Ok(strings(self.0.align(&parse(ids)?, to)?))
    }

    /// `axis` is `horizontal` or `vertical`.
    pub fn distribute(&mut self, ids: Vec<String>, axis: String) -> Result<Vec<String>, JsError> {
        let axis: Axis = serde_json::from_value(axis.into())?;
        Ok(strings(self.0.distribute(&parse(ids)?, axis)?))
    }

    /// In the image's pixels, as displayed.
    pub fn crop(
        &mut self,
        id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<Vec<String>, JsError> {
        let area = Rect {
            x,
            y,
            width,
            height,
        };
        Ok(strings(self.0.crop(id.parse()?, area)?))
    }

    #[wasm_bindgen(js_name = resetCrop)]
    pub fn reset_crop(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.reset_crop(&parse(ids)?)?))
    }

    /// `shape` as JSON.
    #[wasm_bindgen(js_name = setCropShape)]
    pub fn set_crop_shape(
        &mut self,
        ids: Vec<String>,
        shape: &str,
    ) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.set_crop_shape(
            &parse(ids)?,
            serde_json::from_str(shape)?,
        )?))
    }

    /// `trim` as JSON, the whole of each when `undefined`.
    #[wasm_bindgen(js_name = setTrim)]
    pub fn set_trim(
        &mut self,
        ids: Vec<String>,
        trim: Option<String>,
    ) -> Result<Vec<String>, JsError> {
        let trim = trim.map(|trim| serde_json::from_str(&trim)).transpose()?;
        Ok(strings(self.0.set_trim(&parse(ids)?, trim)?))
    }

    /// `times` as fast as each was made, within what browsers play.
    #[wasm_bindgen(js_name = setSpeed)]
    pub fn set_speed(&mut self, ids: Vec<String>, times: f64) -> Result<Vec<String>, JsError> {
        let speed = Speed::new(times)
            .ok_or_else(|| JsError::new(&format!("no browser plays {times} times as fast")))?;
        Ok(strings(self.0.set_speed(&parse(ids)?, speed)?))
    }

    #[wasm_bindgen(js_name = setGreyscale)]
    pub fn set_greyscale(
        &mut self,
        ids: Vec<String>,
        greyscale: bool,
    ) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.set_greyscale(&parse(ids)?, greyscale)?))
    }

    pub fn straighten(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.straighten(&parse(ids)?)?))
    }

    #[wasm_bindgen(js_name = actualSize)]
    pub fn actual_size(&mut self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.actual_size(&parse(ids)?)?))
    }

    /// Of each element itself, whatever its group's lock or its elements' own.
    #[wasm_bindgen(js_name = setLocked)]
    pub fn set_locked(&mut self, ids: Vec<String>, locked: bool) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.set_locked(&parse(ids)?, locked)?))
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

    /// The assets of the images its history holds, which undo, redo, or rewinding the open
    /// gesture may bring back.
    #[wasm_bindgen(js_name = historyAssets)]
    pub fn history_assets(&self) -> Vec<String> {
        self.0
            .history_assets()
            .iter()
            .map(AssetId::to_string)
            .collect()
    }

    /// The topmost element that draws at a point, or within `tolerance` of it.
    pub fn hit(&self, x: f64, y: f64, tolerance: f64) -> Option<String> {
        let hit = self.0.board().hit(Point { x, y }, tolerance);
        hit.as_ref().map(ElementId::to_string)
    }

    /// What `hit` finds, but through the locked elements, as a click goes.
    #[wasm_bindgen(js_name = hitUnlocked)]
    pub fn hit_unlocked(&self, x: f64, y: f64, tolerance: f64) -> Option<String> {
        let hit = self.0.board().hit_unlocked(Point { x, y }, tolerance);
        hit.as_ref().map(ElementId::to_string)
    }

    /// Every element not locked that draws within `tolerance` of the way from one point to
    /// another, under others too, from back to front.
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

    /// Where an arrow's or a line's end let go at a point lands, and what it sticks to there, as
    /// JSON. Within `reach` of what it sticks to, when it sticks, or pulled by the grid that shows
    /// at the zoom `pull`, when it pulls, or locked at a multiple of 45° around the other end, when
    /// given.
    #[wasm_bindgen(js_name = landEnd)]
    pub fn land_end(
        &self,
        x: f64,
        y: f64,
        around_x: Option<f64>,
        around_y: Option<f64>,
        reach: Option<f64>,
        pull: Option<f64>,
    ) -> Result<String, JsError> {
        let around = around_x.zip(around_y).map(|(x, y)| Point { x, y });
        let end = self.0.board().land_end(Point { x, y }, around, reach, pull);
        Ok(serde_json::to_string(&end)?)
    }

    /// Every element that draws something within the rectangle, and every comment pinned in
    /// it, from back to front.
    pub fn touching(&self, x: f64, y: f64, width: f64, height: f64) -> Vec<String> {
        let area = Rect {
            x,
            y,
            width,
            height,
        };
        strings(self.0.board().touching(area))
    }

    /// The top-level elements and outermost groups of what `touching` finds but for the locked
    /// elements, once each.
    #[wasm_bindgen(js_name = touchingTopLevel)]
    pub fn touching_top_level(&self, x: f64, y: f64, width: f64, height: f64) -> Vec<String> {
        let area = Rect {
            x,
            y,
            width,
            height,
        };
        strings(self.0.board().touching_top_level(area))
    }

    /// What the elements, with those of the groups among them, stick to whole, once each.
    #[wasm_bindgen(js_name = targetsOf)]
    pub fn targets_of(&self, ids: Vec<String>) -> Result<Vec<String>, JsError> {
        Ok(strings(self.0.board().targets_of(&parse(ids)?)))
    }

    /// The element itself when at the top level, otherwise its outermost group.
    #[wasm_bindgen(js_name = topLevel)]
    pub fn top_level(&self, id: &str) -> Result<Option<String>, JsError> {
        let top = self.0.board().top_level(id.parse()?);
        Ok(top.as_ref().map(ElementId::to_string))
    }

    /// The outermost of the element and its groups that is locked, the first to unlock,
    /// `undefined` when none is.
    #[wasm_bindgen(js_name = lockedBy)]
    pub fn locked_by(&self, id: &str) -> Result<Option<String>, JsError> {
        let locked = self.0.board().locked_by(id.parse()?);
        Ok(locked.as_ref().map(ElementId::to_string))
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
        Ok(self.0.board().bounds(&parse(ids)?).map(rect))
    }

    /// As `bounds`, with the points where the comments among them are pinned.
    pub fn extent(&self, ids: Vec<String>) -> Result<Option<Vec<f64>>, JsError> {
        Ok(self.0.board().extent(&parse(ids)?).map(rect))
    }

    /// As `bounds` gives them, one after another, each element, or group whole, at the level of
    /// the group `within`, or the top level, that stays put as the elements move.
    pub fn neighbours(
        &self,
        ids: Vec<String>,
        within: Option<String>,
    ) -> Result<Vec<f64>, JsError> {
        let within = within.map(|id| id.parse()).transpose()?;
        let found = self.0.board().neighbours(&parse(ids)?, within);
        Ok(found.into_iter().flat_map(rect).collect())
    }

    /// The x and y of the image's pixel at a point, as displayed, `undefined` for no image.
    #[wasm_bindgen(js_name = pixelAt)]
    pub fn pixel_at(&self, id: &str, x: f64, y: f64) -> Result<Option<Vec<f64>>, JsError> {
        let pixel = self.0.board().pixel_at(id.parse()?, Point { x, y });
        Ok(pixel.map(|pixel| vec![pixel.x, pixel.y]))
    }

    /// Where the image's pixel lies, as `pixelAt` gives it.
    #[wasm_bindgen(js_name = pointOfPixel)]
    pub fn point_of_pixel(&self, id: &str, x: f64, y: f64) -> Result<Option<Vec<f64>>, JsError> {
        let point = self.0.board().point_of_pixel(id.parse()?, Point { x, y });
        Ok(point.map(|point| vec![point.x, point.y]))
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
    pub fn zip_paths(
        &self,
        carried: Vec<String>,
        lacking: Vec<String>,
    ) -> Result<Vec<String>, JsError> {
        let (carried, lacking) = (carried.iter(), lacking.iter());
        Ok(zip::paths(
            &self.0,
            carried.map(String::as_str),
            lacking.map(String::as_str),
        )?)
    }
}

/// A board's folder as the app last read or wrote it, so that a save writes only the files
/// whose bytes changed, and deletes only the element files it knew.
#[wasm_bindgen]
#[derive(Default)]
pub struct Known(save::Known);

#[wasm_bindgen]
impl Known {
    /// Of an empty folder.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// From the folder's listing, and the board files read from it.
    pub fn read(listed: Vec<String>, paths: Vec<String>, contents: Vec<Uint8Array>) -> Known {
        let files = paths
            .into_iter()
            .zip(contents)
            .map(|(path, bytes)| (path, bytes.to_vec()))
            .collect();
        Self(save::Known::new(listed, files))
    }

    /// What saving the board of `snapshot` writes, `touched` naming at least every element
    /// changed since the last save.
    pub fn save(&self, snapshot: &Snapshot, touched: Vec<String>) -> Result<Save, JsError> {
        Ok(Save(self.0.save(&snapshot.0, parse(touched)?)?))
    }

    /// What makes the folder hold the board of `snapshot` and no other element, whatever
    /// another program wrote there since, once read again.
    pub fn overwrite(&self, snapshot: &Snapshot, left_out: Vec<String>) -> Result<Save, JsError> {
        let left_out = left_out.iter().map(String::as_str);
        Ok(Save(self.0.overwrite(&snapshot.0, left_out)?))
    }

    /// Once the board file at `path` holds `bytes`.
    pub fn wrote(&mut self, path: &str, bytes: Vec<u8>) {
        self.0.wrote(path, bytes);
    }

    /// Once the asset at `path` is in the folder.
    pub fn copied(&mut self, path: &str) {
        self.0.copied(path);
    }

    pub fn deleted(&mut self, path: &str) {
        self.0.deleted(path);
    }

    /// What the board file at `path` held when last read or written, `undefined` for one it
    /// never knew.
    pub fn bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.0.bytes(path).map(<[u8]>::to_vec)
    }
}

/// What a save writes, in order: the assets, the board files, then the deletions.
#[wasm_bindgen]
pub struct Save(save::Save);

#[wasm_bindgen]
impl Save {
    /// Those the folder lacks, to copy from where the board's images are read.
    pub fn assets(&self) -> Vec<String> {
        self.0.assets.clone()
    }

    pub fn files(&self) -> Map {
        to_map(self.0.files.iter().cloned())
    }

    pub fn deletions(&self) -> Vec<String> {
        self.0.deletions.clone()
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

/// A stroke of `tip`, a pen's when `undefined`, as JSON, through `points`, each across then down
/// in board units, framed by them, without those that stray less than `tolerance` from the line
/// through the others.
#[wasm_bindgen(js_name = strokeKind)]
pub fn stroke_kind(points: &[f64], tolerance: f64, tip: Option<String>) -> Result<String, JsError> {
    let (pairs, odd) = points.as_chunks::<2>();
    if !odd.is_empty() {
        return Err(JsError::new("A stroke's points are pairs of numbers"));
    }
    let tip: Tip = tip
        .map(|tip| serde_json::from_value(tip.into()))
        .transpose()?
        .unwrap_or_default();
    let points: Vec<Point> = pairs.iter().map(|&[x, y]| Point { x, y }).collect();
    Ok(serde_json::to_string(&ElementKind::stroke(
        tip, &points, tolerance,
    ))?)
}

/// What `kind`, as JSON, draws on its own, as JSON, its text as no element's.
#[wasm_bindgen(js_name = drawnKind)]
pub fn drawn_kind(kind: &str) -> Result<String, JsError> {
    let kind: ElementKind = serde_json::from_str(kind)?;
    Ok(serde_json::to_string(
        &kind.drawn(ElementId::from_random(0)),
    )?)
}

/// How wide an arrow, a line, a shape, or a pen stroke of `weight` draws, in board units, as the
/// core hits it. A medium one when `undefined`, as a weight left as it comes is.
#[wasm_bindgen(js_name = strokeWidth)]
pub fn stroke_width(weight: Option<String>) -> Result<f64, JsError> {
    let weight: Weight = weight
        .map(|weight| serde_json::from_value(weight.into()))
        .transpose()?
        .unwrap_or_default();
    Ok(weight.width())
}

/// The x, y, width, and height of where the text of the shape `kind`, as JSON, lies, in parts of
/// its frame before it turns, `undefined` for anything but a shape.
#[wasm_bindgen(js_name = textArea)]
pub fn text_area(kind: &str) -> Result<Option<Vec<f64>>, JsError> {
    let kind: ElementKind = serde_json::from_str(kind)?;
    Ok(kind.text_area().map(rect))
}

/// The x and y of each corner of a `shape` drawn as a polygon, one after the other, in parts of
/// its frame before it turns, with `corners` of its own when it counts them, `undefined` for any
/// other shape.
#[wasm_bindgen(js_name = cornerParts)]
pub fn corner_parts(shape: String, corners: u8) -> Result<Option<Vec<f64>>, JsError> {
    let shape: Shape = serde_json::from_value(shape.into())?;
    let corners = Corners::new(corners).unwrap_or_default();
    Ok(shape
        .corner_parts(corners)
        .map(|parts| parts.iter().flat_map(|part| [part.x, part.y]).collect()))
}

/// The parts of a style that `kind`, as JSON, takes, as a JSON array.
#[wasm_bindgen(js_name = styleSettings)]
pub fn style_settings(kind: &str) -> Result<String, JsError> {
    let kind: ElementKind = serde_json::from_str(kind)?;
    Ok(serde_json::to_string(kind.settings())?)
}

/// Each part of a style that `kind`, as JSON, takes as it comes, which its type, and a shape's,
/// alone tell, as JSON.
#[wasm_bindgen(js_name = plainStyle)]
pub fn plain_style(kind: &str) -> Result<String, JsError> {
    let kind: ElementKind = serde_json::from_str(kind)?;
    Ok(serde_json::to_string(&kind.plain_style())?)
}

/// `copied` as `Editor::copy` gives it, without the images whose assets `assets` leaves out, nor
/// the groups that empties, as JSON.
#[wasm_bindgen]
pub fn keeping(copied: &str, assets: Vec<String>) -> Result<String, JsError> {
    let copied: Copied = serde_json::from_str(copied)?;
    let assets = assets
        .iter()
        .map(|asset| asset.parse())
        .collect::<board::Result<_>>()?;
    Ok(serde_json::to_string(&copied.keeping(&assets))?)
}

/// `kind` with each part of `style` that it takes, both as JSON, as it writes.
#[wasm_bindgen(js_name = withStyle)]
pub fn with_style(kind: &str, style: &str) -> Result<String, JsError> {
    let kind: ElementKind = serde_json::from_str(kind)?;
    let style: Style = serde_json::from_str(style)?;
    Ok(serde_json::to_string(&kind.with_style(&style))?)
}

/// `style` as JSON, with nothing but parts of a style, each as the core spells it, refused
/// otherwise.
#[wasm_bindgen(js_name = checkedStyle)]
pub fn checked_style(style: &str) -> Result<String, JsError> {
    let style: Style = serde_json::from_str(style)?;
    Ok(serde_json::to_string(&style)?)
}

/// `colour` as the core spells it, refused when it is no colour.
#[wasm_bindgen(js_name = checkedColour)]
pub fn checked_colour(colour: &str) -> Result<String, JsError> {
    Ok(colour.parse::<Colour>()?.to_string())
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

/// Where the moved box lands among its neighbours, which the window shows, or else on the grid's
/// lines when `grid`, at `zoom`, as JSON. Each box, and the window, is an x, a y, a width, and a
/// height, the neighbours one after another.
#[wasm_bindgen(js_name = snapToNeighbours)]
pub fn snap_to_neighbours(
    moving: &[f64],
    neighbours: &[f64],
    window: &[f64],
    zoom: f64,
    grid: bool,
) -> Result<String, JsError> {
    let (moving, window) = (area(moving)?, area(window)?);
    let pull = board::snap_to_neighbours(moving, &areas(neighbours)?, window, zoom, grid);
    Ok(serde_json::to_string(&pull)?)
}

/// What the box `scale` has, as JSON, scales by instead to line up with its neighbours that the
/// window shows, at `zoom`, as JSON. The window is an x, a y, a width, and a height, and the
/// neighbours each are, one after another.
#[wasm_bindgen(js_name = snapScaleToNeighbours)]
pub fn snap_scale_to_neighbours(
    scale: &str,
    neighbours: &[f64],
    window: &[f64],
    zoom: f64,
) -> Result<String, JsError> {
    let scale: Scale = serde_json::from_str(scale)?;
    let scaled = board::snap_scale_to_neighbours(scale, &areas(neighbours)?, area(window)?, zoom);
    Ok(serde_json::to_string(&scaled)?)
}

/// Where a box drawn from one corner to the other lands among its neighbours that the window
/// shows, or else on the grid's lines when `grid`, at `zoom`, as JSON. Each corner is an x and a
/// y, and the window an x, a y, a width, and a height, as each neighbour is, one after another.
#[wasm_bindgen(js_name = snapDrawnToNeighbours)]
pub fn snap_drawn_to_neighbours(
    from: &[f64],
    to: &[f64],
    neighbours: &[f64],
    window: &[f64],
    zoom: f64,
    grid: bool,
) -> Result<String, JsError> {
    let (from, to) = (point(from)?, point(to)?);
    let drawn =
        board::snap_drawn_to_neighbours(from, to, &areas(neighbours)?, area(window)?, zoom, grid);
    Ok(serde_json::to_string(&drawn)?)
}

#[wasm_bindgen(js_name = isBoardFile)]
pub fn is_board_file(path: &str) -> bool {
    format::is_board_file(path)
}

/// Such as a sync tool's conflicted copy of an element file, which the board leaves out.
#[wasm_bindgen(js_name = isStrayElement)]
pub fn is_stray_element(path: &str) -> bool {
    format::is_stray_element(path)
}

#[wasm_bindgen(js_name = isAssetFile)]
pub fn is_asset_file(path: &str) -> bool {
    format::is_asset_file(path)
}

#[wasm_bindgen(js_name = assetPath)]
pub fn asset_path(asset: &str) -> Result<String, JsError> {
    Ok(format::asset_path(asset.parse::<AssetId>()?))
}

/// The asset holding bytes of this SHA-256 `digest`, named after the type their `start`, the
/// first `MEDIA_START` bytes or all of them, tells.
#[wasm_bindgen(js_name = assetOf)]
pub fn asset_of(digest: &str, start: &[u8]) -> Result<String, JsError> {
    Ok(digest.parse::<AssetId>()?.typed(start).to_string())
}

#[wasm_bindgen]
#[derive(Default)]
pub struct AssetHasher(board::AssetHasher);

#[wasm_bindgen]
impl AssetHasher {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub fn finish(self) -> String {
        self.0.finish().to_string()
    }
}

/// Whether `digest`, of the bytes read at `path`, names the asset that the path holds.
#[wasm_bindgen(js_name = matchesDigest)]
pub fn matches_digest(path: &str, digest: &str) -> Result<bool, JsError> {
    let asset =
        format::asset_of(path).ok_or_else(|| JsError::new(&format!("`{path}` is no asset")))?;
    Ok(asset.same_bytes(digest.parse()?))
}

#[wasm_bindgen]
#[derive(Default)]
pub struct Crc32(zip::Crc32);

#[wasm_bindgen]
impl Crc32 {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub fn finish(self) -> u32 {
        self.0.finish()
    }
}

/// What a file holds, as JSON, from `bytes`, its start, or all of it when `whole`. `undefined`
/// when its start does not tell, which then takes the whole file.
#[wasm_bindgen]
pub fn media(bytes: &[u8], whole: bool) -> Result<Option<String>, JsError> {
    let media = board::media(bytes, whole);
    Ok(media.as_ref().map(serde_json::to_string).transpose()?)
}

/// How much of a file's start `media` takes to tell what most files hold.
#[wasm_bindgen(js_name = mediaStart)]
pub fn media_start() -> usize {
    board::MEDIA_START
}

/// The SVG with its root sized to `width` by `height`, for every host to draw it at that size,
/// `undefined` when `bytes` are not an SVG document.
#[wasm_bindgen(js_name = sizedSvg)]
pub fn sized_svg(bytes: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    board::sized_svg(bytes, Size { width, height })
}

/// How long each frame of an animated image shows, in milliseconds, `undefined` when `bytes` are
/// not an image of more than one frame.
#[wasm_bindgen(js_name = frameDelays)]
pub fn frame_delays(bytes: &[u8]) -> Option<Vec<f64>> {
    board::frame_delays(bytes)
}

/// Of a box starting at `start` in a movie `length` bytes long, from `window`, 16 bytes from
/// there on: `[start, end]` of the movie's index once it is that box, or else `[next]`, where the
/// next box starts. `undefined` past its end, or for a box cut short or broken.
#[wasm_bindgen(js_name = movieIndex)]
pub fn movie_index(length: f64, start: f64, window: &[u8]) -> Result<Option<Vec<f64>>, JsError> {
    Ok(
        board::movie_index(offset(length)?, offset(start)?, window).map(|found| match found {
            MovieIndex::At(start, end) => span(start..end),
            MovieIndex::Next(next) => vec![next as f64],
        }),
    )
}

/// When each frame of a movie starts showing, in seconds, in the order they show, then when the
/// last one ends, from its index. `undefined` for one whose index does not tell them all.
#[wasm_bindgen(js_name = movieFrames)]
pub fn movie_frames(index: &[u8]) -> Option<Vec<f64>> {
    board::movie_frames(index)
}

/// Reads when the frames of a WebM or Matroska video show, from its bytes, in order, a chunk at
/// a time.
#[wasm_bindgen]
#[derive(Default)]
pub struct MatroskaFrames(board::MatroskaFrames);

#[wasm_bindgen]
impl MatroskaFrames {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MatroskaFrames {
        Self::default()
    }

    pub fn read(&mut self, bytes: &[u8]) {
        self.0.read(bytes);
    }

    /// As for `movieFrames`, of what it read.
    pub fn frames(&self) -> Option<Vec<f64>> {
        self.0.frames()
    }
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

    /// The header to write right before the entry's bytes. Only an asset has a `digest`.
    pub fn entry(
        &mut self,
        path: &str,
        size: f64,
        crc: u32,
        digest: Option<String>,
    ) -> Result<Vec<u8>, JsError> {
        let digest = digest.map(|digest| digest.parse()).transpose()?;
        Ok(self.0.entry(path, offset(size)?, crc, digest)?)
    }

    /// As `entry` for a file kept as it was read, whose digest need not name its bytes.
    pub fn carried(&mut self, path: &str, size: f64, crc: u32) -> Result<Vec<u8>, JsError> {
        Ok(self.0.carried(path, offset(size)?, crc)?)
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

    /// Whether the bytes at `data` are deflated, which the shell inflates before `check`.
    pub fn deflated(&self, path: &str) -> Result<bool, JsError> {
        Ok(self.entry(path)?.method() == zip::Method::Deflated)
    }

    /// The entry's length once inflated.
    pub fn size(&self, path: &str) -> Result<f64, JsError> {
        Ok(self.entry(path)?.size() as f64)
    }

    /// Checks the size and the checksum of the bytes read at `data`, once inflated.
    pub fn check(&self, path: &str, size: f64, crc: u32) -> Result<(), JsError> {
        Ok(self.entry(path)?.check(offset(size)?, crc)?)
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

fn strings(ids: impl IntoIterator<Item = ElementId>) -> Vec<String> {
    ids.into_iter().map(|id| id.to_string()).collect()
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

fn rect(rect: Rect) -> Vec<f64> {
    vec![rect.x, rect.y, rect.width, rect.height]
}

fn point(values: &[f64]) -> Result<Point, JsError> {
    match *values {
        [x, y] => Ok(Point { x, y }),
        _ => Err(JsError::new("A point is two numbers")),
    }
}

fn area(values: &[f64]) -> Result<Rect, JsError> {
    match areas(values)?[..] {
        [area] => Ok(area),
        _ => Err(JsError::new("A box is four numbers")),
    }
}

fn areas(values: &[f64]) -> Result<Vec<Rect>, JsError> {
    let (boxes, rest) = values.as_chunks::<4>();
    if !rest.is_empty() {
        return Err(JsError::new("Boxes are fours of numbers"));
    }
    Ok(boxes
        .iter()
        .map(|&[x, y, width, height]| Rect {
            x,
            y,
            width,
            height,
        })
        .collect())
}

fn to_map(files: impl IntoIterator<Item = (String, Vec<u8>)>) -> Map {
    let map = Map::new();
    for (path, bytes) in files {
        map.set(&path.into(), &Uint8Array::from(bytes.as_slice()).into());
    }
    map
}
