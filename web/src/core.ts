// The Rust core, compiled to WASM. It owns the board model and file format; the shells only
// move bytes.

import init, {
  AssetHasher,
  Crc32,
  Editor,
  Known,
  MatroskaFrames,
  Snapshot,
  ZipIndex,
  ZipWriter,
  assetOf,
  assetPath,
  checkedColour,
  checkedStyle,
  drawnKind as drawnAlone,
  fileDepth,
  frameDelays as delays,
  gridLevel as level,
  isAssetFile,
  isBoardFile,
  isStrayElement,
  keeping as keep,
  locateZipDirectory,
  media as told,
  mediaStart,
  movieFrames,
  movieIndex as indexIn,
  newBoardFiles,
  snapScaleToGrid as snapScale,
  snapDrawnToNeighbours as drawnNeighbours,
  snapScaleToNeighbours as scaleNeighbours,
  snapToGrid as snap,
  snapToNeighbours as snapNeighbours,
  sizedSvg as sized,
  strokeKind as stroked,
  strokeWidth as width,
  cornerParts,
  plainStyle,
  styleSettings,
  textArea,
  verifyAsset as verify,
  withStyle as styled,
  zipTailLength,
} from "./wasm/bindings.js";
import type {
  Align,
  Alignment,
  Axis,
  Background,
  Board,
  Colour,
  Copied,
  CropShape,
  Dash,
  Drawn,
  Element,
  ElementKind as Kind,
  End,
  Fill,
  Heads,
  ImageEdits,
  Item,
  Media,
  Order,
  Paint,
  Paper,
  Point,
  Pull,
  Rect,
  Restack,
  Scale,
  Scaled,
  Setting,
  Shape,
  Side,
  Size,
  Style,
  Text,
  Tip,
  Transform,
  Trim,
  Weight,
} from "./wasm/bindings.js";

export {
  Editor,
  Known,
  MatroskaFrames,
  Snapshot,
  ZipIndex,
  ZipWriter,
  assetOf,
  assetPath,
  fileDepth,
  isAssetFile,
  isBoardFile,
  isStrayElement,
  locateZipDirectory,
  movieFrames,
  zipTailLength,
};

export type Bytes = Uint8Array<ArrayBuffer>;

/** Board files by path, with `/` between segments on every platform. */
export type Files = Map<string, Bytes>;

export type {
  Align,
  Alignment,
  Axis,
  Background,
  Board,
  Colour,
  Copied,
  CropShape,
  Dash,
  Drawn,
  Element,
  Kind,
  End,
  Fill,
  Heads,
  ImageEdits,
  Item,
  Media,
  Order,
  Paint,
  Paper,
  Point,
  Pull,
  Rect,
  Restack,
  Scale,
  Scaled,
  Setting,
  Shape,
  Side,
  Size,
  Style,
  Text,
  Tip,
  Transform,
  Trim,
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

/** The SHA-256 digest of `bytes` alone, which `assetOf` names their asset from. */
export function digestOf(bytes: Bytes): string {
  const hasher = new AssetHasher();
  feed(hasher, bytes);
  return hasher.finish();
}

/** Throws the core's error when `found`, the digest of bytes read for `asset`, is not its. */
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

/**
 * What each of `ids` draws itself, back to front. Images of the `crossedOut` assets draw where
 * they lie, crossed out.
 */
export function drawn(editor: Editor, ids: string[], crossedOut: ReadonlySet<string>): Item[][] {
  return JSON.parse(editor.drawn(ids, [...crossedOut])) as Item[][];
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

/** For every image of their assets too. The whole of each when `undefined`. */
export function setTrim(editor: Editor, ids: string[], trim: Trim | undefined): string[] {
  return editor.setTrim(ids, trim && JSON.stringify(trim));
}

/**
 * How long each frame of an animated image shows, in milliseconds, `undefined` when `bytes` are
 * not an image of more than one frame.
 */
export function frameDelays(bytes: Bytes): number[] | undefined {
  const found = delays(bytes);
  return found && Array.from(found);
}

/**
 * Of the box starting at `from` in a movie `length` bytes long, given by `window`, its first 16
 * bytes or as many as are left: where the movie's index lies when it is that box, or else where
 * the next box starts, `undefined` past the end or for a box cut short.
 */
export function movieIndex(
  length: number,
  from: number,
  window: Bytes,
): [start: number, end: number] | number | undefined {
  const found = indexIn(length, from, window);
  return found === undefined ? undefined : found.length === 2 ? [found[0]!, found[1]!] : found[0];
}

/**
 * A stroke of `tip`, a pen's when `undefined`, through `points`, in board units, framed by them,
 * without those that stray less than `tolerance` from the line through the others.
 */
export function strokeKind(
  points: Point[],
  tolerance: number,
  tip?: Tip,
): Extract<Kind, { type: "stroke" }> {
  const flat = Float64Array.from(points.flatMap(({ x, y }) => [x, y]));
  return JSON.parse(stroked(flat, tolerance, tip)) as Extract<Kind, { type: "stroke" }>;
}

/** What `kind` draws on its own, as an element of the board would. */
export function drawnKind(kind: Kind): Item[] {
  return JSON.parse(drawnAlone(JSON.stringify(kind))) as Item[];
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

const highlights = new Map<Colour, Paint>();

/** As a highlighter draws `painted`. */
export function highlighted(painted: Colour): Paint {
  let found = highlights.get(painted);
  if (found === undefined) {
    const [stroke] = drawnKind({
      ...strokeKind([{ x: 0, y: 0 }], 0, "highlighter"),
      colour: painted,
    });
    if (stroke?.kind !== "stroke") {
      throw new Error("A highlighter draws no stroke");
    }
    found = stroke.paint;
    highlights.set(painted, found);
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

/**
 * Where `moving` lands among `neighbours`, as `Editor.neighbours` gives them, that `window` shows,
 * or else on the grid's lines when `grid`, at `zoom` CSS pixels per board unit.
 */
export function snapToNeighbours(
  moving: Rect,
  neighbours: Float64Array,
  window: Rect,
  zoom: number,
  grid: boolean,
): Pull {
  const pull = snapNeighbours(packed(moving), neighbours, packed(window), zoom, grid);
  return JSON.parse(pull) as Pull;
}

/**
 * What the box `scale` has scales by instead to line up with `neighbours`, as `Editor.neighbours`
 * gives them, that `window` shows, at `zoom` CSS pixels per board unit.
 */
export function snapScaleToNeighbours(
  scale: Scale,
  neighbours: Float64Array,
  window: Rect,
  zoom: number,
): Scaled {
  const scaled = scaleNeighbours(JSON.stringify(scale), neighbours, packed(window), zoom);
  return JSON.parse(scaled) as Scaled;
}

/**
 * Where a box drawn `from` one corner `to` the other lands among `neighbours`, as
 * `Editor.neighbours` gives them, that `window` shows, or else on the grid's lines when `grid`, at
 * `zoom` CSS pixels per board unit.
 */
export function snapDrawnToNeighbours(
  from: Point,
  to: Point,
  neighbours: Float64Array,
  window: Rect,
  zoom: number,
  grid: boolean,
): Drawn {
  const [first, last] = [Float64Array.of(from.x, from.y), Float64Array.of(to.x, to.y)];
  const landed = drawnNeighbours(first, last, neighbours, packed(window), zoom, grid);
  return JSON.parse(landed) as Drawn;
}

function packed(area: Rect): Float64Array {
  return Float64Array.of(area.x, area.y, area.width, area.height);
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

/** The elements, with all that their groups hold, as `paste` takes them. */
export function copy(editor: Editor, ids: string[]): Copied {
  return JSON.parse(editor.copy(ids)) as Copied;
}

/** On top of `group`, or of the top level, each element of `copied` under the id `ids` maps its own to. */
export function paste(
  editor: Editor,
  copied: Copied,
  ids: Record<string, string>,
  group: string | undefined,
): string[] {
  return editor.paste(JSON.stringify(copied), JSON.stringify(ids), group);
}

/** Of the elements that `ids` names, those that a paste into `group` laid there. */
export function outermost(
  editor: Editor,
  ids: Record<string, string>,
  group: string | undefined,
): string[] {
  return Object.values(ids).filter((id) => {
    const pasted = element(editor, id);
    return pasted !== undefined && pasted.group === group;
  });
}

/** Without the images whose assets are not among `assets`, nor the groups that empties. */
export function keeping(copied: Copied, assets: string[]): Copied {
  return JSON.parse(keep(JSON.stringify(copied), assets)) as Copied;
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

const areas = new Map<string, Readonly<Rect>>();

/**
 * Where the text of a shape lies, in parts of its frame before it turns, which its shape and its
 * corners alone tell.
 */
export function textAreaOf(kind: Extract<Kind, { type: "shape" }>): Readonly<Rect> {
  const key = `${kind.shape} ${kind.corners ?? ""}`;
  let found = areas.get(key);
  if (found === undefined) {
    found = rect(textArea(JSON.stringify(kind)))!;
    areas.set(key, found);
  }
  return found;
}

const polygons = new Map<string, readonly Point[] | undefined>();

/** How far `kind` turns, which an element's file leaves out when it does not. */
export function rotationOf(kind: Kind): number {
  return ("rotation" in kind ? kind.rotation : undefined) ?? 0;
}

const UNEDITED: Readonly<ImageEdits> = Object.freeze({
  crop: null,
  flip_horizontal: false,
  flip_vertical: false,
  greyscale: false,
});

/** An image's edits, which its file leaves out when it has none. */
export function editsOf(image: Extract<Kind, { type: "image" }>): Readonly<ImageEdits> {
  return image.edits ?? UNEDITED;
}

/**
 * Where the corners of a `shape` drawn as a polygon lie, with `corners` of its own when it counts
 * them, in parts of its frame before it turns, `undefined` for any other shape.
 */
export function cornerPartsOf(shape: Shape, corners: number): readonly Point[] | undefined {
  const key = `${shape} ${corners}`;
  if (!polygons.has(key)) {
    const flat = cornerParts(shape, corners);
    polygons.set(
      key,
      flat &&
        Array.from({ length: flat.length / 2 }, (_, at) => ({
          x: flat[2 * at]!,
          y: flat[2 * at + 1]!,
        })),
    );
  }
  return polygons.get(key);
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
  } catch (error) {
    return refused(error);
  }
}

/** `colour` when it is one, as the core spells it. */
export function colour(text: unknown): Colour | undefined {
  try {
    return typeof text === "string" ? (checkedColour(text) as Colour) : undefined;
  } catch (error) {
    return refused(error);
  }
}

/**
 * Nothing for what the core refuses. Its bindings throw a `TypeError` before it starts, which read
 * as nothing would lose what the browser remembers.
 */
function refused(error: unknown): undefined {
  if (error instanceof TypeError) {
    throw error;
  }
  return undefined;
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
