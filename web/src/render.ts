// Pictures of the board drawn off the window, for agents, and of the selection, for the user to
// export or copy, which leave the window's canvas, camera, and textures as they are.

import {
  among,
  decodeAsset,
  files,
  loneImage,
  placed,
  pool,
  readAsset,
  release,
  type Opened,
} from "./board.js";
import { density } from "./capture.js";
import * as core from "./core.js";
import type { Background, Board, Point, Rect, Size } from "./core.js";
import { LONGEST_SIDE, MOST_AREA, MOST_SIDE, overlaps } from "./raster.js";
import type { Placed, Renderer } from "./renderer.js";
import { SMALLEST_VECTOR } from "./still.js";
import { holdsText, isBlank, lettered } from "./text.js";
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
  crossedOut: ReadonlySet<string>;
  background: string;
}

/** What a picture of the selection needs to know of the window's renderer and its textures. */
export interface Textures {
  holds(asset: string): boolean;
  /** Whether its texture follows its playback, which a picture takes as it stands. */
  plays(asset: string): boolean;
  /** Whether the board and the renderer are still the window's. */
  current(): boolean;
}

export interface Exported {
  canvas: HTMLCanvasElement;
  /** Whether it shows its images with fewer pixels than they hold, as it would take too many. */
  capped: boolean;
}

export interface Sizing {
  /** Pixels per board unit. */
  zoom: number;
  size: Size;
  capped: boolean;
}

/** As floats leave a frame of whole pixels a hair over them. */
const HAIR = 1e-6;
/** The pixels a picture's stand-ins take at most, which images stacked or cropped could pass. */
const STAND_INS = 4 * MOST_AREA;
/** Where an arrow's heads reach back along its shaft and across it, per length, at 30° from it. */
const BARB = { back: Math.sqrt(3) / 2, across: 0.5 };

/** Throws what the agent reads when there is nothing to draw. */
export async function render(scene: Scene, request: Request): Promise<Rendered> {
  const { board } = scene.opened;
  const chosen = request.ids && new Set(request.ids);
  const ids = chosen ? board.draw_order.filter((id) => among(board, id, chosen)) : board.draw_order;
  const wanted = request.area ?? framed(board, scene.crossedOut, request.ids ?? []);
  const zoom = density(wanted, request.size);
  const size: Size = {
    width: Math.max(1, Math.floor(wanted.width * zoom)),
    height: Math.max(1, Math.floor(wanted.height * zoom)),
  };
  // What the whole pixels show.
  const area = { x: wanted.x, y: wanted.y, width: size.width / zoom, height: size.height / zoom };
  return { area, canvas: await draw(scene, ids, area, size) };
}

/**
 * The elements `ids` as the board shows them, their groups' elements included, cut to what they
 * draw over, without the grid, at the zoom at which the sharpest of their images shows all its
 * pixels. Throws when they draw nothing.
 */
export async function exported(scene: Scene, ids: string[], textures: Textures): Promise<Exported> {
  const { opened, renderer, drawings, crossedOut } = scene;
  // As it stands now, as edits landing while its assets decode replace its elements.
  const board = selected(opened.board, ids);
  const still: Scene = { ...scene, opened: { ...opened, board } };
  const wanted = tight(board, crossedOut);
  if (wanted === undefined) {
    throw new Error("The selection draws nothing");
  }
  // Not those crossed out, nor vectors, which are as sharp at any zoom.
  const own = board.draw_order.flatMap((id) => {
    const { kind } = board.elements[id]!;
    return kind.type === "image" && !crossedOut.has(kind.asset) && !drawings.holds(kind.asset)
      ? [1 / unitsPerPixel(kind)]
      : [];
  });
  const side = Math.min(MOST_SIDE, renderer.maxTextureSide);
  const { zoom, size, capped } = sizing(wanted, own, side);
  const area = { x: wanted.x, y: wanted.y, width: size.width / zoom, height: size.height / zoom };
  const { bitmaps, shrunk } = await standIns(still, area, zoom, side, textures);
  try {
    if (!textures.current()) {
      throw new Error("Another board opened meanwhile");
    }
    const drawing = { side, bitmaps, backdrop: "plain" } as const;
    const canvas = await draw(still, board.draw_order, area, size, drawing);
    return { canvas, capped: capped || shrunk };
  } finally {
    bitmaps.forEach(release);
  }
}

/** What the elements `ids` draw over, their groups' elements included, `undefined` when nothing. */
export function drawnOver(
  board: Board,
  ids: string[],
  crossedOut: ReadonlySet<string>,
): Rect | undefined {
  return tight(selected(board, ids), crossedOut);
}

/**
 * Pixels per board unit for a picture of `area`, and its size, with `images` given in the pixels
 * per unit each shows all its own at.
 */
export function sizing(area: Size, images: number[], side: number): Sizing {
  const longest = Math.max(area.width, area.height);
  const wanted =
    images.length > 0
      ? images.reduce((most, each) => Math.max(most, each))
      : SMALLEST_VECTOR / longest;
  const most = Math.min(side / longest, Math.sqrt(MOST_AREA / (area.width * area.height)));
  const zoom = Math.min(wanted, most);
  const covering = (whole: (pixels: number) => number): Size => ({
    width: Math.max(1, whole(area.width * zoom)),
    height: Math.max(1, whole(area.height * zoom)),
  });
  // Rounded up, so that its edges show whole, unless that passes the limits.
  const size = covering((pixels) => Math.ceil(pixels - HAIR));
  const fits = size.width * size.height <= MOST_AREA && Math.max(size.width, size.height) <= side;
  return { zoom, size: fits ? size : covering(Math.floor), capped: wanted > most };
}

export function pictureName(board: Board, ids: string[], boardName: string): string {
  const filename = loneImage(board, ids)?.image.filename;
  // Without its folders, which a name from elsewhere may hold, nor its last extension.
  const stem = filename
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]*$/, "")
    .trim();
  return `${stem || boardName}.png`;
}

/** The elements `ids`, their groups' elements included, as a board of their own. */
function selected(board: Board, ids: string[]): Board {
  const chosen = new Set(ids);
  const order = board.draw_order.filter((id) => among(board, id, chosen));
  const elements = Object.fromEntries(order.map((id) => [id, board.elements[id]!]));
  return { ...board, draw_order: order, elements };
}

/** What the board draws over, strokes and arrows' heads included, `undefined` when nothing. */
function tight(board: Board, crossedOut: ReadonlySet<string>): Rect | undefined {
  const items = placed(
    board,
    {
      // As far as the frame it lies in, which the margin of its texture passes, but within an
      // ellipse, whose outline holds it.
      placed: (id, kind) =>
        isBlank(kind) || (kind.type === "shape" && kind.shape === "ellipse")
          ? undefined
          : { kind: "text", id, frame: kind.frame, rotation: kind.rotation, paint: "ink" },
    },
    undefined,
    crossedOut,
  );
  return reach(items);
}

function reach(items: Placed[]): Rect | undefined {
  const points = items.flatMap((item): Point[] => {
    switch (item.kind) {
      case "image":
        return item.elliptical
          ? oval(item.frame, item.rotation, 0)
          : corners(item.frame, item.rotation);
      case "text":
      case "fill":
        return corners(item.frame, item.rotation);
      case "line":
        return [item.from, item.to].flatMap((end) => around(end, item.width / 2));
      case "arrow":
        return [item.from, item.to, ...barbs(item)].flatMap((end) => around(end, item.width / 2));
      // Its outline straddles the ellipse.
      case "ellipse":
        return oval(item.frame, item.rotation, item.width / 2);
      default: {
        // Its outline straddles the frame's edge.
        const { x, y, width, height } = item.frame;
        const half = item.width / 2;
        const grown = {
          x: x - half,
          y: y - half,
          width: width + 2 * half,
          height: height + 2 * half,
        };
        return corners(grown, item.rotation);
      }
    }
  });
  if (points.length === 0) {
    return undefined;
  }
  // Folded, as spreading a large selection's points could pass how many arguments a call takes.
  const [left, top, right, bottom] = points.reduce(
    ([l, t, r, b], { x, y }) => [Math.min(l, x), Math.min(t, y), Math.max(r, x), Math.max(b, y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The ends of an arrow's heads, as the renderer draws them. */
function barbs({ from, to, head, heads }: Extract<Placed, { kind: "arrow" }>): Point[] {
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const along = { x: (to.x - from.x) / span, y: (to.y - from.y) / span };
  const ends = (tip: Point, back: number) =>
    [1, -1].map((side) => ({
      x: tip.x - back * along.x * BARB.back * head - side * along.y * BARB.across * head,
      y: tip.y - back * along.y * BARB.back * head + side * along.x * BARB.across * head,
    }));
  return heads === 2 ? [...ends(to, 1), ...ends(from, -1)] : ends(to, 1);
}

function around({ x, y }: Point, radius: number): Point[] {
  return [
    { x: x - radius, y: y - radius },
    { x: x + radius, y: y + radius },
  ];
}

/** Turned by `degrees` around its centre, whichever way, as it bounds the same either way. */
function corners({ x, y, width, height }: Rect, degrees: number): Point[] {
  const centre = { x: x + width / 2, y: y + height / 2 };
  const radians = (degrees * Math.PI) / 180;
  const [sin, cos] = [Math.sin(radians), Math.cos(radians)];
  return [
    [x, y],
    [x + width, y],
    [x, y + height],
    [x + width, y + height],
  ].map(([cornerX, cornerY]) => {
    const [across, down] = [cornerX! - centre.x, cornerY! - centre.y];
    return { x: centre.x + across * cos - down * sin, y: centre.y + across * sin + down * cos };
  });
}

/** The box around the ellipse that fills `frame`, turned by `degrees`. */
function oval({ x, y, width, height }: Rect, degrees: number, grown: number): Point[] {
  const centre = { x: x + width / 2, y: y + height / 2 };
  const radians = (degrees * Math.PI) / 180;
  const [sin, cos] = [Math.sin(radians), Math.cos(radians)];
  const [across, down] = [width / 2, height / 2];
  const half = {
    x: Math.hypot(across * cos, down * sin) + grown,
    y: Math.hypot(across * sin, down * cos) + grown,
  };
  return [
    { x: centre.x - half.x, y: centre.y - half.y },
    { x: centre.x + half.x, y: centre.y + half.y },
  ];
}

/**
 * The longest side to decode an image of `natural` pixels at, which a picture shows at `pixels`
 * per pixel of its own, within `side` and a canvas, `undefined` when the window's texture, if
 * `held`, has as many.
 */
export function standInSide(
  natural: Size,
  pixels: number,
  side: number,
  held: boolean,
): number | undefined {
  const longest = Math.max(natural.width, natural.height);
  const within = Math.sqrt(MOST_AREA / (natural.width * natural.height));
  const wanted = longest * Math.min(1, pixels, side / longest, within);
  // The window's texture holds it whole up to that side.
  return held && wanted <= LONGEST_SIDE ? undefined : wanted;
}

/**
 * Bitmaps of the assets whose texture is missing, or smaller than the picture shows them, decoded
 * at the size it does, but never one that plays, which shows its frame. `shrunk` once they would
 * take more than `STAND_INS` pixels between them, and show fewer.
 */
async function standIns(
  { opened, drawings, crossedOut }: Scene,
  area: Rect,
  zoom: number,
  side: number,
  textures: Textures,
): Promise<{ bitmaps: Map<string, ImageBitmap>; shrunk: boolean }> {
  const { board } = opened;
  const sizes = new Map<string, Size>();
  for (const id of board.draw_order) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image") {
      sizes.set(kind.asset, kind.natural_size);
    }
  }
  const wanted = [...sharpest(board, board.draw_order, zoom, area)].flatMap(([asset, pixels]) => {
    if (crossedOut.has(asset) || drawings.holds(asset) || textures.plays(asset)) {
      return [];
    }
    const natural = sizes.get(asset)!;
    const held = textures.holds(asset);
    const longest = standInSide(natural, pixels, side, held);
    return longest === undefined ? [] : [{ asset, natural, longest, held }];
  });
  const shrinking = (each: typeof wanted) => {
    const taken = each.reduce(
      (sum, { natural: { width, height }, longest }) =>
        sum + width * height * (longest / Math.max(width, height)) ** 2,
      0,
    );
    return Math.min(1, Math.sqrt(STAND_INS / taken));
  };
  const over = shrinking(wanted);
  // Left to the window's texture once shrunk to no more than it holds, which leaves more for the rest.
  const kept = wanted.filter(({ held, longest }) => !held || longest * over > LONGEST_SIDE);
  const shrink = shrinking(kept);
  const bitmaps = new Map<string, ImageBitmap>();
  const pending = kept.values();
  try {
    await pool(
      () => pending.next().value,
      async ({ asset, natural, longest }) => {
        const read = await readAsset(files(opened), asset, natural);
        const decoded = await decodeAsset(read, longest * shrink);
        if (decoded instanceof ImageBitmap) {
          bitmaps.set(asset, decoded);
        }
      },
    );
  } catch (error) {
    bitmaps.forEach(release);
    throw error;
  }
  return { bitmaps, shrunk: over < 1 };
}

interface Drawing {
  /** The longest side of a text's or a vector's texture, in pixels. */
  side?: number;
  /** Bitmaps that stand in for their assets' textures. */
  bitmaps?: Map<string, ImageBitmap>;
  backdrop?: Background;
}

/** The elements among `ids` that `area` overlaps, onto a canvas of `size` pixels. */
async function draw(
  { opened, renderer, drawings, crossedOut, background }: Scene,
  ids: string[],
  area: Rect,
  size: Size,
  { side, bitmaps, backdrop }: Drawing = {},
): Promise<HTMLCanvasElement> {
  const { board } = opened;
  const zoom = size.width / area.width;
  const lettering = new Map<string, Placed>();
  const texts = new Map<string, HTMLCanvasElement>();
  for (const id of ids) {
    const { kind } = board.elements[id]!;
    if (holdsText(kind) && overlaps(area, kind.frame)) {
      const done = lettered(id, kind, kind.text.font_size * zoom, side);
      if (done) {
        lettering.set(id, done.placed);
        texts.set(id, done.canvas);
      }
    }
  }
  const images = new Map<string, HTMLCanvasElement | ImageBitmap>(bitmaps);
  for (const [asset, pixels] of sharpest(board, ids, zoom, area)) {
    const canvas = drawings.drawn(asset, pixels, side);
    if (canvas) {
      images.set(asset, canvas);
    }
  }
  const items = placed(
    { ...board, draw_order: ids },
    { placed: (id) => lettering.get(id) },
    undefined,
    crossedOut,
  );
  const pixels = await renderer.render({
    area,
    size,
    items,
    background,
    ...(backdrop && { backdrop }),
    images,
    texts,
  });
  const canvas = Object.assign(document.createElement("canvas"), size);
  canvas.getContext("2d")!.putImageData(pixels, 0, 0);
  return canvas;
}

/** The most pixels per pixel of its own that an image among `ids` in `area` shows each asset at. */
function sharpest(board: Board, ids: string[], zoom: number, area: Rect): Map<string, number> {
  const most = new Map<string, number>();
  for (const id of ids) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image" && overlaps(area, kind.frame)) {
      most.set(kind.asset, Math.max(most.get(kind.asset) ?? 0, unitsPerPixel(kind) * zoom));
    }
  }
  return most;
}

function framed(board: Board, crossedOut: ReadonlySet<string>, chosen: string[]): Rect {
  const covered = drawnOver(board, chosen, crossedOut);
  if (covered === undefined) {
    throw new Error(
      chosen.length === 0 ? "Give an area or some ids" : "Those elements draw nothing to show",
    );
  }
  const { x, y, width, height } = covered;
  const margin = Math.max(core.strokeWidth("thick"), 0.02 * Math.max(width, height));
  return { x: x - margin, y: y - margin, width: width + 2 * margin, height: height + 2 * margin };
}
