// The Rust core, compiled to WASM. It owns the board model and file format; the shells only
// move bytes.

import init, {
  AssetHasher,
  Crc32,
  Editor,
  Known,
  Snapshot,
  ZipIndex,
  ZipWriter,
  assetPath,
  checkedColour,
  checkedStyle,
  fileDepth,
  frameDelay,
  gridLevel as level,
  isAssetFile,
  isBoardFile,
  isStrayElement,
  locateZipDirectory,
  media as told,
  mediaStart,
  newBoardFiles,
  snapScaleToGrid as snapScale,
  snapToGrid as snap,
  sizedSvg as sized,
  strokeWidth as width,
  plainStyle,
  styleSettings,
  verifyAsset as verify,
  withStyle as styled,
  zipTailLength,
} from "./wasm/bindings.js";
import type {
  Align,
  Background,
  Board,
  Colour,
  CropShape,
  Dash,
  Element,
  ElementKind as Kind,
  End,
  Fill,
  Heads,
  Media,
  Order,
  Paper,
  Point,
  Rect,
  Restack,
  Setting,
  Side,
  Size,
  Style,
  Text,
  Transform,
  Weight,
} from "./wasm/bindings.js";

export {
  Editor,
  Known,
  Snapshot,
  ZipIndex,
  ZipWriter,
  assetPath,
  fileDepth,
  frameDelay,
  isAssetFile,
  isBoardFile,
  isStrayElement,
  locateZipDirectory,
  zipTailLength,
};

export type Bytes = Uint8Array<ArrayBuffer>;

/** Board files by path, with `/` between segments on every platform. */
export type Files = Map<string, Bytes>;

export type {
  Align,
  Background,
  Board,
  Colour,
  CropShape,
  Dash,
  Element,
  Kind,
  End,
  Fill,
  Heads,
  Media,
  Order,
  Paper,
  Point,
  Rect,
  Restack,
  Setting,
  Side,
  Size,
  Style,
  Text,
  Transform,
  Weight,
};

/** The grid's lines that show at a zoom, in board units apart. */
export interface GridLevel {
  /** The finest ones. */
  spacing: number;
  /** How much the finest ones show, from 0 to 1. */
  fade: number;
  /** Those that show in full. */
  coarse: number;
}

let memory: WebAssembly.Memory | undefined;

export async function start(): Promise<void> {
  ({ memory } = await init());
}

/** The core's memory, which grows with the boards it reads and never shrinks. */
export function coreMemory(): number {
  return memory?.buffer.byteLength ?? 0;
}

/** The most bytes the core takes in one call to name or checksum a file, so that its memory does not grow with it. */
const SLICE = 8 * 2 ** 20;

function feed(sink: { update(slice: Bytes): void }, bytes: Bytes): void {
  for (let at = 0; at < bytes.length; at += SLICE) {
    sink.update(bytes.subarray(at, at + SLICE));
  }
}

export function assetId(bytes: Bytes): string {
  const hasher = new AssetHasher();
  feed(hasher, bytes);
  return hasher.finish();
}

/** Throws the core's error when `found`, the id of bytes read for `asset`, is not `asset`. */
export function verifyAsset(asset: string, found: string): void {
  verify(asset, found);
}

export function crc32(bytes: Bytes): number {
  const crc = new Crc32();
  feed(crc, bytes);
  return crc.finish();
}

/** Throws the core's error when the files are not a board. */
export function read(files: Files): Editor {
  return Editor.read([...files.keys()], [...files.values()]);
}

export function board(editor: Editor): Board {
  return JSON.parse(editor.json()) as Board;
}

export function element(editor: Editor, id: string): Element | undefined {
  const json = editor.element(id);
  return json === undefined ? undefined : (JSON.parse(json) as Element);
}

export function background(editor: Editor): Background {
  return JSON.parse(editor.background()) as Background;
}

export function setBackground(editor: Editor, to: Background): void {
  editor.setBackground(JSON.stringify(to));
}

export function setCropShape(editor: Editor, ids: string[], shape: CropShape): string[] {
  return editor.setCropShape(ids, JSON.stringify(shape));
}

const widths = new Map<Weight | undefined, number>();

/** How wide a stroke of `weight`, or of one as it comes, draws, in board units, as the core hits it. */
export function strokeWidth(weight?: Weight): number {
  let found = widths.get(weight);
  if (found === undefined) {
    found = width(weight);
    widths.set(weight, found);
  }
  return found;
}

/** At `zoom` CSS pixels per board unit. */
export function gridLevel(zoom: number): GridLevel {
  const [spacing, fade, coarse] = level(zoom);
  return { spacing: spacing!, fade: fade!, coarse: coarse! };
}

/**
 * What a file holds, from `bytes`, its start, or all of it when `whole`, `undefined` when its start
 * does not tell, as for a GIF, whose frames take the whole file.
 */
export function media(bytes: Bytes, whole: boolean): Media | undefined {
  const json = told(bytes, whole);
  return json === undefined ? undefined : (JSON.parse(json) as Media);
}

/** How much of a file's start tells what most files hold. */
export { mediaStart };

/** The SVG with its root sized to `natural`, for every host to draw it at that size. */
export function sizedSvg(bytes: Bytes, natural: Size): Bytes | undefined {
  return sized(bytes, natural.width, natural.height) as Bytes | undefined;
}

/**
 * How far to move along one axis for the nearest of `values` to land on a line of the grid that
 * shows at `zoom`, `undefined` when none is near enough.
 */
export function snapToGrid(values: number[], zoom: number): number | undefined {
  return snap(Float64Array.from(values), zoom);
}

/**
 * The factor near `factor` that scales `corner` around `origin` onto a line of the grid that
 * shows at `zoom`, `undefined` when none is near enough.
 */
export function snapScaleToGrid(
  origin: Point,
  corner: Point,
  factor: number,
  zoom: number,
): number | undefined {
  return snapScale(origin.x, origin.y, corner.x, corner.y, factor, zoom);
}

/** What the elements draw over, their groups' elements included, `undefined` when nothing. */
export function bounds(editor: Editor, ids: string[]): Rect | undefined {
  return rect(editor.bounds(ids));
}

/** As `bounds`, with the points where the comments among them are pinned. */
export function extent(editor: Editor, ids: string[]): Rect | undefined {
  return rect(editor.extent(ids));
}

function rect(box: Float64Array | undefined): Rect | undefined {
  return box && { x: box[0]!, y: box[1]!, width: box[2]!, height: box[3]! };
}

/** Each optional field of `T`, which JSON leaves out when `undefined`. */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

/** Throws the core's error, which leaves the board as it was, when any part of it is refused. */
export function transform(editor: Editor, ids: string[], how: Loose<Transform>): string[] {
  return editor.transform(ids, JSON.stringify(how));
}

/**
 * Where an end let go at `at` lands. Within `reach` of what it sticks to when it sticks, pulled by
 * the grid that shows at the zoom `pull` when it pulls, and at a multiple of 45° `around` the
 * other end when locked to it.
 */
export function landEnd(
  editor: Editor,
  at: Point,
  { around, reach, pull }: Loose<{ around: Point; reach: number; pull: number }>,
): End {
  return JSON.parse(editor.landEnd(at.x, at.y, around?.x, around?.y, reach, pull)) as End;
}

/** The pixel of the image `id` at `at`, as displayed, `undefined` when it is no image. */
export function pixelAt(editor: Editor, id: string, at: Point): Point | undefined {
  const pixel = editor.pixelAt(id, at.x, at.y);
  return pixel && { x: pixel[0]!, y: pixel[1]! };
}

/** Where the pixel of the image `id` lies, as `pixelAt` gives it. */
export function pointOfPixel(editor: Editor, id: string, pixel: Point): Point | undefined {
  const at = editor.pointOfPixel(id, pixel.x, pixel.y);
  return at && { x: at[0]!, y: at[1]! };
}

export function arrange(editor: Editor, ids: string[], order: Order): string[] {
  return editor.arrange(ids, JSON.stringify(order));
}

/** What alone tells the parts of a style a kind takes, and how each comes. */
function typeOf(kind: Kind): string {
  return kind.type === "shape" ? kind.shape : kind.type;
}

const taken = new Map<string, readonly Setting[]>();

/** The parts of a style `kind` takes. */
export function settings(kind: Kind): readonly Setting[] {
  let found = taken.get(typeOf(kind));
  if (found === undefined) {
    found = JSON.parse(styleSettings(JSON.stringify(kind))) as Setting[];
    taken.set(typeOf(kind), found);
  }
  return found;
}

const plains = new Map<string, Readonly<Style>>();

/**
 * Each part of a style `kind` takes as it comes, which a part it leaves out draws as, and none of
 * those it does not take.
 */
export function plain(kind: Kind): Readonly<Style> {
  let found = plains.get(typeOf(kind));
  if (found === undefined) {
    found = JSON.parse(plainStyle(JSON.stringify(kind))) as Style;
    plains.set(typeOf(kind), found);
  }
  return found;
}

/** `kind` with each part of `style` it takes, as it writes, so that a part as it comes writes nothing. */
export function withStyle<K extends Kind>(kind: K, style: Style): K {
  return JSON.parse(styled(JSON.stringify(kind), JSON.stringify(style))) as K;
}

/** `style` when it holds nothing but parts of a style, as the core spells them. */
export function checked(style: unknown): Style | undefined {
  try {
    return JSON.parse(checkedStyle(JSON.stringify(style))) as Style;
  } catch {
    return undefined;
  }
}

/** `colour` when it is one, as the core spells it. */
export function colour(text: unknown): Colour | undefined {
  try {
    return typeof text === "string" ? (checkedColour(text) as Colour) : undefined;
  } catch {
    return undefined;
  }
}

/** Every file but the assets. */
export function write(snapshot: Snapshot): Files {
  return snapshot.write() as Files;
}

export function known(listed: string[], files: Files): Known {
  return Known.read(listed, [...files.keys()], [...files.values()]);
}

/** The files a new board folder starts with, besides those of `write`. */
export function newFiles(): Files {
  return newBoardFiles() as Files;
}
