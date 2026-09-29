# Technical foundation

Tracks to be validated by a prototype, not decisions yet. Once the prototype settles one, it becomes a rule here, and this document becomes the single source of truth for the architecture.

## Constraints

- Mostly Rust, with a thin presentation layer in another language.
- Tauri 2 is the current preference for the shell. The canvas will probably be custom-built, in Rust or TypeScript.
- Browser, Windows, macOS, and Linux first; iOS and Android later, but planned for from the start.

## Tracks

### Shell

Tauri 2 around an independent Rust core, built both natively and to WASM for the web.

- **Limits:** WebKitGTK is slow on Linux, and Tauri's Chromium runtime (CEF) is still experimental. Mobile is less mature (e.g. the clipboard only handles text). Window transparency on macOS rules out the App Store. And Tauri does not target the browser, hence a platform abstraction layer.
- **Alternatives:** wgpu and winit, without a webview, at the cost of handling text, IME, and accessibility ourselves. Dioxus has the same webview limits. Slint and Makepad fit this case less well.

### Canvas rendering

wgpu in Rust compiled to WASM, on WebGL2, with WebGPU only as a bonus. Images are drawn with mipmaps and tiles, Vello draws vectors, and a DOM layer edits text.

- **Limits:** Vello Hybrid is in beta, and the upfront investment is heavy.
- **Alternatives:** Canvas2D and Rough.js, Excalidraw's approach: simpler, but in TypeScript and slower with many large images. Or PixiJS.

### File format

A folder of deterministic JSON files, one per element, with images named by their SHA-256 digest. It is the source of truth for Git; a single-file export would be a ZIP of that folder. `crates/format` implements this track, so the core has something to test, but it is as open as the others.

- **Limits:** not a single file day to day. Images need Git LFS, and ideally a dedicated merge driver.
- **Alternatives:** SQLite, robust and single-file as in BeeRef, but opaque and impossible to merge in Git. A single JSON with base64 images, like `.excalidraw`, is heavy and makes useless diffs. JSON Canvas (Obsidian's format) is too poor as a native format, but useful for import and export.

### Sync

A Loro CRDT, whose movable tree maps well to groups. A Phoenix (Channels and Presence) or Axum server, and S3 storage for images.

- **Limits:** Loro is young, with a small community. Reconciling the CRDT with Git is ours to design.
- **Alternatives:** Automerge 3, with a mature sync ecosystem, or Yjs/Yrs, the most proven, but without a native movable tree.

### MCP

rmcp, the official SDK. On desktop, a stdio gateway and a local HTTP server protected by a token. On the web, a remote MCP through the cloud.

- **Limits:** WebMCP is only a draft, so nothing should depend on it. Image content is a prompt injection risk.

### Plugins

WebAssembly components described in WIT (wasmtime on desktop, jco in the browser).

- **Limits:** iOS needs the Pulley interpreter for lack of JIT, about ten times slower.
- **Alternatives:** Extism, simpler to set up. A JavaScript sandbox, on Figma's model. Or Lua/Rhai.

### Licence

MIT/Apache for the client and the format, AGPL for the sync server. The niche seems open: PureRef is closed-source, and BeeRef has not shipped a release since May 2024.

## Main risk

Canvas performance in webviews, especially on Linux and iPad. A 4 to 6 week prototype should settle it before committing to Tauri.
