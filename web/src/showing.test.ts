import { describe, it, expect, vi } from "vitest";
import { open, untitled, type Decoded, type Opened } from "./board.js";
import type { Camera } from "./camera.js";
import * as core from "./core.js";
import type { Bytes } from "./core.js";
import { showing, type Host } from "./showing.js";
import { memoryHome, sample } from "../test/folders.js";

/** The demo's images, from the largest to the smallest on screen. */
const LARGEST = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f";
const MIDDLE = "fabec7ea4f16a728b547c12f25158c75f6b48cf14db92745f92e5e9edcd36d93";
/** Turned, at x 600, y 0, 200 by 200. */
const SMALLEST = "2f76b06fc4959ba89d116fb907f574e622ad2b9def9ec4ab9247e84ffeee6054";
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
    redraw() {},
    abandon: vi.fn<Host<typeof renderer>["abandon"]>(),
    changed() {},
    drawn() {},
  };
  const replace = (next: Opened) => void (opened = next);
  return { host, said, loaded, crossed, released, replace };
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
  await showing(view().host)(board, camera);
  return asked;
}

describe("showing", () => {
  it("draws each image of a board, telling how many it drew, then how many elements it holds", async () => {
    const { host, said, loaded } = view();
    await showing(host)(await demo());
    expect(loaded.toSorted()).toEqual([LARGEST, MIDDLE, SMALLEST].toSorted());
    expect(said).toEqual([
      ["demo: 8 elements", true],
      ["demo: 8 elements, 1 of 3 images…", true],
      ["demo: 8 elements, 2 of 3 images…", true],
      ["demo: 8 elements, 3 of 3 images…", true],
      ["demo: 8 elements", undefined],
    ]);
  });

  it("reads first the largest image on screen", async () => {
    expect((await reads())[0]).toBe(`assets/${LARGEST}`);
    expect((await reads({ x: 650, y: 50, zoom: 4 }))[0]).toBe(`assets/${SMALLEST}`);
  });

  it("crosses out an image this machine cannot decode, and says so", async () => {
    const { host, said, crossed, loaded } = view({ undecodable: [MIDDLE] });
    await showing(host)(await demo());
    expect(crossed).toEqual([MIDDLE]);
    expect(loaded).not.toContain(MIDDLE);
    expect(said.at(-1)).toEqual([
      "demo: 8 elements, an image this machine cannot decode",
      undefined,
    ]);
  });

  it("shows nothing of a board whose image is unlike its digest, and says why it fails", async () => {
    const { host } = view();
    const board = await demo((files) => tamper(files, MIDDLE));
    await expect(showing(host)(board)).rejects.toThrow(`asset ${MIDDLE} does not match its digest`);
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
    await expect(showing(host)(board)).rejects.toThrow("does not match its digest");
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
    await showing(host)(await demo());
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
    await showing(host)(board);
    expect(held).toEqual([true, true, true]);
  });
});
