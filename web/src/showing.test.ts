import { afterEach, describe, it, expect, vi } from "vitest";
import {
  digest,
  files as filesOf,
  imageKind,
  newId,
  open,
  refresh,
  untitled,
  type Decoded,
  type Opened,
} from "./board.js";
import type { Camera } from "./camera.js";
import type { Folder } from "./platform.js";
import * as core from "./core.js";
import type { Bytes } from "./core.js";
import { folderStore, saving } from "./save.js";
import { showing, type Host, type Showing } from "./showing.js";
import { lfsPointer, memoryHome, sample } from "../test/folders.js";

/** The demo's images, from the largest to the smallest on screen. */
const LARGEST = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png";
const MIDDLE = "fabec7ea4f16a728b547c12f25158c75f6b48cf14db92745f92e5e9edcd36d93.jpg";
/** Turned, at x 600, y 0, 200 by 200. */
const SMALLEST = "2f76b06fc4959ba89d116fb907f574e622ad2b9def9ec4ab9247e84ffeee6054.png";
const STICKY = "b7d4e1f05a2c4c8e9f3a6d2b1c0e5f74";

async function demo(change?: (files: Map<string, Bytes>) => void): Promise<Opened> {
  const files = sample("demo");
  change?.(files);
  return (await open(async () => memoryHome("demo", files).home, new Map()))!.opened;
}

function tamper(files: Map<string, Bytes>, asset: string): void {
  files.get(`assets/${asset}`)![100]! ^= 0xff;
}

/** The view around boards as they show, decoding each image but those `undecodable`. */
function view({ undecodable = [] as string[] } = {}) {
  let opened: Opened | undefined;
  const said: [string, boolean | undefined][] = [];
  const loaded: string[] = [];
  const crossed: string[] = [];
  const released: unknown[] = [];
  const unloaded: string[] = [];
  const gesture = { on: false };
  const renderer = { kind: "renderer" };
  const host: Host<typeof renderer> = {
    opened: () => opened,
    saver: () => undefined,
    camera: () => undefined,
    size: () => ({ width: 800, height: 600 }),
    say: (text, busy) => void said.push([text, busy]),
    reset: (next) => void (opened = next),
    attach: async () => renderer,
    // Stands for the bitmap a browser decodes.
    decode: async (read) =>
      undecodable.includes(read.asset) ? undefined : ({ asset: read.asset } as unknown as Decoded),
    release: (decoded) => void (decoded && released.push(decoded)),
    load: (_, asset) => void loaded.push(asset),
    crossOut: (_, asset) => void crossed.push(asset),
    crossed: (asset) => crossed.includes(asset) && !loaded.includes(asset),
    holds: (_, asset) => loaded.includes(asset) || crossed.includes(asset),
    unload(_, asset) {
      unloaded.push(asset);
      if (loaded.includes(asset)) {
        loaded.splice(loaded.indexOf(asset), 1);
      }
    },
    busy: () => gesture.on,
    redraw() {},
    abandon: vi.fn<Host<typeof renderer>["abandon"]>(),
    changed() {},
    drawn() {},
  };
  const replace = (next: Opened) => void (opened = next);
  return { host, said, loaded, crossed, released, unloaded, gesture, replace };
}

/** The files the demo board reads as it shows from `camera`, in the order it asks for them. */
async function reads(camera?: Camera): Promise<string[]> {
  const { home } = memoryHome("demo", sample("demo"));
  const board = (await open(async () => home, new Map()))!.opened;
  const asked: string[] = [];
  const { read } = home;
  home.read = (path) => {
    asked.push(path);
    return read(path);
  };
  await showing(view().host).show(board, camera);
  return asked;
}

describe("showing", () => {
  it("draws each image of a board, telling how many it drew, then how many elements it holds", async () => {
    const { host, said, loaded } = view();
    await showing(host).show(await demo());
    expect(loaded.toSorted()).toEqual([LARGEST, MIDDLE, SMALLEST].toSorted());
    expect(said).toEqual([
      ["demo: 13 elements", true],
      ["demo: 13 elements, 1 of 3 images…", true],
      ["demo: 13 elements, 2 of 3 images…", true],
      ["demo: 13 elements, 3 of 3 images…", true],
      ["demo: 13 elements", undefined],
    ]);
  });

  it("reads first the largest image on screen", async () => {
    expect((await reads())[0]).toBe(`assets/${LARGEST}`);
    expect((await reads({ x: 650, y: 50, zoom: 4 }))[0]).toBe(`assets/${SMALLEST}`);
  });

  it("crosses out an image this machine cannot decode, and says so", async () => {
    const { host, said, crossed, loaded } = view({ undecodable: [MIDDLE] });
    await showing(host).show(await demo());
    expect(crossed).toEqual([MIDDLE]);
    expect(loaded).not.toContain(MIDDLE);
    expect(said.at(-1)).toEqual([
      "demo: 13 elements, an image this machine cannot decode, `dusk.jpg`",
      undefined,
    ]);
  });

  it("crosses out the images whose files are missing or unlike their digests, saying why", async () => {
    const { host, said, crossed, loaded } = view();
    const board = await demo((files) => {
      files.delete(`assets/${LARGEST}`);
      tamper(files, MIDDLE);
      const smallest = files.get(`assets/${SMALLEST}`)!;
      files.set(`assets/${SMALLEST}`, new TextEncoder().encode(lfsPointer(smallest)));
    });
    const wrong = await showing(host).show(board);
    expect(crossed.toSorted()).toEqual([LARGEST, MIDDLE, SMALLEST].toSorted());
    expect(loaded).toEqual([]);
    expect(wrong).toBe(
      `an image whose file is missing, \`assets/${LARGEST}\`, and an image left as a Git LFS ` +
        `pointer, \`assets/${SMALLEST}\`, so run \`git lfs pull\`, and an image whose file ` +
        "differs from its digest, `dusk.jpg`",
    );
    expect(said.at(-1)).toEqual([`demo: 13 elements, ${wrong}`, undefined]);
    expect(host.abandon).not.toHaveBeenCalled();
  });

  it("says which files it left out", async () => {
    const { host, said } = view();
    const board = await demo((files) => files.set(`elements/${STICKY}.json`, new Uint8Array()));
    const wrong = await showing(host).show(board);
    expect(wrong).toMatch(/^a file left out, as `elements\/b7d4.*\.json` is not valid: EOF/);
    expect(said.at(-1)).toEqual([`demo: 12 elements, ${wrong}`, undefined]);
  });

  it("ends where it began what the user started on a board that fails to show", async () => {
    const { host } = view();
    const board = await demo();
    host.load = () => {
      throw new TypeError("the app's own fault");
    };
    const at = () => {
      const kind = core.element(board.editor, STICKY)?.kind;
      return kind?.type === "sticky" ? kind.frame.x : undefined;
    };
    const before = at();
    // A drag under way while its images load.
    host.attach = async (next) => {
      next.editor.beginGesture();
      next.editor.translate([STICKY], 40, 0);
      return { kind: "renderer" };
    };
    await expect(showing(host).show(board)).rejects.toThrow("the app's own fault");
    expect(host.abandon).toHaveBeenCalledOnce();
    expect(at()).toBe(before);
    expect(board.editor.canUndo()).toBe(false);
  });

  it("lets go of what it decoded once another board took the place of the one it shows", async () => {
    const { host, loaded, released, replace } = view();
    const { decode } = host;
    host.decode = async (read) => {
      replace(untitled());
      return decode(read);
    };
    await showing(host).show(await demo());
    expect(loaded).toEqual([]);
    expect(released).toHaveLength(3);
  });

  it("holds the board's saves while it reads each image", async () => {
    const { host } = view();
    const { home } = memoryHome("demo", sample("demo"));
    const board = (await open(async () => home, new Map()))!.opened;
    // How many reads the saves wait for, and whether each file was read while they waited.
    let holding = 0;
    const held: boolean[] = [];
    const { read } = home;
    home.read = (path) => {
      held.push(holding > 0);
      return read(path);
    };
    host.saver = () => ({
      store: { found() {} },
      during: async (work) => {
        holding += 1;
        try {
          return await work();
        } finally {
          holding -= 1;
        }
      },
    });
    await showing(host).show(board);
    expect(held).toEqual([true, true, true]);
  });
});

describe("showing, once an image fails to load", () => {
  afterEach(() => vi.restoreAllMocks());

  it("crosses out only that image, says so, and shows the rest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, loaded, crossed, said } = view();
    const { load } = host;
    // As wgpu throws for a texture past the GPU's limits.
    host.load = (into, asset, decoded, read) => {
      if (asset === MIDDLE) {
        throw new Error("Texture dimension exceeds the device's limit");
      }
      load(into, asset, decoded, read);
    };
    await showing(host).show(await demo());
    expect(crossed).toEqual([MIDDLE]);
    expect(loaded.toSorted()).toEqual([LARGEST, SMALLEST].toSorted());
    expect(host.abandon).not.toHaveBeenCalled();
    expect(said.at(-1)).toEqual([
      "demo: 13 elements, an image this machine cannot show, `dusk.jpg`",
      undefined,
    ]);
  });

  it("fails the opening when the app itself fails, as no upload would", async () => {
    const { host, crossed } = view();
    host.load = () => {
      throw new TypeError("load is not a function");
    };
    await expect(showing(host).show(await demo())).rejects.toThrow(TypeError);
    expect(crossed).toEqual([]);
    expect(host.abandon).toHaveBeenCalledOnce();
  });

  it("fails the opening when the core panics reading an image", async () => {
    const { host, crossed } = view();
    const { home } = memoryHome("demo", sample("demo"));
    const { read } = home;
    home.read = async (path) => {
      if (path === `assets/${MIDDLE}`) {
        throw new WebAssembly.RuntimeError("unreachable");
      }
      return read(path);
    };
    const board = (await open(async () => home, new Map()))!.opened;
    await expect(showing(host).show(board)).rejects.toThrow(WebAssembly.RuntimeError);
    expect(crossed).toEqual([]);
    expect(host.abandon).toHaveBeenCalledOnce();
  });
});

/** The ids of the board's images that show `asset`, or any. */
function imagesOf({ board }: Opened, asset?: string): string[] {
  return board.draw_order.filter((id) => {
    const { kind } = board.elements[id]!;
    return kind.type === "image" && (asset === undefined || kind.asset === asset);
  });
}

/** As the app edits the board it shows. */
function edit(present: Showing, board: Opened, touched: string[]): void {
  present.edited(refresh(board, touched));
}

/** The demo with its images shown, then deleted, and their textures freed. */
async function freed() {
  const files = sample("demo");
  const { home } = memoryHome("demo", files);
  const board = (await open(async () => home, new Map()))!.opened;
  const shown = view();
  const present = showing(shown.host);
  await present.show(board);
  edit(present, board, board.editor.remove(imagesOf(board)));
  present.free();
  const asked: string[] = [];
  const { read } = home;
  home.read = (path) => {
    asked.push(path);
    return read(path);
  };
  return { ...shown, files, board, present, asked };
}

async function reloaded(present: Showing): Promise<void> {
  expect(present.reloading()).toBe(true);
  await vi.waitFor(() => expect(present.reloading()).toBe(false));
}

describe("freeing images", () => {
  it("frees those no image shows any more", async () => {
    const { loaded, unloaded } = await freed();
    expect(loaded).toEqual([]);
    expect(unloaded.toSorted()).toEqual([LARGEST, MIDDLE, SMALLEST].toSorted());
  });

  it("keeps an image another one still shows", async () => {
    const { host, loaded, unloaded } = view();
    const board = await demo();
    const present = showing(host);
    await present.show(board);
    const [first] = imagesOf(board, LARGEST);
    const kind = board.board.elements[first!]!.kind;
    edit(present, board, board.editor.add(newId(), undefined, JSON.stringify(kind)));
    edit(present, board, board.editor.remove([first!]));
    present.free();
    expect(unloaded).toEqual([]);
    expect(loaded).toContain(LARGEST);
  });

  it("frees nothing while a gesture may take its edits back, nor what an undo brought back", async () => {
    const { host, unloaded, gesture } = view();
    const board = await demo();
    const present = showing(host);
    await present.show(board);
    gesture.on = true;
    edit(present, board, board.editor.remove(imagesOf(board, LARGEST)));
    present.free();
    expect(unloaded).toEqual([]);
    gesture.on = false;
    edit(present, board, board.editor.undo());
    present.free();
    expect(unloaded).toEqual([]);
    edit(present, board, board.editor.redo());
    present.free();
    expect(unloaded).toEqual([LARGEST]);
  });
});

describe("showing images again", () => {
  it("reads again, the largest on screen first, the images an undo brings back", async () => {
    const { board, present, loaded, asked } = await freed();
    edit(present, board, board.editor.undo());
    await reloaded(present);
    expect(asked).toEqual([LARGEST, MIDDLE, SMALLEST].map((asset) => `assets/${asset}`));
    expect(loaded.toSorted()).toEqual([LARGEST, MIDDLE, SMALLEST].toSorted());
  });

  it("crosses out only the image it cannot read again, and says why", async () => {
    const { board, present, files, loaded, crossed, said, host } = await freed();
    tamper(files, MIDDLE);
    edit(present, board, board.editor.undo());
    await reloaded(present);
    expect(crossed).toEqual([MIDDLE]);
    expect(loaded.toSorted()).toEqual([LARGEST, SMALLEST].toSorted());
    expect(said.at(-1)?.[0]).toBe(
      "`dusk.jpg` could not be read again: its file differs from its digest",
    );
    expect(host.abandon).not.toHaveBeenCalled();
  });

  it("reads nothing for images the board does not draw, or has already", async () => {
    const { board, present, loaded, asked } = await freed();
    present.edited([]);
    expect(present.reloading()).toBe(false);
    loaded.push(LARGEST, MIDDLE, SMALLEST);
    edit(present, board, board.editor.undo());
    expect(present.reloading()).toBe(false);
    expect(asked).toEqual([]);
  });

  it("loads none deleted again, or of a board left, before they are read", async () => {
    const { board, present, loaded, released, replace } = await freed();
    edit(present, board, board.editor.undo());
    edit(present, board, board.editor.redo());
    await reloaded(present);
    edit(present, board, board.editor.undo());
    replace(untitled());
    await reloaded(present);
    expect(loaded).toEqual([]);
    expect(released).toHaveLength(6);
  });

  it("reads an image deleted while the board opened once an undo brings it back", async () => {
    const { host, loaded } = view();
    const board = await demo();
    const present = showing(host);
    const { decode } = host;
    let removed = false;
    host.decode = async (read) => {
      if (!removed) {
        removed = true;
        edit(present, board, board.editor.remove(imagesOf(board, SMALLEST)));
      }
      return decode(read);
    };
    await present.show(board);
    expect(loaded).not.toContain(SMALLEST);
    edit(present, board, board.editor.undo());
    await reloaded(present);
    expect(loaded).toContain(SMALLEST);
  });

  it("reads an image an undo brought back once its turn had passed, as the board opens", async () => {
    const { host, loaded, released } = view();
    const { home } = memoryHome("demo", sample("demo"));
    const board = (await open(async () => home, new Map()))!.opened;
    const asked: string[] = [];
    const reading = home.read;
    home.read = (path) => {
      asked.push(path);
      return reading(path);
    };
    const present = showing(host);
    const { decode } = host;
    let removed = false;
    host.decode = async (read) => {
      if (read.asset === SMALLEST && !removed) {
        removed = true;
        edit(present, board, board.editor.remove(imagesOf(board, SMALLEST)));
      } else if (read.asset === MIDDLE) {
        // Once the image deleted let go of what it decoded, its turn over.
        await vi.waitUntil(() => released.length === 1);
        edit(present, board, board.editor.undo());
      }
      return decode(read);
    };
    await present.show(board);
    await reloaded(present);
    expect(asked.filter((path) => path === `assets/${SMALLEST}`)).toHaveLength(2);
    expect(loaded).toContain(SMALLEST);
  });

  it("reads at most four images at once", async () => {
    const board = untitled();
    const { host, loaded } = view();
    const present = showing(host);
    for (let at = 0; at < 6; at++) {
      const bytes = new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="${at + 1}" height="1"/></svg>`,
      );
      const asset = await digest(bytes);
      board.added.set(core.assetPath(asset), new Blob([bytes]));
      const frame = { x: at * 20, y: 0, width: 10, height: 10 };
      const kind = imageKind(asset, { width: 10, height: 10 }, frame);
      edit(present, board, board.editor.add(newId(), undefined, JSON.stringify(kind)));
    }
    await present.show(board);
    edit(present, board, board.editor.remove(imagesOf(board)));
    present.free();
    const waiting: (() => void)[] = [];
    const { decode } = host;
    host.decode = async (read) => {
      await new Promise<void>((resolve) => waiting.push(resolve));
      return decode(read);
    };
    edit(present, board, board.editor.undo());
    for (let ended = 0; ended < 6; ended++) {
      await vi.waitFor(() => expect(waiting).toHaveLength(Math.min(4, 6 - ended)), {
        interval: 1,
      });
      waiting.shift()!();
    }
    await reloaded(present);
    expect(loaded).toHaveLength(6);
  });
});

async function shownWith(change: (files: Map<string, Bytes>) => void, readOnce = false) {
  const original = sample("demo");
  const contents = sample("demo");
  change(contents);
  const folder = memoryHome("demo", contents);
  const { home } = folder;
  const once: Folder = {
    name: home.name,
    list: home.list,
    read: home.read,
    readAll: home.readAll,
  };
  const board = (await open(async () => (readOnce ? once : home), new Map()))!.opened;
  const shown = view();
  const found: string[] = [];
  shown.host.saver = () => ({
    during: (work) => work(),
    store: { found: (paths) => void found.push(...paths) },
  });
  const present = showing(shown.host);
  await present.show(board);
  const asked: string[] = [];
  const { read } = home;
  board.folder.read = (path) => {
    asked.push(path);
    return read(path);
  };
  return { ...shown, ...folder, board, present, original, found, asked };
}

describe("showing images whose files come back", () => {
  it("shows again an image whose file came back, which saves then never write", async () => {
    const path = `assets/${LARGEST}`;
    const { board, present, overwrite, original, loaded, said, found, asked } = await shownWith(
      (files) => files.delete(path),
    );
    await present.recheck();
    expect(asked).toEqual([]);
    overwrite(path, original.get(path)!);
    await present.recheck();
    expect(loaded).toContain(LARGEST);
    expect(present.crossedOut(LARGEST)).toBeUndefined();
    expect(filesOf(board).lacking).toEqual([]);
    expect(found).toEqual([path]);
    expect(said.at(-1)?.[0]).toBe(`\`${path}\` shows again`);
  });

  it("reads an altered image again once, then once its file changes, until it is right", async () => {
    const path = `assets/${MIDDLE}`;
    const { present, overwrite, original, loaded, said, asked } = await shownWith((files) =>
      tamper(files, MIDDLE),
    );
    const before = said.length;
    await present.recheck();
    await present.recheck();
    expect(asked).toEqual([path]);
    expect(said).toHaveLength(before);
    overwrite(path, lfsPointer(original.get(path)!));
    await present.recheck();
    expect(present.crossedOut(MIDDLE)).toBe("its file is a Git LFS pointer, so run `git lfs pull`");
    overwrite(path, original.get(path)!);
    await present.recheck();
    expect(loaded).toContain(MIDDLE);
  });

  it("reads nothing again of a folder read once, or of a board left meanwhile", async () => {
    const path = `assets/${LARGEST}`;
    const once = await shownWith((files) => files.delete(path), true);
    once.overwrite(path, once.original.get(path)!);
    await once.present.recheck();
    expect(once.asked).toEqual([]);

    const left = await shownWith((files) => files.delete(path));
    left.overwrite(path, left.original.get(path)!);
    const checking = left.present.recheck();
    left.replace(untitled());
    await checking;
    expect(left.loaded).not.toContain(LARGEST);
    expect(left.found).toEqual([]);
  });

  it("writes no image whose file came back while a save looked at the folder", async () => {
    const path = `assets/${LARGEST}`;
    const original = sample("demo");
    const contents = sample("demo");
    contents.delete(path);
    const { home, written, overwrite } = memoryHome("demo", contents);
    const { opened: board, reading } = (await open(async () => home, new Map()))!;
    const store = await folderStore(home, reading, false);
    const saver = saving(store, {
      snapshot: () => board.editor.snapshot(),
      source: () => filesOf(board),
      saved() {},
      failed() {},
      conflict: async () => false,
      reload: async () => "refused",
    });
    const shown = view();
    shown.host.saver = () => saver;
    const present = showing(shown.host);
    await present.show(board);
    // A new image of the missing asset, whose element file the next save writes.
    const [first] = imagesOf(board, LARGEST);
    const kind = board.board.elements[first!]!.kind;
    const added = board.editor.add(newId(), undefined, JSON.stringify(kind));
    edit(present, board, added);
    // The save's check of the files it writes waits until the recheck looked at the folder.
    let resume!: () => void;
    const paused = new Promise<void>((done) => (resume = done));
    let asked!: () => void;
    const checking = new Promise<void>((done) => (asked = done));
    const { stamps } = home;
    home.stamps = async (paths) => {
      if (!paths.every((at) => at.startsWith("assets/"))) {
        asked();
        await paused;
      }
      return stamps(paths);
    };
    saver.touched(added);
    const flushed = saver.flush();
    await checking;
    overwrite(path, original.get(path)!);
    const rechecked = present.recheck();
    await new Promise((done) => setTimeout(done, 0));
    resume();
    expect(await flushed).toBe(true);
    await rechecked;
    await saver.stop();
    expect(shown.loaded).toContain(LARGEST);
    expect(written).not.toContain(path);
  });
});
