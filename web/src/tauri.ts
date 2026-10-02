// The desktop shell, which picks folders and works in them through commands of its own. It
// checks every file access itself, since it cannot trust the page.

import { typed } from "./commands.js";
import type { AgentCall, Home, Platform, Slices } from "./platform.js";

const LOSING = "Close, and lose the changes to this board?";

export function tauri({ core, event }: TauriApi): Platform {
  let unsaved = false;
  // Reloading would lose the changes without asking, as the webview never does before. With or
  // without Shift, as WebView2 reloads either way.
  addEventListener("keydown", (event) => {
    const reload = event.key === "F5" || ((event.ctrlKey || event.metaKey) && typed(event) === "r");
    if (reload && unsaved) {
      event.preventDefault();
    }
  });
  const folder = (root: string): Home => ({
    name: basename(root),
    list: (depth) => core.invoke<string[]>("list_files", { root, depth }),
    read: async (path) => new Uint8Array(await core.invoke<ArrayBuffer>("read_file", { root, path })),
    write(path, bytes) {
      // Headers only carry ASCII, and paths may not.
      const headers = { root: encodeURIComponent(root), path: encodeURIComponent(path) };
      return core.invoke<string>("write_file", bytes, { headers });
    },
    remove: (path) => core.invoke("remove_file", { root, path }),
    stamps: async (paths) => new Map(await core.invoke<[string, string][]>("stamp_files", { root, paths })),
    remember: () => core.invoke("remember_board", { path: root, zip: false }),
  });
  const zip = (path: string, size: number): Slices => ({
    name: basename(path),
    size,
    read: async (start, end) => new Uint8Array(await core.invoke<ArrayBuffer>("read_zip", { path, start, end })),
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
  return {
    name: "desktop",

    agent: {
      allow: (on) => core.invoke("agent_allow", { on }),
      async serve(answer) {
        const channel = new core.Channel<AgentCall>();
        channel.onmessage = async (call) => {
          let reply;
          try {
            reply = { id: call.id, result: await answer(call) };
          } catch (error) {
            reply = { id: call.id, error: error instanceof Error ? error.message : String(error) };
          }
          // An answer the shell cannot read fails the call at once.
          core.invoke("agent_reply", { reply }).catch((error: unknown) => {
            const failure = { id: call.id, error: `Planche could not send its answer: ${String(error)}` };
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
      return root === null ? null : { ...folder(root), remember: undefined, clear: () => core.invoke("clear_session") };
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

    // The dialog plugin replaces the webview's own `confirm` with one that fails.
    confirm: (question, choices) => core.invoke<boolean>("confirm", { question, choices }),

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
        const readOne = async (path: string) => {
          // Linux paths, where a backslash may be part of a name.
          const name = path.slice(path.lastIndexOf("/") + 1);
          try {
            const bytes = await core.invoke<ArrayBuffer>("read_dropped", { path });
            return { name, filename: name, bytes: new Blob([bytes]) };
          } catch (error) {
            return { name, failure: String(error) };
          }
        };
        dropped(() => Promise.all(paths.map(readOne)), addresses, { clientX, clientY });
      });
    },
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
