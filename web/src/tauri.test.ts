// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { tauri } from "./tauri.js";

/** The desktop shell, which answers its confirm dialog with `answer`, and its save dialog with `picked`. */
function shell(answer: boolean, picked: string | null = null) {
  let closing: (() => Promise<void>) | undefined;
  const sent: string[] = [];
  const calls: unknown[][] = [];
  const api: TauriApi = {
    core: {
      Channel: class {
        onmessage() {}
      },
      async invoke(command: string, ...rest: unknown[]) {
        sent.push(command);
        calls.push([command, ...rest]);
        const answers: Record<string, unknown> = {
          confirm: answer,
          keyboard_layout: [["KeyQ", "a"]],
          pick_export: picked,
        };
        return answers[command] as never;
      },
    },
    event: {
      async listen(name: string, handler: (event: { payload: never }) => void) {
        if (name === "closing") {
          // The page's handler is async, though typed as returning nothing.
          closing = async () => handler({ payload: undefined as never });
        }
        return () => {};
      },
    },
  };
  const close = () => closing!();
  return { api, sent, calls, close };
}

describe("tauri", () => {
  it("reads what each key types alone from the shell, by where it sits", async () => {
    const { api } = shell(true);
    expect(await tauri(api).layout!()).toEqual(new Map([["KeyQ", "a"]]));
  });

  it("closing an unsaved board asks first, and keeps the window when the user declines", async () => {
    const { api, sent, close } = shell(false);
    tauri(api).whenClosing!(async () => false);
    await close();
    expect(sent).toEqual(["confirm", "keep_window"]);
  });

  it("closing an unsaved board asks first, and closes the window when the user agrees", async () => {
    const { api, sent, close } = shell(true);
    tauri(api).whenClosing!(async () => false);
    await close();
    expect(sent).toEqual(["confirm", "close_window"]);
  });

  it("closing a board whose save fails asks first", async () => {
    const { api, sent, close } = shell(false);
    tauri(api).whenClosing!(async () => {
      throw new Error("disk full");
    });
    await close();
    expect(sent).toEqual(["confirm", "keep_window"]);
  });

  it.each([
    ["zip", "Export the board as a ZIP file"],
    ["png", "Export the selection as PNG"],
  ] as const)(
    "exports a %s file where the user picks, which takes its place once finished",
    async (type, title) => {
      const path = `/Users/me/Board.${type}`;
      const { api, calls } = shell(true, path);
      const sink = await tauri(api).pickExport(`Moodboard.${type}`, type);
      expect(sink?.name).toBe(`Board.${type}`);
      await sink!.append(new Uint8Array([1, 2]));
      await sink!.close();
      const headers = { path: encodeURIComponent(path) };
      expect(calls).toEqual([
        ["pick_export", { title, name: `Moodboard.${type}`, kind: type }],
        ["append_export", new Uint8Array([1, 2]), { headers }],
        ["finish_export", { path }],
      ]);
    },
  );

  it("exports nothing when the user cancels, and leaves no trace of a failed export", async () => {
    expect(await tauri(shell(true).api).pickExport("Moodboard.png", "png")).toBeNull();
    const { api, sent } = shell(true, "/Users/me/Board.png");
    await (await tauri(api).pickExport("Moodboard.png", "png"))!.discard();
    expect(sent).toEqual(["pick_export", "discard_export"]);
  });

  it("closing a saved board closes without asking", async () => {
    const { api, sent, close } = shell(false);
    tauri(api).whenClosing!(async () => true);
    await close();
    expect(sent).toEqual(["close_window"]);
  });
});
