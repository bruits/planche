// A board as the app opens it: its files through the platform, edited by the core, and its
// images decoded by the browser.

import * as core from "./core.js";
import type { Board, Bytes, Editor, Files, Kind, Point, Rect, Size } from "./core.js";
import { milliseconds, timed } from "./metrics.js";
import type { Folder } from "./platform.js";
import type { Placed } from "./renderer.js";

export interface Opened {
  folder: Folder;
  editor: Editor;
  /** The editor's board, as `refresh` keeps it. */
  board: Board;
  /** The assets of the images added since it opened, by path, which its folder lacks. */
  added: Map<string, Blob>;
}

/** An image to add, decoded. */
export interface Added {
  asset: string;
  bytes: Blob;
  natural: Size;
  /** Capped as `decode` caps them. */
  bitmap: ImageBitmap;
}

/** An asset that images show, still encoded. */
export interface Asset {
  asset: string;
  blob: Blob;
  natural: Size;
}

/**
 * The board in the folder that `pick` gives, `null` when the user cancels. Otherwise replaces
 * `timings` with how long each step took.
 */
export async function open(
  pick: () => Promise<Folder | null>,
  timings: Map<string, string>,
): Promise<Opened | null> {
  const folder = await pick();
  if (folder === null) {
    return null;
  }
  const [paths, listing] = await timed(() => folder.list(core.fileDepth()));
  const [files, reading] = await timed(async () => {
    const files: Files = new Map();
    for (const path of paths.filter(core.isBoardFile)) {
      files.set(path, await folder.read(path));
    }
    return files;
  });
  const [editor, parsing] = await timed(() => core.read(files));
  timings.clear();
  timings.set(`list ${paths.length} files`, milliseconds(listing));
  timings.set(`read ${files.size} files`, milliseconds(reading));
  timings.set("parse", milliseconds(parsing));
  return { folder, editor, board: core.board(editor), added: new Map() };
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
  return { folder, editor, board: core.board(editor), added: new Map() };
}

/** Its files as they stand: its folder's, and the assets of the images added since. */
export function files({ folder, added }: Opened): Folder {
  return {
    ...folder,
    read: async (path) => {
      const blob = added.get(path);
      return blob ? (new Uint8Array(await blob.arrayBuffer()) as Bytes) : folder.read(path);
    },
  };
}

/** Throws when the bytes are not an image the host can decode. */
export async function prepare(bytes: Blob, cap: number): Promise<Added> {
  const head = new Uint8Array(await bytes.slice(0, 256).arrayBuffer());
  // Vector images have no size of their own in pixels, and hosts decode them unevenly.
  if (new TextDecoder().decode(head).trimStart().startsWith("<")) {
    throw new Error("an SVG or other vector image");
  }
  const asset = await digest(new Uint8Array(await bytes.arrayBuffer()));
  const full = await createImageBitmap(bytes, { imageOrientation: "from-image" });
  const natural = { width: full.width, height: full.height };
  const { width, height } = capped(natural, cap);
  if (width === natural.width && height === natural.height) {
    return { asset, bytes, natural, bitmap: full };
  }
  const bitmap = await createImageBitmap(full, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  }).finally(() => full.close());
  return { asset, bytes, natural, bitmap };
}

export function newId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The asset id of `bytes`, which the host hashes without holding the page up where it can. Only
 * a secure context can, which the macOS webview may not be.
 */
async function digest(bytes: Bytes): Promise<string> {
  return crypto.subtle ? hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) : core.assetId(bytes);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function imageKind(asset: string, natural: Size, frame: Rect): Kind {
  const edits = { crop: null, flip_horizontal: false, flip_vertical: false, greyscale: false };
  return { type: "image", asset, natural_size: natural, frame, rotation: 0, edits };
}

export function row(sizes: Size[], at: Point): Rect[] {
  let x = at.x - sizes.reduce((sum, { width }) => sum + width, 0) / 2;
  return sizes.map(({ width, height }) => {
    const frame = { x, y: at.y - height / 2, width, height };
    x += width;
    return frame;
  });
}

export function refresh({ editor, board }: Opened, touched: string[]): void {
  for (const id of touched) {
    const element = core.element(editor, id);
    if (element === undefined) {
      delete board.elements[id];
    } else {
      board.elements[id] = element;
    }
  }
  board.draw_order = editor.drawOrder();
}

/** Its images, back to front. */
export function images(board: Board): Placed[] {
  return board.draw_order.flatMap((id) => {
    const { kind } = board.elements[id]!;
    if (kind.type !== "image") {
      return [];
    }
    const { width, height } = kind.natural_size;
    const { crop, flip_horizontal, flip_vertical, greyscale } = kind.edits;
    const shown = crop ?? { x: 0, y: 0, width, height };
    let [x, y] = [shown.x / width, shown.y / height];
    let [across, down] = [shown.width / width, shown.height / height];
    // Flipped within the crop.
    if (flip_horizontal) {
      [x, across] = [x + across, -across];
    }
    if (flip_vertical) {
      [y, down] = [y + down, -down];
    }
    const texture = { x, y, width: across, height: down };
    return [{ asset: kind.asset, frame: kind.frame, rotation: kind.rotation, texture, greyscale }];
  });
}

/** Whether any of the elements is an image, or a group holding one. */
export function holdsImage({ elements }: Board, ids: string[]): boolean {
  const chosen = new Set(ids);
  return Object.entries(elements).some(([id, { kind }]) => {
    if (kind.type !== "image") {
      return false;
    }
    // Up through its groups, which reading a board leaves without cycles.
    for (let at: string | undefined = id; at !== undefined; at = elements[at]?.group) {
      if (chosen.has(at)) {
        return true;
      }
    }
    return false;
  });
}

/** Each asset its images show, once. Throws when one is missing or does not match its digest. */
export async function readAssets({ folder, board }: Opened): Promise<Asset[]> {
  const assets = new Map<string, Asset>();
  for (const id of board.draw_order) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image" && !assets.has(kind.asset)) {
      const bytes = await folder.read(core.assetPath(kind.asset));
      core.verifyAsset(kind.asset, bytes);
      assets.set(kind.asset, { asset: kind.asset, blob: new Blob([bytes]), natural: kind.natural_size });
    }
  }
  return [...assets.values()];
}

/** With their longest side capped at `cap` pixels. Four decode at once, to bound the memory in flight. */
export async function decode(assets: Asset[], cap: number): Promise<Map<string, ImageBitmap>> {
  const bitmaps = new Map<string, ImageBitmap>();
  const pending = assets.values();
  const worker = async () => {
    for (const { asset, blob, natural } of pending) {
      const { width, height } = capped(natural, cap);
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "high",
      });
      bitmaps.set(asset, bitmap);
    }
  };
  const done = await Promise.allSettled(Array.from({ length: 4 }, worker));
  const failed = done.find((result) => result.status === "rejected");
  if (failed) {
    bitmaps.forEach((bitmap) => bitmap.close());
    throw failed.reason;
  }
  return bitmaps;
}

function capped(size: Size, cap: number): Size {
  const scale = Math.min(1, cap / Math.max(size.width, size.height));
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}
