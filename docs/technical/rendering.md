# Rendering and images

## Renderer

**Decided:** wgpu, compiled to WASM (`crates/render-wgpu`) and driven by the web app, on WebGPU where the webview has it and on WebGL2 otherwise. The same code can later run natively, without a webview.

Why:

- The renderer is not the bottleneck. Every GPU candidate of the [bake-off](#bake-off) held 60 fps with 300 photos, and drawing took 0.1 to 1.5 ms of a 16.7 ms frame.
- wgpu is the WebGPU API in Rust. It implements WebGPU in Firefox and Servo, Mozilla engineers are among its main contributors, and Bevy and Zed build on it. On WebGPU it had the lowest drawing cost of the libraries tried: 0.2 ms for 300 images.
- It leaves a way out of the webview: native wgpu offers bindless textures and multi-draw, which the web does not.

What it costs:

- A breaking major release about every quarter, eight in two years.
- More code than PixiJS or Three.js: about 450 lines against 75 in the bake-off, since pipelines, bind groups, and mipmaps are explicit.
- On WebGL2, about six times the CPU cost of raw WebGL2: 1.3 ms against 0.1 ms for 300 images. Acceptable, but to watch on weak machines.

Rules:

- WebGL2 stays a first-class target. WebKitGTK, the Linux webview, has no WebGPU and none is announced.
- Request the adapter's limits (`Limits::using_resolution`), since the WebGL2 defaults cap textures at 2048 px.
- Uniform buffers are multiples of 16 bytes on WebGL2.
- Catch validation errors (`Device::on_uncaptured_error`) and hand them to the app: by default wgpu panics, which kills the WASM module.

Vello, for vector graphics, sits out for now: its GPU renderer is being rewritten (`vello_gpu`), and its image atlas cannot hold many photos. It may come back for notes and arrows.

## Image pipeline

**Decided direction, not built yet.** The image pipeline, not the renderer, sets performance. A 12 MP photo takes 48 MB once decoded, 64 MB with mipmaps, so 300 of them would need 19 GB. What sits on the GPU must follow what is on screen, whatever the number of photos.

- **Decoding in the browser,** in JS workers: `createImageBitmap(blob, { resizeWidth, resizeHeight, imageOrientation: "from-image" })`, then the `ImageBitmap` is transferred to the renderer. On a 12 MP JPEG it took 65 ms against 83 ms for Rust in WASM, it runs in parallel off the main thread, and it is the same code in every webview. The formats are those the platform decodes, so HEIC only on Apple platforms.
- **Residency in the Rust core,** without I/O: a planner turns the camera and the visible images into uploads and evictions within a memory budget. It keeps a coarse level of every image, never evicts what is on screen, and serves images by their size on screen, as WebRender and OpenSeadragon do. No crate does this; `lru` or `quick_cache` can serve as parts.
- **Levels of detail:** whole images at halving sizes, and mipmaps generated on the GPU with `wgpu::util::TextureBlitter` into `Rgba8UnormSrgb` textures, so that filtering happens in linear light. The prototype's `Rgba8Unorm` mipmaps darken detail when zoomed out.
- **Tiles** only past the texture limit, which is at least 16384 px on most devices. They are cut with a cropped `createImageBitmap`, since wgpu's WebGL2 backend only copies whole images.
- **Caches** of derived levels stay out of the board, which is the user's files: the app's cache folder on desktop, OPFS on the web, keyed by the asset's digest.

Later, only if measurements call for it:

- Native decoding on the desktop, in Rust with rayon, served to the webview through a custom protocol.
- Rust decoding in WASM for what the browser lacks: `image` (JPEG through zune-jpeg), `jxl` for JPEG XL, `moxcms` for colour profiles, and `fast_image_resize` for resizing. All are pure Rust and build for WASM, but several rest on a single maintainer.
- GPU texture compression with `block_compression`, BC1 to BC7 in WGSL, on WebGPU only. It divides memory by four, but encoding a photo took from 17 ms to 2 s natively on an M5 Pro, depending on quality.
- Rendering in a worker through `OffscreenCanvas`. Uploads take about 2 ms per photo, so this can wait.

Not viable today:

- WASM threads. They need nightly Rust and cross-origin isolation, which WKWebView may not grant under `tauri://`.
- A HEIC or AVIF decoder in Rust under a permissive licence.

## Bake-off

The web app races the candidates on the same images and along the same 10-second camera path: DOM, Canvas2D, raw WebGL2, PixiJS, Three.js, and wgpu, the last three on WebGL and WebGPU. Images are decoded the same way for all, with their longest side capped. The bench times delivered frames with `requestAnimationFrame` and the CPU time spent drawing. No timer sees the GPU on every platform. «Run all», then «Copy as Markdown», gives a table to add here.

**Still to measure:** Safari and the macOS app (WKWebView), Firefox, Windows (WebView2), and Linux (WebKitGTK), on modest GPUs. Once these runs are in, the other candidates can go.

**macOS, headless Chrome 154, Apple M5 Pro.** Viewport 951×777 at 2×, photos of 4000×3000 capped at 2048 px, paced runs:

| Renderer | 100 photos: p99, slow frames | 300 photos: p99, slow frames | Upload, 100 / 300 photos |
| --- | --- | --- | --- |
| DOM | 16.8 ms, 0 % | 16.8 ms, 0 % | at paint |
| Canvas2D | 16.8 ms, 0.2 % | 466.7 ms, 3.3 % | at paint |
| WebGL2 | 16.8 ms, 0 % | 16.8 ms, 0 % | 273 / 861 ms |
| PixiJS, WebGL | 16.8 ms, 0 % | 16.8 ms, 0 % | 236 / 691 ms |
| PixiJS, WebGPU | 16.8 ms, 0 % | 16.8 ms, 0 % | 100 / 264 ms |
| Three.js, WebGL | 16.8 ms, 0 % | 16.8 ms, 0 % | 233 / 761 ms |
| Three.js, WebGPU | 16.8 ms, 0 % | 16.8 ms, 0 % | 89 / 231 ms |
| wgpu, WebGL2 | 16.8 ms, 0 % | 16.8 ms, 0 % | 200 / 518 ms |
| wgpu, WebGPU | 16.8 ms, 0 % | 16.8 ms, 0 % | 108 / 255 ms |

This machine cannot tell the GPU candidates apart. Decoding, the same for all, took 3.7 s for 100 photos and 11 s for 300.
