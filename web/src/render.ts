// Pictures of the board drawn off the window, for agents, which leave the window's canvas,
// camera, and textures as they are.

import { among, placed, type Opened } from "./board.js";
import { density } from "./capture.js";
import * as core from "./core.js";
import type { Rect, Size } from "./core.js";
import { overlaps } from "./raster.js";
import type { Placed, Renderer } from "./renderer.js";
import { holdsText, lettered } from "./text.js";
import { unitsPerPixel, type Vectors } from "./vector.js";

/** Either `area` of the board, or `ids` to frame, at most `size` pixels along the longest side. */
export interface Request {
  area?: Rect;
  ids?: string[];
  size?: number;
}

export interface Rendered {
  /** What the picture covers, in board units. */
  area: Rect;
  canvas: HTMLCanvasElement;
}

export interface Scene {
  opened: Opened;
  renderer: Renderer;
  drawings: Vectors;
  unplayable: ReadonlySet<string>;
  background: string;
}

/** Throws what the agent reads when there is nothing to draw. */
export async function render({ opened, renderer, drawings, unplayable, background }: Scene, request: Request): Promise<Rendered> {
  const { board } = opened;
  const chosen = request.ids && new Set(request.ids);
  const ids = chosen ? board.draw_order.filter((id) => among(board, id, chosen)) : board.draw_order;
  const wanted = request.area ?? framed(opened, ids, request.ids ?? []);
  const zoom = density(wanted, request.size);
  const size: Size = {
    width: Math.max(1, Math.floor(wanted.width * zoom)),
    height: Math.max(1, Math.floor(wanted.height * zoom)),
  };
  // What the whole pixels show.
  const area = { x: wanted.x, y: wanted.y, width: size.width / zoom, height: size.height / zoom };

  const lettering = new Map<string, Placed>();
  const texts = new Map<string, HTMLCanvasElement>();
  const sharpest = new Map<string, number>();
  for (const id of ids) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image" && overlaps(area, kind.frame)) {
      sharpest.set(kind.asset, Math.max(sharpest.get(kind.asset) ?? 0, unitsPerPixel(kind) * zoom));
    } else if (holdsText(kind) && overlaps(area, kind.frame)) {
      const done = lettered(id, kind, kind.text.font_size * zoom);
      if (done) {
        lettering.set(id, done.placed);
        texts.set(id, done.canvas);
      }
    }
  }
  const images = new Map<string, HTMLCanvasElement>();
  for (const [asset, pixels] of sharpest) {
    const canvas = drawings.drawn(asset, pixels);
    if (canvas) {
      images.set(asset, canvas);
    }
  }
  const items = placed({ ...board, draw_order: ids }, { placed: (id) => lettering.get(id) }, undefined, unplayable);
  const pixels = await renderer.render({ area, size, items, background, images, texts });
  const canvas = Object.assign(document.createElement("canvas"), size);
  canvas.getContext("2d")!.putImageData(pixels, 0, 0);
  return { area, canvas };
}

/** What the elements draw over, with some room around it, as a line or an arrow may have no height. */
function framed({ board, editor }: Opened, ids: string[], chosen: string[]): Rect {
  const bounds = core.bounds(editor, chosen);
  if (bounds === undefined) {
    throw new Error(chosen.length === 0 ? "Give an area or some ids" : "Those elements draw nothing to show");
  }
  // The core bounds an arrow by its ends, past which the strokes of its head reach.
  const reached = placed({ ...board, draw_order: ids }, { placed: () => undefined }).flatMap((item) =>
    item.kind === "line" ? [item.to] : [],
  );
  const xs = [bounds.x, bounds.x + bounds.width, ...reached.map(({ x }) => x)];
  const ys = [bounds.y, bounds.y + bounds.height, ...reached.map(({ y }) => y)];
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  const [width, height] = [Math.max(...xs) - x, Math.max(...ys) - y];
  const margin = Math.max(core.strokeWidth(), 0.02 * Math.max(width, height));
  return { x: x - margin, y: y - margin, width: width + 2 * margin, height: height + 2 * margin };
}
