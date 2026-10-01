//! The renderer: images as textured quads, text as textures of its coverage in a colour,
//! strokes (lines, dashed or not, the outlines of rectangles and ellipses, and crosses), and
//! filled rectangles and ellipses, see-through or not, on WebGL2 or WebGPU, drawn in the order
//! given over the grid, if any. It decodes the frames of animated images itself, as not every
//! webview hands them over, and copies those of videos the host plays.

#[cfg(any(target_arch = "wasm32", test))]
mod animation;
#[cfg(target_arch = "wasm32")]
mod web;
