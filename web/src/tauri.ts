// The desktop shell, which picks folders and works in them through commands of its own. It
// checks every file access itself, since it cannot trust the page.

import type { Bytes } from "./core.js";
import type { Platform } from "./platform.js";

export function tauri({ core }: TauriApi): Platform {
  return {
    name: "desktop",

    async open() {
      const root = await core.invoke<string | null>("pick_folder", { title: "Open a board" });
      if (root === null) {
        return null;
      }
      return {
        name: basename(root),
        list: (depth) => core.invoke<string[]>("list_files", { root, depth }),
        read: async (path) =>
          new Uint8Array(await core.invoke<ArrayBuffer>("read_file", { root, path })),
      };
    },

    async pickTarget() {
      const title = "Save the board in an empty folder";
      const root = await core.invoke<string | null>("pick_target", { title });
      if (root === null) {
        return null;
      }
      return {
        name: basename(root),
        async write(path: string, bytes: Bytes) {
          // Headers only carry ASCII, and paths may not.
          const headers = { root: encodeURIComponent(root), path: encodeURIComponent(path) };
          await core.invoke("write_file", bytes, { headers });
        },
      };
    },

    async openZip() {
      const title = "Open a board's ZIP file";
      const picked = await core.invoke<[string, number] | null>("pick_zip", { title });
      if (picked === null) {
        return null;
      }
      const [path, size] = picked;
      return {
        name: basename(path),
        size,
        read: async (start, end) =>
          new Uint8Array(await core.invoke<ArrayBuffer>("read_zip", { path, start, end })),
      };
    },

    async pickZip(name) {
      const title = "Export the board as a ZIP file";
      const path = await core.invoke<string | null>("pick_export", { title, name });
      if (path === null) {
        return null;
      }
      const headers = { path: encodeURIComponent(path) };
      return {
        name: basename(path),
        append: (bytes) => core.invoke("append_export", bytes, { headers }),
        close: () => core.invoke("finish_export", { path }),
        discard: () => core.invoke("discard_export", { path }),
      };
    },
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
