//! A board as a folder of files:
//!
//! ```text
//! .gitattributes        keeps Git off the bytes
//! board.json            format version, and background
//! elements/<id>.json    one per element
//! assets/<sha-256>      image bytes
//! ```
//!
//! Paths use `/` on every platform. The browser has no file system, so the caller does the
//! I/O. It writes each asset once, before any element that draws it, and checks it with
//! [`verify_asset`] when loading it. The same files also travel as a single ZIP file, see
//! [`zip`].

pub mod save;
pub mod zip;

use std::collections::BTreeMap;

use board::{AssetId, Background, Board, Element, ElementId};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Bumped by any change to the files' shape, since an older app would drop fields it does
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
    #[error("element {0} holds a NaN, an infinity, or a font size that is not positive")]
    Invalid(ElementId),
    #[error(
        "asset {0} does not match its digest; if the board lives in Git, is Git LFS installed?"
    )]
    CorruptAsset(AssetId),
    #[error("`{0}` is not a path inside a board")]
    UnsafePath(String),
    #[error("this is not a ZIP file")]
    NotAZip,
    #[error("this ZIP file is damaged: {0}")]
    DamagedZip(String),
    #[error("`{0}` is compressed or encrypted in this ZIP file, so unzip it and open its folder")]
    Compressed(String),
    #[error("this ZIP file needs ZIP64 or spans several files, which a board never does")]
    UnsupportedZip,
    #[error("a board's ZIP file holds 65,534 files and 4 GiB at most")]
    TooLarge,
    #[error("`{0}` comes out of order in the ZIP file")]
    OutOfOrder(String),
}

const MANIFEST: &str = "board.json";
const ELEMENTS: &str = "elements/";
const ASSETS: &str = "assets/";

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u32,
    /// Left out when plain, as on boards from before there was a choice.
    #[serde(default, skip_serializing_if = "Background::is_plain")]
    background: Background,
}

/// Returns every file but the assets. An element file missing from the result belongs to
/// a deleted element (see [`is_element_file`]).
pub fn write(board: &Board) -> Result<Files> {
    let mut files = Files::new();
    files.insert(MANIFEST.to_owned(), manifest_file(board.background));
    for (id, element) in &board.elements {
        files.insert(element_path(*id), element_file(*id, element)?);
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

/// Leaves out what [`is_stray_element`] tells apart. The board comes back repaired (see
/// [`Board::repair`]), and its files only change when the caller writes it.
pub fn read(files: &Files) -> Result<Board> {
    let manifest: Manifest =
        from_json(MANIFEST, files.get(MANIFEST).ok_or(Error::MissingManifest)?)?;
    if manifest.version != FORMAT_VERSION {
        return Err(Error::UnsupportedVersion(manifest.version));
    }

    let mut board = Board {
        background: manifest.background,
        ..Board::default()
    };
    for (path, bytes) in files {
        let Some(id) = element_id(path) else {
            continue;
        };
        let element: Element = from_json(path, bytes)?;
        if !element.kind.is_valid() {
            return Err(Error::Invalid(id));
        }
        board.elements.insert(id, element);
    }
    board.repair();
    Ok(board)
}

/// How many segments deep board files go, such as `elements/<id>.json`, so that the caller
/// lists no further.
pub const DEPTH: usize = 2;

/// The files [`read`] needs. The caller reads them up front, and the assets lazily.
pub fn is_board_file(path: &str) -> bool {
    path == MANIFEST || is_element_file(path)
}

/// Named after its digest, as no other file of `assets/` is a board's.
pub fn is_asset_file(path: &str) -> bool {
    path.strip_prefix(ASSETS)
        .is_some_and(|name| name.parse::<AssetId>().is_ok())
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

/// A `.gitattributes` for a new board folder, as its path and bytes. Converting line endings
/// on checkout would change every file's bytes, and images belong in Git LFS rather than in
/// Git's history. The caller writes it when creating a board and leaves it to its user
/// afterwards; [`read`] skips it like any dot file.
pub fn git_attributes() -> (&'static str, Vec<u8>) {
    let lfs = "filter=lfs diff=lfs merge=lfs -text";
    (
        ".gitattributes",
        format!("* -text\n{ASSETS}** {lfs}\n").into_bytes(),
    )
}

pub fn asset_path(asset: AssetId) -> String {
    format!("{ASSETS}{asset}")
}

pub fn verify_asset(asset: AssetId, found: AssetId) -> Result<()> {
    if found == asset {
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
    serde_json::from_slice(bytes).map_err(|source| Error::Json {
        path: path.to_owned(),
        source,
    })
}
