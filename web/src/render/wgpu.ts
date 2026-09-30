// wgpu, the Rust candidate, compiled to WebAssembly.

import start, { create as createWgpu } from "../wasm/render_wgpu.js";
import { canvas, lose, size, type Create, type Renderer } from "./renderer.js";

/** Floats per image, as `draw` reads them: texture, x, y, width, height, and rotation. */
const STRIDE = 6;

export async function load(webgpu: boolean): Promise<Create> {
  await start();
  return (host, width, height) => create(webgpu, host, width, height);
}

async function create(
  webgpu: boolean,
  host: HTMLElement,
  width: number,
  height: number,
): Promise<Renderer> {
  const output = canvas(host, width, height);
  const renderer = await createWgpu(output, webgpu);
  let images = new Float32Array();
  return {
    backend: renderer.backend,
    async load(quads) {
      images = new Float32Array(quads.length * STRIDE);
      quads.forEach(({ bitmap, frame, rotation }, at) => {
        const texture = renderer.upload(bitmap);
        bitmap.close();
        images.set([texture, frame.x, frame.y, frame.width, frame.height, rotation], at * STRIDE);
      });
    },
    draw({ x, y, zoom }) {
      renderer.draw(x, y, zoom * devicePixelRatio, images);
    },
    resize(width, height) {
      size(output, width, height);
      renderer.resize(output.width, output.height);
    },
    destroy() {
      renderer.free();
      // wgpu never frees its WebGL2 context itself.
      if (!webgpu) {
        lose(output.getContext("webgl2"));
      }
      output.remove();
    },
  };
}
