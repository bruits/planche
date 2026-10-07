//! A board as a folder of files:
//!
//! ```text
//! .gitattributes              keeps Git off the bytes
//! board.json                  format version, and background
//! elements/<id>.json          one per element
//! assets/<sha-256>.<type>     image bytes, named as in the elements, see [`board::AssetId`]
//! ```
//!
//! Paths use `/` on every platform. The browser has no file system, so the caller does the
//! I/O. It writes each asset once, before any element that draws it, and checks it with
//! [`verify_asset`] when loading it. The same files also travel as a single ZIP file, see
//! [`zip`].

pub mod save;
pub mod zip;

use std::collections::{BTreeMap, BTreeSet};

use board::{AssetId, Background, Board, Element, ElementId};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Bumped by any change to the files' shape, since an older app would refuse fields it does
/// not know. From the first release on, [`read`] migrates every earlier version.
pub const FORMAT_VERSION: u32 = 1;

pub type Files = BTreeMap<String, Vec<u8>>;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("`{MANIFEST}` is missing, so this is not a board")]
    MissingManifest,
    #[error("format version {0} is not supported, the latest is {FORMAT_VERSION}")]
    UnsupportedVersion(u32),
    #[error("`{path}` is not valid: {source}")]
    Json {
        path: String,
        source: serde_json::Error,
    },
    #[error("`{0}` is not named after a valid id")]
    InvalidName(String),
    #[error(
        "element {0} holds a NaN, an infinity, a font size that is not positive, or a stroke with \
         no point or one off its frame"
    )]
    Invalid(ElementId),
    #[error(
        "asset {0} does not match its digest; if the board lives in Git, is Git LFS installed?"
    )]
    CorruptAsset(AssetId),
    #[error("`{0}` holds an unresolved Git conflict")]
    Conflict(String),
    #[error("`{0}` is not a path inside a board")]
    UnsafePath(String),
    #[error("this is not a ZIP file")]
    NotAZip,
    #[error("this ZIP file is damaged: {0}")]
    DamagedZip(String),
    #[error(
        "`{0}` is compressed in a way this app cannot read in this ZIP file, so unzip it and open \
         its folder"
    )]
    Compressed(String),
    #[error("`{0}` is encrypted in this ZIP file, so unzip it and open its folder")]
    Encrypted(String),
    #[error("this ZIP file spans several files, which a board never does")]
    UnsupportedZip,
    #[error("`{0}` comes out of order in the ZIP file")]
    OutOfOrder(String),
}

const MANIFEST: &str = "board.json";
const ELEMENTS: &str = "elements/";
const ASSETS: &str = "assets/";
const GIT_ATTRIBUTES: &str = ".gitattributes";

#[derive(Deserialize)]
struct Version {
    version: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    /// Left out when plain, as on boards from before there was a choice.
    #[serde(default, skip_serializing_if = "Background::is_plain")]
    background: Background,
}

/// Returns every file but the assets, with [`git_attributes`]. An element file missing from the
/// result belongs to a deleted element (see [`is_element_file`]).
pub fn write(board: &Board) -> Result<Files> {
    let (path, bytes) = git_attributes();
    let mut files = Files::from([(path.to_owned(), bytes)]);
    files.insert(MANIFEST.to_owned(), manifest_file(board.background));
    for &id in board.elements.keys() {
        let element = board.written(id).expect("on the board");
        files.insert(element_path(id), element_file(id, &element)?);
    }
    Ok(files)
}

fn manifest_file(background: Background) -> Vec<u8> {
    to_json(&Manifest {
        version: FORMAT_VERSION,
        background,
    })
}

fn element_path(id: ElementId) -> String {
    format!("{ELEMENTS}{id}.json")
}

fn element_file(id: ElementId, element: &Element) -> Result<Vec<u8>> {
    if element.kind.is_valid() {
        Ok(to_json(element))
    } else {
        Err(Error::Invalid(id))
    }
}

/// A board as [`read`] found it.
#[derive(Debug)]
pub struct Reading {
    pub board: Board,
    /// The element files it could not take, in path order, which the board lacks and the caller
    /// keeps as they are.
    pub left_out: Vec<LeftOut>,
}

/// An element file that [`read`] could not take, and why.
#[derive(Debug)]
pub struct LeftOut {
    pub path: String,
    /// [`Error::Conflict`], [`Error::Json`] with the key it refused, or [`Error::Invalid`].
    pub error: Error,
}

/// Leaves out what [`is_stray_element`] tells apart, and each element file that holds a conflict
/// or is not valid, which comes back in [`Reading::left_out`]. Refuses a board whose `board.json`
/// is missing, not valid, or of another version. The board comes back repaired (see
/// [`Board::repair`]), and its files only change when the caller writes it.
pub fn read(files: &Files) -> Result<Reading> {
    let manifest = read_manifest(files)?;

    let mut board = Board {
        background: manifest.background,
        ..Board::default()
    };
    let mut left_out = Vec::new();
    let mut unread = BTreeSet::new();
    for (path, bytes) in files {
        let Some(id) = element_id(path) else {
            continue;
        };
        match read_element(id, path, bytes) {
            Ok(element) => {
                board.elements.insert(id, element);
            }
            Err(error) => {
                unread.insert(id);
                left_out.push(LeftOut {
                    path: path.clone(),
                    error,
                });
            }
        }
    }
    board.repair(&unread);
    Ok(Reading { board, left_out })
}

fn read_manifest(files: &Files) -> Result<Manifest> {
    let bytes = files.get(MANIFEST).ok_or(Error::MissingManifest)?;
    // Alone first, as a later version may hold keys this one refuses.
    let Version { version } = from_json(MANIFEST, bytes)?;
    if version != FORMAT_VERSION {
        return Err(Error::UnsupportedVersion(version));
    }
    from_json(MANIFEST, bytes)
}

fn read_element(id: ElementId, path: &str, bytes: &[u8]) -> Result<Element> {
    let element: Element = from_json(path, bytes)?;
    if element.kind.is_valid() {
        Ok(element)
    } else {
        Err(Error::Invalid(id))
    }
}

/// How many segments deep board files go, such as `elements/<id>.json`, so that the caller
/// lists no further.
pub const DEPTH: usize = 2;

/// The files [`read`] needs. The caller reads them up front, and the assets lazily.
pub fn is_board_file(path: &str) -> bool {
    path == MANIFEST || is_element_file(path)
}

/// Named after an asset, as no other file of `assets/` is a board's.
pub fn is_asset_file(path: &str) -> bool {
    asset_of(path).is_some()
}

/// The asset that a file of `assets/` holds.
pub fn asset_of(path: &str) -> Option<AssetId> {
    path.strip_prefix(ASSETS)?.parse().ok()
}

pub fn is_element_file(path: &str) -> bool {
    element_id(path).is_some()
}

/// A `.json` file in `elements/` that is not named after an id, such as a sync tool's
/// conflicted copy. No element owns it, so [`read`] leaves it out, and the caller may say so.
pub fn is_stray_element(path: &str) -> bool {
    element_name(path).is_some_and(|name| name.parse::<ElementId>().is_err())
}

fn element_id(path: &str) -> Option<ElementId> {
    element_name(path)?.parse().ok()
}

fn element_name(path: &str) -> Option<&str> {
    if path.split('/').any(|segment| segment.starts_with('.')) {
        return None;
    }
    path.strip_prefix(ELEMENTS)?.strip_suffix(".json")
}

/// A board's `.gitattributes`, as its path and bytes. Converting line endings on checkout
/// would change every file's bytes, and images belong in Git LFS rather than in Git's history.
/// The caller writes it into a board folder that lacks it, never over one, which is its user's.
/// [`read`] skips it like any dot file.
pub fn git_attributes() -> (&'static str, Vec<u8>) {
    let lfs = "filter=lfs diff=lfs merge=lfs -text";
    (
        GIT_ATTRIBUTES,
        format!("* -text\n{ASSETS}** {lfs}\n").into_bytes(),
    )
}

pub fn asset_path(asset: AssetId) -> String {
    format!("{ASSETS}{asset}")
}

/// The assets that images show and `listed`, the paths of the folder, lacks, each once in draw
/// order. Those images cannot draw, and saving must not try to copy their assets.
pub fn missing_assets<'a>(
    board: &Board,
    listed: impl IntoIterator<Item = &'a str>,
) -> Vec<AssetId> {
    let listed: BTreeSet<&str> = listed.into_iter().collect();
    let mut seen = BTreeSet::new();
    board
        .draw_order()
        .into_iter()
        .filter_map(|id| board.elements[&id].kind.asset())
        .filter(|asset| !listed.contains(asset_path(*asset).as_str()) && seen.insert(*asset))
        .collect()
}

/// Whether `found`, the id of the bytes read for `asset`, names the same bytes.
pub fn verify_asset(asset: AssetId, found: AssetId) -> Result<()> {
    if found.same_bytes(asset) {
        Ok(())
    } else {
        Err(Error::CorruptAsset(asset))
    }
}

/// The same board must give the same bytes, so board types never hold a `HashMap`.
fn to_json<T: Serialize>(value: &T) -> Vec<u8> {
    let mut json = serde_json::to_vec_pretty(value).expect("board types always serialise");
    json.push(b'\n');
    json
}

fn from_json<T: DeserializeOwned>(path: &str, bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|source| {
        if has_conflict(bytes) {
            Error::Conflict(path.to_owned())
        } else {
            Error::Json {
                path: path.to_owned(),
                source,
            }
        }
    })
}

/// Whether a line is one of the markers Git leaves in a file it could not merge. JSON holds no
/// line break within a string, so a valid file never has one.
fn has_conflict(bytes: &[u8]) -> bool {
    bytes.split(|&byte| byte == b'\n').any(|line| {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        line.starts_with(b"<<<<<<<") || line.starts_with(b">>>>>>>") || line == b"======="
    })
}
