// The browser, where only Chromium lets a page read and write a folder, which the board then
// saves itself into, and remembers it for the next visit. Elsewhere a folder can still be picked
// through a file input, read-only, and a board saved by exporting its ZIP file, which downloads.
// Every engine keeps the board being edited in the origin's private file system meanwhile.

import type { Bytes } from "./core.js";
import type { Export, Folder, Home, Platform, Session } from "./platform.js";

const TYPES: Record<Export, string> = { zip: "application/zip", png: "image/png" };

/** Where the page remembers the folder of the board to reopen. */
const DATABASE = "planche";
const HANDLES = "handles";
const BOARD = "board";

let unsaved = false;
addEventListener("beforeunload", (event) => {
  if (unsaved) {
    event.preventDefault();
  }
});

const CANNOT_SAVE = window.showDirectoryPicker
  ? undefined
  : "This browser cannot write to a folder: export a ZIP file, or try a Chromium-based browser or the desktop app.";

const { keyboard } = navigator;

export const browser: Platform = {
  name: "browser",
  cannotSave: CANNOT_SAVE,
  layout: keyboard ? async () => new Map(await keyboard.getLayoutMap()) : undefined,

  async open() {
    if (!window.showDirectoryPicker) {
      return pickWithInput();
    }
    const root = await cancellable(window.showDirectoryPicker({ mode: "readwrite" }));
    return root && home(root, true);
  },

  async pickTarget() {
    const picker = window.showDirectoryPicker;
    if (!picker) {
      throw new Error(CANNOT_SAVE);
    }
    const root = await cancellable(picker({ mode: "readwrite" }));
    if (root === null) {
      return null;
    }
    for await (const name of root.keys()) {
      if (!name.startsWith(".")) {
        throw new Error(`${root.name} is not empty`);
      }
    }
    return home(root, true);
  },

  async openZip() {
    const picked = await choose((input) => (input.accept = ".zip,application/zip"));
    const file = picked?.[0];
    if (file === undefined) {
      return null;
    }
    return {
      name: file.name,
      size: file.size,
      read: (start, end) => bytesOf(file.slice(start, end)),
    };
  },

  async pickExport(name, type) {
    // A blob per part, which the browser may keep out of memory until the download.
    let parts: Blob[] = [];
    return {
      name,
      append: async (bytes) => {
        parts.push(new Blob([bytes]));
      },
      // The page never learns whether the download lands, but the user asked for it, so a
      // board's ZIP file counts as saved.
      close: async () => {
        const url = URL.createObjectURL(new Blob(parts, { type: TYPES[type] }));
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        // Revoked at once, the URL could cancel a download that has yet to start.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
      discard: async () => {
        parts = [];
      },
    };
  },

  async session() {
    // Safari writes there only from a worker before version 26.
    const writable =
      typeof FileSystemFileHandle !== "undefined" &&
      "createWritable" in FileSystemFileHandle.prototype;
    if (!navigator.storage?.getDirectory || !writable || !(await holdSession())) {
      return null;
    }
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("session", { create: true });
    const session = home(root, false);
    let persisting = false;
    return {
      ...session,
      async write(path, bytes) {
        // Asked once there is something to keep, as Firefox asks the user.
        if (!persisting) {
          persisting = true;
          void navigator.storage.persist?.();
        }
        return session.write(path, bytes);
      },
      async clear() {
        for await (const name of root.keys()) {
          await root.removeEntry(name, { recursive: true });
        }
      },
    } satisfies Session;
  },

  async reopen() {
    try {
      const root = await handles<FileSystemDirectoryHandle | undefined>("readonly", (store) =>
        store.get(BOARD),
      );
      if (root === undefined) {
        return null;
      }
      const folder = home(root, true);
      const permission = await root.queryPermission?.({ mode: "readwrite" });
      if (permission === "granted") {
        return { folder };
      }
      if (permission !== "prompt") {
        return null;
      }
      return {
        name: root.name,
        ask: async () =>
          (await root.requestPermission?.({ mode: "readwrite" })) === "granted" ? folder : null,
      };
    } catch {
      // Storage the browser keeps from the page, as in a private window.
      return null;
    }
  },

  async forget() {
    await handles("readwrite", (store) => store.delete(BOARD)).catch(() => {});
  },

  confirm: async (question) => window.confirm(question),

  async openAddress(address) {
    window.open(address, "_blank", "noopener,noreferrer");
  },

  markUnsaved(value) {
    unsaved = value;
  },

  // The page sees them all.
  watchDrops() {},
};

/** One tab at a time keeps its board in the session, for as long as it lives. */
let held: Promise<boolean> | undefined;
function holdSession(): Promise<boolean> {
  held ??= new Promise((resolve) => {
    if (!navigator.locks) {
      resolve(true);
      return;
    }
    void navigator.locks.request("planche.session", { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      return lock === null ? undefined : new Promise(() => {});
    });
  });
  return held;
}

/** The board in `root`, kept to reopen once `remembered`. */
function home(root: FileSystemDirectoryHandle, remembered: boolean): Home {
  return {
    name: root.name,
    list: async (depth) => (await walk(root, "", depth)).toSorted(),
    read: async (path) => {
      const [folder, name] = await locate(root, path, false);
      return bytesOf(await (await folder.getFileHandle(name)).getFile());
    },
    async write(path, bytes) {
      const segments = path.split("/");
      if (segments.length > 1 && segments.some((segment) => segment.startsWith("."))) {
        throw new Error(`${path} is not a file of the folder`);
      }
      const [folder, name] = await locate(root, path, true);
      if (name.startsWith(".") && (await exists(folder, name))) {
        return "";
      }
      const file = await folder.getFileHandle(name, { create: true });
      // The browser writes to a swap file and moves it in place on close.
      const writable = await file.createWritable();
      await writable.write(bytes);
      await writable.close();
      return stamp(await file.getFile());
    },
    async remove(path) {
      try {
        const [folder, name] = await locate(root, path, false);
        await folder.removeEntry(name);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) {
          throw error;
        }
      }
    },
    async stamps(paths) {
      const stamps = new Map<string, string>();
      for (const path of paths) {
        try {
          const [folder, name] = await locate(root, path, false);
          stamps.set(path, stamp(await (await folder.getFileHandle(name)).getFile()));
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "NotFoundError")) {
            throw error;
          }
        }
      }
      return stamps;
    },
    remember: remembered
      ? () =>
          handles("readwrite", (store) => store.put(root, BOARD)).then(
            () => undefined,
            () => undefined,
          )
      : undefined,
  };
}

function stamp(file: File): string {
  return `${file.size}:${file.lastModified}`;
}

/** One request on the handles the page keeps. */
async function handles<T>(
  mode: IDBTransactionMode,
  ask: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore(HANDLES));
    opening.addEventListener("success", () => resolve(opening.result));
    opening.addEventListener("error", () => reject(opening.error));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = ask(database.transaction(HANDLES, mode).objectStore(HANDLES));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
  } finally {
    database.close();
  }
}

async function walk(
  folder: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
): Promise<string[]> {
  const paths: string[] = [];
  for await (const [name, handle] of folder) {
    if (name.startsWith(".")) {
      continue;
    }
    if (handle instanceof FileSystemFileHandle) {
      paths.push(`${prefix}${name}`);
    } else if (handle instanceof FileSystemDirectoryHandle && depth > 1) {
      paths.push(...(await walk(handle, `${prefix}${name}/`, depth - 1)));
    }
  }
  return paths;
}

/** The folder holding `path`, and the file's name in it. */
async function locate(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<[FileSystemDirectoryHandle, string]> {
  const segments = path.split("/");
  const name = segments.pop()!;
  let folder = root;
  for (const segment of segments) {
    folder = await folder.getDirectoryHandle(segment, { create });
  }
  return [folder, name];
}

async function exists(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return false;
    }
    // A folder by that name.
    if (error instanceof DOMException && error.name === "TypeMismatchError") {
      return true;
    }
    throw error;
  }
}

async function pickWithInput(): Promise<Folder | null> {
  const picked = await choose((input) => (input.webkitdirectory = true));
  if (picked === null) {
    return null;
  }
  // Relative paths start with the picked folder's own name.
  const root = picked[0]?.webkitRelativePath.split("/")[0] ?? "";
  const files = new Map<string, File>();
  for (const file of picked) {
    const path = file.webkitRelativePath.slice(root.length + 1);
    if (!path.split("/").some((segment) => segment.startsWith("."))) {
      files.set(path, file);
    }
  }
  return {
    name: root,
    // The browser listed the whole folder before handing it over.
    list: async (depth) =>
      [...files.keys()].filter((path) => path.split("/").length <= depth).toSorted(),
    read: async (path) => {
      const file = files.get(path);
      if (file === undefined) {
        throw new Error(`${path} is not in ${root}`);
      }
      return bytesOf(file);
    },
  };
}

/** `null` when the user cancels. The desktop app's webviews show a file input's picker too. */
export function choose(setUp: (input: HTMLInputElement) => void): Promise<File[] | null> {
  const input = document.createElement("input");
  input.type = "file";
  setUp(input);
  return new Promise((resolve) => {
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

async function bytesOf(blob: Blob): Promise<Bytes> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** `null` when the user dismisses the picker. */
async function cancellable<T>(picking: Promise<T>): Promise<T | null> {
  try {
    return await picking;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}
