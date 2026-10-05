//! The desktop shell: a window around the web app, and the file system that a browser lacks.
//! It knows of boards only which of their files the page may write, since the web app runs the
//! core. Once the user turns agent access on, it passes agents' questions about the board on to
//! the web app.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod keyboard;

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, RunEvent, State, Window, WindowEvent, Wry,
};
use tauri_plugin_dialog::{
    DialogExt, FileDialogBuilder, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind,
};

/// The menu item that quits by closing every window, as closing one asks first.
const QUIT: &str = "quit";
const NO_DIRECTORY: &str = "this machine has no folder for the app's data";
/// In the app's folder, what board to reopen at launch: `folder` or `zip`, a line break, and
/// its path.
const LAST: &str = "last-board";

fn main() {
    let context = tauri::generate_context!();
    // Before any window or Dock icon, as an agent's client spawns it to talk to the app.
    if std::env::args_os()
        .nth(1)
        .is_some_and(|argument| argument == "mcp")
    {
        std::process::exit(gateway(&context.config().identifier));
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Picked::default())
        .manage(Unsaved::default())
        .manage(Session::default())
        .manage(Agent::default())
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                // Tauri keeps sending on the channel of a page that reloaded, to nobody.
                webview.state::<Agent>().bridge.detach();
                // What the page that went away held went with it, its exports' drafts too.
                let unsaved = webview.state::<Unsaved>();
                unsaved.changes.store(false, Ordering::Relaxed);
                unsaved.closing.store(false, Ordering::Relaxed);
                let picked = webview.state::<Picked>();
                picked.exports.lock().expect("never poisoned").clear();
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let unsaved = window.state::<Unsaved>();
                if !unsaved.changes.load(Ordering::Relaxed) {
                    return;
                }
                api.prevent_close();
                // The page writes what it can, then closes the window or asks.
                if !unsaved.closing.swap(true, Ordering::Relaxed) {
                    // It only fails once the window is gone anyway.
                    let _ = window.emit("closing", ());
                    return;
                }
                // Closed again while the page still writes, or after it went away. The dialog
                // cannot block here, on the main thread, so the window closes later.
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
            open_address,
            mark_unsaved,
            close_window,
            keep_window,
            keep_on_top,
            keyboard_layout,
            show_title_bar,
            drag_window,
            read_dropped,
            pick_folder,
            pick_target,
            session,
            clear_session,
            remember_board,
            forget_board,
            reopen_board,
            list_files,
            read_file,
            write_file,
            remove_file,
            stamp_files,
            pick_zip,
            read_zip,
            zip_changed,
            rewrite_zip,
            finish_rewrite,
            reread_zip,
            adopt_zip,
            pick_export,
            append_export,
            finish_export,
            discard_export,
            agent_attach,
            agent_reply,
            agent_allow
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
    // WebKitGTK gives pages no dropped files, so the shell takes them there.
    #[cfg(target_os = "linux")]
    let context = {
        let mut context = context;
        for window in &mut context.config_mut().app.windows {
            window.drag_drop_enabled = true;
        }
        context
    };
    builder
        .build(context)
        .expect("the app builds")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Agent>().stop();
            }
        });
}

fn gateway(identifier: &str) -> i32 {
    let Some(directory) = mcp::directory(identifier) else {
        eprintln!("planche mcp: {NO_DIRECTORY}");
        return 1;
    };
    match mcp::gateway(&directory, io::stdin(), io::stdout()) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("planche mcp: {error}");
            1
        }
    }
}

/// The folders and files the user picked or dropped, the only ones the webview may touch, so that a
/// script injected into it could not reach the rest of the disk. In a folder, it may only write
/// a board's files and delete its element files, and a file picked to export to only changes
/// once the export is complete.
#[derive(Default)]
struct Picked {
    readable: Mutex<BTreeSet<PathBuf>>,
    writable: Mutex<BTreeSet<PathBuf>>,
    zips: Mutex<BTreeMap<PathBuf, Zip>>,
    exports: Mutex<BTreeMap<PathBuf, folder::Draft>>,
    dropped: Mutex<BTreeSet<PathBuf>>,
}

impl Picked {
    fn grant(&self, root: &Path) {
        for set in [&self.readable, &self.writable] {
            set.lock().expect("never poisoned").insert(root.to_owned());
        }
    }

    /// Picked again, it may be the open board's, which only matches it once it adopts it.
    fn read_zip(&self, file: &Path, stamp: folder::Stamp) {
        let mut zips = self.zips.lock().expect("never poisoned");
        zips.entry(file.to_owned())
            .and_modify(|zip| zip.read = stamp)
            .or_insert(Zip::new(stamp));
    }
}

/// A picked ZIP file's stamps: as the web app last located its entries, which reads need, and as
/// the board on screen last matched it, which tells another program's changes.
#[derive(Clone, Copy)]
struct Zip {
    read: folder::Stamp,
    board: folder::Stamp,
}

impl Zip {
    fn new(stamp: folder::Stamp) -> Self {
        Self {
            read: stamp,
            board: stamp,
        }
    }
}

/// Whether the page holds changes not yet safe on disk, so that closing first lets it write them.
#[derive(Default)]
struct Unsaved {
    changes: AtomicBool,
    /// Once a close waits on the page, so that another one asks, should the page be gone.
    closing: AtomicBool,
}

/// The folder that keeps the board being edited while it has no folder of its own, which one
/// app at a time holds, with the file that locks it.
#[derive(Default)]
struct Session(Mutex<Option<(PathBuf, File)>>);

/// How agents reach the web app's board, while agent access is on.
struct Agent {
    bridge: Arc<mcp::Bridge>,
    running: Mutex<Option<mcp::Running>>,
    /// One turn at a time, as starting waits on the network.
    turning: tauri::async_runtime::Mutex<()>,
}

impl Default for Agent {
    fn default() -> Self {
        Self {
            // Long enough to read a large asset again, and to decode a video's first frame.
            bridge: Arc::new(mcp::Bridge::new(Duration::from_secs(30))),
            running: Mutex::default(),
            turning: tauri::async_runtime::Mutex::default(),
        }
    }
}

impl Agent {
    fn stop(&self) {
        self.running.lock().expect("never poisoned").take();
    }
}

/// Over `window`, which it keeps from taking clicks meanwhile, but on Linux.
fn ask(window: &Window, question: &str) -> MessageDialogBuilder<Wry> {
    window
        .dialog()
        .message(question)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .parent(window)
}

/// Over `window`, which Windows would otherwise keep above it once on top, but on Linux.
fn files(window: &Window) -> FileDialogBuilder<Wry> {
    window.dialog().file().set_parent(window)
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

/// The webview's own `confirm` does not work here. `choices` names the buttons, yes then no.
#[tauri::command(async)]
fn confirm(window: Window, question: String, choices: Option<(String, String)>) -> bool {
    let dialog = ask(&window, &question);
    match choices {
        Some((yes, no)) => dialog.buttons(MessageDialogButtons::OkCancelCustom(yes, no)),
        None => dialog,
    }
    .blocking_show()
}

/// Only an http or https address, as agents and boards from elsewhere write what the page asks to
/// open, which might otherwise launch an app.
#[tauri::command]
fn open_address(address: String) -> Result<(), String> {
    let url = tauri::Url::parse(&address).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{address} is not a web address"));
    }
    open::that_detached(url.as_str()).map_err(|error| error.to_string())
}

#[tauri::command]
fn mark_unsaved(unsaved: State<'_, Unsaved>, value: bool) {
    unsaved.changes.store(value, Ordering::Relaxed);
}

/// Once the page wrote what it could on closing, or the user chose to lose the rest.
#[tauri::command]
fn close_window(window: Window) -> Result<(), String> {
    window.destroy().map_err(|error| error.to_string())
}

/// Once the user chose to keep the window, and the changes the page could not write.
#[tauri::command]
fn keep_window(unsaved: State<'_, Unsaved>) {
    unsaved.closing.store(false, Ordering::Relaxed);
}

/// GTK ignores it on Wayland without a word, so the shell refuses there.
#[tauri::command]
fn keep_on_top(window: Window, on: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if on && on_wayland() {
        return Err("Wayland keeps windows from staying on top".to_owned());
    }
    window
        .set_always_on_top(on)
        .map_err(|error| error.to_string())
}

/// What each key types alone, by `KeyboardEvent.code`, which macOS's webview does not tell the
/// page. Elsewhere none, as ⌥ types letters as they are. Not async, so on the main thread.
#[tauri::command]
fn keyboard_layout() -> Vec<(&'static str, String)> {
    #[cfg(target_os = "macos")]
    let typed = keyboard::typed();
    #[cfg(not(target_os = "macos"))]
    let typed = Vec::new();
    typed
}

/// As GTK picks its backend.
#[cfg(target_os = "linux")]
fn on_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        && !std::env::var("GDK_BACKEND").is_ok_and(|backend| backend.starts_with("x11"))
}

/// With its borders too. Refused in full screen, which would bring them back on leaving.
#[tauri::command]
fn show_title_bar(window: Window, shown: bool) -> Result<(), String> {
    if !shown && window.is_fullscreen().map_err(|error| error.to_string())? {
        return Err("A window in full screen keeps its title bar".to_owned());
    }
    window
        .set_decorations(shown)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn drag_window(window: Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn read_dropped(picked: State<'_, Picked>, path: PathBuf) -> Result<Response, String> {
    check(&picked.dropped, &path)?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|error| describe(&path, error))
}

/// A board's folder, which the board saves itself into. `None` when the user cancels.
#[tauri::command(async)]
fn pick_folder(
    window: Window,
    picked: State<'_, Picked>,
    title: String,
) -> Result<Option<PathBuf>, String> {
    let Some(root) = pick(&window, title)? else {
        return Ok(None);
    };
    picked.grant(&root);
    Ok(Some(root))
}

/// An empty folder to save a board into. `None` when the user cancels.
#[tauri::command(async)]
fn pick_target(
    window: Window,
    picked: State<'_, Picked>,
    title: String,
) -> Result<Option<PathBuf>, String> {
    let Some(root) = pick(&window, title)? else {
        return Ok(None);
    };
    if !folder::is_empty(&root).map_err(|error| describe(&root, error))? {
        return Err(format!("{} is not empty", root.display()));
    }
    picked.grant(&root);
    Ok(Some(root))
}

/// The session's folder, `None` while another Planche holds it.
#[tauri::command(async)]
fn session(
    app: AppHandle,
    picked: State<'_, Picked>,
    session: State<'_, Session>,
) -> Result<Option<PathBuf>, String> {
    let mut held = session.0.lock().expect("never poisoned");
    if let Some((root, _)) = held.as_ref() {
        return Ok(Some(root.clone()));
    }
    let directory = app_directory(&app)?;
    let locked = directory.join("session.lock");
    let lock = File::create(&locked).map_err(|error| describe(&locked, error))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(None),
        Err(TryLockError::Error(error)) => return Err(describe(&locked, error)),
    }
    let root = directory.join("session");
    fs::create_dir_all(&root).map_err(|error| describe(&root, error))?;
    picked.grant(&root);
    *held = Some((root.clone(), lock));
    Ok(Some(root))
}

/// Empties the session's folder, as another board takes its place.
#[tauri::command(async)]
fn clear_session(session: State<'_, Session>) -> Result<(), String> {
    let held = session.0.lock().expect("never poisoned");
    let (root, _) = held.as_ref().ok_or("this app does not hold the session")?;
    match fs::remove_dir_all(root) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            return Err(describe(root, error));
        }
        _ => {}
    }
    fs::create_dir_all(root).map_err(|error| describe(root, error))
}

/// The board to reopen at launch, a folder or a ZIP file picked since the app started.
#[tauri::command(async)]
fn remember_board(
    app: AppHandle,
    picked: State<'_, Picked>,
    path: PathBuf,
    zip: bool,
) -> Result<(), String> {
    if zip {
        if !picked
            .zips
            .lock()
            .expect("never poisoned")
            .contains_key(&path)
        {
            return Err(not_picked(&path));
        }
    } else {
        check(&picked.writable, &path)?;
    }
    let text = path
        .to_str()
        .ok_or_else(|| format!("{} is not named in UTF-8", path.display()))?;
    let kind = if zip { "zip" } else { "folder" };
    let file = app_directory(&app)?.join(LAST);
    let mut draft = folder::Draft::create(&file).map_err(|error| describe(&file, error))?;
    draft
        .append(format!("{kind}\n{text}").as_bytes())
        .map_err(|error| describe(&file, error))?;
    draft.commit().map_err(|error| describe(&file, error))
}

#[tauri::command(async)]
fn forget_board(app: AppHandle) -> Result<(), String> {
    let file = app_directory(&app)?.join(LAST);
    match fs::remove_file(&file) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(describe(&file, error)),
        _ => Ok(()),
    }
}

/// The board remembered, picked again: `folder` or `zip`, its path, and a ZIP file's size.
/// `None` when there is none, or it is gone.
#[tauri::command(async)]
fn reopen_board(
    app: AppHandle,
    picked: State<'_, Picked>,
) -> Result<Option<(String, PathBuf, u64)>, String> {
    let file = app_directory(&app)?.join(LAST);
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(describe(&file, error)),
    };
    let Some((kind, path)) = text.split_once('\n') else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    match kind {
        "folder" if path.is_dir() => {
            picked.grant(&path);
            Ok(Some((kind.to_owned(), path, 0)))
        }
        "zip" if path.is_file() => {
            let stamp = folder::stamp(&path).map_err(|error| describe(&path, error))?;
            picked.read_zip(&path, stamp);
            Ok(Some((kind.to_owned(), path, stamp.0)))
        }
        _ => Ok(None),
    }
}

fn app_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = mcp::directory(&app.config().identifier).ok_or(NO_DIRECTORY)?;
    fs::create_dir_all(&directory).map_err(|error| describe(&directory, error))?;
    Ok(directory)
}

fn pick(window: &Window, title: String) -> Result<Option<PathBuf>, String> {
    let dialog = files(window).set_title(title);
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

/// Writes the raw body to the board's file that the `root` and `path` headers name,
/// percent-encoded, and returns its stamp.
#[tauri::command(async)]
fn write_file(picked: State<'_, Picked>, request: Request<'_>) -> Result<String, String> {
    let bytes = raw_body(&request)?;
    let (Some(root), Some(path)) = (header(&request, "root"), header(&request, "path")) else {
        return Err("the `root` and `path` headers must be set".to_owned());
    };
    let root = PathBuf::from(root);
    check(&picked.writable, &root)?;
    // A folder the user opened holds other files too.
    let attributes = path == format::git_attributes().0;
    let asset = format::is_asset_file(&path);
    if !(attributes || asset || format::is_board_file(&path)) {
        return Err(format!("`{path}` is not a file of a board"));
    }
    let stamp = || {
        let stamps = folder::stamps(&root, [path.as_str()]);
        stamps.map_err(|error| describe(&root, error))
    };
    // An asset never changes once named, and so is never written over.
    if asset && !stamp()?.is_empty() {
        return Ok(String::new());
    }
    folder::write(&root, &path, bytes).map_err(|error| describe(&root, error))?;
    // Its user's from then on, which the app never reads.
    if attributes {
        return Ok(String::new());
    }
    Ok(stamp()?
        .first()
        .map(|(_, stamp)| stamped(*stamp))
        .unwrap_or_default())
}

#[tauri::command(async)]
fn remove_file(picked: State<'_, Picked>, root: PathBuf, path: String) -> Result<(), String> {
    check(&picked.writable, &root)?;
    if !format::is_element_file(&path) {
        return Err(format!("`{path}` is not an element's file"));
    }
    folder::remove(&root, &path).map_err(|error| describe(&root, error))
}

/// The stamps of those of `paths` in `root`, which change whenever a program writes one.
#[tauri::command(async)]
fn stamp_files(
    picked: State<'_, Picked>,
    root: PathBuf,
    paths: Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    check(&picked.readable, &root)?;
    let stamps = folder::stamps(&root, paths.iter().map(String::as_str))
        .map_err(|error| describe(&root, error))?;
    Ok(stamps
        .into_iter()
        .map(|(path, stamp)| (path.to_owned(), stamped(stamp)))
        .collect())
}

fn stamped((size, modified): folder::Stamp) -> String {
    let since = modified.and_then(|modified| modified.duration_since(UNIX_EPOCH).ok());
    format!("{size}:{}", since.unwrap_or_default().as_nanos())
}

/// A board's ZIP file to read, and its size. `None` when the user cancels.
#[tauri::command(async)]
fn pick_zip(
    window: Window,
    picked: State<'_, Picked>,
    title: String,
) -> Result<Option<(PathBuf, u64)>, String> {
    let dialog = files(&window).set_title(title).add_filter("ZIP", &["zip"]);
    let Some(file) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let file = file.into_path().map_err(|error| error.to_string())?;
    let stamp = folder::stamp(&file).map_err(|error| describe(&file, error))?;
    picked.read_zip(&file, stamp);
    Ok(Some((file, stamp.0)))
}

/// The bytes from `start` to `end` of a picked ZIP file, raw. Refused once the file changed
/// since it was last read, such as by an export over it, since the web app located its entries
/// then.
#[tauri::command(async)]
fn read_zip(
    picked: State<'_, Picked>,
    path: PathBuf,
    start: u64,
    end: u64,
) -> Result<Response, String> {
    let read = zip(&picked, &path)?.read;
    folder::read_range(&path, start..end, read)
        .map(Response::new)
        .map_err(|error| describe(&path, error))
}

/// Whether another program changed the picked ZIP file since the board was read from it or
/// written to it.
#[tauri::command(async)]
fn zip_changed(picked: State<'_, Picked>, path: PathBuf) -> Result<bool, String> {
    changed(&picked, &path)
}

fn changed(picked: &Picked, path: &Path) -> Result<bool, String> {
    let board = zip(picked, path)?.board;
    Ok(folder::stamp(path).map_err(|error| describe(path, error))? != board)
}

/// Starts writing the picked ZIP file over, as [`pick_export`] starts an export, to finish with
/// [`finish_rewrite`]. `false`, and nothing started, when another program changed the file
/// since the board was read from it or written to it, unless `over`.
#[tauri::command(async)]
fn rewrite_zip(picked: State<'_, Picked>, path: PathBuf, over: bool) -> Result<bool, String> {
    if !over && changed(&picked, &path)? {
        return Ok(false);
    }
    start_export(&picked, &path)?;
    Ok(true)
}

/// Puts the rewritten ZIP file in place, which reads on, and returns its size. `None`, leaving
/// the file as it was, when another program changed it meanwhile, unless `over`.
#[tauri::command(async)]
fn finish_rewrite(
    picked: State<'_, Picked>,
    path: PathBuf,
    over: bool,
) -> Result<Option<u64>, String> {
    let draft = take_export(&picked, &path)?;
    if !over && changed(&picked, &path)? {
        draft.discard().map_err(|error| describe(&path, error))?;
        return Ok(None);
    }
    draft.commit().map_err(|error| describe(&path, error))?;
    let stamp = folder::stamp(&path).map_err(|error| describe(&path, error))?;
    let mut zips = picked.zips.lock().expect("never poisoned");
    zips.insert(path, Zip::new(stamp));
    Ok(Some(stamp.0))
}

/// Reads the picked ZIP file on as another program left it, and returns its size. The board
/// only matches it once [`adopt_zip`].
#[tauri::command(async)]
fn reread_zip(picked: State<'_, Picked>, path: PathBuf) -> Result<u64, String> {
    let stamp = folder::stamp(&path).map_err(|error| describe(&path, error))?;
    let mut zips = picked.zips.lock().expect("never poisoned");
    let zip = zips.get_mut(&path).ok_or_else(|| not_picked(&path))?;
    zip.read = stamp;
    Ok(stamp.0)
}

/// Once the board on screen was read from the picked ZIP file as last read.
#[tauri::command(async)]
fn adopt_zip(picked: State<'_, Picked>, path: PathBuf) -> Result<(), String> {
    let mut zips = picked.zips.lock().expect("never poisoned");
    let zip = zips.get_mut(&path).ok_or_else(|| not_picked(&path))?;
    zip.board = zip.read;
    Ok(())
}

fn zip(picked: &Picked, path: &Path) -> Result<Zip, String> {
    let zips = picked.zips.lock().expect("never poisoned");
    zips.get(path).copied().ok_or_else(|| not_picked(path))
}

/// A file to export a ZIP file or a PNG image to, suggested as `name`, which stays as it was
/// until [`finish_export`]. `None` when the user cancels.
#[tauri::command(async)]
fn pick_export(
    window: Window,
    picked: State<'_, Picked>,
    title: String,
    name: String,
    kind: String,
) -> Result<Option<PathBuf>, String> {
    let (filter, extension) = match kind.as_str() {
        "zip" => ("ZIP", "zip"),
        "png" => ("PNG image", "png"),
        other => return Err(format!("cannot export a file of kind {other}")),
    };
    let dialog = files(&window)
        .set_title(title)
        .set_file_name(name)
        .add_filter(filter, &[extension]);
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let file = file.into_path().map_err(|error| error.to_string())?;
    // Over the open board's own ZIP file, its next save finds it changed, and asks.
    start_export(&picked, &file)?;
    Ok(Some(file))
}

/// Refused while another draft of the file is under way, as both would write to the same
/// temporary file.
fn start_export(picked: &Picked, file: &Path) -> Result<(), String> {
    let mut exports = picked.exports.lock().expect("never poisoned");
    if exports.contains_key(file) {
        return Err(format!("{} is being written already", file.display()));
    }
    let draft = folder::Draft::create(file).map_err(|error| describe(file, error))?;
    exports.insert(file.to_owned(), draft);
    Ok(())
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

/// Where agents' calls go from now on, until the page reloads.
#[tauri::command]
fn agent_attach(agent: State<'_, Agent>, channel: Channel<mcp::Call>) {
    agent
        .bridge
        .attach(move |call| channel.send(call).map_err(|error| error.to_string()));
}

#[tauri::command(async)]
fn agent_reply(agent: State<'_, Agent>, reply: mcp::Reply) {
    agent.bridge.reply(reply);
}

/// Refused while another Planche has agent access on. A page asks again each time it starts, and
/// its reload must not cut the agents off, so on stays on.
#[tauri::command]
async fn agent_allow(app: AppHandle, agent: State<'_, Agent>, on: bool) -> Result<(), String> {
    let _turn = agent.turning.lock().await;
    if !on {
        agent.stop();
        return Ok(());
    }
    if agent.running.lock().expect("never poisoned").is_some() {
        return Ok(());
    }
    let directory = mcp::directory(&app.config().identifier).ok_or(NO_DIRECTORY)?;
    let running = mcp::start(&directory, agent.bridge.clone())
        .await
        .map_err(|error| error.to_string())?;
    *agent.running.lock().expect("never poisoned") = Some(running);
    Ok(())
}
