# Technical foundation

What is decided, what is still being explored, and why. A track becomes a decision once the prototype has measured it; decisions are rules for the code, and nothing is frozen until a release.

## Decided

- **Stack.** Mostly Rust, with a thin presentation layer: one web app in TypeScript, without a framework, runs the Rust core as WASM in the browser and in the desktop shell's webview.
- **Platforms.** The browser, Windows, macOS, and Linux first. iOS and Android come later, but the design must not rule them out.
- **File format.** A folder of deterministic JSON files, one per element, with images named by their SHA-256 digest (`crates/format`). A single-file export is a ZIP of that folder, holding the board's files and the images it draws: stored rather than deflated, since images are compressed already, dated 1980-01-01, and never ZIP64, so that the same board gives the same bytes and a shell reads an image straight out of it. A ZIP file that another tool compressed is refused rather than inflated. Images need Git LFS. SQLite (as in BeeRef) was rejected because Git cannot merge it, and a single JSON with base64 images (as in `.excalidraw`) because it is heavy and its diffs are useless. JSON Canvas is too poor as a native format, but fits import and export.
- **Licence.** MIT or Apache-2.0 for the client and the format. The sync server, if there is one, will be AGPL.

### Rendering

wgpu, compiled to WASM (`crates/renderer`) and driven by the web app, on WebGPU where the webview has it and on WebGL2 otherwise. A bake-off against DOM, Canvas2D, raw WebGL2, PixiJS, and Three.js (its bench and results are at commit `ac764a9`) found that the renderer is not the bottleneck: every GPU candidate held 60 fps with 300 photos. wgpu is the WebGPU API in Rust, drew at the lowest cost on WebGPU, and can later run natively, without a webview. It costs a breaking release about every quarter, and on WebGL2 about six times the CPU time of raw WebGL2: 1.3 ms against 0.1 ms per frame for 300 images.

- Everything a board holds draws on the GPU, in one list back to front, so that it stacks as its z-indices say: images as textured quads, strokes and fills as quads whose fragments measure how far they are from the shape in device pixels, which smooths edges without multisampling, and text as a texture of its coverage, tinted with its colour. The DOM only holds the field that text is written in.
- Text is laid out and rasterised by the host, which holds the font: Inter, bundled, so that it wraps alike wherever it opens. It breaks where the field it is written in breaks (`white-space: pre-wrap`), which the app follows by rule rather than by asking the engine: the line counts matched in Chromium and WKWebView but for CJK, which Inter lacks, tabs, and words too long for a line. WebKitGTK is not measured yet.
- Each text has a texture of its own, at the zoom it shows at rounded up to a power of two, at most 2048 px a side, and at 8 px per font size once out of view. A texture replaced is destroyed (`Texture::destroy`), since dropping one frees nothing on WebGPU. Zooming in and out over the demo board, and editing and undoing its text, over and over, left texture memory where it started, on WebGPU and WebGL2 in Chromium.
- WebGL2 stays a first-class target: WebKitGTK, the Linux webview, has no WebGPU.
- Request the adapter's limits (`Limits::using_resolution`), since WebGL2's defaults cap textures at 2048 px.
- Uniform buffers are multiples of 16 bytes on WebGL2.
- Catch validation errors (`Device::on_uncaptured_error`) and hand them to the app: by default wgpu panics, which kills the WASM module.
- Vello stays out for now: its GPU renderer is being rewritten, and its image atlas cannot hold many photos. It may come back if text or strokes outgrow the above.

### Image pipeline

The direction is decided, and nothing of it is built yet. The pipeline, not the renderer, sets performance: a 12 MP photo takes 48 MB once decoded, so what sits on the GPU must follow what is on screen, whatever the number of photos.

- **Decoding** happens in the browser, off the main thread, with `createImageBitmap` (resized, `imageOrientation: "from-image"`). It beat Rust in WASM, 65 ms against 83 ms for 12 MP, and is the same code in every webview. The formats are the platform's, so HEIC only on Apple platforms.
- **Residency** is planned by the Rust core, without I/O: from the camera and the visible images, it gives uploads and evictions within a memory budget. It keeps a coarse level of every image, never evicts what is on screen, and serves each image at its size on screen. No crate does this; `lru` or `quick_cache` can serve as parts.
- **Levels of detail** are whole images at halving sizes, with mipmaps generated on the GPU (`wgpu::util::TextureBlitter`) into `Rgba8UnormSrgb` textures, drawn to an sRGB surface format or view, so that filtering happens in linear light. The current `Rgba8Unorm` mipmaps darken detail when zoomed out.
- **Tiles** only past the texture limit, cut with a cropped `createImageBitmap`, since wgpu's WebGL2 backend only copies whole images.
- **Caches** of derived levels stay out of the board: the app's cache folder on desktop, OPFS on the web, keyed by the asset's digest.

Later, only if measurements call for it: native decoding on desktop, Rust decoders in WASM for what browsers lack (`jxl`, `moxcms`), GPU texture compression (WebGPU only), and rendering in a worker. Not viable today: WASM threads, which need nightly Rust and a cross-origin isolation that WKWebView may not grant under `tauri://`, and a HEIC or AVIF decoder in Rust under a permissive licence.

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

Canvas performance in webviews, above all WebKitGTK on Linux and WebKit on iPad. The bake-off only ran in headless Chrome on an Apple M5 Pro. Safari and WKWebView, Firefox, WebView2, and WebKitGTK, on modest GPUs, are still to run, with the bench at `ac764a9`.
