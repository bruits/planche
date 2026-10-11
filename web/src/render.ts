// Pictures of the board drawn off the window, for agents, and of the selection, for the user to
// export or copy at the size, on the background, and with the margin they choose, which leave the
// window's canvas, camera, and textures as they are.

import {
  decodeAsset,
  files,
  loneImage,
  placing,
  readAsset,
  release,
  shownOrder,
  stacked,
  type Opened,
} from "./board.js";
import { pool } from "./pool.js";
import { density } from "./capture.js";
import * as core from "./core.js";
import type { Background, Board, Item, Rect, Size } from "./core.js";
import { CANVAS_AREA, CANVAS_SIDE, TEXTURE_SIDE, scaleWithin, overlaps } from "./raster.js";
import type { Paint } from "./paint.js";
import type { Lettering, Placed, Renderer } from "./renderer.js";
import { SMALLEST_VECTOR } from "./still.js";
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

/** What shows behind a picture, white drawing it in the light theme's colours. */
export type Backing = "board" | "white" | "transparent";

export interface Options {
  /** Pixels along its longest side, at most, `undefined` for as many as its images show. */
  longest: number | undefined;
  background: Backing;
  margin: boolean;
}

export interface Plan extends Sizing {
  /** What the picture covers, in board units. */
  area: Rect;
}

/** Left on each side of what a picture shows, per its longest side, with a margin. */
export const MARGIN = 0.04;
/** Checks across the longest side of a picture without a background, as the board shows it. */
const CHECKS = 32;
/** How much of the ink a check takes over the board. */
const CHECKED = 0.12;

/** As floats leave a frame of whole pixels a hair over them. */
const HAIR = 1e-6;
/** The pixels a picture's stand-ins take at most, which images stacked or cropped could pass. */
const STAND_INS = 4 * CANVAS_AREA;

/** Throws what the agent reads when there is nothing to draw. */
export async function render(scene: Scene, request: Request): Promise<Rendered> {
  const { opened, crossedOut } = scene;
  const { board, editor } = opened;
  const chosen = request.ids && new Set(editor.withDescendants(request.ids));
  const ids = chosen ? board.draw_order.filter((id) => chosen.has(id)) : board.draw_order;
  const items = stacked(opened, crossedOut, ids);
  const wanted = request.area ?? framed(opened, request.ids ?? [], crossedOut);
  const zoom = density(wanted, request.size);
  const size: Size = {
    width: Math.max(1, Math.floor(wanted.width * zoom)),
    height: Math.max(1, Math.floor(wanted.height * zoom)),
  };
  // What the whole pixels show.
  const area = { x: wanted.x, y: wanted.y, width: size.width / zoom, height: size.height / zoom };
  return { area, canvas: await draw(scene, { ...board, draw_order: ids }, items, area, size) };
}

/**
 * The elements `ids` as the board shows them, their groups' elements included but for the
 * annotations unless they are `shown`, as `options` frame them, without the grid. Throws when they
 * draw nothing.
 */
export async function exported(
  scene: Scene,
  ids: string[],
  textures: Textures,
  options: Options,
  shown = true,
): Promise<Exported> {
  const { opened, renderer, drawings, crossedOut } = scene;
  // As it stands now, as edits landing while its assets decode replace its elements.
  const board = selected(opened, ids, shown);
  const items = stacked(opened, crossedOut, board.draw_order);
  const side = Math.min(CANVAS_SIDE, renderer.maxTextureSide);
  const drawn = core.drawnBounds(opened.editor, ids, crossedOut, shown);
  const laid = plan(board, drawn, crossedOut, drawings, options, side);
  if (laid === undefined) {
    throw new Error("The selection draws nothing");
  }
  const { area, zoom, size, capped } = laid;
  const { bitmaps, shrunk } = await standIns(scene, board, area, zoom, side, textures);
  try {
    if (!textures.current()) {
      throw new Error("Another board opened meanwhile");
    }
    const drawing: Drawing = {
      side,
      bitmaps,
      backdrop: "plain",
      ...(options.background === "white" && { background: "#ffffff", light: true }),
      ...(options.background === "transparent" && { transparent: true }),
    };
    const canvas = await draw(scene, board, items, area, size, drawing);
    return { canvas, capped: capped || shrunk };
  } finally {
    bitmaps.forEach(release);
  }
}

/**
 * What a picture of the elements `ids`, their groups' elements included but for the annotations
 * unless they are `shown`, covers, and at how many pixels, as `options` frame it, within `side`
 * pixels along its longest side. `undefined` when they draw nothing.
 */
export function planned(
  { opened, drawings, crossedOut }: Pick<Scene, "opened" | "drawings" | "crossedOut">,
  ids: string[],
  options: Options,
  side: number,
  shown = true,
): Plan | undefined {
  const board = selected(opened, ids, shown);
  const drawn = core.drawnBounds(opened.editor, ids, crossedOut, shown);
  return plan(board, drawn, crossedOut, drawings, options, Math.min(CANVAS_SIDE, side));
}

/**
 * Cut to what `board` draws over, `drawn`, with a margin if any, at the zoom at which the sharpest
 * of its images shows all its pixels, or fewer as `options` ask.
 */
function plan(
  board: Board,
  drawn: Rect | undefined,
  crossedOut: ReadonlySet<string>,
  drawings: Pick<Vectors, "holds">,
  options: Options,
  side: number,
): Plan | undefined {
  if (drawn === undefined) {
    return undefined;
  }
  const wanted = options.margin
    ? padded(drawn, MARGIN * Math.max(drawn.width, drawn.height))
    : drawn;
  // Not those crossed out, nor vectors, which are as sharp at any zoom.
  const own = board.draw_order.flatMap((id) => {
    const { kind } = board.elements[id]!;
    return kind.type === "image" && !crossedOut.has(kind.asset) && !drawings.holds(kind.asset)
      ? [1 / unitsPerPixel(kind)]
      : [];
  });
  const sized = sizing(wanted, own, side, options.longest);
  const { zoom, size } = sized;
  const area = { x: wanted.x, y: wanted.y, width: size.width / zoom, height: size.height / zoom };
  return { ...sized, area };
}

/** What stands on the board for the background of a picture that covers `area`, over what it leaves out. */
export function backing(area: Rect, background: Backing): Placed[] {
  if (background === "white") {
    return [{ ...filled(area, "#ffffff"), light: true }];
  }
  const behind = [filled(area, "board")];
  if (background === "board") {
    return behind;
  }
  const cell = Math.max(area.width, area.height) / CHECKS;
  const columns = Math.ceil(area.width / cell - HAIR);
  const rows = Math.ceil(area.height / cell - HAIR);
  for (let down = 0; down < rows; down += 1) {
    for (let across = down % 2; across < columns; across += 2) {
      const [x, y] = [across * cell, down * cell];
      const frame = {
        x: area.x + x,
        y: area.y + y,
        width: Math.min(cell, area.width - x),
        height: Math.min(cell, area.height - y),
      };
      behind.push(filled(frame, "ink", CHECKED));
    }
  }
  return behind;
}

function filled(frame: Rect, paint: Paint, opacity = 1): Placed {
  return { kind: "fill", frame, rotation: 0, paint, opacity };
}

/**
 * What the elements `ids` draw over, their groups' elements included but for the annotations
 * unless they are `shown`, `undefined` when nothing.
 */
export function drawnOver(
  opened: Opened,
  ids: string[],
  crossedOut: ReadonlySet<string>,
  shown = true,
): Rect | undefined {
  return core.drawnBounds(opened.editor, ids, crossedOut, shown);
}

/**
 * Pixels per board unit for a picture of `area`, and its size, with `images` given in the pixels
 * per unit each shows all its own at, and no more than `limit` along its longest side, which a
 * picture without images takes whole, as nothing else in it loses sharpness.
 */
export function sizing(area: Size, images: number[], side: number, limit?: number): Sizing {
  const longest = Math.max(area.width, area.height);
  const finest =
    images.length > 0 ? images.reduce((most, each) => Math.max(most, each)) : undefined;
  const wanted =
    limit === undefined
      ? (finest ?? SMALLEST_VECTOR / longest)
      : Math.min(finest ?? Infinity, limit / longest);
  const most = scaleWithin(area, side);
  const zoom = Math.min(wanted, most);
  const covering = (whole: (pixels: number) => number): Size => ({
    width: Math.max(1, whole(area.width * zoom)),
    height: Math.max(1, whole(area.height * zoom)),
  });
  // Rounded up, so that its edges show whole, unless that passes the limits.
  const size = covering((pixels) => Math.ceil(pixels - HAIR));
  const fits = size.width * size.height <= CANVAS_AREA && Math.max(size.width, size.height) <= side;
  return { zoom, size: fits ? size : covering(Math.floor), capped: wanted > most * (1 + HAIR) };
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

/**
 * The elements `ids`, their groups' elements included but for the annotations unless they are
 * `shown`, as a board of their own.
 */
function selected({ board, editor }: Opened, ids: string[], shown: boolean): Board {
  const chosen = new Set(editor.withDescendants(ids));
  const order = shownOrder(board, shown).filter((id) => chosen.has(id));
  const elements = Object.fromEntries(order.map((id) => [id, board.elements[id]!]));
  return { ...board, draw_order: order, elements };
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
  const wanted =
    Math.max(natural.width, natural.height) * Math.min(1, pixels, scaleWithin(natural, side));
  // The window's texture holds it whole up to that side.
  return held && wanted <= TEXTURE_SIDE ? undefined : wanted;
}

/**
 * Bitmaps of the assets whose texture is missing, or smaller than the picture shows them, decoded
 * at the size it does, but never one that plays, which shows its frame. `shrunk` once they would
 * take more than `STAND_INS` pixels between them, and show fewer.
 */
async function standIns(
  { opened, drawings, crossedOut }: Scene,
  board: Board,
  area: Rect,
  zoom: number,
  side: number,
  textures: Textures,
): Promise<{ bitmaps: Map<string, ImageBitmap>; shrunk: boolean }> {
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
  const kept = wanted.filter(({ held, longest }) => !held || longest * over > TEXTURE_SIDE);
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
  /** In place of the scene's. */
  background?: string;
  transparent?: boolean;
  light?: boolean;
}

/** What `items` draw of `board`'s elements, where `area` overlaps them, onto a canvas of `size` pixels. */
async function draw(
  { renderer, drawings, background: behind }: Scene,
  board: Board,
  items: Item[],
  area: Rect,
  size: Size,
  { side, bitmaps, backdrop, background = behind, transparent, light }: Drawing = {},
): Promise<HTMLCanvasElement> {
  const ids = board.draw_order;
  const zoom = size.width / area.width;
  const lettering = new Map<string, Lettering>();
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
  const pixels = await renderer.render({
    area,
    size,
    items: placing(items, board, { placed: (id) => lettering.get(id) }),
    background,
    ...(transparent && { transparent }),
    ...(light && { light }),
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

function framed(opened: Opened, chosen: string[], crossedOut: ReadonlySet<string>): Rect {
  const covered =
    chosen.length === 0 ? undefined : core.drawnBounds(opened.editor, chosen, crossedOut, true);
  if (covered === undefined) {
    throw new Error(
      chosen.length === 0 ? "Give an area or some ids" : "Those elements draw nothing to show",
    );
  }
  return padded(
    covered,
    Math.max(core.strokeWidth("thick"), 0.02 * Math.max(covered.width, covered.height)),
  );
}

function padded({ x, y, width, height }: Rect, margin: number): Rect {
  return { x: x - margin, y: y - margin, width: width + 2 * margin, height: height + 2 * margin };
}
