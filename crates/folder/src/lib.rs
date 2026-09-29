//! A folder on disk as the desktop shell reads and writes it: its files are named by paths
//! relative to it with `/` between segments, a crash never leaves one half-written, and
//! nothing leads out of it. Links are no part of it, and neither are dot files and folders,
//! such as `.git/`, though the app may create a missing top-level dot file, such as
//! `.gitattributes`, which it never reads or lists. It knows nothing of boards, and needs no
//! Tauri, so its tests run on every platform.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

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
    let folder = file.parent().expect("inside the root");
    fs::create_dir_all(folder)?;
    // A dot file too, so that one left behind by a crash is no part of the folder. It must
    // be new, since a link in its place would lead the write elsewhere.
    let temporary = folder.join(format!(".{name}.tmp"));
    match fs::remove_file(&temporary) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    out.write_all(bytes)?;
    out.sync_all()?;
    fs::rename(&temporary, file)
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
