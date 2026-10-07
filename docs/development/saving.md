# Saving

How a board saves itself. What users see of it is in [boards](../usage/boards.md).

## When

A board saves a second after the last edit, or ten seconds after the first while edits go on. A ZIP file is rewritten whole, so it waits ten seconds after the last edit. Losing focus, hiding, closing, and an explicit Save write at once. An edit made during a save counts as made at its end, so saves never chain while you work. Leaving a board writes until nothing waits, once the images still being read are in, and asks only when it cannot.

## Where

The session is OPFS in a browser and the app's data folder on desktop. One window holds it at a time, through a Web Lock or a lock file, and only that window decides what the next launch reopens. On desktop the page reaches only paths the user picked, so the shell remembers the last board's path and grants it again at launch.

In a folder the user opened, the shell writes only a board's files, deletes only element files, and never overwrites an asset. It never writes over or deletes an element file the board left out, and copies those files into a folder that lacks them. A save goes without the assets the folder lacked when the board opened. Its first save adds the board's `.gitattributes` when the folder lacks one, and never touches one there. A session gets none.

## How

`crates/format/src/save.rs` plans each save. It writes only the files whose bytes differ from what the app last read or wrote. New assets go first, then element files, then `board.json`, which comes before the elements when the folder has none yet. Files of removed elements go last, and only those the app knew. Each step lands before the next starts. On desktop, its files are flushed to the drive together before any takes its place. A save cut at any point leaves whole files that `Board::repair` heals on read, so there is no journal.

A ZIP file holds only the assets the board shows. Before a rewrite, and before Save as leaves a folder or the session, the app keeps in memory the assets that undo may bring back, and writes each one again once an image shows it.

## Changes from other programs

Before writing a file, and when the window comes back to the front, the app compares its size and modification time with what it last saw, then its bytes if those differ. A folder watcher would miss changes on Windows and on network drives. A ZIP file is compared by size and modification time alone. The shell tracks the version the page reads from apart from the one the board shows, so a file read again but not shown yet still counts as changed.

## Limits

- A power cut may lose the last renames, as the folder itself is not flushed.
- In a browser, each file takes its place once written, and the browser decides when it reaches the drive.
- Where a browser lacks Web Locks, two windows may both hold the session.
