// Pictures of the board drawn off the window, for agents, and of the selection, for the user to
// export or copy at the size, on the background, and with the margin they choose, which leave the
// window's canvas, camera, and textures as they are.

import {
  among,
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
import type { Background, Board, Item, Point, Rect, Size } from "./core.js";
import { LONGEST_SIDE, MOST_AREA, MOST_SIDE, overlaps } from "./raster.js";
import type { Paint } from "./paint.js";
import type { Lettering, Placed, Renderer } from "./renderer.js";
import { SMALLEST_VECTOR } from "./still.js";
import { holdsText, lettered, type Holder } from "./text.js";
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
const STAND_INS = 4 * MOST_AREA;
/** Where an arrow's heads reach back along its shaft and across it, per length, at 30° from it. */
const BARB = { back: Math.sqrt(3) / 2, across: 0.5 };

/** Throws what the agent reads when there is nothing to draw. */
export async function render(scene: Scene, request: Request): Promise<Rendered> {
  const { opened, crossedOut } = scene;
  const { board } = opened;
  const chosen = request.ids && new Set(request.ids);
  const ids = chosen ? board.draw_order.filter((id) => among(board, id, chosen)) : board.draw_order;
  const items = stacked(opened, crossedOut, ids);
  const wanted = request.area ?? framed(chosen ? items : [], board, request.ids ?? []);
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
  const board = selected(opened.board, ids, shown);
  const items = stacked(opened, crossedOut, board.draw_order);
  const side = Math.min(MOST_SIDE, renderer.maxTextureSide);
  const laid = plan(board, items, crossedOut, drawings, options, side);
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
  const board = selected(opened.board, ids, shown);
  const items = stacked(opened, crossedOut, board.draw_order);
  return plan(board, items, crossedOut, drawings, options, Math.min(MOST_SIDE, side));
}

/**
 * Cut to what `items` draw over, with a margin if any, at the zoom at which the sharpest of their
 * images shows all its pixels, or fewer as `options` ask.
 */
function plan(
  board: Board,
  items: Item[],
  crossedOut: ReadonlySet<string>,
  drawings: Pick<Vectors, "holds">,
  options: Options,
  side: number,
): Plan | undefined {
  const drawn = tight(items, board);
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
  const { board } = opened;
  return tight(stacked(opened, crossedOut, selected(board, ids, shown).draw_order), board);
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
  const most = Math.min(side / longest, Math.sqrt(MOST_AREA / (area.width * area.height)));
  const zoom = Math.min(wanted, most);
  const covering = (whole: (pixels: number) => number): Size => ({
    width: Math.max(1, whole(area.width * zoom)),
    height: Math.max(1, whole(area.height * zoom)),
  });
  // Rounded up, so that its edges show whole, unless that passes the limits.
  const size = covering((pixels) => Math.ceil(pixels - HAIR));
  const fits = size.width * size.height <= MOST_AREA && Math.max(size.width, size.height) <= side;
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
function selected(board: Board, ids: string[], shown: boolean): Board {
  const chosen = new Set(ids);
  const order = shownOrder(board, shown).filter((id) => among(board, id, chosen));
  const elements = Object.fromEntries(order.map((id) => [id, board.elements[id]!]));
  return { ...board, draw_order: order, elements };
}

/** What `items` draw over, strokes and arrows' heads included, `undefined` when nothing. */
function tight(items: Item[], board: Board): Rect | undefined {
  const texts = {
    // As far as the frame it lies in, which the margin of its texture passes, but within a
    // shape's outline when that holds it, as all but a rectangle's or a cross's do.
    placed: (id: string, kind: Holder): Lettering | undefined =>
      kind.type === "shape" && core.textAreaOf(kind).width < 1
        ? undefined
        : { id, frame: kind.frame, rotation: core.rotationOf(kind), paint: "ink" },
  };
  return reach(placing(items, board, texts));
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
      case "stroke":
        return item.points.flatMap((point) => around(point, item.width / 2));
      case "arrow":
        return [item.from, item.to, ...barbs(item)].flatMap((end) => around(end, item.width / 2));
      case "outline": {
        const half = item.width / 2;
        // Its outline straddles the ellipse.
        if (item.shape === "ellipse") {
          return oval(item.frame, item.rotation, half);
        }
        // Round about each corner, as far as half its width.
        const parts = core.cornerPartsOf(item.shape, item.corners);
        if (parts) {
          return parts.flatMap((part) => around(partOf(item.frame, item.rotation, part), half));
        }
        // A rectangle's or a cross's outline straddles the frame's edge.
        const { x, y, width, height } = item.frame;
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
  return heads === "both" ? [...ends(to, 1), ...ends(from, -1)] : ends(to, 1);
}

function around({ x, y }: Point, radius: number): Point[] {
  return [
    { x: x - radius, y: y - radius },
    { x: x + radius, y: y + radius },
  ];
}

/** Turned by `degrees` around its centre, whichever way, as it bounds the same either way. */
function corners(frame: Rect, degrees: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ].map((part) => partOf(frame, degrees, part));
}

/**
 * Where `part` of `frame`, from 0 to 1 across and down, lies once it turns by `degrees` around
 * its centre, whichever way its size goes.
 */
function partOf({ x, y, width, height }: Rect, degrees: number, part: Point): Point {
  const centre = { x: x + width / 2, y: y + height / 2 };
  const radians = (degrees * Math.PI) / 180;
  const [sin, cos] = [Math.sin(radians), Math.cos(radians)];
  const [across, down] = [(part.x - 0.5) * Math.abs(width), (part.y - 0.5) * Math.abs(height)];
  return { x: centre.x + across * cos - down * sin, y: centre.y + across * sin + down * cos };
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

function framed(items: Item[], board: Board, chosen: string[]): Rect {
  const covered = tight(items, board);
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
