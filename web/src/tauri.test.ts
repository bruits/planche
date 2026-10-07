// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import type { Bytes, Files } from "./core.js";
import { pack, tauri, unpack } from "./tauri.js";

/**
 * The desktop shell, which answers its confirm dialog with `answer`, its save dialog with
 * `picked`, and other commands as `more` says.
 */
function shell(answer: boolean, picked: string | null = null, more: Record<string, unknown> = {}) {
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
          ...more,
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

  it("writes many files in one call, and keeps the stamps of those that landed before a failure", async () => {
    const root = "/Users/me/Planche à dessin";
    const { api, calls } = shell(true, null, {
      pick_target: root,
      write_files: [["stamp"], "disk full"],
    });
    const home = (await tauri(api).pickTarget())!;
    const files: [string, Bytes][] = [
      ["elements/a.json", new Uint8Array([1])],
      ["elements/b.json", new Uint8Array([2])],
    ];
    const wrote: [string, string][] = [];
    const writing = home.writeAll(files, (path, stamp) => void wrote.push([path, stamp]));
    await expect(writing).rejects.toThrow("disk full");
    expect(wrote).toEqual([["elements/a.json", "stamp"]]);
    const headers = { root: encodeURIComponent(root) };
    expect(calls.at(-1)).toEqual(["write_files", pack(files), { headers }]);
  });

  it("writes a lone file as it is, which may be a large video", async () => {
    const root = "/Users/me/Board";
    const { api, calls } = shell(true, null, { pick_target: root, write_files: [["stamp"], null] });
    const home = (await tauri(api).pickTarget())!;
    const bytes = new Uint8Array([1, 2]);
    expect(await home.write("assets/à.png", bytes)).toBe("stamp");
    const headers = { root: encodeURIComponent(root), path: encodeURIComponent("assets/à.png") };
    expect(calls.at(-1)).toEqual(["write_files", bytes, { headers }]);
    expect(calls.at(-1)![1]).toBe(bytes);
  });

  it("reads many files in one call, stamped before they are read", async () => {
    const files = new Map([["board.json", new Uint8Array([1, 2])]]);
    const stamps = new Map([["board.json", "stamp"]]);
    const { api, sent } = shell(true, null, {
      pick_folder: "/Users/me/Board",
      stamp_files: [...stamps],
      read_files: pack(files).buffer,
    });
    const home = (await tauri(api).open())!;
    expect(await home.readAll(["board.json"])).toEqual({ files, stamps });
    expect(sent).toEqual(["pick_folder", "stamp_files", "read_files"]);
  });

  it("closing a saved board closes without asking", async () => {
    const { api, sent, close } = shell(false);
    tauri(api).whenClosing!(async () => true);
    await close();
    expect(sent).toEqual(["close_window"]);
  });
});

describe("pack", () => {
  it("packs files as the desktop shell unpacks them, and unpacks them back", () => {
    const files: Files = new Map([
      ["é", new Uint8Array([7])],
      ["empty", new Uint8Array()],
    ]);
    const packed = pack(files);
    expect([...packed.subarray(0, 15)]).toEqual([
      2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0xc3, 0xa9, 7,
    ]);
    expect(unpack(packed.buffer)).toEqual(files);
    expect(unpack(pack([]).buffer)).toEqual(new Map());
  });

  it("refuses a body cut short, with bytes past its last file, or a path that is no text", () => {
    const packed = pack([["board.json", new Uint8Array([1, 2])]]);
    for (const damaged of [
      packed.slice(0, -1),
      new Uint8Array([...packed, 0]),
      new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]),
      new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0xff]),
    ]) {
      expect(() => unpack(damaged.buffer)).toThrow("the files read are damaged");
    }
  });
});
