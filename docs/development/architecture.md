# Architecture

Planche is a Rust core behind one web app. The core holds the board, its edits, and its files. The web app, in TypeScript without a framework, runs the core as WASM and holds the interface, gestures, playback, and the I/O through the shells. It runs in browsers and in the desktop app's webview, so every platform shares the same code.

The browser, Windows, macOS, and Linux come first. iOS and Android come later, and nothing should rule them out.

The client and the file format are under MIT or Apache-2.0. A sync server, if there is one, will be under AGPL.

## The core runs everywhere

`board` and `format` build for `wasm32-unknown-unknown`. They do no I/O and read no clock or randomness source. The shells pass those in, such as the bits of a new element id. `just wasm` checks it.

## Shell

Tauri 2 around the web app, with the system webview, in `crates/desktop`. WebKitGTK is slow on Linux, has no WebGPU, and may fall back to software WebGL without saying so. Tauri's Chromium runtime is still an alpha. Tauri's clipboard handles only text on mobile, and its transparent windows are buggy on every desktop platform.

## Agents

An MCP server on rmcp in the desktop app, see [agents](./agents.md). The web app has none yet. It would need a remote MCP through the cloud, and WebMCP is only a draft, so nothing should depend on it.

## Tracks

A track is the current answer to a question still open. The prototype may build on one to measure it, as long as the core never depends on it and it can be dropped if it loses. A track becomes a rule in these docs once measured.

### Sync

Not started. The candidate is a Loro CRDT, whose movable tree maps well to groups, with a Phoenix or Axum server and S3 storage for images. Loro is young, and reconciling a CRDT with Git is ours to design. Loro needs randomness and a clock, so it must live outside `board` and `format`. Automerge 3 is the alternative, and Yjs or Yrs the most proven, though without a native movable tree.

### Plugins

Not started. The candidate is WebAssembly components described in WIT, run by wasmtime on desktop and jco in the browser. iOS has no JIT, so it would need the Pulley interpreter, about ten times slower. Extism is simpler to set up, and a JavaScript sandbox or Lua and Rhai remain options.

## Not measured yet

Canvas performance in webviews is the main risk, above all WebKitGTK on Linux and WebKit on iPad. Most measurements so far ran in Chromium on an Apple M5 Pro, and a few on WKWebView test pages on macOS 26. These are still to measure, on modest GPUs too.

- Safari, Firefox, WebView2, WebKitGTK, and the desktop app's own WKWebView.
- Text line breaks and SVG sizes in WebKitGTK.
- Animated images and videos anywhere but Chromium.

The Measurements view shows draws a second, memory, and read times, and its test photos fill a board with large images. `just bench` times the core compiled to WASM. The renderer bake-off and its bench live at commit `ac764a9`.
