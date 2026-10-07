# Boards

A board is a folder of plain files. Planche saves it as you go, a moment after each edit and at once when its window loses focus or closes. Agents' edits save the same way.

## Where a board saves

| | Desktop app | Chrome, Edge, and other Chromium browsers | Firefox and Safari |
| --- | --- | --- | --- |
| Opened from a folder | Into the folder | Into the folder | In the session |
| Opened from a ZIP file | Into the ZIP file | In the session | In the session |
| Save as | Into an empty folder | Into an empty folder | Unavailable, Save exports a ZIP file |

A new board lives in the session too. The session is the browser's storage for the site, or the app's data folder on desktop. Planche reopens it at the next launch and asks before you leave a board kept only there. Save it as a folder or export a ZIP file to keep it for good.

At launch, Planche reopens the board you left. Chromium browsers forget their right to write to a folder when they restart, so Planche waits for a click before opening it again, unless you let the site edit files on every visit.

Only one window holds the session. A second window says it keeps no board for next time, so save what it shows before closing it.

## When another program changes a board

Planche notices when `git pull`, a sync tool, or another program changed the board's files, before each save and when its window comes back to the front. With no unsaved edits, it reads the board again and keeps your view. Otherwise it asks whether to read it again or keep your edits, which then overwrite the other program's changes.

A file in `elements/` that belongs to no element, such as a sync tool's conflicted copy, is left out with a warning. Planche never deletes it.

## Boards in Git

Images need [Git LFS](https://git-lfs.com/). A new board writes a `.gitattributes` that sends `assets/` to Git LFS and keeps Git from changing line endings. A clone made without Git LFS holds small pointer files in place of the images, and Planche refuses to open it. Install Git LFS, then run `git lfs pull`.

Each element has its own file, so branches that edit different elements merge cleanly. Planche repairs what a merge can break, such as a group nested in itself or an arrow stuck to a deleted element, when it reads the board. The same board always writes the same bytes, so only real edits show up in a diff.

## ZIP files

Export a ZIP file to send a board as one file. It holds the board's files and the images the board shows.

Planche stores files in a ZIP uncompressed, since images are compressed already. It refuses a ZIP file that another tool compressed. Unzip it and open its folder. A board's ZIP file holds 65,534 files and 4 GiB at most.

## When a board does not open

- An image is missing. The board that was open stays.
- An image's file differs from the one the board recorded, which Planche finds out as it shows the board. A Git LFS pointer is the usual cause, see [Boards in Git](#boards-in-git). The board that was open is gone by then, so a new one takes its place.
- The board or the session was written by a newer version of Planche. A session Planche cannot read stays untouched until you open or start another board.
- A folder Planche cannot write to opens on desktop, and each save then fails and says why. In Chromium, refusing to let the page edit a folder cancels opening it.

## Limits

- Undo history lives in memory and goes when the board closes.
- Browser storage can be cleared by a browser short of space. Safari clears a site's storage after seven days without a visit, unless the web app is installed. Export boards you keep in Firefox or Safari.
