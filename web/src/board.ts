// A board as the app opens it: its files through the platform, edited by the core, and its
// images decoded by the browser.

import * as core from "./core.js";
import type { Board, Editor, Files } from "./core.js";
import { milliseconds, timed } from "./metrics.js";
import type { Folder } from "./platform.js";
import type { Placed } from "./renderer.js";

export interface Opened {
  folder: Folder;
  editor: Editor;
  /** The editor's board, as `refresh` keeps it. */
  board: Board;
}

/** An asset that images show, still encoded. */
export interface Asset {
  asset: string;
  blob: Blob;
  natural: { width: number; height: number };
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
  return { folder, editor, board: core.board(editor) };
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
    return kind.type === "image" ? [{ asset: kind.asset, frame: kind.frame, rotation: kind.rotation }] : [];
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
      const scale = Math.min(1, cap / Math.max(natural.width, natural.height));
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
        resizeWidth: Math.round(natural.width * scale),
        resizeHeight: Math.round(natural.height * scale),
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
