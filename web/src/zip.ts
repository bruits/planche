// A board's single ZIP file. The core says which bytes it needs, and they are read or
// written a slice at a time, so that a large board never sits whole in memory.

import { carried, digest, type Source } from "./board.js";
import * as core from "./core.js";
import type { Bytes, Files, Snapshot } from "./core.js";
import type { Folder, Sink, Slices } from "./platform.js";
import { VIDEO_LIMIT } from "./video.js";

/**
 * The most a deflated entry may take once inflated, as large as the largest file a board takes.
 * Deflate shrinks bytes about a thousand times at most, so a small ZIP file may still take this.
 */
const INFLATED_LIMIT = VIDEO_LIMIT;

/** The board in a ZIP file. Throws when the file cannot hold one. */
export async function zipFolder(file: Slices): Promise<Folder> {
  const read = ([start, end]: [number, number]) => file.read(start, end);
  const tail = await read([file.size - core.zipTailLength(file.size), file.size]);
  const directory = span(core.locateZipDirectory(file.size, tail));
  const index = new core.ZipIndex(directory[0], await read(directory));
  const paths = index.paths();
  const unzipped = async (path: string, data: Bytes) => {
    const bytes = index.deflated(path) ? await inflate(path, data, index.size(path)) : data;
    index.check(path, bytes.length, core.crc32(bytes));
    return bytes;
  };
  return {
    name: file.name.replace(/\.zip$/i, ""),
    list: async (depth) => paths.filter((path) => path.split("/").length <= depth),
    read: async (path) => {
      const header = await read(span(index.header(path)));
      return unzipped(path, await read(span(index.data(path, header))));
    },
    // A range at a time, which holds a board's files side by side.
    async readAll(wanted) {
      const placed = wanted
        .map((path) => [path, span(index.header(path))] as const)
        .toSorted(([, one], [, other]) => one[0] - other[0]);
      const runs = index.runs(wanted);
      const files: Files = new Map();
      let next = 0;
      for (let at = 0; at < runs.length; at += 2) {
        const [start, end] = [runs[at]!, runs[at + 1]!];
        const run = await read([start, end]);
        const within = ([from, to]: [number, number]) => run.subarray(from - start, to - start);
        for (; next < placed.length && placed[next]![1][0] < end; next++) {
          const [path, header] = placed[next]!;
          const data = span(index.data(path, within(header)));
          files.set(path, await unzipped(path, data[1] <= end ? within(data) : await read(data)));
        }
      }
      return { files: new Map(wanted.map((path) => [path, files.get(path)!])), stamps: new Map() };
    },
  };
}

/** Inflates `data`, which another tool deflated, into the `size` bytes its ZIP file says. */
async function inflate(path: string, data: Bytes, size: number): Promise<Bytes> {
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "this browser cannot read a compressed ZIP file, so unzip it and open its folder",
    );
  }
  if (size > INFLATED_LIMIT) {
    throw new Error(`\`${path}\` is over ${INFLATED_LIMIT / 1e6} MB once unzipped`);
  }
  const inflated = new Uint8Array(size);
  let length = 0;
  const reader = new ReadableStream<Bytes>({
    start: (controller) => {
      controller.enqueue(data);
      controller.close();
    },
  })
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  for (;;) {
    const read = await reader.read().catch(() => {
      throw new Error(`this ZIP file is damaged: \`${path}\` does not unzip`);
    });
    if (read.done) {
      // Shorter than it says, which the checksum then refuses.
      return inflated.subarray(0, length);
    }
    if (length + read.value.length > size) {
      await reader.cancel().catch(() => {});
      throw new Error(`\`${path}\` is larger than its ZIP file says`);
    }
    inflated.set(read.value, length);
    length += read.value.length;
  }
}

/**
 * Writes the board's ZIP file into `sink`, its assets and the files it left out read from
 * `folder` one at a time, and returns how many files it holds. Leaves no trace when it throws.
 */
export async function writeZip(snapshot: Snapshot, folder: Source, sink: Sink): Promise<number> {
  let count: number;
  try {
    const paths = snapshot.zipPaths(await carried(folder), [...folder.lacking]);
    const files = core.write(snapshot);
    const writer = new core.ZipWriter();
    for (const path of paths) {
      const bytes = files.get(path) ?? (await folder.read(path));
      const [size, crc] = [bytes.length, core.crc32(bytes)];
      const found = core.isAssetFile(path) ? await digest(bytes) : undefined;
      // An asset unlike its digest, which its images show crossed out, goes as it was read. A
      // ZIP file's bytes passed its checksum, and those added since are named by their digest.
      const header =
        found === undefined || core.matchesDigest(path, found)
          ? writer.entry(path, size, crc, found)
          : writer.carried(path, size, crc);
      // wasm-bindgen types the bytes it copies out loosely.
      await sink.append(header as Bytes);
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
