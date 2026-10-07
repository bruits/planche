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

## When part of a board cannot be read

The rest of the board opens, and Planche says what it left out.

- A file in `elements/` that holds an unresolved Git conflict, is cut short, or holds a field Planche does not know is left out. Planche never writes over it or deletes it, and copies it as it is when you save the board as a folder or a ZIP file. What sticks to it or sits in it comes apart until you fix it, and Planche then reads it again. An element you edit meanwhile goes back too, unless you moved it off, grouped it, or stuck it elsewhere.
- A file in `elements/` that belongs to no element, such as a sync tool's conflicted copy, is left out too. Planche never deletes it from a folder, but a copy or a ZIP file goes without it.
- An image whose file is missing, or differs from the one the board recorded, shows crossed out, and Planche names it. A Git LFS pointer is the usual cause, see [Boards in Git](#boards-in-git). You can still move or edit the image, and saves go without the missing file. Once the file is right, the image shows again when the window comes back to the front, for a board that saves into its folder.

## Boards in Git

Images need [Git LFS](https://git-lfs.com/). Planche gives a board's folder a `.gitattributes` when it lacks one, and puts one in each ZIP file. It sends `assets/` to Git LFS and keeps Git from changing line endings. Planche never changes a `.gitattributes` that is there. A clone made without Git LFS holds small pointer files in place of the images, which show crossed out. Install Git LFS, then run `git lfs pull`. The images show again when the window comes back to the front, for a board that saves into its folder. Otherwise, open the board again.

Each element has its own file, so branches that edit different elements merge cleanly. Planche repairs what a merge can break, such as a group nested in itself or an arrow stuck to a deleted element, when it reads the board. The same board always writes the same bytes, so only real edits show up in a diff.

## ZIP files

Export a ZIP file to send a board as one file. It holds the board's files and the images the board shows.

Planche stores files in a ZIP uncompressed, since images are compressed already. A board unzipped then zipped again with another tool, such as Finder or Explorer, still opens, and Planche stores it uncompressed again when it next saves into it. Planche refuses an encrypted ZIP file, and a compressed file over 300 MB within one. Unzip it and open its folder.

## When a board does not open

The board that was open stays when the board picked cannot open.

- Its `board.json` is missing, holds an unresolved Git conflict or a field Planche does not know, or cannot be read.
- The board or the session was written by a newer version of Planche. A session Planche cannot read stays untouched until you open or start another board.
- A folder Planche cannot write to opens on desktop, and each save then fails and says why. In Chromium, refusing to let the page edit a folder cancels opening it.

## Limits

- Undo history lives in memory and goes when the board closes.
- Browser storage can be cleared by a browser short of space. Safari clears a site's storage after seven days without a visit, unless the web app is installed. Export boards you keep in Firefox or Safari.
