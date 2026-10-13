# Planche

## 0.4.0 — 2026-10-13

### Minor changes

- [edfb484](https://github.com/bruits/planche/commit/edfb484d53694a8f5d109bd057b8b1161c40c41b) Added curved arrows and lines. Drag the handle in the middle of one to bend it. — Thanks @goulvenclech!

## 0.3.0 — 2026-10-12

### Minor changes

- [404d4b3](https://github.com/bruits/planche/commit/404d4b3bd04d10b8bb4dd91d578ea7b0ae3fcb37) Added updates to the desktop app, which now lets you know when a new version is out, and installs it in one click 🎉 You can turn this off in Settings whenever you like. — Thanks @goulvenclech!
- [28b7b5f](https://github.com/bruits/planche/commit/28b7b5f45079054b7b2bcca93b268767fc55388d) Added Report a bug to the menu. It opens a bug report on GitHub, with the platform, the desktop app's version, the renderer, and the browser filled in. — Thanks @goulvenclech!
- [8cb51b1](https://github.com/bruits/planche/commit/8cb51b1247fbef2f71458c77557f2caf586108e1) Added error messages with details to copy for a bug report, and an error log in the desktop app's settings. When Planche cannot go on, such as after losing the GPU, it says so and offers to reload, saving what it can first. — Thanks @goulvenclech!

### Patch changes

- [3ddd5e2](https://github.com/bruits/planche/commit/3ddd5e2884c21d8db355905be6a0086ba94ddcc7) Improved panning, zooming, and dragging on large boards, which do less work at each frame. — Thanks @goulvenclech!
- [92fcabc](https://github.com/bruits/planche/commit/92fcabc2901d3af0d11860b8e22e6f56ec19e23a) Fixed the hint above the toolbar flickering between two buttons, and a style card above the toolbar bouncing while hovered with hints turned off. — Thanks @goulvenclech!
- [0c0e78e](https://github.com/bruits/planche/commit/0c0e78e02d89676b2e922ca40e1293eb733635ea) Fixed macOS blocking the desktop app. — Thanks @goulvenclech!

## 0.2.0 — 2026-10-10

### Minor changes

- [8079cf0](https://github.com/bruits/planche/commit/8079cf03498567503398e28c94a62cac4c46417b) Added a friendly welcome over an empty board, which says how to start and points to the tools, until your first edit. — Thanks @goulvenclech!
- [c2e584f](https://github.com/bruits/planche/commit/c2e584fe5d10f98621681ce6dfab886a6febdfaa) Added panning and zooming with two fingers on touch screens. A second finger takes back what the first one started, such as a move or a marquee. — Thanks @goulvenclech!
- [02b0a3c](https://github.com/bruits/planche/commit/02b0a3c845ea9fe5245ad0ef634ae7478b8e5ad3) Changed a double-click on an image, a stroke, an arrow, or a line to zoom to it, and another to go back. ↩ still crops an image. — Thanks @goulvenclech!
- [1533ced](https://github.com/bruits/planche/commit/1533ced15a7e8280a93d1fdbcd606d198ffe5cef) Added Get the desktop app to the web app's menu. It opens the latest release, with the installers. — Thanks @goulvenclech!

### Patch changes

- [02b0a3c](https://github.com/bruits/planche/commit/02b0a3c845ea9fe5245ad0ef634ae7478b8e5ad3) Changed the pipette to hide the outline of the selection while it picks a colour, as the style card does. — Thanks @goulvenclech!
- [c2e584f](https://github.com/bruits/planche/commit/c2e584fe5d10f98621681ce6dfab886a6febdfaa) Fixed panning with the middle button or the hand tool, which drifted from the pointer in Chromium browsers when the page was zoomed in or out. — Thanks @goulvenclech!
- [c2e584f](https://github.com/bruits/planche/commit/c2e584fe5d10f98621681ce6dfab886a6febdfaa) Changed zooming by scrolling with ⌘ or Ctrl held to go by a tenth at most for each notch of a mouse wheel, instead of more than a quarter. Pinching a trackpad still follows the fingers, unless very quick. — Thanks @goulvenclech!
- [02b0a3c](https://github.com/bruits/planche/commit/02b0a3c845ea9fe5245ad0ef634ae7478b8e5ad3) Fixed turning from just outside a corner of the selection, which an element beneath it took over. — Thanks @goulvenclech!
- [02b0a3c](https://github.com/bruits/planche/commit/02b0a3c845ea9fe5245ad0ef634ae7478b8e5ad3) Changed trimming a video or an animated image to show again the frame shown before once an end is let go, unless trimmed away, and to stay on it once done. — Thanks @goulvenclech!

## 0.1.0 — 2026-10-08

### Minor changes

- [3c01e3c](https://github.com/bruits/planche/commit/3c01e3c55e03dee00846e5c5cc2c98142b67daf5) Initial release of Planche 🎉 a board of images, notes, shapes, drawings, and comments, saved as a folder of plain files, in browsers and as a desktop app. — Thanks @goulvenclech!

