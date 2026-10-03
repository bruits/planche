// The renderer, on wgpu compiled to WebAssembly.

import type { Camera } from "./camera.js";
import * as core from "./core.js";
import type { Background, Bytes, Point, Rect, Size } from "./core.js";
import { paints, reader, type Paint, type Paints } from "./paint.js";
import start, { Animation, create as createWgpu, type Readback } from "./wasm/renderer.js";

/**
 * An image, as it shows its asset, a text from its texture, a stroke, or a filled rectangle or
 * ellipse, with `opacity` from 0 to 1. Rotations are clockwise, in degrees, around the frame's
 * centre, and stroke widths in board units.
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
      /** Whether it shows only the ellipse that fills its frame. */
      elliptical: boolean;
    }
  | { kind: "text"; id: string; frame: Rect; rotation: number; paint: Paint }
  | { kind: "line"; from: Point; to: Point; width: number; paint: Paint; dashed?: boolean }
  | {
      kind: "rectangle" | "ellipse" | "cross";
      frame: Rect;
      rotation: number;
      width: number;
      paint: Paint;
      dashed?: boolean;
    }
  | {
      kind: "fill";
      shape: "rectangle" | "ellipse";
      frame: Rect;
      rotation: number;
      paint: Paint;
      opacity: number;
    };

/** An animated image, whose frames it draws onto its asset's texture. */
export interface Playing {
  /**
   * Draws the next frame. How long it asks to show, in milliseconds, `undefined` once none is
   * left. Throws when it does not decode, or is not as large as the texture.
   */
  next(): number | undefined;
  restart(): void;
  free(): void;
}

export interface Shot {
  /** In board units. */
  area: Rect;
  /** In pixels, within what the GPU's textures hold. */
  size: Size;
  /** Back to front. */
  items: Placed[];
  /** The colour behind the board, as CSS gives it. */
  background: string;
  /** Canvases that stand in, for this render only, for the textures of assets and texts. */
  images: Map<string, HTMLCanvasElement>;
  texts: Map<string, HTMLCanvasElement>;
}

export interface Renderer {
  /** What it runs on, such as the GPU's name. */
  readonly backend: string;
  /** What its textures take on the GPU. */
  readonly textureBytes: number;
  /** What it draws on, in device pixels. */
  readonly canvas: HTMLCanvasElement;
  /** Takes each asset's bitmap over, and closes them all even when it fails. Loaded ones stay. */
  load(bitmaps: Map<string, ImageBitmap>): void;
  /** The asset as the canvas holds it, in place of any before. */
  setImage(asset: string, canvas: HTMLCanvasElement): void;
  /** The frames the bytes of a loaded asset hold. Throws when they do not decode. */
  animate(asset: string, bytes: Bytes): Playing;
  /**
   * The frame the video shows, onto a loaded asset's texture. Whether it had one to show. Throws
   * when it is not as large as the texture.
   */
  copyVideo(asset: string, video: HTMLVideoElement): boolean;
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
  /** The picture, opaque. Without a frame to wait for, so it works in a hidden window. */
  render(shot: Shot): Promise<ImageData>;
  /** In CSS pixels. */
  resize(width: number, height: number): void;
  destroy(): void;
}

/** How long a render may wait for the GPU to hand its pixels over, in milliseconds. */
const READBACK_TIME = 15_000;
/** Floats per item, as `draw` reads them, those an item leaves out being zeros. */
const STRIDE = 13;
/** As the renderer tells its items apart. */
const KINDS = { image: 0, stroke: 1, text: 2 };
/** As the renderer tells its strokes apart. */
const SHAPES = { line: 0, rectangle: 1, ellipse: 2, fill: 3, cross: 4, ellipseFill: 5 };
/** How wide a line of the grid is, or a dot across, in CSS pixels, and how much of the ink it takes. */
const GRID = {
  grid: { width: 1, alpha: 0.1 },
  dots: { width: 2, alpha: 0.25 },
};

function gridStrength(host: HTMLElement): number {
  return Number(getComputedStyle(host).getPropertyValue("--grid-strength")) || 1;
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

async function on(
  webgpu: boolean,
  host: HTMLElement,
  width: number,
  height: number,
): Promise<Renderer> {
  // Before the renderer exists, which nothing would free if this threw.
  let painted = paints(host);
  let strength = gridStrength(host);
  const output = appended(host, width, height);
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
  const pack = () => (items = packed(placed, images, texts, painted));
  const replace = (textures: Map<string, number>, key: string, canvas: HTMLCanvasElement) => {
    const before = textures.get(key);
    textures.set(key, renderer.uploadCanvas(canvas));
    if (before !== undefined) {
      renderer.release(before);
    }
    items = undefined;
  };
  return {
    backend: renderer.backend,
    canvas: output,
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
    setImage(asset, canvas) {
      replace(images, asset, canvas);
    },
    animate(asset, bytes) {
      const animation = new Animation(bytes);
      return {
        next() {
          const texture = images.get(asset);
          return texture === undefined ? undefined : renderer.advance(texture, animation);
        },
        restart: () => animation.restart(),
        free: () => animation.free(),
      };
    },
    copyVideo(asset, video) {
      const texture = images.get(asset);
      return texture !== undefined && renderer.copyVideo(texture, video);
    },
    setText(id, canvas) {
      replace(texts, id, canvas);
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
      strength = gridStrength(host);
      items = undefined;
    },
    draw(camera) {
      const { x, y, zoom } = camera;
      renderer.draw(
        x,
        y,
        zoom * devicePixelRatio,
        items ?? pack(),
        grid(background, camera, painted("ink"), strength, devicePixelRatio),
      );
    },
    async render({
      area,
      size: picture,
      items: shown,
      background: behind,
      images: own,
      texts: ownTexts,
    }) {
      const staged = new Map<string, number>();
      const stagedTexts = new Map<string, number>();
      let readback: Readback;
      try {
        // Uploaded first, as the items name the textures by index, and released as soon as the
        // GPU has what it needs, which the readback does not wait for.
        own.forEach((canvas, asset) => staged.set(asset, renderer.uploadCanvas(canvas)));
        ownTexts.forEach((canvas, id) => stagedTexts.set(id, renderer.uploadCanvas(canvas)));
        const zoom = picture.width / area.width;
        const view = Float32Array.of(
          area.x,
          area.y,
          zoom,
          picture.width,
          picture.height,
          ...reader()(behind),
        );
        const camera = { x: area.x, y: area.y, zoom };
        const lookup = [
          new Map([...images, ...staged]),
          new Map([...texts, ...stagedTexts]),
        ] as const;
        readback = renderer.render(
          view,
          packed(shown, lookup[0], lookup[1], painted),
          grid(background, camera, painted("ink"), strength, 1),
        );
      } finally {
        [...staged.values(), ...stagedTexts.values()].forEach((texture) =>
          renderer.release(texture),
        );
      }
      try {
        const until = performance.now() + READBACK_TIME;
        while (!readback.poll()) {
          if (performance.now() > until) {
            throw new Error("The GPU did not hand the render back in time");
          }
          await turn();
        }
        // Copied out of the module's memory, so never a shared buffer.
        return new ImageData(
          readback.pixels() as Uint8ClampedArray<ArrayBuffer>,
          picture.width,
          picture.height,
        );
      } finally {
        readback.free();
      }
    },
    resize(wide, high) {
      size(output, wide, high);
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

/** Without the items whose texture is not uploaded, as drawing one would panic and kill the module. */
function packed(
  placed: Placed[],
  images: Map<string, number>,
  texts: Map<string, number>,
  painted: Paints,
): Float32Array {
  const shown = placed.flatMap((item) => {
    const texture =
      item.kind === "image"
        ? images.get(item.asset)
        : item.kind === "text"
          ? texts.get(item.id)
          : -1;
    return texture === undefined ? [] : [floats(item, texture, painted)];
  });
  const items = new Float32Array(shown.length * STRIDE);
  shown.forEach((item, at) => items.set(item, at * STRIDE));
  return items;
}

/**
 * Lets the event loop turn, which a hidden window still does for messages, though not for frames,
 * and for timers only about once a second. WebGL2 tells the GPU is done only between turns.
 */
const turns = new MessageChannel();
const waiting: (() => void)[] = [];
// Setting the handler starts the port.
// oxlint-disable-next-line unicorn/prefer-add-event-listener
turns.port1.onmessage = () => waiting.splice(0).forEach((resolve) => resolve());

function turn(): Promise<void> {
  return new Promise((resolve) => {
    waiting.push(resolve);
    turns.port2.postMessage(null);
  });
}

/** As the renderer lays out its items: its kind, its texture, then its instance. */
function floats(item: Placed, texture: number, colours: Paints): number[] {
  switch (item.kind) {
    case "image": {
      const { frame, texture: shown } = item;
      const quad = [frame.x, frame.y, frame.width, frame.height, item.rotation];
      const flags = [item.greyscale ? 1 : 0, item.elliptical ? 1 : 0];
      return [KINDS.image, texture, ...quad, shown.x, shown.y, shown.width, shown.height, ...flags];
    }
    case "text": {
      const { frame } = item;
      const quad = [frame.x, frame.y, frame.width, frame.height, item.rotation];
      return [KINDS.text, texture, ...quad, ...colours(item.paint), 0, 0];
    }
    case "line": {
      const { from, to } = item;
      const line = [from.x, from.y, to.x, to.y, 0, stroke(item)];
      return [KINDS.stroke, -1, SHAPES.line, ...line, ...colours(item.paint)];
    }
    case "fill": {
      const { frame } = item;
      const fill = [frame.x, frame.y, frame.width, frame.height, item.rotation, item.opacity];
      return [
        KINDS.stroke,
        -1,
        item.shape === "ellipse" ? SHAPES.ellipseFill : SHAPES.fill,
        ...fill,
        ...colours(item.paint),
      ];
    }
    default: {
      const { frame } = item;
      const outline = [frame.x, frame.y, frame.width, frame.height, item.rotation, stroke(item)];
      return [KINDS.stroke, -1, SHAPES[item.kind], ...outline, ...colours(item.paint)];
    }
  }
}

/** Its width, negative when dashed, as the renderer reads it. */
function stroke({ width, dashed }: { width: number; dashed?: boolean }): number {
  return dashed ? -width : width;
}

/** As the renderer lays out its grid, none when plain. `density` is the device pixels per CSS pixel. */
function grid(
  background: Background,
  { x, y, zoom }: Camera,
  ink: number[],
  strength: number,
  density: number,
): Float32Array {
  if (background === "plain") {
    return new Float32Array();
  }
  const { spacing, fade, coarse } = core.gridLevel(zoom);
  // Here, where numbers are doubles, as the renderer's floats would lose the lines far out.
  const offset = (value: number) => value - Math.floor(value / coarse) * coarse;
  const { width, alpha } = GRID[background];
  const opacity = Math.min(alpha * strength, 1);
  const dots = background === "dots" ? 1 : 0;
  return Float32Array.of(
    offset(x),
    offset(y),
    spacing,
    fade,
    ...ink,
    opacity,
    width * density,
    dots,
    coarse / spacing,
    0,
  );
}

function appended(host: HTMLElement, width: number, height: number): HTMLCanvasElement {
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
