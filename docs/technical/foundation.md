# Technical foundation

What is decided, what is still being explored, and why. A track becomes a decision once the prototype has measured it; decisions are rules for the code, and nothing is frozen until a release.

## Decided

- **Stack.** Mostly Rust, with a thin presentation layer: one web app in TypeScript, without a framework, runs the Rust core as WASM in the browser and in the desktop shell's webview.
- **Platforms.** The browser, Windows, macOS, and Linux first. iOS and Android come later, but the design must not rule them out.
- **Rendering.** wgpu, on WebGPU where the webview has it and on WebGL2 otherwise. See [rendering](./rendering.md).
- **Image pipeline.** The browser decodes, and the Rust core decides what stays on the GPU. See [rendering](./rendering.md#image-pipeline).
- **File format.** A folder of deterministic JSON files, one per element, with images named by their SHA-256 digest (`crates/format`). A single-file export is a ZIP of that folder. Images need Git LFS. SQLite (as in BeeRef) was rejected because Git cannot merge it, and a single JSON with base64 images (as in `.excalidraw`) because it is heavy and its diffs are useless. JSON Canvas is too poor as a native format, but fits import and export.
- **Licence.** MIT or Apache-2.0 for the client and the format. The sync server, if there is one, will be AGPL.

## Tracks

Current preferences, not decisions yet.

### Shell

Tauri 2 around the web app, with the system webview.

- **Limits:** WebKitGTK is slow on Linux, has no WebGPU, and may fall back to software WebGL without saying so. Tauri's Chromium runtime (CEF) is still an alpha. The clipboard handles only text on mobile. Transparent windows are buggy on every desktop platform.
- **Alternatives:** wgpu and winit without a webview, at the cost of handling text, IME, and accessibility ourselves; since the renderer is wgpu, this stays open if webviews fall short. Dioxus shares the webview limits, and Slint and Makepad fit this case less well.

### Sync

A Loro CRDT, whose movable tree maps well to groups. A Phoenix or Axum server, and S3 storage for images.

- **Limits:** Loro is young, and reconciling the CRDT with Git is ours to design. Loro needs randomness and a clock, so it must live outside `board` and `format`.
- **Alternatives:** Automerge 3, or Yjs/Yrs, the most proven but without a native movable tree.

### MCP

rmcp, the official SDK. On desktop, a stdio gateway and a local HTTP server protected by a token. On the web, a remote MCP through the cloud.

- **Limits:** WebMCP is only a draft, so nothing should depend on it. Image content is a prompt injection risk.

### Plugins

WebAssembly components described in WIT: wasmtime on desktop, jco in the browser.

- **Limits:** iOS has no JIT, so it needs the Pulley interpreter, about ten times slower.
- **Alternatives:** Extism, simpler to set up; a JavaScript sandbox, as Figma does; or Lua/Rhai.

## Main risk

Canvas performance in webviews, above all WebKitGTK on Linux and WebKit on iPad. The renderer bake-off measures it; the runs on real devices are still to come ([rendering](./rendering.md#bake-off)).
