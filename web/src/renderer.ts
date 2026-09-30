// The renderer, on wgpu compiled to WebAssembly.

import type { Camera } from "./camera.js";
import type { Point, Rect } from "./core.js";
import start, { create as createWgpu } from "./wasm/renderer.js";

/**
 * An image, as it shows its asset, or a stroke in the theme's ink. Rotations are clockwise, in
 * degrees, around the frame's centre, and stroke widths in board units.
 */
export type Placed =
  | {
      kind: "image";
      asset: string;
      frame: Rect;
      rotation: number;
      /** The part of the asset it shows, from 0 to 1 across and down, which a negative size flips. */
      texture: Rect;
      greyscale: boolean;
    }
  | { kind: "line"; from: Point; to: Point; width: number }
  | { kind: "rectangle" | "ellipse"; frame: Rect; rotation: number; width: number };

export interface Renderer {
  /** What it runs on, such as the GPU's name. */
  readonly backend: string;
  /** Takes each asset's bitmap over, and closes them all even when it fails. Loaded ones stay. */
  load(bitmaps: Map<string, ImageBitmap>): void;
  /** What to draw from now on, back to front. Images whose asset is not loaded are left out. */
  place(items: Placed[]): void;
  /** Reads the ink again, once the theme changed. */
  restyle(): void;
  draw(camera: Camera): void;
  /** In CSS pixels. */
  resize(width: number, height: number): void;
  destroy(): void;
}

/** Floats per item, as `draw` reads them. */
const STRIDE = 11;
/** As the renderer tells its strokes apart. */
const SHAPES = { line: 0, rectangle: 1, ellipse: 2 };

/**
 * The text colour of `host`, which forced colours override too, as straight red, green, blue,
 * and alpha from 0 to 1. Drawn to a pixel and read back, as its computed value may be in any
 * colour space.
 */
function ink(host: HTMLElement): number[] {
  const canvas = Object.assign(document.createElement("canvas"), { width: 1, height: 1 });
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = getComputedStyle(host).color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].map((channel) => channel / 255);
}

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
  // Before the renderer exists, which nothing would free if this threw.
  let inked = ink(host);
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
  let items = new Float32Array();
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
      const shown = placed.filter((item) => item.kind !== "image" || textures.has(item.asset));
      items = new Float32Array(shown.length * STRIDE);
      shown.forEach((item, at) => items.set(floats(item, textures), at * STRIDE));
    },
    restyle() {
      inked = ink(host);
    },
    draw({ x, y, zoom }) {
      const [red, green, blue, alpha] = inked;
      renderer.setInk(red!, green!, blue!, alpha!);
      renderer.draw(x, y, zoom * devicePixelRatio, items);
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

/** As the renderer lays out its items, with an image's texture, or -1 for a stroke, first. */
function floats(item: Placed, textures: Map<string, number>): number[] {
  switch (item.kind) {
    case "image": {
      const { frame, texture } = item;
      return [
        textures.get(item.asset)!,
        ...[frame.x, frame.y, frame.width, frame.height, item.rotation],
        ...[texture.x, texture.y, texture.width, texture.height, item.greyscale ? 1 : 0],
      ];
    }
    case "line":
      return [-1, SHAPES.line, item.from.x, item.from.y, item.to.x, item.to.y, 0, item.width, 0, 0, 0];
    default: {
      const { frame } = item;
      return [-1, SHAPES[item.kind], frame.x, frame.y, frame.width, frame.height, item.rotation, item.width, 0, 0, 0];
    }
  }
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
