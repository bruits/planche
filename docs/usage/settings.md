# Settings

The toolbar's menu holds the board's grid, the theme, the view, and the settings. In a browser, Get the desktop app opens its latest release, with the installers. Report a bug opens a bug report on GitHub, with the platform, the desktop app's version, the renderer, and the browser filled in. Preferences stay in the browser, or in the desktop app's webview, apart from any board. They do not travel with a board, and clearing the site's data resets them.

## Grid

No grid, Lines, or Dots. The grid is saved in the board. Snap to grid turns on whenever you choose a grid or open a board that has one. Snap to neighbours is remembered.

## Theme

Light, Dark, or System, and High contrast, which follows the system until you set it. Both are remembered.

## View

What the view does changes nothing on the board.

- Greyscale board and Mirror board show the board in grey or flipped left to right, to check values and composition.
- Annotations shows or hides notes, sticky notes, shapes, arrows, lines, strokes, and comments, to see the images bare. Hidden, they stay out of clicks, selections, the style card, and PNG exports, though a group moved, copied, or deleted takes its own along. They come back once you pick a tool that draws, or once a paste, an undo, a redo, or an agent adds or selects one. Agents still see them.
- Hints shows the line above the toolbar that says what a tool or gesture does.
- Measurements shows draws a second, memory in use, and how long the board took to read, and adds commands that fill a board kept in the session with test photos.
- Always on top keeps the desktop app's window above other apps. Wayland does not allow it.
- Compact mode hides the desktop app's title bar. Drag the window by its top edge, and leave the mode from the right-click menu.

Hints, Always on top, and the theme are remembered. Greyscale board, Mirror board, hidden annotations, Measurements, and Compact mode last until the window closes.

## Settings menu

- Play videos on hover, see [media](./media.md#playback).
- Keep style open keeps the style card up after a click on nothing, which otherwise closes it.
- Agent access, in the desktop app, lets agents read and edit the open board, see [agents](./agents.md).
- Open the error log, in the desktop app, opens the errors it recorded, to attach to a bug report. It is `errors.log` in the app's data folder, which moves to `errors.log.1` past 1 MB, so the log never takes more than 2 MB.

The first three are remembered.

## When something goes wrong

An unexpected error stays above the toolbar until dismissed. When Planche cannot go on, such as after losing the GPU, it greys out and offers to reload. Reload, ⌘R, and F5 save what they can first, and ask before losing anything. "Planche cannot draw on this device" means neither WebGPU nor WebGL2 started, which a reload may fix. Copy details copies the error, the browser, and the GPU, to paste into a bug report.
