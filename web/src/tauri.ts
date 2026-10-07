// The desktop shell, which picks folders and works in them through commands of its own. It
// checks every file access itself, since it cannot trust the page.

import type { Incoming } from "./add.js";
import { typed } from "./commands.js";
import type { Bytes, Files } from "./core.js";
import { message } from "./errors.js";
import type { AgentCall, Export, Home, Platform, Slices } from "./platform.js";

const LOSING = "Close, and lose the changes to this board?";
/** What the save dialog says it picks a file for. */
const EXPORTS: Record<Export, string> = {
  zip: "Export the board as a ZIP file",
  png: "Export the selection as PNG",
};

export function tauri({ core, event }: TauriApi): Platform {
  let unsaved = false;
  // Reloading would lose the changes without asking, as the webview never does before. With or
  // without Shift, as WebView2 reloads either way.
  addEventListener("keydown", (pressed) => {
    const reload =
      pressed.key === "F5" || ((pressed.ctrlKey || pressed.metaKey) && typed(pressed) === "r");
    if (reload && unsaved) {
      pressed.preventDefault();
    }
  });
  const folder = (root: string): Home => {
    const stamps = async (paths: string[]) =>
      new Map(await core.invoke<[string, string][]>("stamp_files", { root, paths }));
    const writeAll: Home["writeAll"] = async (files, wrote) => {
      // A lone file goes as it is, as it may be a large video, which a pack would copy.
      const [lone] = files.length === 1 ? files : [];
      // Headers only carry ASCII, and paths may not.
      const headers = {
        root: encodeURIComponent(root),
        ...(lone === undefined ? {} : { path: encodeURIComponent(lone[0]) }),
      };
      const [stamped, failure] = await core.invoke<[string[], string | null]>(
        "write_files",
        lone === undefined ? pack(files) : lone[1],
        { headers },
      );
      stamped.forEach((stamp, at) => wrote(files[at]![0], stamp));
      if (failure !== null) {
        throw new Error(failure);
      }
    };
    return {
      name: basename(root),
      list: (depth) => core.invoke<string[]>("list_files", { root, depth }),
      read: async (path) =>
        new Uint8Array(await core.invoke<ArrayBuffer>("read_file", { root, path })),
      async readAll(paths) {
        // Before reading, so that what another program writes meanwhile tells by its stamp.
        const taken = await stamps(paths);
        const files = unpack(await core.invoke<ArrayBuffer>("read_files", { root, paths }));
        return { files, stamps: taken };
      },
      async write(path, bytes) {
        let stamp = "";
        await writeAll([[path, bytes]], (_, written) => (stamp = written));
        return stamp;
      },
      writeAll,
      remove: (path) => core.invoke("remove_file", { root, path }),
      stamps,
      remember: () => core.invoke("remember_board", { path: root, zip: false }),
    };
  };
  const zip = (path: string, size: number): Slices => ({
    name: basename(path),
    size,
    read: async (start, end) =>
      new Uint8Array(await core.invoke<ArrayBuffer>("read_zip", { path, start, end })),
    home: {
      async rewrite(over) {
        if (!(await core.invoke<boolean>("rewrite_zip", { path, over }))) {
          return null;
        }
        let written: number | null = null;
        const headers = { path: encodeURIComponent(path) };
        const sink = {
          name: basename(path),
          append: (bytes: Uint8Array) => core.invoke<void>("append_export", bytes, { headers }),
          close: async () => {
            written = await core.invoke<number | null>("finish_rewrite", { path, over });
          },
          discard: () => core.invoke<void>("discard_export", { path }),
        };
        return { sink, written: () => (written === null ? null : zip(path, written)) };
      },
      changed: () => core.invoke<boolean>("zip_changed", { path }),
      reread: async () => zip(path, await core.invoke<number>("reread_zip", { path })),
      adopt: () => core.invoke("adopt_zip", { path }),
      remember: () => core.invoke("remember_board", { path, zip: true }),
    },
  });
  const readDropped = async (path: string): Promise<Incoming> => {
    // Linux paths, where a backslash may be part of a name.
    const name = path.slice(path.lastIndexOf("/") + 1);
    try {
      const bytes = await core.invoke<ArrayBuffer>("read_dropped", { path });
      return { name, filename: name, bytes: new Blob([bytes]) };
    } catch (error) {
      return { name, failure: String(error) };
    }
  };
  return {
    name: "desktop",
    layout: async () => new Map(await core.invoke<[string, string][]>("keyboard_layout")),

    agent: {
      allow: (on) => core.invoke("agent_allow", { on }),
      async serve(answer) {
        const channel = new core.Channel<AgentCall>();
        // A channel of Tauri's, which takes no listeners.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        channel.onmessage = async (call) => {
          let reply;
          try {
            reply = { id: call.id, result: await answer(call) };
          } catch (error) {
            reply = { id: call.id, error: message(error) };
          }
          // An answer the shell cannot read fails the call at once.
          core.invoke("agent_reply", { reply }).catch((error: unknown) => {
            const failure = {
              id: call.id,
              error: `Planche could not send its answer: ${String(error)}`,
            };
            void core.invoke("agent_reply", { reply: failure });
          });
        };
        await core.invoke("agent_attach", { channel });
      },
    },

    async open() {
      const root = await core.invoke<string | null>("pick_folder", { title: "Open a board" });
      return root === null ? null : folder(root);
    },

    async pickTarget() {
      const title = "Save the board in an empty folder";
      const root = await core.invoke<string | null>("pick_target", { title });
      return root === null ? null : folder(root);
    },

    async openZip() {
      const title = "Open a board's ZIP file";
      const picked = await core.invoke<[string, number] | null>("pick_zip", { title });
      return picked === null ? null : zip(...picked);
    },

    async session() {
      const root = await core.invoke<string | null>("session");
      return root === null
        ? null
        : { ...folder(root), remember: undefined, clear: () => core.invoke("clear_session") };
    },

    async reopen() {
      const found = await core.invoke<[string, string, number] | null>("reopen_board");
      if (found === null) {
        return null;
      }
      const [kind, path, size] = found;
      return kind === "zip" ? { zip: zip(path, size) } : { folder: folder(path) };
    },

    forget: () => core.invoke("forget_board"),

    async pickExport(name, type) {
      const title = EXPORTS[type];
      const path = await core.invoke<string | null>("pick_export", { title, name, kind: type });
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

    // The dialog plugin replaces the webview's own `confirm` with one that fails.
    confirm: (question, choices) => core.invoke<boolean>("confirm", { question, choices }),

    // The webview opens no window of its own.
    openAddress: (address) => core.invoke("open_address", { address }),

    markUnsaved(value) {
      unsaved = value;
      void core.invoke("mark_unsaved", { value });
    },

    whenClosing(write) {
      void event.listen("closing", async () => {
        let close: boolean;
        try {
          close = (await write()) || (await core.invoke<boolean>("confirm", { question: LOSING }));
        } catch {
          close = await core.invoke<boolean>("confirm", { question: LOSING });
        }
        await core.invoke(close ? "close_window" : "keep_window");
      });
    },

    keepOnTop: (on) => core.invoke("keep_on_top", { on }),

    titleBar: {
      show: (shown) => core.invoke("show_title_bar", { shown }),
      drag: () => void core.invoke("drag_window"),
    },

    // Only on Linux, where the shell takes drops itself.
    watchDrops(dropped) {
      type Dropped = [string[], string[], number, number];
      void event.listen<Dropped>("dropped", ({ payload: [paths, addresses, clientX, clientY] }) => {
        dropped(() => Promise.all(paths.map(readDropped)), addresses, { clientX, clientY });
      });
    },
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Many files in one body, as `folder::pack` packs them on the desktop shell's side. */
export function pack(files: Iterable<[string, Bytes]>): Bytes {
  const encoder = new TextEncoder();
  const encoded = [...files].map(([path, bytes]) => [encoder.encode(path), bytes] as const);
  const size = encoded.reduce((sum, [path, bytes]) => sum + 8 + path.length + bytes.length, 4);
  const packed = new Uint8Array(size);
  const view = new DataView(packed.buffer);
  view.setUint32(0, encoded.length, true);
  let at = 4;
  for (const [path, bytes] of encoded) {
    view.setUint32(at, path.length, true);
    view.setUint32(at + 4, bytes.length, true);
    packed.set(path, at + 8);
    packed.set(bytes, at + 8 + path.length);
    at += 8 + path.length + bytes.length;
  }
  return packed;
}

/** The files `pack` packed, by path in their order, as views into `body`. */
export function unpack(body: ArrayBuffer): Files {
  const view = new DataView(body);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: Files = new Map();
  let at = 4;
  try {
    for (let count = view.getUint32(0, true); count > 0; count--) {
      const [pathLength, length] = [view.getUint32(at, true), view.getUint32(at + 4, true)];
      const path = decoder.decode(new Uint8Array(body, at + 8, pathLength));
      files.set(path, new Uint8Array(body, at + 8 + pathLength, length));
      at += 8 + pathLength + length;
    }
  } catch {
    at = Number.NaN;
  }
  if (at !== body.byteLength) {
    throw new Error("the files read are damaged");
  }
  return files;
}
