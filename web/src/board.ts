// A board as the app opens it: its files through the platform, edited by the core, and its
// images decoded by the browser.

import type { Moving } from "./animation.js";
import * as core from "./core.js";
import type { Board, Bytes, Editor, Files, Kind, Point, Rect, Size } from "./core.js";
import { milliseconds, timed } from "./metrics.js";
import type { Folder } from "./platform.js";
import type { Placed } from "./renderer.js";
import { holdsText, type Texts } from "./text.js";
import { picture, type Picture } from "./vector.js";
import { VIDEO_LIMIT, firstFrame } from "./video.js";

export interface Opened {
  folder: Folder;
  editor: Editor;
  /** The editor's board, as `refresh` keeps it. */
  board: Board;
  /** The assets of the images added since it opened, by path, which its folder lacks. */
  added: Map<string, Blob>;
}

/**
 * A bitmap capped as `decode` caps them, or a video's first frame, or an SVG, which is
 * rasterised as it shows.
 */
export type Decoded = ImageBitmap | Picture;

/** An image to add, decoded. */
export interface Added {
  asset: string;
  bytes: Blob;
  natural: Size;
  decoded: Decoded;
  moving?: Moving;
  /** Typed, to play from. */
  video?: Blob;
  filename?: string;
}

/** An asset that images show, still encoded. */
export interface Asset {
  asset: string;
  blob: Blob;
  natural: Size;
  vector: boolean;
  moving?: Moving;
  /** The blob, when a video. */
  video?: Blob;
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
  const type = core.videoType(new Uint8Array(await bytes.slice(0, core.VIDEO_START).arrayBuffer()));
  if (type !== undefined) {
    return prepareVideo(bytes, type);
  }
  const whole = new Uint8Array(await bytes.arrayBuffer());
  const vector = checkedSvgSize(whole);
  const asset = await digest(whole);
  if (vector !== undefined) {
    return { asset, bytes, natural: vector, decoded: await picture(whole, vector) };
  }
  // Its first frame, when it moves.
  const full = await createImageBitmap(bytes, { imageOrientation: "from-image" });
  const natural = { width: full.width, height: full.height };
  const moving = moves(whole);
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

async function prepareVideo(bytes: Blob, type: string): Promise<Added> {
  if (bytes.size > VIDEO_LIMIT) {
    throw new Error(`it is over the ${VIDEO_LIMIT / 1e6} MB limit for videos`);
  }
  const video = new Blob([bytes], { type });
  const { bitmap, natural } = await firstFrame(video);
  try {
    const asset = await digest(new Uint8Array(await bytes.arrayBuffer()));
    return { asset, bytes, natural, decoded: bitmap, video };
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

/** Only a GIF, a PNG, or a WebP may move, and only their bytes are worth copying into the core. */
function moves(bytes: Bytes): Moving | undefined {
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  const may = head.startsWith("GIF8") || head.startsWith("\x89PNG") || (head.startsWith("RIFF") && head.endsWith("WEBP"));
  const plays = may ? core.animationPlays(bytes) : undefined;
  return plays === undefined ? undefined : { bytes, plays };
}

export function release(decoded: Decoded): void {
  if (decoded instanceof ImageBitmap) {
    decoded.close();
  }
}

/**
 * An SVG's natural size, `undefined` for bytes that do not start as markup, which only then are
 * worth copying into the core. Throws for other markup, such as HTML.
 */
function checkedSvgSize(bytes: Bytes): Size | undefined {
  if (!new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().startsWith("<")) {
    return undefined;
  }
  const size = core.svgSize(bytes);
  if (size === undefined) {
    throw new Error("markup that is not an SVG");
  }
  return size;
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

export function imageKind(asset: string, natural: Size, frame: Rect, filename?: string): Kind {
  const edits = { crop: null, flip_horizontal: false, flip_vertical: false, greyscale: false };
  return { type: "image", asset, natural_size: natural, frame, rotation: 0, edits, filename };
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
  board.background = core.background(editor);
}

/** The longest an arrow's head is, in board units, and the most of its arrow it takes. */
const HEAD_LENGTH = 16;
const HEAD_SHARE = 1 / 3;
/** Between each side of an arrow's head and its line, in radians. */
const HEAD_ANGLE = Math.PI / 6;

/**
 * What draws, back to front, but the text of `hidden`, which is being written. Images of the
 * `unplayable` videos show where they lie, crossed out.
 */
export function placed(
  board: Board,
  texts: Texts,
  hidden?: string,
  unplayable: ReadonlySet<string> = new Set(),
): Placed[] {
  const width = core.strokeWidth();
  return board.draw_order.flatMap((id): Placed[] => {
    const { kind } = board.elements[id]!;
    const text = holdsText(kind) ? texts.placed(id, kind) : undefined;
    const written = text && id !== hidden ? [text] : [];
    switch (kind.type) {
      case "image": {
        const { frame, rotation } = kind;
        return unplayable.has(kind.asset)
          ? [
              { kind: "rectangle", frame, rotation, width },
              { kind: "cross", frame, rotation, width },
            ]
          : [image(kind)];
      }
      case "arrow":
        return arrow(kind.from, kind.to, width);
      case "line":
        return [{ kind: "line", from: kind.from, to: kind.to, width }];
      case "note":
        return written;
      case "sticky":
        return [{ kind: "fill", frame: kind.frame, rotation: kind.rotation, paint: "sticky" }, ...written];
      case "shape":
        return [{ kind: kind.shape, frame: kind.frame, rotation: kind.rotation, width }, ...written];
      case "comment":
      case "group":
        return [];
    }
  });
}

function image(kind: Extract<Kind, { type: "image" }>): Placed {
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
  return { kind: "image", asset: kind.asset, frame: kind.frame, rotation: kind.rotation, texture, greyscale };
}

/** Its line, and the two strokes of an open head at `to`. */
function arrow(from: Point, to: Point, width: number): Placed[] {
  const line = { kind: "line" as const, from, to, width };
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  if (span === 0) {
    return [line];
  }
  const head = Math.min(HEAD_LENGTH, span * HEAD_SHARE);
  const back = Math.atan2(from.y - to.y, from.x - to.x);
  const side = (angle: number) => ({
    ...line,
    from: to,
    to: { x: to.x + Math.cos(back + angle) * head, y: to.y + Math.sin(back + angle) * head },
  });
  return [line, side(HEAD_ANGLE), side(-HEAD_ANGLE)];
}

/** What the board draws over, with the points its comments are pinned at, `undefined` when nothing. */
export function extent({ editor, board }: Opened): Rect | undefined {
  const drawn = core.bounds(editor, board.draw_order);
  const points = board.draw_order.flatMap((id) => {
    const { kind } = board.elements[id]!;
    return kind.type === "comment" ? [kind.at] : [];
  });
  if (drawn) {
    points.push({ x: drawn.x, y: drawn.y }, { x: drawn.x + drawn.width, y: drawn.y + drawn.height });
  }
  if (points.length === 0) {
    return undefined;
  }
  const [xs, ys] = [points.map(({ x }) => x), points.map(({ y }) => y)];
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Whether any of the elements is an image, or a group holding one. */
export function holdsImage(board: Board, ids: string[]): boolean {
  return assetsOf(board, ids).length > 0;
}

/** Those of the images among the elements, or within groups among them, once each. */
export function assetsOf(board: Board, ids: string[]): string[] {
  const chosen = new Set(ids);
  const assets = Object.entries(board.elements).flatMap(([id, { kind }]) =>
    kind.type === "image" && among(board, id, chosen) ? [kind.asset] : [],
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

/** Each asset its images show, once. Throws when one is missing or does not match its digest. */
export async function readAssets({ folder, board }: Opened): Promise<Asset[]> {
  const assets = new Map<string, Asset>();
  for (const id of board.draw_order) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image" && !assets.has(kind.asset)) {
      const bytes = await folder.read(core.assetPath(kind.asset));
      core.verifyAsset(kind.asset, bytes);
      const natural = kind.natural_size;
      const type = core.videoType(bytes);
      if (type === undefined) {
        const vector = checkedSvgSize(bytes) !== undefined;
        assets.set(kind.asset, { asset: kind.asset, blob: new Blob([bytes]), natural, vector, moving: moves(bytes) });
      } else {
        const video = new Blob([bytes], { type });
        assets.set(kind.asset, { asset: kind.asset, blob: video, natural, vector: false, video });
      }
    }
  }
  return [...assets.values()];
}

/**
 * Bitmaps with their longest side capped at `cap` pixels, and a video's first frame at the video's
 * own size, as its frames go onto the same texture. Four decode at once, to bound the memory in
 * flight. A video this machine cannot play is left out, for the board to open all the same.
 */
export async function decode(assets: Asset[], cap: number): Promise<Map<string, Decoded>> {
  const decoded = new Map<string, Decoded>();
  const pending = assets.values();
  const worker = async () => {
    for (const { asset, blob, natural, vector, video } of pending) {
      if (video) {
        await firstFrame(video).then(
          ({ bitmap }) => decoded.set(asset, bitmap),
          () => undefined,
        );
        continue;
      }
      if (vector) {
        decoded.set(asset, await picture(new Uint8Array(await blob.arrayBuffer()), natural));
        continue;
      }
      const { width, height } = capped(natural, cap);
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "high",
      });
      decoded.set(asset, bitmap);
    }
  };
  const done = await Promise.allSettled(Array.from({ length: 4 }, worker));
  const failed = done.find((result) => result.status === "rejected");
  if (failed) {
    decoded.forEach(release);
    throw failed.reason;
  }
  return decoded;
}

function capped(size: Size, cap: number): Size {
  const scale = Math.min(1, cap / Math.max(size.width, size.height));
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}
