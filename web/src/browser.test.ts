// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { files as filesOf, untitled } from "./board.js";
import { browser } from "./browser.js";
import type { Bytes } from "./core.js";
import { folderStore } from "./save.js";

function notFound() {
  return new DOMException("A requested file or directory could not be found.", "NotFoundError");
}

/** A folder of the origin's private file system, in memory. */
class MemoryFolder {
  folders = new Map<string, MemoryFolder>();
  files = new Map<string, MemoryFile>();
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let folder = this.folders.get(name);
    if (folder === undefined) {
      if (!options?.create) {
        throw notFound();
      }
      folder = new MemoryFolder();
      this.folders.set(name, folder);
    }
    return folder;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name);
    if (file === undefined) {
      if (!options?.create) {
        throw notFound();
      }
      file = new MemoryFile();
      this.files.set(name, file);
    }
    return file;
  }
  async *keys() {
    yield* this.folders.keys();
    yield* this.files.keys();
  }
}

class MemoryFile {
  bytes: Bytes = new Uint8Array();
  modified = 0;
  async createWritable() {
    return {
      write: async (bytes: Bytes) => {
        this.bytes = bytes;
        this.modified++;
      },
      close: async () => {},
    };
  }
  async getFile() {
    return new File([this.bytes.slice()], "file", { lastModified: this.modified });
  }
}

/** The session the browser keeps in `root`'s `session` folder. */
async function sessionIn(root: MemoryFolder, persist = async () => true) {
  vi.stubGlobal("FileSystemFileHandle", MemoryFile);
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { getDirectory: async () => root, persist },
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const session = (await browser.session())!;
  expect(session).not.toBeNull();
  return session;
}

async function writeNames(session: Awaited<ReturnType<typeof sessionIn>>, paths: string[]) {
  const stamps = new Map<string, string>();
  for (const path of paths) {
    stamps.set(path, await session.write(path, new TextEncoder().encode(path)));
  }
  return stamps;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "storage");
  Reflect.deleteProperty(navigator, "locks");
});

describe("browser session", () => {
  it("asks to persist the storage once a save writes the board", async () => {
    const persist = vi.fn<() => Promise<boolean>>(async () => true);
    const root = new MemoryFolder();
    const session = await sessionIn(root, persist);
    const opened = untitled();
    const store = await folderStore(session, undefined, true);
    const snapshot = opened.editor.snapshot();
    try {
      expect(await store.save(snapshot, [], () => filesOf(opened))).toBe(true);
    } finally {
      snapshot.free();
    }
    expect(root.folders.get("session")!.files.size).toBeGreaterThan(0);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("browser folder", () => {
  it("reads each file with the stamp of its bytes, by path in the order asked", async () => {
    const session = await sessionIn(new MemoryFolder());
    const written = await writeNames(session, ["a.json", "x/a.json", "x/b.json", "y/c.json"]);
    const asked = ["x/b.json", "a.json", "y/c.json", "x/a.json"];

    const { files, stamps } = await session.readAll(asked);

    expect([...files].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)])).toEqual(
      asked.map((path) => [path, path]),
    );
    expect([...stamps]).toEqual(asked.map((path) => [path, written.get(path)]));
  });

  it("stamps only the files still there once another program deleted some, or their folder", async () => {
    const root = new MemoryFolder();
    const session = await sessionIn(root);
    const written = await writeNames(session, [
      "a.json",
      "x/a.json",
      "x/b.json",
      "y/c.json",
      "y/d.json",
    ]);
    const folder = root.folders.get("session")!;
    folder.folders.delete("x");
    folder.folders.get("y")!.files.delete("d.json");

    const stamps = await session.stamps([
      "x/a.json",
      "a.json",
      "x/b.json",
      "y/d.json",
      "z/new.json",
      "y/c.json",
    ]);

    expect([...stamps]).toEqual([
      ["a.json", written.get("a.json")],
      ["y/c.json", written.get("y/c.json")],
    ]);
  });
});
