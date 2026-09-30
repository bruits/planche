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
  isAssetFile,
  isBoardFile,
  locateZipDirectory,
  newBoardFiles,
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
  | { type: "shape"; frame: Rect; rotation: number; shape: "rectangle" | "ellipse"; text: Text }
  | { type: "arrow"; from: Point; to: Point }
  | { type: "group" };

export interface Element {
  group?: string;
  z: string;
  kind: Kind;
}

export interface Board {
  elements: Record<string, Element>;
  /** Back to front. */
  draw_order: string[];
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
