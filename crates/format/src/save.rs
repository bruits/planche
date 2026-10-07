//! Saving a board back into its folder a file at a time, so that a save costs what changed
//! and leaves alone what another program wrote.

use std::collections::BTreeSet;

use board::{Board, ElementId};

use crate::{
    Files, MANIFEST, Result, asset_path, element_file, element_id, element_path, is_asset_file,
    is_board_file, manifest_file, read_element,
};

/// A board's folder as the app last read or wrote it.
#[derive(Debug, Default)]
pub struct Known {
    files: Files,
    assets: BTreeSet<String>,
}

/// What a save writes, in an order that a crash at any point leaves a board that reads, its
/// elements whole, old or new, and their images there.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Save {
    /// The assets of the images written that the folder lacks, first.
    pub assets: Vec<String>,
    /// The element files whose bytes changed, then the manifest when its did, or before them
    /// when the folder has none yet, which a board needs to read at all.
    pub files: Vec<(String, Vec<u8>)>,
    /// The files of elements gone, last, only those it knew.
    pub deletions: Vec<String>,
}

impl Known {
    /// From the folder's listing, and the board files read from it.
    pub fn new(listed: impl IntoIterator<Item = String>, files: Files) -> Self {
        Self {
            files: files
                .into_iter()
                .filter(|(path, _)| is_board_file(path))
                .collect(),
            assets: listed
                .into_iter()
                .filter(|path| is_asset_file(path))
                .collect(),
        }
    }

    /// What saving `board` writes, `touched` naming at least every element changed since the
    /// last save.
    pub fn save(
        &self,
        board: &Board,
        touched: impl IntoIterator<Item = ElementId>,
    ) -> Result<Save> {
        let mut save = Save::default();
        let mut assets = BTreeSet::new();
        for id in touched.into_iter().collect::<BTreeSet<_>>() {
            let path = element_path(id);
            let Some(element) = board.written(id) else {
                if self.files.contains_key(&path) {
                    save.deletions.push(path);
                }
                continue;
            };
            let bytes = element_file(id, &element)?;
            if self.files.get(&path) == Some(&bytes) {
                continue;
            }
            let asset = element.kind.asset().map(asset_path);
            assets.extend(asset.filter(|asset| !self.assets.contains(asset)));
            save.files.push((path, bytes));
        }
        let manifest = manifest_file(board.background);
        match self.files.get(MANIFEST) {
            None => save.files.insert(0, (MANIFEST.to_owned(), manifest)),
            Some(known) if *known != manifest => save.files.push((MANIFEST.to_owned(), manifest)),
            Some(_) => {}
        }
        save.assets = assets.into_iter().collect();
        Ok(save)
    }

    /// What makes the folder hold `board`'s files and no other element's, whatever another
    /// program wrote there since the app read it, as known once read again. The files that
    /// [`crate::read`] `left_out` stay, fixed since or not, as do those it would leave out now.
    pub fn overwrite<'a>(
        &self,
        board: &Board,
        left_out: impl IntoIterator<Item = &'a str>,
    ) -> Result<Save> {
        let left_out: BTreeSet<&str> = left_out.into_iter().collect();
        let mut save = self.save(board, board.elements.keys().copied())?;
        save.deletions = self
            .files
            .iter()
            .filter(|(path, bytes)| {
                !left_out.contains(path.as_str())
                    && element_id(path).is_some_and(|id| {
                        !board.elements.contains_key(&id) && read_element(id, path, bytes).is_ok()
                    })
            })
            .map(|(path, _)| path.clone())
            .collect();
        Ok(save)
    }

    /// Once the board file at `path` holds `bytes`.
    pub fn wrote(&mut self, path: &str, bytes: Vec<u8>) {
        self.files.insert(path.to_owned(), bytes);
    }

    /// Once the asset at `path` is in the folder.
    pub fn copied(&mut self, path: &str) {
        self.assets.insert(path.to_owned());
    }

    pub fn deleted(&mut self, path: &str) {
        self.files.remove(path);
    }

    /// What the board file at `path` held when last read or written, which another program
    /// changed if the file no longer does.
    pub fn bytes(&self, path: &str) -> Option<&[u8]> {
        self.files.get(path).map(Vec::as_slice)
    }
}
