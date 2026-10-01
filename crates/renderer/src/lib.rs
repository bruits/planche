//! The renderer: images as textured quads, text as textures of its coverage in a colour,
//! strokes (lines, the outlines of rectangles and ellipses, and crosses), and filled
//! rectangles, on WebGL2 or WebGPU, drawn in the order given over the grid, if any. It decodes
//! the frames of animated images itself, as not every webview hands them over.

#[cfg(any(target_arch = "wasm32", test))]
mod animation;
#[cfg(target_arch = "wasm32")]
mod web;
