//! A folder on disk as the desktop shell reads and writes it: its files are named by paths
//! relative to it with `/` between segments, a crash never leaves one half-written, and
//! nothing leads out of it. Links are no part of it, and neither are dot files and folders,
//! such as `.git/`, though the app may create a missing top-level dot file, such as
//! `.gitattributes`, which it never reads or lists. A single file the user picks, such as a
//! ZIP file, is read in ranges and written in parts. It knows nothing of boards, and needs no
//! Tauri, so its tests run on every platform.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

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
    let segments = segments(path)?;
    if segments.iter().any(|segment| segment.starts_with('.')) {
        return Err(refused(path));
    }
    let file = file(root, path, &segments)?;
    if is_link(&file) {
        return Err(refused(path));
    }
    fs::read(file)
}

/// Writes through a temporary file renamed over the target. A top-level dot file is only
/// ever created, since its user owns it afterwards, and no other is.
pub fn write(root: &Path, path: &str, bytes: &[u8]) -> io::Result<()> {
    let segments = segments(path)?;
    if segments.len() > 1 && segments.iter().any(|segment| segment.starts_with('.')) {
        return Err(refused(path));
    }
    let file = file(root, path, &segments)?;
    let name = segments.last().expect("never empty");
    if name.starts_with('.') && fs::symlink_metadata(&file).is_ok() {
        return Ok(());
    }
    if is_link(&file) {
        return Err(refused(path));
    }
    fs::create_dir_all(file.parent().expect("inside the root"))?;
    let mut draft = Draft::create(&file)?;
    draft.append(bytes)?;
    draft.commit()
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

    pub fn commit(mut self) -> io::Result<()> {
        let out = self.out.take().expect("open until the draft ends");
        out.sync_all()?;
        drop(out);
        fs::rename(&self.temporary, &self.file)?;
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
}
