// The renderer, on wgpu compiled to WebAssembly.

import type { Camera } from "./camera.js";
import { gridLevel, type Background, type Point, type Rect } from "./core.js";
import start, { create as createWgpu } from "./wasm/renderer.js";

/**
 * A colour of the theme, as its host's style gives it: the ink is its text colour, which forced
 * colours override too, and the others are its `--sticky` and `--sticky-ink` properties.
 */
export type Paint = "ink" | "sticky" | "sticky-ink";

/**
 * An image, as it shows its asset, a text from its texture, a stroke in the ink, or a filled
 * rectangle. Rotations are clockwise, in degrees, around the frame's centre, and stroke widths in
 * board units.
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
  | { kind: "text"; id: string; frame: Rect; rotation: number; paint: Paint }
  | { kind: "line"; from: Point; to: Point; width: number }
  | { kind: "rectangle" | "ellipse" | "cross"; frame: Rect; rotation: number; width: number }
  | { kind: "fill"; frame: Rect; rotation: number; paint: Paint };

export interface Renderer {
  /** What it runs on, such as the GPU's name. */
  readonly backend: string;
  /** What its textures take on the GPU. */
  readonly textureBytes: number;
  /** Takes each asset's bitmap over, and closes them all even when it fails. Loaded ones stay. */
  load(bitmaps: Map<string, ImageBitmap>): void;
  /** The text `id` as the canvas holds it, in place of any before. */
  setText(id: string, canvas: HTMLCanvasElement): void;
  dropText(id: string): void;
  /** What to draw from now on, back to front. Images and texts without a texture are left out. */
  place(items: Placed[]): void;
  /** What shows behind the items from now on. */
  backdrop(background: Background): void;
  /** Reads the paints again, once the theme changed. */
  restyle(): void;
  draw(camera: Camera): void;
  /** In CSS pixels. */
  resize(width: number, height: number): void;
  destroy(): void;
}

/** Floats per item, as `draw` reads them. */
const STRIDE = 12;
/** As the renderer tells its items apart. */
const KINDS = { image: 0, stroke: 1, text: 2 };
/** As the renderer tells its strokes apart. */
const SHAPES = { line: 0, rectangle: 1, ellipse: 2, fill: 3, cross: 4 };
/** How wide a line of the grid is, or a dot across, in CSS pixels, and how much of the ink it takes. */
const GRID = {
  grid: { width: 1, alpha: 0.1 },
  dots: { width: 2, alpha: 0.25 },
};

type Paints = Record<Paint, number[]>;

/**
 * Straight red, green, and blue from 0 to 1. Drawn to a pixel and read back, as a computed colour
 * may be in any colour space.
 */
function paints(host: HTMLElement): Paints {
  const canvas = Object.assign(document.createElement("canvas"), { width: 1, height: 1 });
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const style = getComputedStyle(host);
  const read = (colour: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((channel) => channel / 255);
  };
  return {
    ink: read(style.color),
    sticky: read(style.getPropertyValue("--sticky")),
    "sticky-ink": read(style.getPropertyValue("--sticky-ink")),
  };
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
  let painted = paints(host);
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
  const images = new Map<string, number>();
  const texts = new Map<string, number>();
  let placed: Placed[] = [];
  let background: Background = "plain";
  /** Packed at the next draw, as uploads and releases move the textures that items name. */
  let items: Float32Array | undefined;
  const pack = () => {
    const shown = placed.flatMap((item) => {
      const texture = item.kind === "image" ? images.get(item.asset) : item.kind === "text" ? texts.get(item.id) : -1;
      return texture === undefined ? [] : [floats(item, texture, painted)];
    });
    items = new Float32Array(shown.length * STRIDE);
    shown.forEach((item, at) => items!.set(item, at * STRIDE));
    return items;
  };
  return {
    backend: renderer.backend,
    get textureBytes() {
      return renderer.textureBytes;
    },
    load(bitmaps) {
      try {
        for (const [asset, bitmap] of bitmaps) {
          if (!images.has(asset)) {
            images.set(asset, renderer.upload(bitmap));
          }
          bitmap.close();
        }
      } finally {
        // Closing one twice does nothing.
        bitmaps.forEach((bitmap) => bitmap.close());
        items = undefined;
      }
    },
    setText(id, canvas) {
      const before = texts.get(id);
      texts.set(id, renderer.uploadCanvas(canvas));
      if (before !== undefined) {
        renderer.release(before);
      }
      items = undefined;
    },
    dropText(id) {
      const texture = texts.get(id);
      if (texture !== undefined) {
        renderer.release(texture);
        texts.delete(id);
        items = undefined;
      }
    },
    place(next) {
      placed = next;
      items = undefined;
    },
    backdrop(next) {
      background = next;
    },
    restyle() {
      painted = paints(host);
      items = undefined;
    },
    draw(camera) {
      const { x, y, zoom } = camera;
      renderer.draw(x, y, zoom * devicePixelRatio, items ?? pack(), grid(background, camera, painted.ink));
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

/** As the renderer lays out its items: its kind, its texture, then its instance. */
function floats(item: Placed, texture: number, paints: Paints): number[] {
  switch (item.kind) {
    case "image": {
      const { frame, texture: shown } = item;
      return [
        ...[KINDS.image, texture, frame.x, frame.y, frame.width, frame.height, item.rotation],
        ...[shown.x, shown.y, shown.width, shown.height, item.greyscale ? 1 : 0],
      ];
    }
    case "text": {
      const { frame } = item;
      const quad = [frame.x, frame.y, frame.width, frame.height, item.rotation];
      return [KINDS.text, texture, ...quad, ...paints[item.paint], 0, 0];
    }
    case "line": {
      const { from, to } = item;
      return [KINDS.stroke, -1, SHAPES.line, from.x, from.y, to.x, to.y, 0, item.width, ...paints.ink];
    }
    case "fill": {
      const { frame } = item;
      const fill = [frame.x, frame.y, frame.width, frame.height, item.rotation, 0];
      return [KINDS.stroke, -1, SHAPES.fill, ...fill, ...paints[item.paint]];
    }
    default: {
      const { frame } = item;
      const outline = [frame.x, frame.y, frame.width, frame.height, item.rotation, item.width];
      return [KINDS.stroke, -1, SHAPES[item.kind], ...outline, ...paints.ink];
    }
  }
}

/** As the renderer lays out its grid, none when plain. */
function grid(background: Background, { x, y, zoom }: Camera, ink: number[]): Float32Array {
  if (background === "plain") {
    return new Float32Array();
  }
  const { spacing, fade, coarse } = gridLevel(zoom);
  // Here, where numbers are doubles, as the renderer's floats would lose the lines far out.
  const offset = (value: number) => value - Math.floor(value / coarse) * coarse;
  const { width, alpha } = GRID[background];
  const dots = background === "dots" ? 1 : 0;
  return Float32Array.of(offset(x), offset(y), spacing, fade, ...ink, alpha, width * devicePixelRatio, dots, coarse / spacing, 0);
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
