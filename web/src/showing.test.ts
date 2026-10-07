import { afterEach, describe, it, expect, vi } from "vitest";
import {
  digest,
  imageKind,
  newId,
  open,
  refresh,
  untitled,
  type Decoded,
  type Opened,
} from "./board.js";
import type { Camera } from "./camera.js";
import * as core from "./core.js";
import type { Bytes } from "./core.js";
import { showing, type Host, type Showing } from "./showing.js";
import { memoryHome, sample } from "../test/folders.js";

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
      "demo: 13 elements, an image this machine cannot decode",
      undefined,
    ]);
  });

  it("shows nothing of a board whose image is unlike its digest, and says why it fails", async () => {
    const { host } = view();
    const board = await demo((files) => tamper(files, MIDDLE));
    await expect(showing(host).show(board)).rejects.toThrow(
      `asset ${MIDDLE} does not match its digest`,
    );
    expect(host.abandon).toHaveBeenCalledOnce();
  });

  it("ends where it began what the user started on a board that fails to show", async () => {
    const { host } = view();
    const board = await demo((files) => tamper(files, MIDDLE));
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
    await expect(showing(host).show(board)).rejects.toThrow("does not match its digest");
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
      "demo: 13 elements, an image this machine cannot show",
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
    expect(said.at(-1)?.[0]).toContain(
      `An image could not be read again: asset ${MIDDLE} does not match its digest`,
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
    let decoding = 0;
    let most = 0;
    const { decode } = host;
    host.decode = async (read) => {
      decoding += 1;
      most = Math.max(most, decoding);
      await new Promise((resolve) => setTimeout(resolve, 1));
      decoding -= 1;
      return decode(read);
    };
    edit(present, board, board.editor.undo());
    await reloaded(present);
    expect(loaded).toHaveLength(6);
    expect(most).toBe(4);
  });
});
