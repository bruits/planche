//! The desktop shell: a window around the web app, and the file system that a browser lacks.
//! It knows nothing of boards, since the web app runs the core.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Picked::default())
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            pick_target,
            list_files,
            read_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("the app runs");
}

/// The folders the user picked, the only ones the webview may touch, so that a script
/// injected into it could not reach the rest of the disk. It may only write into folders
/// that were empty when picked, which hold nothing but what the app wrote.
#[derive(Default)]
struct Picked {
    readable: Mutex<BTreeSet<PathBuf>>,
    writable: Mutex<BTreeSet<PathBuf>>,
}

fn check(picked: &Mutex<BTreeSet<PathBuf>>, root: &Path) -> Result<(), String> {
    if picked.lock().expect("never poisoned").contains(root) {
        Ok(())
    } else {
        Err(format!("{} was not picked", root.display()))
    }
}

// Commands run off the main thread, which would otherwise freeze the window on every file.

/// A folder to read. `None` when the user cancels.
#[tauri::command(async)]
fn pick_folder(
    app: AppHandle,
    picked: State<'_, Picked>,
    title: String,
) -> Result<Option<PathBuf>, String> {
    let Some(root) = pick(&app, title)? else {
        return Ok(None);
    };
    picked
        .readable
        .lock()
        .expect("never poisoned")
        .insert(root.clone());
    Ok(Some(root))
}

/// An empty folder to write into. `None` when the user cancels.
#[tauri::command(async)]
fn pick_target(
    app: AppHandle,
    picked: State<'_, Picked>,
    title: String,
) -> Result<Option<PathBuf>, String> {
    let Some(root) = pick(&app, title)? else {
        return Ok(None);
    };
    if !folder::is_empty(&root).map_err(|error| describe(&root, error))? {
        return Err(format!("{} is not empty", root.display()));
    }
    picked
        .writable
        .lock()
        .expect("never poisoned")
        .insert(root.clone());
    Ok(Some(root))
}

fn pick(app: &AppHandle, title: String) -> Result<Option<PathBuf>, String> {
    let dialog = app.dialog().file().set_title(title);
    dialog
        .blocking_pick_folder()
        .map(|folder| folder.into_path().map_err(|error| error.to_string()))
        .transpose()
}

#[tauri::command(async)]
fn list_files(
    picked: State<'_, Picked>,
    root: PathBuf,
    depth: usize,
) -> Result<Vec<String>, String> {
    check(&picked.readable, &root)?;
    folder::list(&root, depth).map_err(|error| describe(&root, error))
}

/// The file's bytes, raw rather than as a JSON array, since assets can be large.
#[tauri::command(async)]
fn read_file(picked: State<'_, Picked>, root: PathBuf, path: String) -> Result<Response, String> {
    check(&picked.readable, &root)?;
    folder::read(&root, &path)
        .map(Response::new)
        .map_err(|error| describe(&root, error))
}

/// Writes the raw body to the file that the `root` and `path` headers name, percent-encoded.
#[tauri::command(async)]
fn write_file(picked: State<'_, Picked>, request: Request<'_>) -> Result<(), String> {
    let header = |name: &str| {
        let value = request.headers().get(name)?.to_str().ok()?;
        percent_decode_str(value)
            .decode_utf8()
            .ok()
            .map(|value| value.into_owned())
    };
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("the body must be raw bytes".to_owned());
    };
    let (Some(root), Some(path)) = (header("root"), header("path")) else {
        return Err("the `root` and `path` headers must be set".to_owned());
    };
    let root = PathBuf::from(root);
    check(&picked.writable, &root)?;
    folder::write(&root, &path, bytes).map_err(|error| describe(&root, error))
}

fn describe(path: &Path, error: io::Error) -> String {
    format!("{}: {error}", path.display())
}
