//! A folder on disk as the desktop shell reads and writes it: its files are named by paths
//! relative to it with `/` between segments, a crash never leaves one half-written, and
//! nothing leads out of it. Links are no part of it, and neither are dot files and folders,
//! such as `.git/`, though the app may create a missing top-level dot file, such as
//! `.gitattributes`, which it never reads or lists. A single file the user picks, such as a
//! ZIP file, is read in ranges and written in parts, and a log of the app's grows by entries,
//! within a size. It knows nothing of boards, and needs no Tauri, so its tests run on every
//! platform.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

#[cfg(target_vendor = "apple")]
unsafe extern "C" {
    /// Hands the data to the drive without asking it to empty its cache, which std's `sync_all`
    /// does on Apple. Harmless on a bad descriptor.
    safe fn fsync(fd: std::ffi::c_int) -> std::ffi::c_int;
}

/// Every file in `root` and in its folders, down to `depth` levels in all, sorted. Names
/// that are not UTF-8 are left out too.
pub fn list(root: &Path, depth: usize) -> io::Result<Vec<String>> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_owned(), String::new(), depth)];
    while let Some((folder, prefix, depth)) = pending.pop() {
        for entry in fs::read_dir(&folder)? {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let kind = entry.file_type()?;
            if name.starts_with('.') || kind.is_symlink() {
                continue;
            }
            let path = format!("{prefix}{name}");
            if kind.is_file() {
                files.push(path);
            } else if kind.is_dir() && depth > 1 {
                pending.push((entry.path(), format!("{path}/"), depth - 1));
            }
        }
    }
    files.sort_unstable();
    Ok(files)
}

/// Whether `root` holds nothing but dot files and folders, whatever the other names' encoding.
pub fn is_empty(root: &Path) -> io::Result<bool> {
    for entry in fs::read_dir(root)? {
        if entry?.file_name().as_encoded_bytes().first() != Some(&b'.') {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn read(root: &Path, path: &str) -> io::Result<Vec<u8>> {
    fs::read(visible(root, path)?)
}

/// Writes through a temporary file renamed over the target. A top-level dot file is only
/// ever created, since its user owns it afterwards, and no other is.
pub fn write(root: &Path, path: &str, bytes: &[u8]) -> io::Result<()> {
    write_all(root, &[(path, bytes)]).map_err(|interrupted| interrupted.error)
}

/// The files at `paths`, packed as [`pack`] packs them, as [`read`] reads each.
pub fn read_all<'a>(root: &Path, paths: impl IntoIterator<Item = &'a str>) -> io::Result<Vec<u8>> {
    let mut files = Vec::new();
    for path in paths {
        let bytes = read(root, path)
            .map_err(|error| io::Error::new(error.kind(), format!("`{path}`: {error}")))?;
        files.push((path, bytes));
    }
    Ok(pack(
        files.iter().map(|(path, bytes)| (*path, bytes.as_slice())),
    ))
}

/// Many files in one body, as the shell and the page pass them. Their count, then for each the
/// length of its path and of its bytes, its path, and its bytes, the numbers as little-endian
/// 32-bit integers.
pub fn pack<'a>(files: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> Vec<u8> {
    let mut packed = vec![0; 4];
    let mut count: u32 = 0;
    for (path, bytes) in files {
        packed.extend(length(path.len()).to_le_bytes());
        packed.extend(length(bytes.len()).to_le_bytes());
        packed.extend(path.as_bytes());
        packed.extend(bytes);
        count += 1;
    }
    packed[..4].copy_from_slice(&count.to_le_bytes());
    packed
}

fn length(len: usize) -> u32 {
    u32::try_from(len).expect("files pass 4 GiB in slices")
}

/// The files that [`pack`] packed.
pub fn unpack(body: &[u8]) -> io::Result<Vec<(&str, &[u8])>> {
    let mut rest = body;
    let count = number(&mut rest)?;
    // Each takes 8 bytes at least, so more would run past the body.
    if count > rest.len() / 8 {
        return Err(damaged());
    }
    let mut files = Vec::with_capacity(count);
    for _ in 0..count {
        let (path_len, len) = (number(&mut rest)?, number(&mut rest)?);
        let path = str::from_utf8(take(&mut rest, path_len)?).map_err(|_| damaged())?;
        files.push((path, take(&mut rest, len)?));
    }
    if !rest.is_empty() {
        return Err(damaged());
    }
    Ok(files)
}

fn take<'a>(rest: &mut &'a [u8], len: usize) -> io::Result<&'a [u8]> {
    let (taken, left) = rest.split_at_checked(len).ok_or_else(damaged)?;
    *rest = left;
    Ok(taken)
}

fn number(rest: &mut &[u8]) -> io::Result<usize> {
    let bytes = take(rest, 4)?.try_into().expect("4 bytes");
    Ok(u32::from_le_bytes(bytes) as usize)
}

fn damaged() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "the files sent are damaged")
}

/// Also when the file is gone already. Dot files are never removed.
pub fn remove(root: &Path, path: &str) -> io::Result<()> {
    let file = visible(root, path)?;
    match retried(|| fs::remove_file(&file)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// The stamps of those of `paths` that are in the folder, which tell that another program
/// changed one since.
pub fn stamps<'a>(
    root: &Path,
    paths: impl IntoIterator<Item = &'a str>,
) -> io::Result<Vec<(&'a str, Stamp)>> {
    let mut stamps = Vec::new();
    for path in paths {
        match fs::metadata(visible(root, path)?) {
            Ok(metadata) => stamps.push((path, stamp_of(&metadata))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(stamps)
}

/// The file at `path`, unless it is a dot file or a link, which [`list`] leaves out.
fn visible(root: &Path, path: &str) -> io::Result<PathBuf> {
    let segments = segments(path)?;
    if segments.iter().any(|segment| segment.starts_with('.')) {
        return Err(refused(path));
    }
    let file = file(root, path, &segments)?;
    if is_link(&file) {
        return Err(refused(path));
    }
    Ok(file)
}

/// Windows refuses to replace or remove a file for as long as another program, such as an
/// indexer or an antivirus, holds it open, which it mostly does for a moment.
fn retried(mut act: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    // Access denied, and a sharing or a lock violation.
    let held =
        |error: &io::Error| cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33));
    let mut tries = 0;
    loop {
        match act() {
            Err(error) if held(&error) && tries < 5 => {
                tries += 1;
                thread::sleep(Duration::from_millis(100));
            }
            result => return result,
        }
    }
}

/// How many of a batch took their place before it failed, and why it did.
#[derive(Debug)]
pub struct Interrupted {
    pub done: usize,
    pub error: io::Error,
}

/// What [`write`] does, for many files at once. Where the system can, the drive's cache is flushed
/// once for all of them, before the first rename. The files take their places in the order given,
/// so a crash at any point leaves a prefix of them, each whole.
pub fn write_all(root: &Path, entries: &[(&str, &[u8])]) -> Result<(), Interrupted> {
    let interrupted = |done, error| Interrupted { done, error };
    let mut seen = BTreeSet::new();
    let mut targets = Vec::with_capacity(entries.len());
    for (path, _) in entries {
        if !seen.insert(*path) {
            return Err(interrupted(0, refused(path)));
        }
        targets.push(target(root, path).map_err(|error| interrupted(0, error))?);
    }
    let mut staged: Vec<Option<Staged>> = Vec::with_capacity(entries.len());
    let last = targets.iter().rposition(Option::is_some);
    for (at, ((_, bytes), target)) in entries.iter().zip(&targets).enumerate() {
        let Some(file) = target else {
            staged.push(None);
            continue;
        };
        let stage = || -> io::Result<Staged> {
            fs::create_dir_all(file.parent().expect("inside the root"))?;
            let mut draft = Draft::create(file)?;
            draft.append(bytes)?;
            // The last one's full flush covers the others' writeouts, which the drive has by then.
            draft.stage(Some(at) == last)
        };
        staged.push(Some(stage().map_err(|error| interrupted(0, error))?));
    }
    for (done, staged) in staged.into_iter().enumerate() {
        if let Some(staged) = staged {
            staged.place().map_err(|error| interrupted(done, error))?;
        }
    }
    Ok(())
}

/// Where `path` is written, `None` for a top-level dot file that is there already.
fn target(root: &Path, path: &str) -> io::Result<Option<PathBuf>> {
    let segments = segments(path)?;
    if segments.len() > 1 && segments.iter().any(|segment| segment.starts_with('.')) {
        return Err(refused(path));
    }
    let file = file(root, path, &segments)?;
    let name = segments.last().expect("never empty");
    if name.starts_with('.') && fs::symlink_metadata(&file).is_ok() {
        return Ok(None);
    }
    if is_link(&file) {
        return Err(refused(path));
    }
    Ok(Some(file))
}

/// A draft's file, complete and closed, that waits to take the file's place.
#[derive(Debug)]
struct Staged {
    file: PathBuf,
    temporary: PathBuf,
    gone: bool,
}

impl Staged {
    fn place(mut self) -> io::Result<()> {
        retried(|| fs::rename(&self.temporary, &self.file))?;
        self.gone = true;
        Ok(())
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.gone {
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

/// A file written in parts through a temporary file beside it, which takes the file's place
/// once complete, so that a crash never leaves it half-written. Short of a crash, the
/// temporary file goes away with the draft, however it ends.
#[derive(Debug)]
pub struct Draft {
    file: PathBuf,
    temporary: PathBuf,
    /// `None` once closed, which Windows needs before removing it.
    out: Option<File>,
    /// Whether the temporary file was renamed or removed, after which another draft of the
    /// same file may have taken its name.
    gone: bool,
}

impl Draft {
    /// In a folder that exists.
    pub fn create(file: &Path) -> io::Result<Self> {
        let name = file
            .file_name()
            .ok_or_else(|| refused(&file.display().to_string()))?;
        // A dot file, so that one left behind by a crash is no part of the folder. It must be
        // new, since a link in its place would lead the write elsewhere.
        let mut temporary = OsString::from(".");
        temporary.push(name);
        temporary.push(".tmp");
        let temporary = file.with_file_name(temporary);
        match fs::remove_file(&temporary) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        Ok(Self {
            file: file.to_owned(),
            temporary,
            out: Some(out),
            gone: false,
        })
    }

    pub fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        let out = self.out.as_mut().expect("open until the draft ends");
        out.write_all(bytes)
    }

    /// Closes the draft with its bytes handed to the drive. With `hardened` they are on the
    /// medium, and so is whatever was staged before.
    fn stage(mut self, hardened: bool) -> io::Result<Staged> {
        let out = self.out.take().expect("open until the draft ends");
        if hardened {
            out.sync_all()?;
        } else {
            hand_over(&out)?;
        }
        drop(out);
        self.gone = true;
        Ok(Staged {
            file: self.file.clone(),
            temporary: self.temporary.clone(),
            gone: false,
        })
    }

    pub fn commit(mut self) -> io::Result<()> {
        let out = self.out.take().expect("open until the draft ends");
        out.sync_all()?;
        drop(out);
        retried(|| fs::rename(&self.temporary, &self.file))?;
        self.gone = true;
        Ok(())
    }

    /// Leaves the file as it was.
    pub fn discard(mut self) -> io::Result<()> {
        drop(self.out.take());
        fs::remove_file(&self.temporary)?;
        self.gone = true;
        Ok(())
    }
}

impl Drop for Draft {
    fn drop(&mut self) {
        drop(self.out.take());
        if !self.gone {
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

/// Hands `file`'s data to the drive without asking it to flush its cache, where the system can,
/// and else flushes it fully.
fn hand_over(file: &File) -> io::Result<()> {
    #[cfg(target_vendor = "apple")]
    {
        use std::os::fd::AsRawFd;
        loop {
            if fsync(file.as_raw_fd()) == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    #[cfg(not(target_vendor = "apple"))]
    file.sync_all()
}

/// A file's size and modification time, which tell that it changed since it was opened.
pub type Stamp = (u64, Option<SystemTime>);

pub fn stamp(file: &Path) -> io::Result<Stamp> {
    Ok(stamp_of(&fs::metadata(file)?))
}

fn stamp_of(metadata: &fs::Metadata) -> Stamp {
    (metadata.len(), metadata.modified().ok())
}

/// The bytes of `range` in `file`, refused once it no longer bears the `stamp` it had when
/// the caller located the range.
pub fn read_range(file: &Path, range: Range<u64>, stamp: Stamp) -> io::Result<Vec<u8>> {
    let mut file = File::open(file)?;
    let metadata = file.metadata()?;
    if stamp_of(&metadata) != stamp {
        return Err(io::Error::other(
            "it changed since it was opened, so open it again",
        ));
    }
    let outside = || io::Error::new(io::ErrorKind::InvalidInput, "the range is not in the file");
    if range.start > range.end || range.end > metadata.len() {
        return Err(outside());
    }
    let mut bytes = vec![0; usize::try_from(range.end - range.start).map_err(|_| outside())?];
    file.seek(SeekFrom::Start(range.start))?;
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Appends `entry` to the log `file`, which first moves to `<file>.1`, in place of the one there,
/// when the entry would take it past `most` bytes. So the two never hold more than `most` bytes
/// each, and an entry longer than that keeps only its start.
pub fn append(file: &Path, entry: &[u8], most: u64) -> io::Result<()> {
    let kept = entry.len().min(usize::try_from(most).unwrap_or(usize::MAX));
    let entry = &entry[..kept];
    let held = match fs::metadata(file) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    if held > 0 && held + entry.len() as u64 > most {
        let mut older = file.as_os_str().to_owned();
        older.push(".1");
        retried(|| fs::rename(file, &older))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?
        .write_all(entry)
}

/// The segments of `path`, unless it could climb out of the folder. A `~` could name a dot
/// folder on Windows, as `GIT~1` does `.git`.
fn segments(path: &str) -> io::Result<Vec<&str>> {
    let segments: Vec<&str> = path.split('/').collect();
    let inside = segments.iter().all(|segment| {
        !segment.is_empty()
            && *segment != "."
            && *segment != ".."
            && !segment.contains(['\\', ':', '~'])
    });
    if inside {
        Ok(segments)
    } else {
        Err(refused(path))
    }
}

/// The file that `segments` name in `root`, unless a link lies among its folders.
fn file(root: &Path, path: &str, segments: &[&str]) -> io::Result<PathBuf> {
    let mut file = root.to_owned();
    for (at, segment) in segments.iter().enumerate() {
        if at > 0 && is_link(&file) {
            return Err(refused(path));
        }
        file.push(segment);
    }
    Ok(file)
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_symlink())
}

fn refused(path: &str) -> io::Error {
    let message = format!("`{path}` is not a file of the folder");
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder per test, as tests run in parallel.
    fn scratch(test: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("planche-{}-{test}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// Bypasses [`write`], which refuses dot folders.
    fn touch(root: &Path, path: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, path).unwrap();
    }

    fn refuses<T: std::fmt::Debug>(result: io::Result<T>) -> bool {
        result.is_err_and(|error| error.kind() == io::ErrorKind::InvalidInput)
    }

    #[test]
    fn a_path_cannot_climb_out() {
        let root = scratch("climb");
        for outside in [
            "",
            "/etc/passwd",
            "../a.json",
            "elements/../../a.json",
            "./a.json",
            "elements//a.json",
            "elements/",
            "elements\\a.json",
            "C:/a.json",
            "c:a.json",
            "GIT~1/config",
        ] {
            assert!(refuses(read(&root, outside)), "{outside}");
            assert!(refuses(write(&root, outside, b"")), "{outside}");
            assert!(refuses(remove(&root, outside)), "{outside}");
            assert!(refuses(stamps(&root, [outside])), "{outside}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_folder_lists_its_files_down_to_a_depth() {
        let root = scratch("list");
        for path in [
            "board.json",
            "elements/a.json",
            "elements/deeper/b.json",
            "elements/.DS_Store",
            ".git/config",
        ] {
            touch(&root, path);
        }
        assert_eq!(list(&root, 1).unwrap(), ["board.json"]);
        assert_eq!(list(&root, 2).unwrap(), ["board.json", "elements/a.json"]);
        assert_eq!(
            list(&root, 3).unwrap(),
            ["board.json", "elements/a.json", "elements/deeper/b.json"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_folder_of_dot_files_is_empty() {
        let root = scratch("empty");
        assert!(is_empty(&root).unwrap());
        touch(&root, ".git/config");
        touch(&root, ".DS_Store");
        assert!(is_empty(&root).unwrap());
        touch(&root, "notes.txt");
        assert!(!is_empty(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_write_replaces_the_file_and_leaves_nothing_else() {
        let root = scratch("write");
        write(&root, "elements/a.json", b"before").unwrap();
        write(&root, "elements/a.json", b"after").unwrap();
        assert_eq!(read(&root, "elements/a.json").unwrap(), b"after");
        assert_eq!(list(&root, 2).unwrap(), ["elements/a.json"]);
        let names: Vec<_> = fs::read_dir(root.join("elements"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["a.json"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_draft_takes_the_files_place_once_committed() {
        let root = scratch("draft");
        let file = root.join("board.zip");
        fs::write(&file, b"before").unwrap();
        let mut draft = Draft::create(&file).unwrap();
        draft.append(b"af").unwrap();
        draft.append(b"ter").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"before");
        draft.commit().unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"after");

        let mut draft = Draft::create(&file).unwrap();
        draft.append(b"never").unwrap();
        draft.discard().unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"after");
        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["board.zip"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_draft_that_fails_to_commit_leaves_nothing_behind() {
        let root = scratch("draft-fails");
        // A file cannot take the place of a folder that holds something, on any system.
        let file = root.join("board.zip");
        touch(&root, "board.zip/inside");
        let mut draft = Draft::create(&file).unwrap();
        draft.append(b"never").unwrap();
        assert!(draft.commit().is_err());
        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["board.zip"]);

        let other = root.join("other.zip");
        drop(Draft::create(&other).unwrap());
        assert!(!root.join(".other.zip.tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn names(folder: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_batch_writes_every_file_and_leaves_no_temporary() {
        let root = scratch("batch");
        write(&root, "elements/a.json", b"before").unwrap();
        let entries: [(&str, &[u8]); 4] = [
            ("assets/x", b"x"),
            ("elements/a.json", b"after"),
            ("elements/b.json", b"b"),
            ("board.json", b"board"),
        ];
        write_all(&root, &entries).unwrap();
        for (path, bytes) in entries {
            assert_eq!(read(&root, path).unwrap(), bytes);
        }
        assert_eq!(names(&root), ["assets", "board.json", "elements"]);
        assert_eq!(names(&root.join("elements")), ["a.json", "b.json"]);
        assert_eq!(names(&root.join("assets")), ["x"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_batch_takes_its_places_in_order_and_a_failure_keeps_the_rest_as_it_was() {
        let root = scratch("batch-order");
        write(&root, "elements/c.json", b"c before").unwrap();
        // A folder that holds something cannot be replaced by a file, on any system.
        touch(&root, "elements/b.json/inside");
        let entries: [(&str, &[u8]); 4] = [
            ("elements/a.json", b"a"),
            ("elements/b.json", b"b"),
            ("elements/c.json", b"c after"),
            ("board.json", b"board"),
        ];
        let failed = write_all(&root, &entries).unwrap_err();
        assert_eq!(failed.done, 1);
        assert_eq!(read(&root, "elements/a.json").unwrap(), b"a");
        assert_eq!(read(&root, "elements/c.json").unwrap(), b"c before");
        assert!(!root.join("board.json").exists());
        assert_eq!(
            names(&root.join("elements")),
            ["a.json", "b.json", "c.json"]
        );
        assert_eq!(names(&root), ["elements"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_batch_that_cannot_be_staged_changes_nothing() {
        let root = scratch("batch-stage");
        write(&root, "elements/a.json", b"before").unwrap();
        let entries: [(&str, &[u8]); 2] =
            [("elements/a.json", b"after"), ("elements/.hidden", b"")];
        let failed = write_all(&root, &entries).unwrap_err();
        assert_eq!(failed.done, 0);
        assert_eq!(failed.error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(read(&root, "elements/a.json").unwrap(), b"before");
        assert_eq!(names(&root.join("elements")), ["a.json"]);

        // The same path twice would write one temporary file twice.
        let twice: [(&str, &[u8]); 2] = [("board.json", b"1"), ("board.json", b"2")];
        assert_eq!(
            write_all(&root, &twice).unwrap_err().error.kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(!root.join("board.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_batch_only_creates_a_top_level_dot_file() {
        let root = scratch("batch-dot");
        write(&root, ".gitattributes", b"ours").unwrap();
        let entries: [(&str, &[u8]); 3] = [
            (".gitattributes", b"theirs"),
            (".other", b"new"),
            ("board.json", b"board"),
        ];
        write_all(&root, &entries).unwrap();
        assert_eq!(fs::read(root.join(".gitattributes")).unwrap(), b"ours");
        assert_eq!(fs::read(root.join(".other")).unwrap(), b"new");
        assert_eq!(read(&root, "board.json").unwrap(), b"board");
        assert_eq!(names(&root), [".gitattributes", ".other", "board.json"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn files_packed_unpack_as_they_were() {
        let files: [(&str, &[u8]); 3] = [
            ("board.json", b"{}"),
            ("elements/\u{e9}.json", b""),
            ("assets/a", &[0, 1, 2]),
        ];
        let packed = pack(files);
        assert_eq!(unpack(&packed).unwrap(), files);
        // As the page packs them.
        let one: [(&str, &[u8]); 1] = [("\u{e9}", &[7])];
        assert_eq!(
            pack(one),
            [1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0xc3, 0xa9, 7]
        );
        assert_eq!(unpack(&pack([])).unwrap(), []);

        for damaged in [
            &packed[..packed.len() - 1],
            &[packed.as_slice(), &[0]].concat(),
            &[255, 255, 255, 255, 0, 0, 0, 0],
            &[1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0xff],
        ] {
            let error = unpack(damaged).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{damaged:?}");
        }
    }

    #[test]
    fn many_files_read_packed_in_the_order_asked() {
        let root = scratch("read-all");
        write(&root, "elements/a.json", b"a").unwrap();
        write(&root, "board.json", b"board").unwrap();
        let packed = read_all(&root, ["elements/a.json", "board.json"]).unwrap();
        let read: [(&str, &[u8]); 2] = [("elements/a.json", b"a"), ("board.json", b"board")];
        assert_eq!(unpack(&packed).unwrap(), read);

        let missing = read_all(&root, ["board.json", "elements/b.json"]).unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);
        assert!(missing.to_string().contains("elements/b.json"));
        let hidden = read_all(&root, ["elements/.a.json"]).unwrap_err();
        assert_eq!(hidden.kind(), io::ErrorKind::InvalidInput);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_empty_batch_writes_nothing() {
        let root = scratch("batch-empty");
        write_all(&root, &[]).unwrap();
        assert!(names(&root).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_range_reads_only_its_bytes() {
        let root = scratch("range");
        let file = root.join("board.zip");
        fs::write(&file, b"0123456789").unwrap();
        let opened = stamp(&file).unwrap();
        assert_eq!(read_range(&file, 2..5, opened).unwrap(), b"234");
        assert_eq!(read_range(&file, 10..10, opened).unwrap(), b"");
        assert!(refuses(read_range(&file, 8..11, opened)));
        assert!(refuses(read_range(
            &file,
            Range { start: 5, end: 2 },
            opened
        )));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_range_is_refused_once_its_file_changed() {
        let root = scratch("changed");
        let file = root.join("board.zip");
        fs::write(&file, b"0123456789").unwrap();
        let opened = stamp(&file).unwrap();
        let changed = |result: io::Result<Vec<u8>>| {
            result.is_err_and(|error| error.kind() == io::ErrorKind::Other)
        };

        // Rewritten at the same size, which only its modification time tells.
        fs::write(&file, b"9876543210").unwrap();
        let later = opened.1.unwrap() + std::time::Duration::from_secs(3600);
        let rewritten = File::options().write(true).open(&file).unwrap();
        rewritten.set_modified(later).unwrap();
        drop(rewritten);
        assert!(changed(read_range(&file, 2..5, opened)));

        let mut draft = Draft::create(&file).unwrap();
        draft.append(b"a longer file").unwrap();
        draft.commit().unwrap();
        assert!(changed(read_range(&file, 2..5, opened)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dot_files_are_only_ever_created_at_the_top() {
        let root = scratch("dot");
        write(&root, ".gitattributes", b"ours").unwrap();
        write(&root, ".gitattributes", b"theirs").unwrap();
        assert_eq!(fs::read(root.join(".gitattributes")).unwrap(), b"ours");
        touch(&root, ".git/config");
        assert!(refuses(write(&root, ".git/hooks/pre-commit", b"")));
        assert!(refuses(write(&root, "elements/.hidden", b"")));
        assert!(refuses(read(&root, ".git/config")));
        assert!(refuses(read(&root, ".gitattributes")));
        assert!(refuses(remove(&root, ".gitattributes")));
        assert!(refuses(remove(&root, ".git/config")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_removal_leaves_the_rest_and_forgives_a_file_gone_already() {
        let root = scratch("remove");
        write(&root, "elements/a.json", b"a").unwrap();
        write(&root, "elements/b.json", b"b").unwrap();
        remove(&root, "elements/a.json").unwrap();
        remove(&root, "elements/a.json").unwrap();
        assert_eq!(list(&root, 2).unwrap(), ["elements/b.json"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stamps_tell_which_files_changed() {
        let root = scratch("stamps");
        write(&root, "board.json", b"before").unwrap();
        let before = stamps(&root, ["board.json", "elements/gone.json"]).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].0, "board.json");

        // Rewritten at the same size, which only its modification time tells.
        fs::write(root.join("board.json"), b"after!").unwrap();
        let later = before[0].1.1.unwrap() + std::time::Duration::from_secs(3600);
        let rewritten = File::options()
            .write(true)
            .open(root.join("board.json"))
            .unwrap();
        rewritten.set_modified(later).unwrap();
        drop(rewritten);
        assert_ne!(stamps(&root, ["board.json"]).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    /// `false` where the system forbids links, as Windows does without Developer Mode.
    #[cfg(any(unix, windows))]
    fn link(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let made = if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        };
        match made {
            Ok(()) => true,
            Err(error) if error.raw_os_error() == Some(1314) => false,
            Err(error) => panic!("{error}"),
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn links_lead_nowhere() {
        let root = scratch("links");
        let elsewhere = scratch("links-elsewhere");
        touch(&elsewhere, "secret");
        if !link(&elsewhere, &root.join("assets")) {
            eprintln!("skipped: this system forbids links");
            fs::remove_dir_all(root).unwrap();
            fs::remove_dir_all(elsewhere).unwrap();
            return;
        }
        link(&elsewhere.join("secret"), &root.join("board.json"));
        // Left there by a crash, or planted to lead the next write elsewhere.
        link(&elsewhere.join("secret"), &root.join(".notes.tmp"));
        link(&elsewhere.join("secret"), &root.join(".gitattributes"));
        link(&elsewhere.join("missing"), &root.join(".dangling"));

        assert!(list(&root, 2).unwrap().is_empty());
        assert!(refuses(read(&root, "assets/secret")));
        assert!(refuses(read(&root, "board.json")));
        assert!(refuses(write(&root, "assets/secret", b"")));
        assert!(refuses(remove(&root, "board.json")));
        assert!(refuses(stamps(&root, ["board.json"])));
        write(&root, "notes", b"mine").unwrap();
        write(&root, ".gitattributes", b"mine").unwrap();
        write(&root, ".dangling", b"mine").unwrap();
        assert_eq!(fs::read(elsewhere.join("secret")).unwrap(), b"secret");
        assert!(!elsewhere.join("missing").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(elsewhere).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_name_that_is_not_utf8_still_fills_a_folder() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let root = scratch("encoding");
        fs::write(root.join(OsStr::from_bytes(b"\xff")), b"").unwrap();
        assert!(!is_empty(&root).unwrap());
        assert!(list(&root, 1).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_batch_that_fails_while_staging_leaves_no_temporary() {
        let root = scratch("batch-staging-fails");
        write(&root, "elements/a.json", b"before").unwrap();
        // A file where a folder should be fails the batch once `elements/a.json` is staged.
        touch(&root, "assets");
        let entries: [(&str, &[u8]); 3] = [
            ("elements/a.json", b"after"),
            ("assets/x", b"x"),
            ("board.json", b"board"),
        ];
        let failed = write_all(&root, &entries).unwrap_err();
        assert_eq!(failed.done, 0);
        assert_ne!(failed.error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(read(&root, "elements/a.json").unwrap(), b"before");
        assert_eq!(names(&root.join("elements")), ["a.json"]);
        assert_eq!(names(&root), ["assets", "elements"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_log_grows_by_entries() {
        let root = scratch("log-grows");
        let log = root.join("errors.log");
        append(&log, b"one\n", 100).unwrap();
        append(&log, b"two\n", 100).unwrap();
        assert_eq!(fs::read(&log).unwrap(), b"one\ntwo\n");
        assert_eq!(names(&root), ["errors.log"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_full_log_moves_aside_in_place_of_the_older_one() {
        let root = scratch("log-rolls");
        let log = root.join("errors.log");
        append(&log, b"first\n", 10).unwrap();
        append(&log, b"second\n", 10).unwrap();
        append(&log, b"third\n", 10).unwrap();
        assert_eq!(fs::read(&log).unwrap(), b"third\n");
        assert_eq!(fs::read(root.join("errors.log.1")).unwrap(), b"second\n");
        assert_eq!(names(&root), ["errors.log", "errors.log.1"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_entry_longer_than_a_log_keeps_its_start() {
        let root = scratch("log-entry-too-long");
        let log = root.join("errors.log");
        append(&log, b"0123456789", 4).unwrap();
        assert_eq!(fs::read(&log).unwrap(), b"0123");
        append(&log, b"abcdef", 4).unwrap();
        assert_eq!(fs::read(&log).unwrap(), b"abcd");
        assert_eq!(fs::read(root.join("errors.log.1")).unwrap(), b"0123");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_log_that_cannot_move_aside_refuses_what_would_grow_it_past_its_size() {
        let root = scratch("log-cannot-roll");
        let log = root.join("errors.log");
        append(&log, b"first\n", 10).unwrap();
        // A non-empty folder in place of `.1` makes the rename fail, as a viewer holding the
        // file open without delete sharing would on Windows.
        let older = root.join("errors.log.1");
        fs::create_dir(&older).unwrap();
        fs::write(older.join("x"), b"x").unwrap();
        assert!(append(&log, b"second\n", 10).is_err());
        assert!(append(&log, b"third\n", 10).is_err());
        assert_eq!(fs::read(&log).unwrap(), b"first\n");
        append(&log, b"abc\n", 10).unwrap();
        assert_eq!(fs::read(&log).unwrap(), b"first\nabc\n");
        fs::remove_dir_all(root).unwrap();
    }
}
