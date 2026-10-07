// Boards' folders in memory, for tests to open, edit and save boards as the app does.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Bytes } from "../src/core.js";
import type { Home, Session } from "../src/platform.js";

export const SAMPLES = join(import.meta.dirname, "../../samples");

/** The files of a board in samples/, by path. */
export function sample(name: string): Map<string, Bytes> {
  const root = join(SAMPLES, name);
  const files = new Map<string, Bytes>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      // Keyed as boards name their files, with `/` between segments whatever the system.
      files.set(
        path.slice(root.length + 1).replaceAll(sep, "/"),
        new Uint8Array(readFileSync(path)),
      );
    }
  }
  return files;
}

/** What a clone made without Git LFS holds in place of `bytes`. */
export function lfsPointer(bytes: Bytes): string {
  const oid = createHash("sha256").update(bytes).digest("hex");
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`;
}

/**
 * A board's folder holding `files`, which another program may write to as well, as `overwrite`
 * does. Each write stamps its file anew, as a disk would.
 */
export function memoryHome(name: string, files = new Map<string, Bytes>()) {
  const stamps = new Map<string, string>();
  let clock = 0;
  const stamp = (path: string) => {
    clock += 1;
    stamps.set(path, String(clock));
    return String(clock);
  };
  files.forEach((_, path) => stamp(path));
  /** The board files written, in order. */
  const written: string[] = [];
  const removed: string[] = [];
  const home: Home = {
    name,
    list: async (depth) =>
      [...files.keys()]
        .filter((path) => path.split("/").length <= depth && !path.startsWith("."))
        .toSorted(),
    read: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) {
        throw new Error(`${path} is missing`);
      }
      return bytes;
    },
    // Through `read` and `write`, which tests may wrap, one file after another.
    async readAll(paths) {
      const batch = { files: new Map<string, Bytes>(), stamps: new Map<string, string>() };
      for (const path of paths) {
        batch.stamps.set(path, stamps.get(path) ?? "");
        batch.files.set(path, await this.read(path));
      }
      return batch;
    },
    async writeAll(entries, wrote) {
      for (const [path, bytes] of entries) {
        wrote(path, await this.write(path, bytes));
      }
    },
    async write(path, bytes) {
      // A dot file is its user's once there, as in a folder on disk, and no board file.
      if (path.startsWith(".")) {
        if (!files.has(path)) {
          files.set(path, bytes.slice());
        }
        return "";
      }
      written.push(path);
      files.set(path, bytes.slice());
      return stamp(path);
    },
    async remove(path) {
      removed.push(path);
      files.delete(path);
      stamps.delete(path);
    },
    stamps: async (paths) =>
      new Map(paths.flatMap((path) => (stamps.has(path) ? [[path, stamps.get(path)!]] : []))),
  };
  const overwrite = (path: string, text: string) => {
    files.set(path, new TextEncoder().encode(text));
    stamp(path);
  };
  return { home, files, written, removed, overwrite };
}

/** The app's own folder for a board, holding `files`. */
export function memorySession(files = new Map<string, Bytes>()) {
  const folder = memoryHome("session", files);
  const session: Session = {
    ...folder.home,
    remember: undefined,
    async clear() {
      for (const path of files.keys()) {
        await folder.home.remove(path);
      }
    },
  };
  return { ...folder, session };
}
