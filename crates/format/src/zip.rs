//! A board as a single ZIP file, to move it around: the files of its folder, stored as they
//! are. Like the rest of the crate it does no I/O, so a shell can read a large file in slices
//! and write one entry at a time, and never hold it whole. Writing then reading:
//!
//! 1. [`paths`] lists the entries, and [`Writer::entry`] gives the header to write before
//!    each from its size and checksums, taken in slices with [`Crc32`] and
//!    [`board::AssetHasher`], then [`Writer::finish`] what ends the file.
//! 2. [`locate`] finds the central directory in the file's last [`tail_length`] bytes, and
//!    [`Index::read`] parses it. Each [`Entry`] then leads to its bytes in two reads: its
//!    [`header`](Entry::header), then its [`data`](Entry::data), checked by [`Entry::check`].
//!
//! Every entry is stored rather than deflated, since images are compressed already and
//! deflated bytes depend on the compressor's version. The same board then always gives the
//! same file, and a shell can read an image straight out of it. A board never needs ZIP64,
//! so files that would are refused, and so are compressed or encrypted entries.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use board::{AssetId, Board};

use crate::{ASSETS, Error, Result, asset_path, verify_asset};

const LOCAL: u32 = 0x0403_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const END: u32 = 0x0605_4b50;

const LOCAL_LEN: usize = 30;
const CENTRAL_LEN: usize = 46;
const END_LEN: usize = 22;

const STORED: u16 = 0;
const ENCRYPTED: u16 = 1;
const UTF8_NAME: u16 = 1 << 11;
/// Enough to extract stored files.
const VERSION_NEEDED: u16 = 10;
/// Made on Unix, so that `FILE_MODE` holds.
const MADE_BY: u16 = (3 << 8) | 20;
/// A regular file that its owner may write and anyone read.
const FILE_MODE: u32 = 0o100_644 << 16;
/// Midnight on 1980-01-01, the earliest DOS date: a clock would make every file differ.
const TIME: u16 = 0;
const DATE: u16 = (1 << 5) | 1;

/// Beyond these, ZIP64 takes over, since its fields hold the maxima as markers.
const MAX_ENTRIES: u16 = u16::MAX - 1;
const MAX_OFFSET: u64 = u32::MAX as u64 - 1;

/// The paths of `board`'s ZIP file, in the order it holds them: those of [`write`] and the
/// assets it draws, and nothing else, so that the file depends on the board alone.
///
/// [`write`]: crate::write
pub fn paths(board: &Board) -> Result<Vec<String>> {
    let mut paths: BTreeSet<String> = crate::write(board)?.into_keys().collect();
    let assets = board
        .elements
        .values()
        .filter_map(|element| element.kind.asset());
    paths.extend(assets.map(asset_path));
    Ok(paths.into_iter().collect())
}

/// Writes a ZIP file one entry at a time.
#[derive(Debug, Default)]
pub struct Writer {
    written: u64,
    last: Option<String>,
    directory: Vec<u8>,
    entries: u16,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }

    /// The header to write right before the entry's bytes, which go in as they are. Paths come
    /// in increasing order, as [`paths`] gives them, and an asset's `digest` must be its name.
    pub fn entry(
        &mut self,
        path: &str,
        size: u64,
        crc: u32,
        digest: Option<AssetId>,
    ) -> Result<Vec<u8>> {
        if !is_board_path(path)? {
            return Err(Error::UnsafePath(path.to_owned()));
        }
        if self.last.as_deref().is_some_and(|last| path <= last) {
            return Err(Error::OutOfOrder(path.to_owned()));
        }
        if let Some(name) = path.strip_prefix(ASSETS) {
            let asset = name
                .parse()
                .map_err(|_| Error::InvalidName(path.to_owned()))?;
            verify_asset(asset, digest.ok_or(Error::CorruptAsset(asset))?)?;
        }
        let name_len = u16::try_from(path.len()).map_err(|_| Error::UnsafePath(path.to_owned()))?;
        let end = (self.written + (LOCAL_LEN + path.len()) as u64).saturating_add(size);
        if self.entries == MAX_ENTRIES || end > MAX_OFFSET {
            return Err(Error::TooLarge);
        }
        let fields = Fields {
            flags: if path.is_ascii() { 0 } else { UTF8_NAME },
            crc,
            size: size as u32,
            name_len,
        };

        let mut header = Vec::with_capacity(LOCAL_LEN + path.len());
        put32(&mut header, LOCAL);
        fields.put(&mut header);
        put16(&mut header, 0); // extra field
        header.extend_from_slice(path.as_bytes());

        let directory = &mut self.directory;
        put32(directory, CENTRAL);
        put16(directory, MADE_BY);
        fields.put(directory);
        put16(directory, 0); // extra field
        put16(directory, 0); // comment
        put16(directory, 0); // disk
        put16(directory, 0); // internal attributes
        put32(directory, FILE_MODE);
        put32(directory, self.written as u32);
        directory.extend_from_slice(path.as_bytes());

        self.written = end;
        self.entries += 1;
        self.last = Some(path.to_owned());
        Ok(header)
    }

    /// What ends the file, after the last entry.
    pub fn finish(self) -> Result<Vec<u8>> {
        let mut end = self.directory;
        if self.written + (end.len() + END_LEN) as u64 > MAX_OFFSET {
            return Err(Error::TooLarge);
        }
        let size = end.len() as u32;
        put32(&mut end, END);
        put16(&mut end, 0); // this disk
        put16(&mut end, 0); // the directory's disk
        put16(&mut end, self.entries);
        put16(&mut end, self.entries);
        put32(&mut end, size);
        put32(&mut end, self.written as u32);
        put16(&mut end, 0); // comment
        Ok(end)
    }
}

/// The fields that local headers and the central directory share.
struct Fields {
    flags: u16,
    crc: u32,
    size: u32,
    name_len: u16,
}

impl Fields {
    fn put(&self, out: &mut Vec<u8>) {
        put16(out, VERSION_NEEDED);
        put16(out, self.flags);
        put16(out, STORED);
        put16(out, TIME);
        put16(out, DATE);
        put32(out, self.crc);
        put32(out, self.size); // compressed
        put32(out, self.size);
        put16(out, self.name_len);
    }
}

/// How many bytes to read from the end of a file `length` bytes long for [`locate`]: enough
/// for the largest comment another tool may leave there.
pub fn tail_length(length: u64) -> u64 {
    length.min((END_LEN + usize::from(u16::MAX)) as u64)
}

/// Where the central directory lies in a file `length` bytes long, from its last bytes.
pub fn locate(length: u64, tail: &[u8]) -> Result<Range<u64>> {
    let tail_start = length
        .checked_sub(tail.len() as u64)
        .ok_or_else(|| damaged("it is shorter than its end"))?;
    let at = (0..=tail.len().checked_sub(END_LEN).ok_or(Error::NotAZip)?)
        .rev()
        .find(|&at| {
            get32(tail, at) == END && at + END_LEN + usize::from(get16(tail, at + 20)) == tail.len()
        })
        .ok_or(Error::NotAZip)?;

    let disk = get16(tail, at + 4);
    let directory_disk = get16(tail, at + 6);
    let on_disk = get16(tail, at + 8);
    let entries = get16(tail, at + 10);
    let size = get32(tail, at + 12);
    let start = get32(tail, at + 16);
    if disk != 0 || directory_disk != 0 || on_disk != entries {
        return Err(Error::UnsupportedZip);
    }
    if entries == u16::MAX || size == u32::MAX || start == u32::MAX {
        return Err(Error::UnsupportedZip);
    }
    let directory = u64::from(start)..u64::from(start) + u64::from(size);
    if directory.end > tail_start + at as u64 {
        return Err(damaged("its directory runs past its end"));
    }
    Ok(directory)
}

/// A ZIP file's entries by path. Folders, dot files, and names with a `~` are left out,
/// since the desktop's folder never reads them either.
#[derive(Debug)]
pub struct Index {
    entries: BTreeMap<String, Entry>,
}

impl Index {
    /// Parses the central directory, which starts at `start` in the file (see [`locate`]).
    pub fn read(start: u64, directory: &[u8]) -> Result<Self> {
        let mut entries = BTreeMap::new();
        let mut at = 0;
        while at < directory.len() {
            if directory.len() - at < CENTRAL_LEN || get32(directory, at) != CENTRAL {
                return Err(damaged("its directory is cut short"));
            }
            let flags = get16(directory, at + 8);
            let method = get16(directory, at + 10);
            let crc = get32(directory, at + 16);
            let compressed = get32(directory, at + 20);
            let size = get32(directory, at + 24);
            let name_len = usize::from(get16(directory, at + 28));
            let others =
                usize::from(get16(directory, at + 30)) + usize::from(get16(directory, at + 32));
            let offset = get32(directory, at + 42);
            let name = at + CENTRAL_LEN..at + CENTRAL_LEN + name_len;
            at = name.end + others;
            let name = directory
                .get(name)
                .filter(|_| at <= directory.len())
                .ok_or_else(|| damaged("its directory is cut short"))?;

            let path = str::from_utf8(name)
                .map_err(|_| Error::UnsafePath(String::from_utf8_lossy(name).into_owned()))?;
            if path.ends_with('/') || !is_board_path(path)? {
                continue;
            }
            if compressed == u32::MAX || size == u32::MAX || offset == u32::MAX {
                return Err(Error::UnsupportedZip);
            }
            if method != STORED || flags & ENCRYPTED != 0 {
                return Err(Error::Compressed(path.to_owned()));
            }
            let entry = Entry {
                path: path.to_owned(),
                offset: u64::from(offset),
                size: u64::from(size),
                crc,
                directory: start,
            };
            if compressed != size || entry.header().end + entry.size > start {
                return Err(damaged(format!("`{path}` runs into its directory")));
            }
            if entries.insert(path.to_owned(), entry).is_some() {
                return Err(damaged(format!("`{path}` is in it twice")));
            }
        }

        // Entries sharing bytes would let a small file make a shell read far more than its
        // length, one entry at a time.
        let mut placed: Vec<&Entry> = entries.values().collect();
        placed.sort_unstable_by_key(|entry| entry.offset);
        for pair in placed.windows(2) {
            if pair[0].header().end + pair[0].size > pair[1].offset {
                let (first, second) = (&pair[0].path, &pair[1].path);
                return Err(damaged(format!("`{first}` runs into `{second}`")));
            }
        }
        Ok(Self { entries })
    }

    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.entries.keys().map(String::as_str)
    }

    pub fn entry(&self, path: &str) -> Option<&Entry> {
        self.entries.get(path)
    }
}

#[derive(Debug)]
pub struct Entry {
    path: String,
    offset: u64,
    size: u64,
    crc: u32,
    directory: u64,
}

impl Entry {
    /// Where its local header lies, which says where its bytes start.
    pub fn header(&self) -> Range<u64> {
        self.offset..self.offset + (LOCAL_LEN + self.path.len()) as u64
    }

    /// Where its bytes lie, from the bytes at [`Entry::header`].
    pub fn data(&self, header: &[u8]) -> Result<Range<u64>> {
        let expected = self.header();
        let matches = header.len() as u64 == expected.end - expected.start
            && get32(header, 0) == LOCAL
            && get16(header, 8) == STORED
            && usize::from(get16(header, 26)) == self.path.len()
            && &header[LOCAL_LEN..] == self.path.as_bytes();
        if !matches {
            return Err(damaged(format!("`{}` has no header of its own", self.path)));
        }
        let start = expected.end + u64::from(get16(header, 28));
        let data = start..start + self.size;
        if data.end > self.directory {
            return Err(damaged(format!("`{}` runs into its directory", self.path)));
        }
        Ok(data)
    }

    /// Checks the bytes read at [`Entry::data`] against the size and checksum stored.
    pub fn check(&self, size: u64, crc: u32) -> Result<()> {
        if size == self.size && crc == self.crc {
            Ok(())
        } else {
            Err(damaged(format!(
                "`{}` does not match its checksum",
                self.path
            )))
        }
    }
}

/// Whether `path` names a file of a board folder. Dot files do not, as a board folder's
/// listing leaves them out, nor do names with a `~`, since the desktop's folder refuses them:
/// on Windows, `GIT~1` can name `.git`. An error when it could lead out of the folder.
fn is_board_path(path: &str) -> Result<bool> {
    let mut inside = true;
    let mut hidden = false;
    for segment in path.split('/') {
        inside &= !segment.is_empty()
            && segment != "."
            && segment != ".."
            && !segment.contains(['\\', ':']);
        hidden |= segment.starts_with('.') || segment.contains('~');
    }
    if inside {
        Ok(!hidden)
    } else {
        Err(Error::UnsafePath(path.to_owned()))
    }
}

fn damaged(reason: impl Into<String>) -> Error {
    Error::DamagedZip(reason.into())
}

fn put16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// Callers check the length first.
fn get16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn get32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

#[derive(Debug, Clone, Default)]
pub struct Crc32(crc32fast::Hasher);

impl Crc32 {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn of(bytes: &[u8]) -> u32 {
        crc32fast::hash(bytes)
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub fn finish(self) -> u32 {
        self.0.finalize()
    }
}
