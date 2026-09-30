// The Rust core, compiled to WASM. It owns the board model and file format; the shells only
// move bytes.

import init, {
  Editor,
  Snapshot,
  ZipIndex,
  ZipWriter,
  assetId,
  assetPath,
  fileDepth,
  gridLevel as level,
  isAssetFile,
  isBoardFile,
  locateZipDirectory,
  newBoardFiles,
  snapScaleToGrid as snapScale,
  snapToGrid as snap,
  strokeWidth,
  verifyAsset,
  zipTailLength,
} from "./wasm/bindings.js";

export {
  Editor,
  Snapshot,
  ZipIndex,
  ZipWriter,
  assetId,
  assetPath,
  fileDepth,
  isAssetFile,
  isBoardFile,
  locateZipDirectory,
  strokeWidth,
  verifyAsset,
  zipTailLength,
};

export type Bytes = Uint8Array<ArrayBuffer>;

/** Board files by path, with `/` between segments on every platform. */
export type Files = Map<string, Bytes>;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Text {
  content: string;
  /** In board units. */
  font_size: number;
}

/** Mirrors `board::ElementKind`, as far as the shells read it. */
export type Kind =
  | {
      type: "image";
      asset: string;
      natural_size: Size;
      frame: Rect;
      rotation: number;
      edits: { crop: Rect | null; flip_horizontal: boolean; flip_vertical: boolean; greyscale: boolean };
    }
  | { type: "note"; frame: Rect; rotation: number; text: Text }
  | { type: "sticky"; frame: Rect; rotation: number; text: Text }
  | { type: "shape"; frame: Rect; rotation: number; shape: "rectangle" | "ellipse" | "cross"; text: Text }
  | { type: "arrow"; from: Point; to: Point; from_target?: string; to_target?: string }
  | { type: "line"; from: Point; to: Point; from_target?: string; to_target?: string }
  | { type: "comment"; at: Point; text: string }
  | { type: "group" };

export interface Element {
  group?: string;
  z: string;
  kind: Kind;
}

export type Background = "plain" | "grid" | "dots";

export interface Board {
  elements: Record<string, Element>;
  /** Back to front. */
  draw_order: string[];
  background: Background;
}

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

export function setBackground(editor: Editor, background: Background): void {
  editor.setBackground(JSON.stringify(background));
}

/** At `zoom` CSS pixels per board unit. */
export function gridLevel(zoom: number): GridLevel {
  const [spacing, fade, coarse] = level(zoom);
  return { spacing: spacing!, fade: fade!, coarse: coarse! };
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
export function snapScaleToGrid(origin: Point, corner: Point, factor: number, zoom: number): number | undefined {
  return snapScale(origin.x, origin.y, corner.x, corner.y, factor, zoom);
}

export interface Stuck {
  target: string;
  at: Point;
}

/**
 * Where an end let go at `at` sticks, onto the outline of what it sticks to when within
 * `tolerance` of it, `undefined` when nothing there takes ends.
 */
export function stick(editor: Editor, at: Point, tolerance: number): Stuck | undefined {
  const json = editor.stick(at.x, at.y, tolerance);
  return json === undefined ? undefined : (JSON.parse(json) as Stuck);
}

/** What the elements draw over, their groups' elements included, `undefined` when nothing. */
export function bounds(editor: Editor, ids: string[]): Rect | undefined {
  const bounds = editor.bounds(ids);
  return bounds && { x: bounds[0]!, y: bounds[1]!, width: bounds[2]!, height: bounds[3]! };
}

/** Every file but the assets. */
export function write(snapshot: Snapshot): Files {
  return snapshot.write() as Files;
}

/** The files a new board folder starts with, besides those of `write`. */
export function newFiles(): Files {
  return newBoardFiles() as Files;
}
