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
//! Every entry is written stored rather than deflated, since images are compressed already and
//! deflated bytes depend on the compressor's version. The same board then always gives the
//! same file, and a shell can read an image straight out of it. ZIP64 records only come past
//! the limits of the plain ones. A board zipped again by another tool still opens, with deflated
//! entries, which the shell inflates, and in the one folder it may wrap the board in.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use board::{AssetId, Board};

use crate::{ASSETS, Error, GIT_ATTRIBUTES, MANIFEST, Result, asset_of, verify_asset};

const LOCAL: u32 = 0x0403_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const END: u32 = 0x0605_4b50;
const END64: u32 = 0x0606_4b50;
const LOCATOR: u32 = 0x0706_4b50;

const LOCAL_LEN: usize = 30;
const CENTRAL_LEN: usize = 46;
const END_LEN: usize = 22;
const END64_LEN: usize = 56;
const LOCATOR_LEN: usize = 20;

const STORED: u16 = 0;
const DEFLATED: u16 = 8;
const ENCRYPTED: u16 = 1;
const STRONGLY_ENCRYPTED: u16 = 1 << 6;
const UTF8_NAME: u16 = 1 << 11;
/// Enough to extract stored files.
const VERSION_NEEDED: u16 = 10;
const ZIP64_NEEDED: u16 = 45;
/// Made on Unix, so that `FILE_MODE` holds.
const UNIX: u16 = 3 << 8;
/// A regular file that its owner may write and anyone read.
const FILE_MODE: u32 = 0o100_644 << 16;
/// Midnight on 1980-01-01, the earliest DOS date: a clock would make every file differ.
const TIME: u16 = 0;
const DATE: u16 = (1 << 5) | 1;

/// The ZIP64 extra field, which holds what its record's fields mark as too large for them.
const ZIP64_EXTRA: u16 = 1;
const MARK16: u16 = u16::MAX;
const MARK32: u32 = u32::MAX;
/// Deflate shrinks bytes this many times at most, so an entry claiming to inflate to more is a
/// trap.
const MAX_RATIO: u64 = 1032;

/// The paths of `board`'s ZIP file, in the order it holds them: those of [`write`], the assets
/// it draws but `lacking`, and the `carried` element files and assets, which the board did not
/// take or shows crossed out and the file keeps as they were. Nothing else, so that the file
/// depends on them alone.
///
/// [`write`]: crate::write
pub fn paths<'a>(
    board: &Board,
    carried: impl IntoIterator<Item = &'a str>,
    lacking: impl IntoIterator<Item = &'a str>,
) -> Result<Vec<String>> {
    let mut paths: BTreeSet<String> = crate::write(board)?.into_keys().collect();
    let lacking: BTreeSet<&str> = lacking.into_iter().collect();
    let assets = board
        .elements
        .values()
        .filter_map(|element| element.kind.asset())
        .map(crate::asset_path)
        .filter(|path| !lacking.contains(path.as_str()));
    paths.extend(assets);
    for path in carried {
        if !crate::is_element_file(path) && !crate::is_asset_file(path) {
            return Err(Error::UnsafePath(path.to_owned()));
        }
        paths.insert(path.to_owned());
    }
    Ok(paths.into_iter().collect())
}

/// Writes a ZIP file one entry at a time.
#[derive(Debug, Default)]
pub struct Writer {
    written: u64,
    last: Option<String>,
    directory: Vec<u8>,
    entries: u64,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }

    /// The header to write right before the entry's bytes, which go in as they are. Paths come
    /// in increasing order, as [`paths`] gives them, and an asset's `digest` must name its bytes.
    pub fn entry(
        &mut self,
        path: &str,
        size: u64,
        crc: u32,
        digest: Option<AssetId>,
    ) -> Result<Vec<u8>> {
        self.check(path)?;
        if path.starts_with(ASSETS) {
            let asset = asset_of(path).ok_or_else(|| Error::InvalidName(path.to_owned()))?;
            verify_asset(asset, digest.ok_or(Error::CorruptAsset(asset))?)?;
        }
        self.header(path, size, crc)
    }

    /// As [`Writer::entry`] for a file the board keeps as it was read, which an asset's digest
    /// need not name, such as a Git LFS pointer.
    pub fn carried(&mut self, path: &str, size: u64, crc: u32) -> Result<Vec<u8>> {
        self.check(path)?;
        if path.starts_with(ASSETS) && asset_of(path).is_none() {
            return Err(Error::InvalidName(path.to_owned()));
        }
        self.header(path, size, crc)
    }

    fn check(&self, path: &str) -> Result<()> {
        if path != GIT_ATTRIBUTES && !is_board_path(path)? {
            return Err(Error::UnsafePath(path.to_owned()));
        }
        if self.last.as_deref().is_some_and(|last| path <= last) {
            return Err(Error::OutOfOrder(path.to_owned()));
        }
        Ok(())
    }

    fn header(&mut self, path: &str, size: u64, crc: u32) -> Result<Vec<u8>> {
        let name_len = u16::try_from(path.len()).map_err(|_| Error::UnsafePath(path.to_owned()))?;

        // Past 4 GiB, the size goes in a ZIP64 field in both records, and the offset in the
        // directory's alone, as the local header has none.
        let large = size >= u64::from(MARK32);
        let far = self.written >= u64::from(MARK32);
        let mut local_extra = Vec::new();
        let mut central_extra = Vec::new();
        if large {
            put64(&mut local_extra, size);
            put64(&mut local_extra, size);
            put64(&mut central_extra, size);
            put64(&mut central_extra, size);
        }
        if far {
            put64(&mut central_extra, self.written);
        }
        let fields = Fields {
            needed: if large || far {
                ZIP64_NEEDED
            } else {
                VERSION_NEEDED
            },
            flags: if path.is_ascii() { 0 } else { UTF8_NAME },
            crc,
            size: if large { MARK32 } else { size as u32 },
            name_len,
        };

        let mut header = Vec::with_capacity(LOCAL_LEN + path.len() + local_extra.len());
        put32(&mut header, LOCAL);
        fields.put(&mut header);
        put16(&mut header, extra_len(&local_extra));
        header.extend_from_slice(path.as_bytes());
        put_extra(&mut header, &local_extra);

        let directory = &mut self.directory;
        put32(directory, CENTRAL);
        put16(directory, UNIX | fields.needed.max(20));
        fields.put(directory);
        put16(directory, extra_len(&central_extra));
        put16(directory, 0); // comment
        put16(directory, 0); // disk
        put16(directory, 0); // internal attributes
        put32(directory, FILE_MODE);
        put32(directory, if far { MARK32 } else { self.written as u32 });
        directory.extend_from_slice(path.as_bytes());
        put_extra(directory, &central_extra);

        self.written = self
            .written
            .saturating_add(header.len() as u64)
            .saturating_add(size);
        self.entries += 1;
        self.last = Some(path.to_owned());
        Ok(header)
    }

    /// What ends the file, after the last entry, with ZIP64 records when the plain end's fields
    /// cannot hold its counts.
    pub fn finish(self) -> Result<Vec<u8>> {
        let size = self.directory.len() as u64;
        let mut end = self.directory;
        let many = self.entries >= u64::from(MARK16);
        let large = size >= u64::from(MARK32) || self.written >= u64::from(MARK32);
        if many || large {
            let record = self.written + size;
            put32(&mut end, END64);
            put64(&mut end, (END64_LEN - 12) as u64);
            put16(&mut end, UNIX | ZIP64_NEEDED);
            put16(&mut end, ZIP64_NEEDED);
            put32(&mut end, 0); // this disk
            put32(&mut end, 0); // the directory's disk
            put64(&mut end, self.entries);
            put64(&mut end, self.entries);
            put64(&mut end, size);
            put64(&mut end, self.written);
            put32(&mut end, LOCATOR);
            put32(&mut end, 0); // the record's disk
            put64(&mut end, record);
            put32(&mut end, 1); // disks
        }
        let entries = if many { MARK16 } else { self.entries as u16 };
        put32(&mut end, END);
        put16(&mut end, 0); // this disk
        put16(&mut end, 0); // the directory's disk
        put16(&mut end, entries);
        put16(&mut end, entries);
        put32(&mut end, size.min(u64::from(MARK32)) as u32);
        put32(&mut end, self.written.min(u64::from(MARK32)) as u32);
        put16(&mut end, 0); // comment
        Ok(end)
    }
}

/// The fields that local headers and the central directory share.
struct Fields {
    needed: u16,
    flags: u16,
    crc: u32,
    size: u32,
    name_len: u16,
}

impl Fields {
    fn put(&self, out: &mut Vec<u8>) {
        put16(out, self.needed);
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

fn extra_len(fields: &[u8]) -> u16 {
    if fields.is_empty() {
        0
    } else {
        4 + fields.len() as u16
    }
}

fn put_extra(out: &mut Vec<u8>, fields: &[u8]) {
    if !fields.is_empty() {
        put16(out, ZIP64_EXTRA);
        put16(out, fields.len() as u16);
        out.extend_from_slice(fields);
    }
}

/// How many bytes to read from the end of a file `length` bytes long for [`locate`]: enough
/// for the largest comment another tool may leave there, and the ZIP64 records before it.
pub fn tail_length(length: u64) -> u64 {
    length.min((END64_LEN + LOCATOR_LEN + END_LEN + usize::from(u16::MAX)) as u64)
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
    let marked = [disk, directory_disk, on_disk, entries].contains(&MARK16)
        || [size, start].contains(&MARK32);
    // Another tool may write a marker as a mere value, with no ZIP64 records to look up.
    let locator = at
        .checked_sub(LOCATOR_LEN)
        .filter(|&locator| marked && get32(tail, locator) == LOCATOR);
    let (directory, before) = match locator {
        Some(locator) => {
            let (record, record_at) = zip64_end(tail, tail_start, locator)?;
            let start = get64(tail, record_at + 48);
            let directory = start..start.saturating_add(get64(tail, record_at + 40));
            (directory, record)
        }
        None => {
            if disk != 0 || directory_disk != 0 || on_disk != entries {
                return Err(Error::UnsupportedZip);
            }
            let directory = u64::from(start)..u64::from(start) + u64::from(size);
            (directory, tail_start + at as u64)
        }
    };
    if directory.end > before {
        return Err(damaged("its directory runs past its end"));
    }
    Ok(directory)
}

/// The ZIP64 end record that the locator at `locator` in `tail` points to, as its offset in
/// the file and in `tail`.
fn zip64_end(tail: &[u8], tail_start: u64, locator: usize) -> Result<(u64, usize)> {
    if get32(tail, locator + 4) != 0 || get32(tail, locator + 16) != 1 {
        return Err(Error::UnsupportedZip);
    }
    let record = get64(tail, locator + 8);
    let record_at = record
        .checked_sub(tail_start)
        .and_then(|at| usize::try_from(at).ok())
        .filter(|&at| {
            at.checked_add(END64_LEN).is_some_and(|end| end <= locator) && get32(tail, at) == END64
        })
        .ok_or_else(|| damaged("its ZIP64 end is not where it says"))?;
    let (disk, directory_disk) = (get32(tail, record_at + 16), get32(tail, record_at + 20));
    if disk != 0
        || directory_disk != 0
        || get64(tail, record_at + 24) != get64(tail, record_at + 32)
    {
        return Err(Error::UnsupportedZip);
    }
    Ok((record, record_at))
}

/// A ZIP file's entries by path. Folders, dot files, and names with a `~` are left out,
/// since the desktop's folder never reads them either. So is the one folder that holds every
/// entry and the board's manifest, as zipping a board's folder with another tool gives.
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
            let extra_len = usize::from(get16(directory, at + 30));
            let comment_len = usize::from(get16(directory, at + 32));
            let disk = get16(directory, at + 34);
            let offset = get32(directory, at + 42);
            let name = at + CENTRAL_LEN..at + CENTRAL_LEN + name_len;
            let extra = name.end..name.end + extra_len;
            at = extra.end + comment_len;
            let (Some(name), Some(extra)) = (directory.get(name), directory.get(extra)) else {
                return Err(damaged("its directory is cut short"));
            };
            if at > directory.len() {
                return Err(damaged("its directory is cut short"));
            }

            let path = str::from_utf8(name)
                .map_err(|_| Error::UnsafePath(String::from_utf8_lossy(name).into_owned()))?;
            if path.ends_with('/') || !is_board_path(path)? {
                continue;
            }
            // The ZIP64 field holds, in this order, only those that their own field marks.
            let mut wide = Wide { path, extra, at: 0 };
            let size = wide.take(size)?;
            let compressed = wide.take(compressed)?;
            let offset = wide.take(offset)?;
            if disk == MARK16 {
                wide.disk()?;
            }
            if flags & (ENCRYPTED | STRONGLY_ENCRYPTED) != 0 {
                return Err(Error::Encrypted(path.to_owned()));
            }
            let method = match method {
                STORED if compressed == size => Method::Stored,
                DEFLATED if size <= compressed.saturating_mul(MAX_RATIO) => Method::Deflated,
                STORED | DEFLATED => {
                    return Err(damaged(format!("`{path}` is not the size it says")));
                }
                _ => return Err(Error::Compressed(path.to_owned())),
            };
            // A ZIP64 field may hold any offset.
            let end = offset
                .checked_add((LOCAL_LEN + path.len()) as u64)
                .and_then(|header| header.checked_add(compressed));
            if end.is_none_or(|end| end > start) {
                return Err(damaged(format!("`{path}` runs into its directory")));
            }
            let entry = Entry {
                path: path.to_owned(),
                name: path.to_owned(),
                method,
                offset,
                compressed,
                size,
                crc,
                directory: start,
            };
            if entries.insert(path.to_owned(), entry).is_some() {
                return Err(damaged(format!("`{path}` is in it twice")));
            }
        }

        // Entries sharing bytes would let a small file make a shell read far more than its
        // length, one entry at a time.
        let mut placed: Vec<&Entry> = entries.values().collect();
        placed.sort_unstable_by_key(|entry| entry.offset);
        for pair in placed.windows(2) {
            if pair[0].header().end + pair[0].compressed > pair[1].offset {
                let (first, second) = (&pair[0].path, &pair[1].path);
                return Err(damaged(format!("`{first}` runs into `{second}`")));
            }
        }
        Ok(Self {
            entries: unwrapped(entries),
        })
    }

    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.entries.keys().map(String::as_str)
    }

    pub fn entry(&self, path: &str) -> Option<&Entry> {
        self.entries.get(path)
    }
}

/// The entries out of the one folder that holds them all and the board's manifest.
fn unwrapped(entries: BTreeMap<String, Entry>) -> BTreeMap<String, Entry> {
    let folder = entries
        .keys()
        .next()
        .and_then(|path| path.split_once('/'))
        .map(|(folder, _)| format!("{folder}/"))
        .filter(|folder| {
            !entries.contains_key(MANIFEST)
                && entries.contains_key(&format!("{folder}{MANIFEST}"))
                && entries.keys().all(|path| path.starts_with(folder.as_str()))
        });
    let Some(folder) = folder else {
        return entries;
    };
    entries
        .into_values()
        .map(|mut entry| {
            entry.path = entry.name[folder.len()..].to_owned();
            (entry.path.clone(), entry)
        })
        .collect()
}

/// Reads the values of a ZIP64 extra field.
struct Wide<'a> {
    path: &'a str,
    extra: &'a [u8],
    at: usize,
}

impl<'a> Wide<'a> {
    /// `value`, or the next of the field when it is the marker.
    fn take(&mut self, value: u32) -> Result<u64> {
        if value != MARK32 {
            return Ok(u64::from(value));
        }
        let field = self.field()?;
        let wide = field
            .get(self.at..self.at + 8)
            .ok_or_else(|| self.damaged())?;
        self.at += 8;
        Ok(u64::from_le_bytes(wide.try_into().expect("8 bytes")))
    }

    /// Refuses an entry starting on another disk.
    fn disk(&mut self) -> Result<()> {
        let field = self.field()?;
        let disk = field
            .get(self.at..self.at + 4)
            .ok_or_else(|| self.damaged())?;
        if disk == [0; 4] {
            Ok(())
        } else {
            Err(Error::UnsupportedZip)
        }
    }

    fn field(&self) -> Result<&'a [u8]> {
        let mut at = 0;
        while at + 4 <= self.extra.len() {
            let len = usize::from(get16(self.extra, at + 2));
            let data = self
                .extra
                .get(at + 4..at + 4 + len)
                .ok_or_else(|| self.damaged())?;
            if get16(self.extra, at) == ZIP64_EXTRA {
                return Ok(data);
            }
            at += 4 + len;
        }
        Err(self.damaged())
    }

    fn damaged(&self) -> Error {
        damaged(format!("`{}` lacks its ZIP64 sizes", self.path))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Stored,
    /// Inflated by the shell, which checks the result with [`Entry::check`].
    Deflated,
}

#[derive(Debug)]
pub struct Entry {
    path: String,
    /// The path in the file, which holds a folder more when the board is wrapped in one.
    name: String,
    method: Method,
    offset: u64,
    compressed: u64,
    size: u64,
    crc: u32,
    directory: u64,
}

impl Entry {
    pub fn method(&self) -> Method {
        self.method
    }

    /// Its length once inflated.
    pub fn size(&self) -> u64 {
        self.size
    }

    /// Where its local header lies, which says where its bytes start.
    pub fn header(&self) -> Range<u64> {
        self.offset..self.offset + (LOCAL_LEN + self.name.len()) as u64
    }

    /// Where its bytes lie, deflated or not, from the bytes at [`Entry::header`].
    pub fn data(&self, header: &[u8]) -> Result<Range<u64>> {
        let expected = self.header();
        let method = match self.method {
            Method::Stored => STORED,
            Method::Deflated => DEFLATED,
        };
        let matches = header.len() as u64 == expected.end - expected.start
            && get32(header, 0) == LOCAL
            && get16(header, 8) == method
            && usize::from(get16(header, 26)) == self.name.len()
            && &header[LOCAL_LEN..] == self.name.as_bytes();
        if !matches {
            return Err(damaged(format!("`{}` has no header of its own", self.path)));
        }
        let start = expected.end + u64::from(get16(header, 28));
        let data = start..start.saturating_add(self.compressed);
        if data.end > self.directory {
            return Err(damaged(format!("`{}` runs into its directory", self.path)));
        }
        Ok(data)
    }

    /// Checks the bytes read at [`Entry::data`], once inflated, against the size and checksum
    /// stored.
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

fn put64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// Callers check the length first.
fn get16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn get32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn get64(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8 bytes"))
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
