//! New versions of the app, which it checks for at launch and every day while the page lets it,
//! and installs in place once the user asks.

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tauri::async_runtime::{self, JoinHandle};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// How long a running app waits before it checks again, by the wall clock, as the runtime's own
/// stops while the computer sleeps.
const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// How often a running app reads the wall clock.
const HOUR: Duration = Duration::from_secs(60 * 60);
/// How long a request waits to connect, or for its next bytes, as one with no answer would hold
/// back the next checks, or leave a download under way for good.
const PATIENCE: Duration = Duration::from_secs(30);
const WITHDRAWN: &str = "it is no longer the latest release";
const NOTHING_DOWNLOADED: &str = "the new version is not downloaded yet";

#[derive(Default)]
pub struct Updates {
    checking: Mutex<Option<JoinHandle<()>>>,
    /// The newest version the last check that got an answer found, which only checks write.
    found: Mutex<Option<Update>>,
    /// A version downloaded, with its installer, which a check may have outdated since.
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
}

/// Checks at once, then every day, while `on`. A page asks again each time it starts, which
/// starts over.
#[tauri::command]
pub fn update_allow(app: AppHandle, updates: State<'_, Updates>, on: bool) {
    let mut checking = updates.checking.lock().expect("never poisoned");
    if let Some(task) = checking.take() {
        task.abort();
    }
    if on && installed(&app) {
        *checking = Some(async_runtime::spawn(async move {
            loop {
                check(&app).await;
                let checked = SystemTime::now();
                // An error is a clock set back, after which a check is due.
                while checked.elapsed().is_ok_and(|elapsed| elapsed < DAY) {
                    tokio::time::sleep(HOUR).await;
                }
            }
        }));
    }
}

/// Downloads `version`, the newest found. Refused once a check found another, so that what the
/// page names is what goes in place.
#[tauri::command]
pub async fn update_download(
    updates: State<'_, Updates>,
    version: String,
    progress: Channel<(u64, Option<u64>)>,
) -> Result<(), String> {
    let update = match &*updates.found.lock().expect("never poisoned") {
        Some(update) if update.version == version => update.clone(),
        Some(update) => return Err(format!("Planche {} came out meanwhile", update.version)),
        None => return Err(WITHDRAWN.into()),
    };
    // Not again, unless the release was signed anew since.
    if updates
        .downloaded
        .lock()
        .expect("never poisoned")
        .as_ref()
        .is_some_and(|(kept, _)| kept.version == version && kept.signature == update.signature)
    {
        return Ok(());
    }
    let mut done = 0;
    let mut told = 0;
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                // A message a chunk would be thousands of them.
                if done - told >= total.map_or(1 << 20, |total| total / 100) {
                    told = done;
                    // It only fails once the page is gone.
                    let _ = progress.send((done, total));
                }
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    *updates.downloaded.lock().expect("never poisoned") = Some((update, bytes));
    Ok(())
}

/// Puts `version`, once downloaded, in place and relaunches, once the page wrote what it held,
/// since a relaunch never asks it to. On Windows, its installer takes over and the app ends at
/// once.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    updates: State<'_, Updates>,
    version: String,
) -> Result<(), String> {
    let taken = {
        let mut downloaded = updates.downloaded.lock().expect("never poisoned");
        // Another may have ended last, after the page reloaded during a download.
        if downloaded
            .as_ref()
            .is_some_and(|(kept, _)| kept.version == version)
        {
            downloaded.take()
        } else {
            None
        }
    };
    let (update, installer) = taken.ok_or(NOTHING_DOWNLOADED)?;
    // Off the async runtime, as it may wait on the user typing a password.
    let installing = update.clone();
    let (installer, installed) = async_runtime::spawn_blocking(move || {
        let installed = installing.install(&installer);
        (installer, installed)
    })
    .await
    .map_err(|error| error.to_string())?;
    if let Err(error) = installed {
        // The download checked its signature, so another try only installs again, unless
        // another download ended meanwhile.
        updates
            .downloaded
            .lock()
            .expect("never poisoned")
            .get_or_insert((update, installer));
        return Err(error.to_string());
    }
    app.request_restart();
    Ok(())
}

/// Tells the page of a newer version. A failure says nothing, as every offline launch would fail,
/// and so would each release's first minutes, before its installers are up.
async fn check(app: &AppHandle) {
    let Ok(newer) = newer(app).await else {
        return;
    };
    let version = newer.as_ref().map(|update| update.version.clone());
    // None, once the latest release is this one again, as when a newer one was taken down.
    *app.state::<Updates>().found.lock().expect("never poisoned") = newer;
    if let Some(version) = version {
        // It only fails once the window is gone anyway.
        let _ = app.emit("update", (version, stuck()));
    }
}

async fn newer(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater_builder()
        .configure_client(|client| client.connect_timeout(PATIENCE).read_timeout(PATIENCE))
        // Only on Windows, where the app ends once its installer starts. Tauri's own cleanup hides
        // the window, which an installer that failed to start would leave hidden for good.
        .on_before_exit(|| {})
        .build()?
        .check()
        .await
}

/// Whether this copy is one an installer put in place, which the updater can replace. A build
/// run from the project is not, and the updater would replace its build folder.
fn installed(app: &AppHandle) -> bool {
    !tauri::is_dev() && bundled(app)
}

#[cfg(target_os = "macos")]
fn bundled(_app: &AppHandle) -> bool {
    std::env::current_exe().is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
}

#[cfg(target_os = "linux")]
fn bundled(app: &AppHandle) -> bool {
    use tauri::utils::config::BundleType;
    app.env().appimage.is_some()
        || matches!(tauri::utils::platform::bundle_type(), Some(BundleType::Deb))
}

#[cfg(windows)]
fn bundled(_app: &AppHandle) -> bool {
    use tauri::utils::config::BundleType;
    matches!(
        tauri::utils::platform::bundle_type(),
        Some(BundleType::Nsis)
    )
}

/// Why this copy cannot replace itself, if it cannot: macOS runs an app from its disk image, or
/// from where it was downloaded until the user moves it, read-only. The updater only finds out
/// once the download is done. A folder the user cannot write is no reason, as the updater then
/// asks for an administrator's password.
#[cfg(target_os = "macos")]
fn stuck() -> Option<&'static str> {
    use std::ffi::{CString, c_char, c_int};
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    // libSystem's, which every program links.
    unsafe extern "C" {
        fn access(path: *const c_char, mode: c_int) -> c_int;
    }
    /// `W_OK`, whether the caller may write.
    const WRITE: c_int = 2;
    let exe = std::env::current_exe().ok()?;
    let path = CString::new(exe.as_os_str().as_bytes()).ok()?;
    // SAFETY: `path` ends with a nul, and lives through the call.
    let read_only = unsafe { access(path.as_ptr(), WRITE) } != 0
        && io::Error::last_os_error().kind() == io::ErrorKind::ReadOnlyFilesystem;
    let translocated = exe.to_string_lossy().contains("/AppTranslocation/");
    (read_only || translocated).then_some("Move it to Applications to update it")
}

#[cfg(not(target_os = "macos"))]
fn stuck() -> Option<&'static str> {
    None
}
