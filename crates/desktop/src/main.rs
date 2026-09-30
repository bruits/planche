//! The desktop shell: a window around the web app, and the file system that a browser lacks.
//! It knows nothing of boards, since the web app runs the core.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, Window, WindowEvent, Wry};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind,
};

/// The menu item that quits by closing every window, as closing one asks first.
const QUIT: &str = "quit";

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Picked::default())
        .manage(Unsaved::default())
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if !window.state::<Unsaved>().0.load(Ordering::Relaxed) {
                    return;
                }
                // The dialog cannot block here, on the main thread, so the window closes later.
                api.prevent_close();
                let closing = window.clone();
                ask(window, "Close, and lose the changes to this board?").show(move |close| {
                    if close {
                        // It only fails once the window is gone anyway.
                        let _ = closing.destroy();
                    }
                });
            }
            // Only on Linux, where drags from a web page come through here too, and there the
            // position is in CSS pixels.
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) => {
                // A page's image comes as its address, which wry takes for a relative path.
                let (files, addresses): (Vec<PathBuf>, Vec<PathBuf>) =
                    paths.iter().cloned().partition(|path| path.is_absolute());
                let addresses: Vec<String> = addresses
                    .iter()
                    .map(|address| address.to_string_lossy().into_owned())
                    .collect();
                let picked = window.state::<Picked>();
                picked
                    .dropped
                    .lock()
                    .expect("never poisoned")
                    .extend(files.iter().cloned());
                // Only once they may be read. It only fails once the window is gone anyway.
                let _ = window.emit("dropped", (files, addresses, position.x, position.y));
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            if event.id() == QUIT {
                for window in app.webview_windows().values() {
                    let _ = window.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            confirm,
            mark_unsaved,
            read_dropped,
            pick_folder,
            pick_target,
            list_files,
            read_file,
            write_file,
            pick_zip,
            read_zip,
            pick_export,
            append_export,
            finish_export,
            discard_export
        ]);
    // The predefined Quit of macOS ends the app without closing its windows, so without asking.
    // Quitting from the Dock or logging out still does, as tao never lets the app refuse.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        let menu = tauri::menu::Menu::default(app)?;
        let items = menu.items()?;
        // Tauri only tells a predefined item by its text, "Quit" and the app's name.
        let (app_menu, at) = items
            .first()
            .and_then(|item| item.as_submenu())
            .and_then(|app_menu| {
                let at = app_menu.items().ok()?.iter().position(|item| {
                    item.as_predefined_menuitem()
                        .and_then(|item| item.text().ok())
                        .is_some_and(|text| text.starts_with("Quit"))
                })?;
                Some((app_menu, at))
            })
            .expect("the app's menu has a predefined Quit");
        app_menu.remove_at(at)?;
        let label = format!("Quit {}", app.package_info().name);
        let quit = tauri::menu::MenuItem::with_id(app, QUIT, label, true, Some("CmdOrCtrl+Q"))?;
        app_menu.insert(&quit, at)?;
        Ok(menu)
    });
    let context = tauri::generate_context!();
    // WebKitGTK gives pages no dropped files, so the shell takes them there.
    #[cfg(target_os = "linux")]
    let context = {
        let mut context = context;
        for window in &mut context.config_mut().app.windows {
            window.drag_drop_enabled = true;
        }
        context
    };
    builder.run(context).expect("the app runs");
}

/// The folders and files the user picked or dropped, the only ones the webview may touch, so that a
/// script injected into it could not reach the rest of the disk. It may only write into
/// folders that were empty when picked, which hold nothing but what the app wrote, and to
/// files picked to export to, which only change once the export is complete.
#[derive(Default)]
struct Picked {
    readable: Mutex<BTreeSet<PathBuf>>,
    writable: Mutex<BTreeSet<PathBuf>>,
    zips: Mutex<BTreeMap<PathBuf, folder::Stamp>>,
    exports: Mutex<BTreeMap<PathBuf, folder::Draft>>,
    dropped: Mutex<BTreeSet<PathBuf>>,
}

#[derive(Default)]
struct Unsaved(AtomicBool);

/// Over `window`, which it keeps from taking clicks meanwhile, but on Linux.
fn ask(window: &Window, question: &str) -> MessageDialogBuilder<Wry> {
    window
        .dialog()
        .message(question)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .parent(window)
}

fn check(picked: &Mutex<BTreeSet<PathBuf>>, root: &Path) -> Result<(), String> {
    if picked.lock().expect("never poisoned").contains(root) {
        Ok(())
    } else {
        Err(not_picked(root))
    }
}

fn not_picked(path: &Path) -> String {
    format!("{} was not picked", path.display())
}

// Commands run off the main thread, which would otherwise freeze the window on every file.

/// The webview's own `confirm` does not work here.
#[tauri::command(async)]
fn confirm(window: Window, question: String) -> bool {
    ask(&window, &question).blocking_show()
}

#[tauri::command]
fn mark_unsaved(unsaved: State<'_, Unsaved>, value: bool) {
    unsaved.0.store(value, Ordering::Relaxed);
}

#[tauri::command(async)]
fn read_dropped(picked: State<'_, Picked>, path: PathBuf) -> Result<Response, String> {
    check(&picked.dropped, &path)?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|error| describe(&path, error))
}

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
    let bytes = raw_body(&request)?;
    let (Some(root), Some(path)) = (header(&request, "root"), header(&request, "path")) else {
        return Err("the `root` and `path` headers must be set".to_owned());
    };
    let root = PathBuf::from(root);
    check(&picked.writable, &root)?;
    folder::write(&root, &path, bytes).map_err(|error| describe(&root, error))
}

/// A board's ZIP file to read, and its size. `None` when the user cancels.
#[tauri::command(async)]
fn pick_zip(
    app: AppHandle,
    picked: State<'_, Picked>,
    title: String,
) -> Result<Option<(PathBuf, u64)>, String> {
    let dialog = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter("ZIP", &["zip"]);
    let Some(file) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let file = file.into_path().map_err(|error| error.to_string())?;
    let stamp = folder::stamp(&file).map_err(|error| describe(&file, error))?;
    picked
        .zips
        .lock()
        .expect("never poisoned")
        .insert(file.clone(), stamp);
    Ok(Some((file, stamp.0)))
}

/// The bytes from `start` to `end` of a picked ZIP file, raw. Refused once the file changed
/// since it was last picked, such as by an export over it, since the web app located its
/// entries then.
#[tauri::command(async)]
fn read_zip(
    picked: State<'_, Picked>,
    path: PathBuf,
    start: u64,
    end: u64,
) -> Result<Response, String> {
    let opened = picked
        .zips
        .lock()
        .expect("never poisoned")
        .get(&path)
        .copied()
        .ok_or_else(|| not_picked(&path))?;
    folder::read_range(&path, start..end, opened)
        .map(Response::new)
        .map_err(|error| describe(&path, error))
}

/// A file to export a ZIP file to, suggested as `name`, which stays as it was until
/// [`finish_export`]. `None` when the user cancels.
#[tauri::command(async)]
fn pick_export(
    app: AppHandle,
    picked: State<'_, Picked>,
    title: String,
    name: String,
) -> Result<Option<PathBuf>, String> {
    let dialog = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(name)
        .add_filter("ZIP", &["zip"]);
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let file = file.into_path().map_err(|error| error.to_string())?;
    let mut exports = picked.exports.lock().expect("never poisoned");
    // Left by a page that went away mid-export, whose temporary file Windows could not remove
    // while open. The web app runs one export at a time, so it is never a live one.
    if let Some(stale) = exports.remove(&file) {
        stale.discard().map_err(|error| describe(&file, error))?;
    }
    let draft = folder::Draft::create(&file).map_err(|error| describe(&file, error))?;
    exports.insert(file.clone(), draft);
    Ok(Some(file))
}

/// Appends the raw body to the export that the `path` header names, percent-encoded.
#[tauri::command(async)]
fn append_export(picked: State<'_, Picked>, request: Request<'_>) -> Result<(), String> {
    let bytes = raw_body(&request)?;
    let path = PathBuf::from(header(&request, "path").ok_or("the `path` header must be set")?);
    let mut exports = picked.exports.lock().expect("never poisoned");
    let draft = exports.get_mut(&path).ok_or_else(|| not_picked(&path))?;
    draft.append(bytes).map_err(|error| describe(&path, error))
}

/// Puts the complete export in place of the file.
#[tauri::command(async)]
fn finish_export(picked: State<'_, Picked>, path: PathBuf) -> Result<(), String> {
    let draft = take_export(&picked, &path)?;
    draft.commit().map_err(|error| describe(&path, error))
}

/// Leaves the file as it was.
#[tauri::command(async)]
fn discard_export(picked: State<'_, Picked>, path: PathBuf) -> Result<(), String> {
    let draft = take_export(&picked, &path)?;
    draft.discard().map_err(|error| describe(&path, error))
}

fn take_export(picked: &Picked, path: &Path) -> Result<folder::Draft, String> {
    let mut exports = picked.exports.lock().expect("never poisoned");
    exports.remove(path).ok_or_else(|| not_picked(path))
}

fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err("the body must be raw bytes".to_owned()),
    }
}

/// Headers only carry ASCII, so paths come percent-encoded.
fn header(request: &Request<'_>, name: &str) -> Option<String> {
    let value = request.headers().get(name)?.to_str().ok()?;
    percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn describe(path: &Path, error: io::Error) -> String {
    format!("{}: {error}", path.display())
}
