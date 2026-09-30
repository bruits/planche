// The Rust core, compiled to WASM. It owns the board model and file format; the shells only
// move bytes.

import init, {
  ZipIndex,
  ZipWriter,
  assetPath,
  fileDepth,
  isAssetFile,
  isBoardFile,
  locateZipDirectory,
  newBoardFiles,
  readBoard,
  verifyAsset,
  writeBoard,
  zipPaths as boardZipPaths,
  zipTailLength,
} from "./wasm/bindings.js";

export {
  ZipIndex,
  ZipWriter,
  assetPath,
  fileDepth,
  isAssetFile,
  isBoardFile,
  locateZipDirectory,
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

/** Mirrors `board::ElementKind`, as far as the shells read it. */
export type Kind =
  | {
      type: "image";
      asset: string;
      natural_size: { width: number; height: number };
      frame: Rect;
      rotation: number;
    }
  | { type: "note"; frame: Rect; rotation: number; text: string }
  | { type: "shape"; frame: Rect; rotation: number; shape: "rectangle" | "ellipse" }
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
export function read(files: Files): Board {
  return JSON.parse(readBoard([...files.keys()], [...files.values()])) as Board;
}

/** Every file but the assets. */
export function write(board: Board): Files {
  return writeBoard(JSON.stringify(board)) as Files;
}

/** The files a new board folder starts with, besides those of `write`. */
export function newFiles(): Files {
  return newBoardFiles() as Files;
}

/** The paths of the board's ZIP file, in the order it holds them. */
export function zipPaths(board: Board): string[] {
  return boardZipPaths(JSON.stringify(board));
}
