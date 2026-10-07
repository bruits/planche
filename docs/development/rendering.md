# Rendering

`crates/renderer` draws the board with wgpu compiled to WASM, on WebGPU where the webview has it and on WebGL2 otherwise. The web app drives it.

A bake-off against the DOM, Canvas2D, raw WebGL2, PixiJS, and Three.js found that the renderer is not the bottleneck, as every GPU candidate held 60 fps with 300 photos. wgpu drew at the lowest cost on WebGPU and can later run without a webview. It costs a breaking release about every quarter, and on WebGL2 about six times the CPU time of raw WebGL2, 1.3 ms against 0.1 ms a frame for 300 images. Vello is out, as its image atlas cannot hold many photos. The intention is to look at it again if text or strokes outgrow what follows.

## What draws where

Everything on the board draws on the GPU, in one list back to front that the core compiles. Images are textured quads. Strokes and fills are quads whose fragments measure their distance to the shape in device pixels, which smooths edges without multisampling. Text and SVGs are textures the web app rasterises. The page itself holds only what lies over the board, such as the selection's outlines and handles, the field where text is written, and comments' pins.

The core compiles each element's draw items from that element alone, and the web app keeps them until an edit touches the element or its assets change. A group's panel follows its elements, so an edit to one also drops what the groups holding it drew. Groups' titles lie over the board with the comments' pins, at one size on screen. Compiling the whole board at each step of a drag would cost 4.8 ms at 3,000 elements, against 0.08 ms for the 50 elements a drag moves (`just bench`).

A see-through stroke, as a highlighter's always is, draws each pixel once however it crosses itself, through depth and stencil passes. Only a frame holding one pays for the depth and stencil buffer, about 40 MB for a full-screen MacBook Pro window.

## Text and SVG

The web app lays out and rasterises text with Inter, which it bundles so that text wraps alike everywhere. Lines break where the editing field's `white-space: pre-wrap` breaks them, which the app works out itself. Line counts matched in Chromium and WKWebView except for CJK, which Inter lacks, tabs, and words longer than a line.

SVGs rasterise through an `<img>` from a `data:` URL, since `createImageBitmap` refuses SVG bytes and a `blob:` URL taints the canvas once an SVG holds a `foreignObject`. Engines disagree on an SVG's size, so the core gives each one a single natural size.

Each text and SVG gets its own texture at the zoom it shows at, rounded up to a power of two, at most 2048 pixels a side, and smaller once out of view.

## Rules for GPU code

- WebGL2 stays a first-class target, since WebKitGTK has no WebGPU.
- wgpu panics on a validation error, and a panic kills the WASM module. The renderer catches errors with `Device::on_uncaptured_error` and hands them to the app.
- Dropping a texture, a buffer, or a device frees nothing on WebGPU, so destroy each one.
- WASM memory never shrinks, so large bytes cross the boundary in slices.
