# Images and videos

The image pipeline sets performance more than the renderer does. A 12 MP photo takes 48 MB once decoded at full size, so what sits on the GPU has to follow what the board shows, whatever the number of photos.

## Still images

The browser decodes images off the main thread with `createImageBitmap`. It beat Rust in WASM, 65 ms against 83 ms for 12 MP, and runs the same code in every webview. The formats are therefore the platform's.

- Each photo decodes once, at most 2048 pixels on its longest side, which WebGL2 guarantees. That is about 17 MB of texture with its mipmaps. Exports and agents' renders decode larger stand-ins at the size they draw.
- Four images load at a time, the largest on screen first, and each shows once uploaded. 100 photos of 12 MP show their first in 0.2 s and all in 4.3 s, in Chromium on an Apple M5 Pro.
- A texture goes once no image draws its asset. Undo, redo, or an agent bringing it back reads and decodes it again, about 60 ms a photo.
- Mipmaps are made on the GPU into `Rgba8UnormSrgb` textures, so filtering and greyscale work in linear light.
- An image this machine cannot decode, whose asset is missing, or whose asset differs from its digest, shows crossed out. Only the app's own faults keep a board from showing.

The next steps are set and not built. The core will plan which images stay on the GPU within a memory budget, from the camera, keeping a coarse level of every image and never evicting what shows. Levels of detail will be whole images at halving sizes, tiles will cover images past the texture limit, and caches of derived levels will stay out of the board, keyed by digest. Native decoding on desktop, more Rust decoders in WASM, GPU texture compression, and rendering in a worker come only if measurements call for them. WASM threads are out for now, as they need nightly Rust and a cross-origin isolation that WKWebView may not grant under `tauri://`. So is decoding HEIC or AVIF in Rust, for want of a decoder under a permissive licence.

## Animated images

The renderer decodes animated GIF, PNG, and WebP files itself with the `image` crate, since not every webview hands their frames over. Drawing an animated `<img>` onto a canvas gives its first frame in Chromium and WKWebView, and WKWebView and WebKitGTK lack `ImageDecoder`.

Frames decode onto the asset's texture, and only while an image of the asset shows, so memory follows the board. Decoding stops for a frame of the page once it has spent 8 ms. The core reads from the bytes how many times an image plays and how long each frame shows, as browsers play it. Frames are not colour-managed, and images over 2048 pixels a side, or turned or flipped by their metadata, stay still.

## Videos

Videos play in `<video>` elements the page never shows, and the renderer copies each new frame onto the asset's texture. At most eight play at once, since decoders are few. Browsers do not say which frame shows, so the core reads frame times from an MP4 or QuickTime file's index, or from a WebM or Matroska file's clusters. That lets trims and frame steps land on exact frames.

- The `blob:` URL carries the type the core reads from the bytes, as WKWebView refuses an untyped MP4.
- Copying from a `<video>` that has no frame yet panics on WebGPU, so the renderer waits for one. `preload` is `auto`, since with `metadata` the copy fails in Chromium even once ready.
- WKWebView keeps presenting about a frame a second in a hidden page, so the app pauses videos itself while hidden.
- `VideoFrame` from WebCodecs would need `web_sys_unstable_apis`, so frames come from the `<video>`.
- Videos over 300 MB or 4096 pixels a side are refused. Assets cross into WASM in slices to be hashed, so memory stays bounded.
