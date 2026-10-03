// A board's single ZIP file. The core says which bytes it needs, and they are read or
// written a slice at a time, so that a large board never sits whole in memory.

import { digest } from "./board.js";
import * as core from "./core.js";
import type { Bytes, Snapshot } from "./core.js";
import type { Folder, Sink, Slices } from "./platform.js";

/** The board in a ZIP file. Throws when the file cannot hold one. */
export async function zipFolder(file: Slices): Promise<Folder> {
  const read = ([start, end]: [number, number]) => file.read(start, end);
  const tail = await read([file.size - core.zipTailLength(file.size), file.size]);
  const directory = span(core.locateZipDirectory(file.size, tail));
  const index = new core.ZipIndex(directory[0], await read(directory));
  const paths = index.paths();
  return {
    name: file.name.replace(/\.zip$/i, ""),
    list: async (depth) => paths.filter((path) => path.split("/").length <= depth),
    read: async (path) => {
      const header = await read(span(index.header(path)));
      const bytes = await read(span(index.data(path, header)));
      index.check(path, bytes.length, core.crc32(bytes));
      return bytes;
    },
  };
}

/**
 * Writes the board's ZIP file into `sink`, its assets read from `folder` one at a time, and
 * returns how many files it holds. Leaves no trace when it throws.
 */
export async function writeZip(snapshot: Snapshot, folder: Folder, sink: Sink): Promise<number> {
  let count: number;
  try {
    const paths = snapshot.zipPaths();
    const files = core.write(snapshot);
    const writer = new core.ZipWriter();
    for (const path of paths) {
      const bytes = files.get(path) ?? (await folder.read(path));
      const found = core.isAssetFile(path) ? await digest(bytes) : undefined;
      // wasm-bindgen types the bytes it copies out loosely.
      await sink.append(writer.entry(path, bytes.length, core.crc32(bytes), found) as Bytes);
      await sink.append(bytes);
    }
    await sink.append(writer.finish() as Bytes);
    count = paths.length;
  } catch (error) {
    // The first error is the one worth showing.
    await sink.discard().catch(() => {});
    throw error;
  }
  await sink.close();
  return count;
}

/** The core gives ranges as `[start, end]`. */
function span(range: Float64Array): [number, number] {
  return [range[0]!, range[1]!];
}
