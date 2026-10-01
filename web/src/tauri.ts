// The desktop shell, which picks folders and works in them through commands of its own. It
// checks every file access itself, since it cannot trust the page.

import { typed } from "./commands.js";
import type { Bytes } from "./core.js";
import type { AgentCall, Platform } from "./platform.js";

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

    // The dialog plugin replaces the webview's own `confirm` with one that fails.
    confirm: (question) => core.invoke<boolean>("confirm", { question }),

    markUnsaved(value) {
      unsaved = value;
      void core.invoke("mark_unsaved", { value });
    },

    keepOnTop: (on) => core.invoke("keep_on_top", { on }),

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
