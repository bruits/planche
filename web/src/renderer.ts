// The renderer, on wgpu compiled to WebAssembly.

import type { Camera } from "./camera.js";
import type { Rect } from "./core.js";
import start, { create as createWgpu } from "./wasm/renderer.js";

/** An image, as it shows its asset. */
export interface Placed {
  asset: string;
  frame: Rect;
  /** Clockwise, in degrees, around the frame's centre. */
  rotation: number;
  /** The part of the asset it shows, from 0 to 1 across and down, which a negative size flips. */
  texture: Rect;
  greyscale: boolean;
}

export interface Renderer {
  /** What it runs on, such as the GPU's name. */
  readonly backend: string;
  /** Takes each asset's bitmap over, and closes them all even when it fails. Loaded ones stay. */
  load(bitmaps: Map<string, ImageBitmap>): void;
  /** What to draw from now on, back to front. Images whose asset is not loaded are left out. */
  place(images: Placed[]): void;
  draw(camera: Camera): void;
  /** In CSS pixels. */
  resize(width: number, height: number): void;
  destroy(): void;
}

/** Floats per image, as `draw` reads them. */
const STRIDE = 11;

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
  // Drawing a texture that was never uploaded would panic, and kill the module.
  const textures = new Map<string, number>();
  let images = new Float32Array();
  return {
    backend: renderer.backend,
    load(bitmaps) {
      try {
        for (const [asset, bitmap] of bitmaps) {
          if (!textures.has(asset)) {
            textures.set(asset, renderer.upload(bitmap));
          }
          bitmap.close();
        }
      } finally {
        // Closing one twice does nothing.
        bitmaps.forEach((bitmap) => bitmap.close());
      }
    },
    place(placed) {
      const shown = placed.filter(({ asset }) => textures.has(asset));
      images = new Float32Array(shown.length * STRIDE);
      shown.forEach(({ asset, frame, rotation, texture, greyscale }, at) => {
        images.set(
          [
            textures.get(asset)!,
            ...[frame.x, frame.y, frame.width, frame.height, rotation],
            ...[texture.x, texture.y, texture.width, texture.height, greyscale ? 1 : 0],
          ],
          at * STRIDE,
        );
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
