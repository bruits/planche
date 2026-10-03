# Saving

## Behaviour

A board saves itself shortly after each edit, and at once when its window loses focus, hides, or closes. Agents' edits save the same way. Closing the app first writes what waits, and asks when it cannot.

A board opened from a folder, or saved as one, saves into that folder, and a ZIP file opened on desktop saves into that file. In a browser only Chromium can write to a folder, and after the browser restarts the user clicks once before the page may write there again, unless they allowed it on every visit. Any other board lives in the session, such as a new board, or one opened in Firefox, in Safari, or from a ZIP file in a browser, which is copied into it. The next launch reopens the board or the session as it was left. Leaving a board kept only in the session asks first, until it is saved as a folder or exported as a ZIP file. A session the app cannot read, such as one written by a newer version, stays untouched until the user opens or starts another board.

When another program such as `git pull` changes the board, a board without unsaved changes of its own reads the new version and keeps its camera. Otherwise the user chooses between reading it again and keeping their changes, which then overwrite the other program's. A `.json` file in `elements/` that no element owns, such as a sync tool's conflicted copy, is left out with a warning.

## How it works

The session is the browser's private storage for the site, or the app's data folder on desktop. One window at a time holds it, through a Web Lock or a lock file, and only that window decides what the next launch reopens. On desktop the page can only reach paths the user picked, so the shell remembers the last board's path itself and grants it again at launch. In a folder the user opened, the shell writes only a board's files, deletes only element files, and never overwrites an asset.

A save writes only the files whose bytes differ from what the app last read or wrote, as each one is flushed to the drive. New assets go first, then element files, then `board.json`, unless the folder has none yet, when it comes before the elements. The files of removed elements are deleted last, and only those the app knew. A save cut at any point leaves whole files that read back once `Board::repair` heals them, so there is no journal. The core plans each save in `crates/format/src/save.rs`, and a ZIP file is rewritten whole, so it waits longer after an edit. An edit made during a save waits as if made at its end, so that saves do not follow one another while edits go on.

Before writing a file, and when the window comes back to the front, the app compares its size and modification time with what it last saw, then its bytes if those differ. A folder watcher would miss changes on Windows and on network drives. A ZIP file is compared by size and modification time alone, and the shell tracks the version the page reads from apart from the one the board shows, so a file read again but not yet shown still counts as changed.

## Limits

- Firefox and Safari cannot write to the user's disk, so their boards leave the session only as exported ZIP files. Safari clears a site's storage after seven days without a visit, unless the web app is installed.
- Browser storage is best effort, and a browser short of space may clear it.
- In Chromium, refusing to let the page edit a folder cancels opening it. On desktop, a folder the app cannot write to opens, and each save fails and says why.
- A power cut may lose the last renames, as the folder itself is not flushed.
- Undo lives in memory only.
