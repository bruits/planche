# Saving

How a board saves itself, why it does it this way, and where it stops. The [foundation](./foundation.md) decides the file format; this is how the shells keep it on disk.

## Behaviour

- **Mostly automatic.** A board saves itself a second after the last change, at the latest ten seconds into a long stretch of edits, and at once when its window loses focus, hides, or closes. Agents' edits save like the user's. Closing the app first writes what waits, and only asks when a save failed.
- **The session.** A board with no folder or ZIP file of its own lives in the app's session: a new one, one opened in Firefox or Safari, or one opened from a ZIP file in a browser. The session is the browser's private file system for the site, or the app's data folder on desktop. The next launch reopens it as it was left. Opening or creating another board asks first while it holds changes saved nowhere else, until it is saved as a folder or exported as a ZIP file.
- **Its own files.** A board opened from a folder, or saved as one, saves itself there, and so does a ZIP file opened on desktop, written whole ten seconds after the last change. The next launch reopens it. In a browser, only Chromium writes to a folder, and after it restarts, a click lets the page write there again, unless the user allowed it on every visit.
- **Only what changed.** A save writes new images first, then the element files whose bytes changed, then `board.json` when the background did, or before them in a folder that has none yet, and last deletes the files of elements gone, only those the app read or wrote, never one another program added.
- **Another program's changes.** Before writing a file, and when its window comes back, the app checks whether another program changed the board, such as `git pull`. A board with no changes of its own reads again, keeping the camera; otherwise the user chooses between reading it again, losing the changes, and writing them over it.
- **Conflicted copies.** A `.json` file in `elements/` that no element owns, such as a sync tool's conflicted copy, is left out with a warning, and never deleted.

## Choices

- **No journal.** Cut at any point, a save in that order leaves whole files, old or new, and the images they draw, which read back as a board once `Board::repair` heals it, as it does a Git merge. Systems offer no transaction across files anyway.
- **Only what changed.** Each file is flushed to the drive, about 4 ms on a Mac, so the few files an edit touches save in under 40 ms, where a 1,000-element board written whole takes 4.5 s. The core plans each save from the elements touched since the last one and the bytes it last read or wrote, so that touching an element and putting it back writes nothing (`crates/format/src/save.rs`).
- **Checked, not watched.** A file's size and modification time, then its bytes, tell whether another program changed it, as in VS Code, and a ZIP file's size and modification time alone. Watching the folder misses changes on Windows and on network drives.
- **The shell grants.** On desktop, the page cannot reach a folder unless the user picked it, so the shell remembers the last board's path in the app's data folder and grants it again at launch. In a folder the user opened, it only writes a board's files, and only deletes element files.
- **One window holds the session**, through a lock file on desktop and a Web Lock in a browser, and alone decides what the next launch opens. Another one keeps no board for next time.

## Limits

- **Firefox and Safari** cannot write to the user's disk, so their boards live in the session, and leave it as an exported ZIP file, a new file each time. Safari deletes a site's storage after seven days without a visit, unless the web app is installed.
- **Browser storage** is best effort: the app asks to keep it, which Firefox asks the user about, but a browser short of space may still clear it. A ZIP file or a folder opened there is copied into it, images included.
- **A folder the app may not write to**: in Chromium, refusing to let the page edit it opens nothing, as a cancel does; on desktop, the board opens there, each save fails with its reason, closing or leaving asks first, and Save as moves it elsewhere.
- **A session that cannot be read**, such as one a newer version wrote, is left as it was, and the window keeps no board meanwhile. Nothing offers to throw it away yet.
- **A power cut**, unlike a crash, may lose the last renames, as the folder itself is not flushed.
- **Undo** lives in memory: once saved, an edit only goes back through undo while the app runs, or through Git.
- **Untested** on Windows and Linux, where a rename that another program blocks is tried again five times, and Chromium may write many small files slowly.
