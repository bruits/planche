// The browser, where only Chromium lets a page read and write a folder. Elsewhere a folder
// can still be picked through a file input, read-only, and a board saved by exporting its ZIP
// file, which downloads.

import type { Bytes } from "./core.js";
import type { Folder, Platform } from "./platform.js";

let unsaved = false;
addEventListener("beforeunload", (event) => {
  if (unsaved) {
    event.preventDefault();
  }
});

export const browser: Platform = {
  name: "browser",
  cannotSave: window.showDirectoryPicker
    ? undefined
    : "This browser cannot write to a folder: export a ZIP file, or try a Chromium-based browser or the desktop app.",

  async open() {
    if (!window.showDirectoryPicker) {
      return pickWithInput();
    }
    const root = await cancellable(window.showDirectoryPicker());
    if (root === null) {
      return null;
    }
    return {
      name: root.name,
      list: async (depth) => (await walk(root, "", depth)).sort(),
      read: async (path) => {
        const [folder, name] = await locate(root, path, false);
        return bytesOf(await (await folder.getFileHandle(name)).getFile());
      },
    };
  },

  async pickTarget() {
    const picker = window.showDirectoryPicker;
    if (!picker) {
      throw new Error(this.cannotSave);
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
    return {
      name: root.name,
      async write(path: string, bytes: Bytes) {
        const segments = path.split("/");
        if (segments.length > 1 && segments.some((segment) => segment.startsWith("."))) {
          throw new Error(`${path} is not a file of the folder`);
        }
        const [folder, name] = await locate(root, path, true);
        if (name.startsWith(".") && (await exists(folder, name))) {
          return;
        }
        const file = await folder.getFileHandle(name, { create: true });
        // The browser writes to a swap file and moves it in place on close.
        const writable = await file.createWritable();
        await writable.write(bytes);
        await writable.close();
      },
    };
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

  async pickZip(name) {
    // A blob per part, which the browser may keep out of memory until the download.
    let parts: Blob[] = [];
    return {
      name,
      append: async (bytes) => {
        parts.push(new Blob([bytes]));
      },
      // The page never learns whether the download lands, but the user asked for it, so the
      // board counts as saved.
      close: async () => {
        const url = URL.createObjectURL(new Blob(parts, { type: "application/zip" }));
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

  confirm: async (question) => window.confirm(question),

  markUnsaved(value) {
    unsaved = value;
  },
};

async function walk(folder: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<string[]> {
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
    list: async (depth) => [...files.keys()].filter((path) => path.split("/").length <= depth).sort(),
    read: async (path) => {
      const file = files.get(path);
      if (file === undefined) {
        throw new Error(`${path} is not in ${root}`);
      }
      return bytesOf(file);
    },
  };
}

/** `null` when the user cancels. */
function choose(setUp: (input: HTMLInputElement) => void): Promise<File[] | null> {
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
