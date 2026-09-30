// A board as the app opens it: its files through the platform, parsed by the core, and its
// images decoded by the browser.

import * as core from "./core.js";
import type { Board, Files, Rect } from "./core.js";
import { milliseconds, timed } from "./metrics.js";
import type { Folder } from "./platform.js";
import type { Quad } from "./renderer.js";

export interface Opened {
  folder: Folder;
  /** All its files, the assets included. */
  paths: string[];
  board: Board;
}

/** An image element, still encoded. */
export interface BoardImage {
  blob: Blob;
  natural: { width: number; height: number };
  frame: Rect;
  rotation: number;
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
  const [board, parsing] = await timed(() => core.read(files));
  timings.clear();
  timings.set(`list ${paths.length} files`, milliseconds(listing));
  timings.set(`read ${files.size} files`, milliseconds(reading));
  timings.set("parse", milliseconds(parsing));
  return { folder, paths, board };
}

/** In draw order. Throws when an asset is missing or does not match its digest. */
export async function readImages({ folder, board }: Opened): Promise<BoardImage[]> {
  const images: BoardImage[] = [];
  for (const id of board.draw_order) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image") {
      const bytes = await folder.read(core.assetPath(kind.asset));
      core.verifyAsset(kind.asset, bytes);
      const { natural_size: natural, frame, rotation } = kind;
      images.push({ blob: new Blob([bytes]), natural, frame, rotation });
    }
  }
  return images;
}

/** With their longest side capped at `cap` pixels. Four decode at once, to bound the memory in flight. */
export async function decode(images: BoardImage[], cap: number): Promise<Quad[]> {
  const quads: Quad[] = [];
  const pending = images.entries();
  const worker = async () => {
    for (const [at, { blob, natural, frame, rotation }] of pending) {
      const scale = Math.min(1, cap / Math.max(natural.width, natural.height));
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
        resizeWidth: Math.round(natural.width * scale),
        resizeHeight: Math.round(natural.height * scale),
        resizeQuality: "high",
      });
      quads[at] = { bitmap, frame, rotation };
    }
  };
  const done = await Promise.allSettled(Array.from({ length: 4 }, worker));
  const failed = done.find((result) => result.status === "rejected");
  if (failed) {
    quads.forEach(({ bitmap }) => bitmap.close());
    throw failed.reason;
  }
  return quads;
}
