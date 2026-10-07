// A board as the app opens it: its files through the platform, edited by the core, and its
// images decoded by the browser.

import type { Moving } from "./animation.js";
import * as core from "./core.js";
import type { Board, Bytes, Copied, Editor, Files, Item, Kind, Point, Rect, Size } from "./core.js";
import { milliseconds, timed } from "./metrics.js";
import type { Folder, Home } from "./platform.js";
import type { Placed } from "./renderer.js";
import type { Saving } from "./save.js";
import { holdsText, type Texts } from "./text.js";
import { picture, type Picture } from "./vector.js";
import { VIDEO_LIMIT, firstFrame } from "./video.js";

export interface Opened {
  folder: Folder;
  editor: Editor;
  /** The editor's board, as `refresh` keeps it. */
  board: Board;
  /**
   * The assets its folder lacks, by path, those of the images added since it opened and those
   * that undo or redo may bring back.
   */
  added: Map<string, Blob>;
  /** What its elements draw, as the core gives it, until `refresh` finds them touched. */
  drawn: Drawn;
}

/** Each element's items, with the images of `crossedOut` crossed out. */
interface Drawn {
  crossedOut: ReadonlySet<string>;
  items: Map<string, readonly Item[]>;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * A bitmap capped as `decode` caps them, or a video's first frame, or an SVG, which is
 * rasterised as it shows.
 */
export type Decoded = ImageBitmap | Picture;

/** An image to add, decoded unless the board shows it already. */
export interface Added {
  asset: string;
  bytes: Blob;
  natural: Size;
  decoded?: Decoded | undefined;
  moving?: Moving | undefined;
  /** Typed, to play from. */
  video?: Blob;
  filename?: string | undefined;
  source?: string | undefined;
}

export type Image = Extract<Kind, { type: "image" }>;

/** As long as agents may write a caption or a source, which crates/mcp holds them to. */
export const MOST_LABEL = 2000;

/** An asset that images show, still encoded. */
export interface Asset {
  asset: string;
  blob: Blob;
  natural: Size;
  vector: boolean;
  moving?: Moving | undefined;
  /** The blob, when a video. */
  video?: Blob;
}

/** A folder's files as the board was read from it. */
export interface Reading {
  listed: string[];
  /** Those of the board, all but the assets. */
  files: Files;
  /** Theirs, taken before they were read, where the folder has them. */
  stamps: Map<string, string>;
}

/**
 * The board in the folder that `pick` gives, `null` when the user cancels. Otherwise replaces
 * `timings` with how long each step took.
 */
export async function open<T extends Folder>(
  pick: () => Promise<T | null>,
  timings: Map<string, string>,
): Promise<{ opened: Opened & { folder: T }; reading: Reading } | null> {
  const folder = await pick();
  if (folder === null) {
    return null;
  }
  const [listed, listing] = await timed(() => folder.list(core.fileDepth()));
  const board = listed.filter(core.isBoardFile);
  // Before reading, so that what another program writes meanwhile tells by its stamp.
  const stamps =
    "stamps" in folder
      ? await (folder as unknown as Home).stamps(board)
      : new Map<string, string>();
  const [read, reading] = await timed(async () => {
    const contents: Files = new Map();
    for (const path of board) {
      contents.set(path, await folder.read(path));
    }
    return contents;
  });
  const [editor, parsing] = await timed(() => core.read(read));
  // Found before it takes the open board's place, as showing it would fail.
  try {
    editor.checkAssets(listed);
  } catch (error) {
    editor.free();
    throw error;
  }
  const opened = {
    folder,
    editor,
    board: core.board(editor),
    added: new Map<string, Blob>(),
    drawn: { crossedOut: NONE, items: new Map() },
  };
  timings.clear();
  timings.set(`list ${listed.length} files`, milliseconds(listing));
  timings.set(`read ${read.size} files`, milliseconds(reading));
  timings.set("parse", milliseconds(parsing));
  return {
    opened,
    reading: { listed, files: read, stamps },
  };
}

/** A new board, which has no folder yet. */
export function untitled(): Opened {
  const folder: Folder = {
    name: "Untitled",
    list: async () => [],
    read: async (path) => {
      throw new Error(`${path} is not in the board`);
    },
  };
  const editor = new core.Editor();
  return {
    folder,
    editor,
    board: core.board(editor),
    added: new Map(),
    drawn: { crossedOut: NONE, items: new Map() },
  };
}

/** Its files as they stand: its folder's, and the assets of the images added since. */
export function files({ folder, added }: Opened): Folder {
  return {
    ...folder,
    read: async (path) => {
      const blob = added.get(path);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : folder.read(path);
    },
  };
}

/**
 * Left undecoded when `held` gives the natural size of its asset, which the board shows already.
 * Throws when the bytes are not an image the host can decode.
 */
export async function prepare(
  bytes: Blob,
  cap: number,
  held: (asset: string) => Size | undefined = () => undefined,
): Promise<Added> {
  const start = new Uint8Array(await bytes.slice(0, core.mediaStart()).arrayBuffer());
  const told = core.media(start, start.length === bytes.size);
  if (told?.kind === "video") {
    return prepareVideo(bytes, start, told.type, held);
  }
  const whole = new Uint8Array(await bytes.arrayBuffer());
  const asset = core.assetOf(await digest(whole), start);
  const known = held(asset);
  if (known !== undefined) {
    return { asset, bytes, natural: known };
  }
  // Only what its start does not tell is worth copying whole into the core.
  const media = told ?? core.media(whole, true)!;
  switch (media.kind) {
    case "video":
      return prepareVideo(bytes, start, media.type, held);
    case "markup":
      throw new Error("markup that is not an SVG");
    case "svg":
      return { asset, bytes, natural: media.size, decoded: await picture(whole, media.size) };
  }
  // Its first frame, when it moves.
  const full = await createImageBitmap(bytes, { imageOrientation: "from-image" });
  const natural = { width: full.width, height: full.height };
  const moving = movingOf(media, whole);
  const { width, height } = capped(natural, cap);
  if (width === natural.width && height === natural.height) {
    return { asset, bytes, natural, decoded: full, moving };
  }
  const bitmap = await createImageBitmap(full, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  }).finally(() => full.close());
  return { asset, bytes, natural, decoded: bitmap, moving };
}

/** One video's bytes at a time, as each is held twice while it is hashed, up to `VIDEO_LIMIT`. */
let hashingVideo: Promise<unknown> = Promise.resolve();

async function prepareVideo(
  bytes: Blob,
  start: Bytes,
  type: string,
  held: (asset: string) => Size | undefined,
): Promise<Added> {
  if (bytes.size > VIDEO_LIMIT) {
    throw new Error(`it is over the ${VIDEO_LIMIT / 1e6} MB limit for videos`);
  }
  const hashed = hashingVideo.then(async () => digest(new Uint8Array(await bytes.arrayBuffer())));
  hashingVideo = hashed.catch(() => undefined);
  const asset = core.assetOf(await hashed, start);
  const known = held(asset);
  if (known !== undefined) {
    return { asset, bytes, natural: known };
  }
  const video = new Blob([bytes], { type });
  const { bitmap, natural } = await firstFrame(video);
  return { asset, bytes, natural, decoded: bitmap, video };
}

function movingOf(media: core.Media, bytes: Bytes): Moving | undefined {
  return media.kind === "animated" ? { bytes, plays: media.plays ?? Infinity } : undefined;
}

export function release(decoded: Decoded | undefined): void {
  if (decoded instanceof ImageBitmap) {
    decoded.close();
  }
}

export function newId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export function renamed({ elements }: Copied): Record<string, string> {
  return Object.fromEntries(Object.keys(elements).map((id) => [id, newId()]));
}

/**
 * The SHA-256 digest of `bytes`, which names their asset with `core.assetOf`. The host hashes them
 * without holding the page up in a secure context, which every shell's webview is, and the core
 * otherwise, as for a page served over plain HTTP.
 */
export async function digest(bytes: Bytes): Promise<string> {
  return crypto.subtle
    ? hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    : core.digestOf(bytes);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function webAddress(text: string | undefined): string | undefined {
  // Whatever an agent or a board from elsewhere wrote, which may launch an app as a file would.
  try {
    const url = new URL(text?.trim() ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function loneImage(
  board: Board | undefined,
  ids: string[],
): { id: string; image: Image } | undefined {
  const [id] = ids;
  const kind = ids.length === 1 ? board?.elements[id!]?.kind : undefined;
  return kind?.type === "image" ? { id: id!, image: kind } : undefined;
}

export function setLabel(kind: Image, field: "caption" | "source", text: string): void {
  if (text.trim()) {
    kind[field] = text;
  } else {
    delete kind[field];
  }
}

export function imageKind(
  asset: string,
  natural: Size,
  frame: Rect,
  {
    filename,
    source,
    caption,
  }: {
    filename?: string | undefined;
    source?: string | undefined;
    caption?: string | undefined;
  } = {},
): Kind {
  const edits = { crop: null, flip_horizontal: false, flip_vertical: false, greyscale: false };
  return {
    type: "image",
    asset,
    natural_size: natural,
    frame,
    rotation: 0,
    edits,
    ...(filename !== undefined && { filename }),
    ...(source !== undefined && { source }),
    ...(caption !== undefined && { caption }),
  };
}

/** Side by side around `at`, shrunk as one and moved to fit within `area` when given. */
export function row(sizes: Size[], at: Point, area?: Rect): Rect[] {
  const across = sizes.reduce((sum, { width }) => sum + width, 0);
  const tallest = Math.max(...sizes.map(({ height }) => height));
  const scale = area ? Math.min(1, area.width / across, area.height / tallest) : 1;
  const [wide, high] = [across * scale, tallest * scale];
  const centre = area
    ? {
        x: Math.min(Math.max(at.x, area.x + wide / 2), area.x + area.width - wide / 2),
        y: Math.min(Math.max(at.y, area.y + high / 2), area.y + area.height - high / 2),
      }
    : at;
  let x = centre.x - wide / 2;
  return sizes.map(({ width, height }) => {
    const frame = {
      x,
      y: centre.y - (height * scale) / 2,
      width: width * scale,
      height: height * scale,
    };
    x += frame.width;
    return frame;
  });
}

/**
 * How far right and down a duplicate lies from what it copies, at least `least` CSS pixels at
 * `zoom`, by whole steps of the grid that shows then, so that what lies on its lines stays on them.
 */
export function duplicateOffset(zoom: number, least: number): number {
  const step = core.gridLevel(zoom).spacing;
  return Math.ceil(least / (step * zoom)) * step;
}

/** How far an arrow key moves the selection at `zoom`, ten times as far when `wide`. */
export function nudge(zoom: number, wide: boolean, grid: boolean): number {
  const times = wide ? 10 : 1;
  if (!grid) {
    return times / zoom;
  }
  const { spacing, fade, coarse } = core.gridLevel(zoom);
  return times * (fade < 1 ? coarse : spacing);
}

/** What `kind` sticks to, which carries it along. */
export function anchors(kind: Kind): string[] {
  return [
    "target" in kind ? kind.target : undefined,
    "from_target" in kind ? kind.from_target : undefined,
    "to_target" in kind ? kind.to_target : undefined,
  ].filter((id) => id !== undefined);
}

/** How far to move `area` for its centre to come to `at`, by whole steps of the grid that shows at `zoom`. */
export function centring(area: Rect, at: Point, zoom: number): Point {
  const step = core.gridLevel(zoom).spacing;
  const whole = (length: number) => Math.round(length / step) * step;
  return {
    x: whole(at.x - area.x - area.width / 2),
    y: whole(at.y - area.y - area.height / 2),
  };
}

/** The assets that the touched elements showed and no longer do, which other images may. */
export function refresh({ editor, board, drawn }: Opened, touched: string[]): string[] {
  // Only which elements there are, where each stacks, and in which group, order the board.
  let reordered = false;
  const shown = new Set<string>();
  const kept = new Set<string>();
  const containers = new Set<string>();
  for (const id of new Set(touched)) {
    drawn.items.delete(id);
    const before = board.elements[id];
    const element = core.element(editor, id);
    if (element === undefined) {
      delete board.elements[id];
    } else {
      board.elements[id] = element;
    }
    for (const group of [before?.group, element?.group]) {
      if (group !== undefined) {
        containers.add(group);
      }
    }
    reordered ||=
      (before === undefined) !== (element === undefined) ||
      before?.z !== element?.z ||
      before?.group !== element?.group;
    if (before?.kind.type === "image") {
      shown.add(before.kind.asset);
    }
    if (element?.kind.type === "image") {
      kept.add(element.kind.asset);
    }
  }
  // A group's panel follows what its elements draw, all the way up.
  const seen = new Set<string>();
  for (const group of containers) {
    for (let up: string | undefined = group; up !== undefined && !seen.has(up);) {
      seen.add(up);
      drawn.items.delete(up);
      up = board.elements[up]?.group;
    }
  }
  if (reordered) {
    board.draw_order = editor.drawOrder();
  }
  board.background = core.background(editor);
  return [...shown].filter((asset) => !kept.has(asset));
}

/**
 * What the elements of `order` draw, stacked back to front, with the images of the `crossedOut`
 * assets where they lie, crossed out.
 */
export function stacked(
  { editor, board, drawn }: Opened,
  crossedOut: ReadonlySet<string> = NONE,
  order = board.draw_order,
): Item[] {
  if (drawn.crossedOut !== crossedOut) {
    const before = drawn.crossedOut;
    const changed = new Set(
      [...before, ...crossedOut].filter((asset) => before.has(asset) !== crossedOut.has(asset)),
    );
    // Only images draw otherwise once their asset is crossed out, or back.
    for (const id of drawn.items.keys()) {
      const kind = board.elements[id]?.kind;
      if (kind?.type === "image" && changed.has(kind.asset)) {
        drawn.items.delete(id);
      }
    }
    drawn.crossedOut = crossedOut;
  }
  // At once, as each call to the core costs as much as a few elements.
  const missing = order.filter((id) => !drawn.items.has(id));
  if (missing.length > 0) {
    core.drawn(editor, missing, crossedOut).forEach((items, at) => {
      drawn.items.set(missing[at]!, items);
    });
  }
  return order.flatMap((id) => drawn.items.get(id)!);
}

/**
 * What draws, back to front, but the text of `hidden`, which is being written. Images of the
 * `crossedOut` assets show where they lie, crossed out. `adding` stacks where an element added to
 * its `group`, or to the board without one, would.
 */
export function placed(
  opened: Opened,
  texts: Pick<Texts, "placed">,
  hidden?: string,
  crossedOut?: ReadonlySet<string>,
  adding?: { item: Placed; group: string | undefined },
): Placed[] {
  const { board } = opened;
  const place = (order: string[]) =>
    placing(stacked(opened, crossedOut, order), board, texts, hidden);
  if (!adding) {
    return place(board.draw_order);
  }
  const { draw_order: order } = board;
  const chosen = new Set(adding.group === undefined ? [] : [adding.group]);
  // On top of what the group holds, which stacks right after it.
  const end =
    adding.group === undefined
      ? order.length
      : order.findLastIndex((id) => among(board, id, chosen)) + 1;
  return [...place(order.slice(0, end)), adding.item, ...place(order.slice(end))];
}

/** As `placed`, while a picture of the elements `chosen`, their groups' elements included, shows over the board. */
export function exposing(
  opened: Opened,
  texts: Pick<Texts, "placed">,
  chosen: string[],
  { backing, light }: { backing: Placed[]; light: boolean },
  hidden?: string,
  crossedOut?: ReadonlySet<string>,
): Placed[] {
  const { board } = opened;
  const ids = new Set(chosen);
  const place = (order: string[]) =>
    placing(stacked(opened, crossedOut, order), board, texts, hidden);
  const shown = place(board.draw_order.filter((id) => among(board, id, ids)));
  return [
    ...place(board.draw_order.filter((id) => !among(board, id, ids))),
    ...backing,
    ...(light ? shown.map((item) => ({ ...item, light })) : shown),
  ];
}

/** What `items` draw, their texts as `texts` lays them out, but that of `hidden` and those not laid out. */
export function placing(
  items: Item[],
  { elements }: Board,
  texts: Pick<Texts, "placed">,
  hidden?: string,
): Placed[] {
  return items.flatMap((item): Placed[] => {
    if (item.kind !== "text") {
      return [item];
    }
    const kind = elements[item.id]?.kind;
    const text = item.id !== hidden && holdsText(kind) ? texts.placed(item.id, kind) : undefined;
    return text ? [{ kind: "text", ...text, opacity: item.opacity }] : [];
  });
}

/** What the elements draw over, with the points their comments are pinned at, `undefined` when nothing. */
export function extent({ editor, board }: Opened, ids = board.draw_order): Rect | undefined {
  return core.extent(editor, ids);
}

/** Whether any of the elements is an unlocked image, or a group holding one, which edits reach. */
export function holdsImage({ board, editor }: Opened, ids: string[]): boolean {
  const chosen = new Set(ids);
  return Object.entries(board.elements).some(
    ([id, { kind }]) =>
      kind.type === "image" && among(board, id, chosen) && editor.lockedBy(id) === undefined,
  );
}

/** Those of the images among the elements, or within groups among them, once each. */
export function assetsOf(board: Board, ids: string[]): string[] {
  const chosen = new Set(ids);
  const assets = Object.entries(board.elements).flatMap(([id, { kind }]) =>
    kind.type === "image" && among(board, id, chosen) ? [kind.asset] : [],
  );
  return [...new Set(assets)];
}

/** The bytes of those of a board's assets that are asked for, by asset, each left out where unread. */
export type Reader = (assets: string[]) => Promise<Map<string, Blob>>;

/**
 * Reads those of `assets` that a paste asks for from `from`, once it asks, or all of them at once
 * when `saver` is given, while it writes nothing, as the board's files may be gone by then.
 */
export function reader(from: Opened, assets: string[], saver?: Pick<Saving, "during">): Reader {
  const held = new Map(
    assets.flatMap((asset) => {
      const blob = from.added.get(core.assetPath(asset));
      return blob ? [[asset, blob] as const] : [];
    }),
  );
  // What it returns is made out of this scope, which would keep the board.
  if (saver === undefined) {
    return later(from.folder, held);
  }
  // From the folder as the save under way leaves it, which may move the board's files.
  return picking(saver.during(() => readAssets(from.folder, held, assets)));
}

function later(folder: Folder, held: Map<string, Blob>): Reader {
  return (wanted) => readAssets(folder, held, wanted);
}

function picking(read: Promise<Map<string, Blob>>): Reader {
  return async (wanted) => {
    const bytes = await read;
    return new Map(
      wanted.flatMap((asset) => (bytes.has(asset) ? [[asset, bytes.get(asset)!]] : [])),
    );
  };
}

/**
 * Holds in `added` the assets that undo or redo may bring back and `holds` lacks, read from `from`
 * while it is still there. One it cannot read is left out, as on a board that lacks it.
 */
export async function retain(
  opened: Opened,
  from: Folder,
  holds: (path: string) => boolean,
): Promise<void> {
  const lacking = opened.editor.historyAssets().filter((asset) => {
    const path = core.assetPath(asset);
    return !holds(path) && !opened.added.has(path);
  });
  const read = await readAssets(from, new Map(), lacking);
  read.forEach((blob, asset) => opened.added.set(core.assetPath(asset), blob));
}

async function readAssets(
  folder: Folder,
  held: Map<string, Blob>,
  wanted: string[],
): Promise<Map<string, Blob>> {
  const bytes = new Map<string, Blob>();
  for (const asset of wanted) {
    try {
      bytes.set(asset, held.get(asset) ?? new Blob([await folder.read(core.assetPath(asset))]));
    } catch {
      // As on a board that lacks it.
    }
  }
  return bytes;
}

export function copiedAssets({ elements }: Copied): string[] {
  const assets = Object.values(elements).flatMap(({ kind }) =>
    kind.type === "image" ? [kind.asset] : [],
  );
  return [...new Set(assets)];
}

/** Whether the element is one of `chosen`, or within a group among them. */
export function among({ elements }: Board, id: string, chosen: Set<string>): boolean {
  // Up through its groups, which reading a board leaves without cycles.
  for (let at: string | undefined = id; at !== undefined; at = elements[at]?.group) {
    if (chosen.has(at)) {
      return true;
    }
  }
  return false;
}

/** How many images are read, decoded, or prepared at once, which bounds the memory in flight. */
export const AT_ONCE = 4;

/**
 * Runs `work` on each item `next` hands out, `AT_ONCE` at a time, until it hands out none. Once
 * one throws, it hands out no more, and throws that once the items under way are done.
 */
export async function pool<T>(
  next: () => T | undefined,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let failure: { reason: unknown } | undefined;
  const worker = async () => {
    while (failure === undefined) {
      try {
        const item = next();
        if (item === undefined) {
          return;
        }
        await work(item);
      } catch (reason) {
        failure ??= { reason };
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  if (failure !== undefined) {
    throw failure.reason;
  }
}

/** The natural size of each asset its images show, in the order they draw. */
export function assetSizes(board: Board): Map<string, Size> {
  const sizes = new Map<string, Size>();
  for (const id of board.draw_order) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image" && !sizes.has(kind.asset)) {
      sizes.set(kind.asset, kind.natural_size);
    }
  }
  return sizes;
}

/** How each asset plays, as all its images do. */
export function assetPlayback(board: Board): Map<string, Pick<core.ImageEdits, "trim" | "speed">> {
  const played = new Map<string, Pick<core.ImageEdits, "trim" | "speed">>();
  for (const id of board.draw_order) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image" && !played.has(kind.asset)) {
      played.set(kind.asset, core.editsOf(kind));
    }
  }
  return played;
}

/** Throws when it is missing or does not match its digest. */
export async function readAsset(folder: Folder, asset: string, natural: Size): Promise<Asset> {
  const bytes = await folder.read(core.assetPath(asset));
  core.verifyAsset(asset, await digest(bytes));
  const start = core.mediaStart();
  const media =
    core.media(bytes.subarray(0, start), bytes.length <= start) ?? core.media(bytes, true)!;
  if (media.kind === "video") {
    const video = new Blob([bytes], { type: media.type });
    return { asset, blob: video, natural, vector: false, video };
  }
  // Markup that is no SVG shows crossed out, as an image this machine cannot decode.
  const vector = media.kind === "svg" || media.kind === "markup";
  return { asset, blob: new Blob([bytes]), natural, vector, moving: movingOf(media, bytes) };
}

/** Each as `decodeAsset` decodes it, but those this machine cannot decode or play, which are left out. */
export async function decode(assets: Asset[], cap: number): Promise<Map<string, Decoded>> {
  const decoded = new Map<string, Decoded>();
  const pending = assets.values();
  await pool(
    () => pending.next().value,
    async (asset) => {
      try {
        decoded.set(asset.asset, await decodeAsset(asset, cap));
      } catch {}
    },
  );
  return decoded;
}

/**
 * A bitmap with its longest side capped at `cap` pixels, or a video's first frame at the video's
 * own size, as its frames go onto the same texture. Throws when this machine cannot decode it or
 * play it.
 */
export async function decodeAsset(
  { blob, natural, vector, video }: Asset,
  cap: number,
): Promise<Decoded> {
  if (video) {
    return (await firstFrame(video)).bitmap;
  }
  if (vector) {
    return picture(new Uint8Array(await blob.arrayBuffer()), natural);
  }
  const { width, height } = capped(natural, cap);
  return createImageBitmap(blob, {
    imageOrientation: "from-image",
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
}

export function capped(size: Size, cap: number): Size {
  const scale = Math.min(1, cap / Math.max(size.width, size.height));
  return scaled(size, scale);
}

/** A pixel a side at least, as a thin image would round to none. */
export function scaled({ width, height }: Size, scale: number): Size {
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
