// Vector images as the renderer draws them. A browser rasterises an SVG only through an `<img>`,
// and only from a `data:` URL, since `createImageBitmap` refuses its bytes and a `blob:` URL
// taints the canvas it is drawn on once it holds a `foreignObject`. Each asset is rasterised as
// texts are, at the zoom its largest image shows at.

import type { Camera, Viewport } from "./camera.js";
import * as core from "./core.js";
import type { Board, Bytes, Kind, Size } from "./core.js";
import { LONGEST_SIDE, overlaps, rounded, settling } from "./raster.js";
import type { Renderer } from "./renderer.js";

/** Pixels along the longest side of an SVG out of view, enough to show until it refines. */
const FAR = 256;

export interface Picture {
  image: HTMLImageElement;
  natural: Size;
}

/** Throws when the host cannot draw it. */
export async function picture(bytes: Bytes, natural: Size): Promise<Picture> {
  const sized = core.sizedSvg(bytes, natural);
  if (sized === undefined) {
    throw new Error("markup that is not an SVG");
  }
  const image = new Image();
  image.src = await dataUrl(new Blob([sized], { type: "image/svg+xml" }));
  await image.decode();
  return { image, natural };
}

function dataUrl(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

/** Board units across a pixel of an image's asset, as its frame lays it out. */
export function unitsPerPixel(kind: Extract<Kind, { type: "image" }>): number {
  const { width, height } = kind.edits.crop ?? kind.natural_size;
  return Math.max(kind.frame.width / width, kind.frame.height / height);
}

export interface Vectors {
  /** Rasterises `asset` from now on, unless it already does. */
  keep(asset: string, picture: Picture): void;
  /** Rasterises the assets that show at a zoom they were not rasterised for. */
  update(board: Board, renderer: Renderer, camera: Camera, viewport: Viewport): void;
  /** Forgets `asset`, whose texture is freed. */
  drop(asset: string): void;
  /**
   * `asset` on a canvas of its own, at `density` pixels per pixel of its natural size, fewer where
   * it would not fit a texture. Nothing is kept. `undefined` for an asset not rasterised.
   */
  drawn(asset: string, density: number): HTMLCanvasElement | undefined;
  /** Forgets them all, as their renderer is gone. */
  reset(): void;
}

/** `again` asks for another frame, once the camera settles. */
export function vectors(again: () => void): Vectors {
  const pictures = new Map<string, Picture>();
  /** Pixels per natural pixel, by asset. */
  const rasterised = new Map<string, number>();
  const canvas = document.createElement("canvas");
  const settle = settling(again);
  return {
    keep(asset, drawing) {
      if (!pictures.has(asset)) {
        pictures.set(asset, drawing);
      }
    },
    update(board, renderer, camera, viewport) {
      const shown = settle.follow(camera, viewport);
      /** The most device pixels per natural pixel that an image of each asset shows at. */
      const wanted = new Map<string, number>();
      const visible = new Set<string>();
      for (const id of board.draw_order) {
        const { kind } = board.elements[id]!;
        if (kind.type !== "image" || !pictures.has(kind.asset)) {
          continue;
        }
        const here = unitsPerPixel(kind) * camera.zoom * devicePixelRatio;
        wanted.set(kind.asset, Math.max(wanted.get(kind.asset) ?? 0, here));
        if (overlaps(shown, kind.frame)) {
          visible.add(kind.asset);
        }
      }
      for (const [asset, here] of wanted) {
        const { natural } = pictures.get(asset)!;
        const longest = Math.max(natural.width, natural.height);
        const inView = visible.has(asset);
        // Out of view, an asset drops to a density that costs little, so that memory follows what shows.
        const density = Math.min(
          rounded(here),
          inView ? Infinity : FAR / longest,
          LONGEST_SIDE / longest,
        );
        const done = rasterised.get(asset);
        if (done !== undefined && (done === density || !settle.settled(inView))) {
          continue;
        }
        // A frame so small that it spans no pixel has nothing to show.
        if (!(density > 0)) {
          continue;
        }
        rasterise(canvas, pictures.get(asset)!, density);
        renderer.setImage(asset, canvas);
        rasterised.set(asset, density);
      }
    },
    drop(asset) {
      pictures.delete(asset);
      rasterised.delete(asset);
    },
    drawn(asset, density) {
      const drawing = pictures.get(asset);
      if (drawing === undefined) {
        return undefined;
      }
      const own = document.createElement("canvas");
      const longest = Math.max(drawing.natural.width, drawing.natural.height);
      rasterise(own, drawing, Math.min(density, LONGEST_SIDE / longest));
      return own;
    },
    reset() {
      pictures.clear();
      rasterised.clear();
      settle.reset();
    },
  };
}

function rasterise(canvas: HTMLCanvasElement, { image, natural }: Picture, density: number): void {
  canvas.width = Math.max(Math.round(natural.width * density), 1);
  canvas.height = Math.max(Math.round(natural.height * density), 1);
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
}
