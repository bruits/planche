// The renderer, on wgpu compiled to WebAssembly.

import type { Camera } from "./camera.js";
import type { Rect } from "./core.js";
import start, { create as createWgpu } from "./wasm/renderer.js";

export interface Quad {
  bitmap: ImageBitmap;
  frame: Rect;
  /** Clockwise, in degrees, around the frame's centre. */
  rotation: number;
}

export interface Renderer {
  /** What it runs on, such as the GPU's name. */
  readonly backend: string;
  /** Takes the bitmaps over, and closes them all even when it fails. */
  load(quads: Quad[]): void;
  draw(camera: Camera): void;
  /** In CSS pixels. */
  resize(width: number, height: number): void;
  destroy(): void;
}

/** Floats per image, as `draw` reads them. */
const STRIDE = 6;

/** Appends its canvas to `host`, sized in CSS pixels. */
export async function create(host: HTMLElement, width: number, height: number): Promise<Renderer> {
  await start();
  if ("gpu" in navigator) {
    try {
      return await on(true, host, width, height);
    } catch (error) {
      // A browser may have WebGPU and still find no adapter for it.
      console.warn("WebGPU failed, falling back to WebGL2:", error);
    }
  }
  return on(false, host, width, height);
}

async function on(webgpu: boolean, host: HTMLElement, width: number, height: number): Promise<Renderer> {
  const output = canvas(host, width, height);
  // A canvas keeps the first kind of context it gives, so a failed one is no use to the other backend.
  const renderer = await createWgpu(output, webgpu).catch((error: unknown) => {
    if (!webgpu) {
      lose(output.getContext("webgl2"));
    }
    output.remove();
    throw error;
  });
  let images = new Float32Array();
  return {
    backend: renderer.backend,
    load(quads) {
      images = new Float32Array(quads.length * STRIDE);
      try {
        quads.forEach(({ bitmap, frame, rotation }, at) => {
          const texture = renderer.upload(bitmap);
          bitmap.close();
          images.set([texture, frame.x, frame.y, frame.width, frame.height, rotation], at * STRIDE);
        });
      } catch (error) {
        // Closing one twice does nothing.
        quads.forEach(({ bitmap }) => bitmap.close());
        // Drawing a texture that was never uploaded would panic, and kill the module.
        images = new Float32Array();
        throw error;
      }
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

function canvas(host: HTMLElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  size(canvas, width, height);
  host.append(canvas);
  return canvas;
}

function size(canvas: HTMLCanvasElement, width: number, height: number): void {
  canvas.width = Math.round(width * devicePixelRatio);
  canvas.height = Math.round(height * devicePixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

/** Frees a WebGL context now rather than when collected, which the next renderer would pay for. */
function lose(gl: WebGL2RenderingContext | null): void {
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
}
