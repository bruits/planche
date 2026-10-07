import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  centring,
  copiedAssets,
  duplicateOffset,
  exposing,
  files as filesOf,
  imageKind,
  newId,
  nudge,
  open,
  placed,
  prepare,
  reader,
  readAsset,
  refresh,
  row,
  untitled,
  webAddress,
} from "./board.js";
import * as core from "./core.js";
import type { Bytes, Kind } from "./core.js";
import type { Placed } from "./renderer.js";
import type { Slices, ZipHome } from "./platform.js";
import { saving, zipStore } from "./save.js";
import { zipFolder } from "./zip.js";
import { memoryHome, sample, SAMPLES } from "../test/folders.js";

const bytes = (text: string): Bytes => new TextEncoder().encode(text);

/** One of the demo's images. */
const ASSET = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png";
const NATURAL = { width: 320, height: 240 };

describe("open", () => {
  it("refuses a board one of whose images is missing", async () => {
    const files = sample("demo");
    files.delete(`assets/${ASSET}`);
    const { home } = memoryHome("demo", files);
    await expect(open(async () => home, new Map())).rejects.toThrow(`asset ${ASSET} is missing`);
  });
});

describe("readAsset", () => {
  it("reads an asset whose bytes match its digest", async () => {
    const { home } = memoryHome("demo", sample("demo"));
    const read = await readAsset(home, ASSET, NATURAL);
    expect(read).toMatchObject({ asset: ASSET, natural: NATURAL, vector: false });
    expect(read.blob.size).toBe(readFileSync(join(SAMPLES, "demo/assets", ASSET)).length);
  });

  it("refuses an asset whose bytes do not match its digest", async () => {
    const files = sample("demo");
    files.get(`assets/${ASSET}`)![100]! ^= 0xff;
    const { home } = memoryHome("demo", files);
    await expect(readAsset(home, ASSET, NATURAL)).rejects.toThrow(
      `asset ${ASSET} does not match its digest`,
    );
  });

  it("tells what an asset holds from as little of it as tells", async () => {
    const frame = "\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x4C\x01\x00";
    const gif = Uint8Array.from(`GIF89a\x01\x00\x01\x00\x00\x00\x00${frame}${frame};`, (c) =>
      c.charCodeAt(0),
    );
    const movie = Uint8Array.from(
      "\x00\x00\x00\x10ftypisom\x00\x00\x02\x00\x00\x00\x00\x08mdat",
      (c) => c.charCodeAt(0),
    );
    const assets = [bytes('<svg width="20" height="10"/>'), bytes("<html></html>"), gif, movie];
    const ids = assets.map((asset) => core.assetOf(core.digestOf(asset), asset));
    const files = new Map(ids.map((id, at) => [core.assetPath(id), assets[at]!]));
    const { home } = memoryHome("media", files);
    const [svg, html, moving, video] = await Promise.all(
      ids.map((id) => readAsset(home, id, NATURAL)),
    );
    expect(svg).toMatchObject({ vector: true, moving: undefined });
    // Shown crossed out, as an image this machine cannot decode.
    expect(html).toMatchObject({ vector: true });
    expect(moving).toMatchObject({ vector: false, moving: { bytes: gif, plays: 1 } });
    expect(video?.video?.type).toBe("video/mp4");
  });

  it("tells what an asset holds from all of it when its start does not", async () => {
    const frame = "\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x4C\x01\x00";
    // Both frames past its start, behind a comment, so that its start alone shows none.
    const blocks = `\xFF${"\x00".repeat(255)}`.repeat(Math.ceil(core.mediaStart() / 256));
    const gif = Uint8Array.from(
      `GIF89a\x01\x00\x01\x00\x00\x00\x00\x21\xFE${blocks}\x00${frame}${frame};`,
      (c) => c.charCodeAt(0),
    );
    const id = core.assetOf(core.digestOf(gif), gif);
    const { home } = memoryHome("media", new Map([[core.assetPath(id), gif]]));
    const read = await readAsset(home, id, NATURAL);
    expect(read).toMatchObject({ vector: false, moving: { bytes: gif, plays: 1 } });
  });

  it("refuses a missing asset", async () => {
    const files = sample("demo");
    files.delete(`assets/${ASSET}`);
    const { home } = memoryHome("demo", files);
    await expect(readAsset(home, ASSET, NATURAL)).rejects.toThrow("missing");
  });
});

describe("prepare", () => {
  it.each([ASSET, "fabec7ea4f16a728b547c12f25158c75f6b48cf14db92745f92e5e9edcd36d93.jpg"])(
    "names an image's asset after its digest and type, as the demo's %s",
    async (asset) => {
      const image = readFileSync(join(SAMPLES, "demo/assets", asset));
      const held: string[] = [];
      const added = await prepare(new Blob([image]), 2048, (known) => {
        held.push(known);
        return NATURAL;
      });
      expect(added).toMatchObject({ asset, natural: NATURAL });
      expect(held).toEqual([asset]);
    },
  );

  it("names a video's asset after its type", async () => {
    const movie = Uint8Array.from(
      "\x00\x00\x00\x10ftypisom\x00\x00\x02\x00\x00\x00\x00\x08mdat",
      (c) => c.charCodeAt(0),
    );
    const added = await prepare(new Blob([movie]), 2048, () => NATURAL);
    expect(added.asset).toBe(`${core.digestOf(movie)}.mp4`);
  });

  it("refuses markup that is not an SVG", async () => {
    await expect(prepare(new Blob(["<html></html>"]), 2048)).rejects.toThrow(
      "markup that is not an SVG",
    );
  });
});

/** A new board holding `kinds`, back to front, and their ids. */
function holding(kinds: Kind[]) {
  const opened = untitled();
  const ids = kinds.map((kind) => {
    const id = newId();
    refresh(opened, opened.editor.add(id, undefined, JSON.stringify(kind)));
    return id;
  });
  return { opened, ids };
}

function level(y: number): Kind {
  return { type: "line", from: { x: 0, y }, to: { x: 100, y } };
}

function heights(shown: Placed[]): (number | undefined)[] {
  return shown.map((each) => (each.kind === "line" ? each.from.y : undefined));
}

describe("placed", () => {
  const frame = { x: 0, y: 0, width: 100, height: 50 };
  const none = { placed: () => undefined };

  it("lays each text out where its element stacks, faded with it, but the one being written and those not laid out", () => {
    const { opened, ids } = holding([
      { type: "sticky", frame, rotation: 0, text: { content: "Dusk", font_size: 20 }, opacity: 50 },
      { type: "line", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
    ]);
    const sticky = ids[0]!;
    const texts = {
      placed: (id: string) => ({ id, frame, rotation: 0, paint: "sticky-ink" as const }),
    };
    expect(placed(opened, texts)).toMatchObject([
      { kind: "fill", opacity: 0.5 },
      { kind: "text", id: sticky, frame, paint: "sticky-ink", opacity: 0.5 },
      { kind: "line", opacity: 1 },
    ]);
    for (const shown of [placed(opened, texts, sticky), placed(opened, none)]) {
      expect(shown.map(({ kind }) => kind)).toEqual(["fill", "line"]);
    }
  });

  it("stacks what is being added where an element added to its group goes, under what lies above", () => {
    const { opened, ids } = holding([level(0), level(10)]);
    const group = newId();
    refresh(opened, opened.editor.group(group, ids));
    refresh(opened, opened.editor.add(newId(), undefined, JSON.stringify(level(20))));
    const item: Placed = {
      kind: "line",
      from: { x: 0, y: 99 },
      to: { x: 1, y: 99 },
      width: 1,
      paint: "ink",
      dashed: false,
      opacity: 1,
    };
    expect(heights(placed(opened, none, undefined, undefined, { item, group }))).toEqual([
      0, 10, 99, 20,
    ]);
    expect(heights(placed(opened, none, undefined, undefined, { item, group: undefined }))).toEqual(
      [0, 10, 20, 99],
    );
  });

  it("lays a group's panel under its elements, which an edit to one of them moves", () => {
    const { opened, ids } = holding([level(0), level(100)]);
    const group = newId();
    refresh(opened, opened.editor.group(group, ids));
    const filled = { ...core.element(opened.editor, group)!.kind, colour: "blue", fill: "tint" };
    refresh(opened, opened.editor.update(group, JSON.stringify(filled)));
    const panel = () => placed(opened, none).find((item) => item.kind === "fill");
    expect(placed(opened, none).map(({ kind }) => kind)).toEqual(["fill", "line", "line"]);
    // A twentieth of the mean side of what the lines span around it.
    expect(panel()).toMatchObject({ paint: "blue", frame: { y: -5, height: 110 } });
    refresh(opened, opened.editor.translate([ids[1]!], 0, 100));
    expect(panel()).toMatchObject({ frame: { y: -7.5, height: 215 } });
  });

  it("lays anew the panels of every group holding an element an edit moves", () => {
    const { opened, ids } = holding([level(0), level(100), level(200)]);
    const [inner, outer] = [newId(), newId()];
    refresh(opened, opened.editor.group(inner, ids.slice(0, 2)));
    refresh(opened, opened.editor.group(outer, [inner, ids[2]!]));
    for (const group of [inner, outer]) {
      const filled = { ...core.element(opened.editor, group)!.kind, fill: "tint" };
      refresh(opened, opened.editor.update(group, JSON.stringify(filled)));
    }
    const panels = () =>
      placed(opened, none).flatMap((item) => (item.kind === "fill" ? [item.frame.width] : []));
    const before = panels();
    refresh(opened, opened.editor.translate([ids[0]!], 300, 0));
    const after = panels();
    expect(after[0]).toBeGreaterThan(before[0]!);
    expect(after[1]).toBeGreaterThan(before[1]!);
  });

  it("draws an element anew once an edit touches it, and its images once other assets are crossed out", () => {
    const { opened, ids } = holding([imageKind(ASSET, NATURAL, { x: 0, y: 0, ...NATURAL })]);
    expect(placed(opened, none)).toMatchObject([{ kind: "image", frame: { x: 0 } }]);
    refresh(opened, opened.editor.translate(ids, 10, 0));
    expect(placed(opened, none)).toMatchObject([{ kind: "image", frame: { x: 10 } }]);
    expect(placed(opened, none, undefined, new Set([ASSET]))).toMatchObject([
      { kind: "outline", shape: "rectangle", frame: { x: 10 } },
      { kind: "outline", shape: "cross" },
    ]);
  });

  it("draws anew only the images whose assets were crossed out or back since", () => {
    const { opened, ids } = holding([
      { type: "line", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
      imageKind(ASSET, NATURAL, { x: 0, y: 0, ...NATURAL }),
      { type: "line", from: { x: 0, y: 10 }, to: { x: 100, y: 10 } },
    ]);
    const image = ids[1]!;
    placed(opened, none, undefined, new Set());
    const fetched = vi.spyOn(opened.editor, "drawn");
    const asked = () => fetched.mock.calls.flatMap(([fetching]) => fetching);
    // The same assets, as a new set, and one that no image shows.
    placed(opened, none, undefined, new Set());
    placed(opened, none, undefined, new Set(["0".repeat(64)]));
    expect(asked()).toEqual([]);
    placed(opened, none, undefined, new Set([ASSET]));
    expect(asked()).toEqual([image]);
    fetched.mockClear();
    expect(placed(opened, none, undefined, new Set())[1]).toMatchObject({ kind: "image" });
    expect(asked()).toEqual([image]);
  });
});

describe("exposing", () => {
  const none = { placed: () => undefined };
  const backing: Placed = {
    kind: "fill",
    frame: { x: 0, y: 0, width: 100, height: 100 },
    rotation: 0,
    paint: "board",
    opacity: 1,
  };

  it("draws the elements chosen, their groups' included, over what stands for the background, over the rest", () => {
    const { opened, ids } = holding([level(0), level(10), level(20), level(30)]);
    const group = newId();
    refresh(opened, opened.editor.group(group, [ids[0]!, ids[2]!]));
    const shown = exposing(opened, none, [group], { backing: [backing], light: false });
    expect(heights(shown)).toEqual([10, 30, undefined, 0, 20]);
    expect(shown.some((item) => item.light)).toBe(false);
  });

  it("draws the elements chosen in the light theme's colours when asked", () => {
    const { opened, ids } = holding([level(0), level(10)]);
    const shown = exposing(opened, none, [ids[1]!], { backing: [], light: true });
    expect(shown.map(({ light }) => light ?? false)).toEqual([false, true]);
  });
});

describe("row", () => {
  const sizes = [
    { width: 200, height: 100 },
    { width: 100, height: 300 },
  ];
  const view = { x: 0, y: 0, width: 1000, height: 800 };

  it("lays images side by side around where they were added, at their own size", () => {
    expect(row(sizes, { x: 500, y: 400 }, view)).toEqual([
      { x: 350, y: 350, width: 200, height: 100 },
      { x: 550, y: 250, width: 100, height: 300 },
    ]);
  });

  it("moves images added by the edge of the view into it", () => {
    const frames = row(sizes, { x: 990, y: 10 }, view);
    for (const { x, y, width, height } of frames) {
      expect(x).toBeGreaterThanOrEqual(view.x);
      expect(y).toBeGreaterThanOrEqual(view.y);
      expect(x + width).toBeLessThanOrEqual(view.x + view.width);
      expect(y + height).toBeLessThanOrEqual(view.y + view.height);
    }
    expect(frames.map(({ width }) => width)).toEqual([200, 100]);
  });

  it("shrinks images too large for the view as one, keeping their proportions", () => {
    const frames = row(sizes, { x: 50, y: 50 }, { x: 0, y: 0, width: 150, height: 600 });
    expect(frames.map(({ width, height }) => [width, height])).toEqual([
      [100, 50],
      [50, 150],
    ]);
    expect(frames[0]!.x).toBe(0);
    expect(frames[1]!.x + frames[1]!.width).toBe(150);
  });
});

describe("duplicateOffset", () => {
  it("steps by whole steps of the grid that shows, as few as span the least", () => {
    for (const zoom of [0.05, 0.37, 1, 3, 12]) {
      const step = core.gridLevel(zoom).spacing;
      const offset = duplicateOffset(zoom, 16);
      expect(Number.isInteger(offset / step)).toBe(true);
      expect(offset * zoom).toBeGreaterThanOrEqual(16);
      expect((offset - step) * zoom).toBeLessThan(16);
    }
  });
});

describe("nudge", () => {
  it("moves a CSS pixel, or ten when wide, whatever the zoom", () => {
    expect(nudge(2, false, false)).toBe(0.5);
    expect(nudge(0.5, true, false)).toBe(20);
  });

  it("moves by the step between the grid's lines that show, but those still fading in", () => {
    expect(nudge(1, false, true)).toBe(20);
    expect(nudge(1, true, true)).toBe(200);
    expect(nudge(0.5, false, true)).toBe(100);
  });
});

describe("centring", () => {
  it("brings an area's centre to within half a step of the grid of a point", () => {
    const area = { x: 3, y: 7, width: 40, height: 10 };
    const at = { x: 113, y: -52 };
    const by = centring(area, at, 1);
    expect(by).toEqual({ x: 100, y: -60 });
    expect(Math.abs(area.x + area.width / 2 + by.x - at.x)).toBeLessThanOrEqual(10);
    expect(Math.abs(area.y + area.height / 2 + by.y - at.y)).toBeLessThanOrEqual(10);
  });
});

/**
 * A ZIP file in memory read as the desktop reads one, at its path as it stands, so that a folder
 * indexed before a rewrite reads the new file at old offsets. `hold` holds the next read back.
 */
function zipInPlace(initial: Bytes) {
  let file = initial;
  let gate: Promise<void> | undefined;
  const slices = (): Slices => ({
    name: "demo.zip",
    size: file.length,
    async read(start, end) {
      const waiting = gate;
      gate = undefined;
      await waiting;
      return file.slice(start, end);
    },
  });
  const home: ZipHome = {
    async rewrite() {
      const parts: Bytes[] = [];
      let closed = false;
      return {
        sink: {
          name: "demo.zip",
          append: async (part) => void parts.push(part.slice()),
          close: async () => {
            file = new Uint8Array(Buffer.concat(parts));
            closed = true;
          },
          discard: async () => void (parts.length = 0),
        },
        written: () => (closed ? slices() : null),
      };
    },
    changed: async () => false,
    reread: async () => slices(),
    adopt: async () => {},
    remember: async () => {},
  };
  const hold = () => {
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    return release;
  };
  return { home, hold };
}

describe("reader", () => {
  it("reads only what a paste asks for, once it asks", async () => {
    const { home } = memoryHome("demo", sample("demo"));
    const { opened } = (await open(async () => home, new Map()))!;
    const read = vi.spyOn(home, "read");
    const assets = reader(opened, [ASSET]);
    expect(read).not.toHaveBeenCalled();
    expect(await assets([])).toEqual(new Map());
    const got = await assets([ASSET, "0".repeat(64)]);
    expect([...got.keys()]).toEqual([ASSET]);
    expect(got.get(ASSET)!.size).toBe(readFileSync(join(SAMPLES, "demo/assets", ASSET)).length);
  });

  it("reads at once the images of a ZIP file saved in place, which a save meanwhile keeps", async () => {
    const zip = zipInPlace(new Uint8Array(readFileSync(join(SAMPLES, "demo.zip"))));
    const { opened } = (await open(async () => zipFolder(await zip.home.reread()), new Map()))!;
    const saver = saving(zipStore(zip.home, opened), {
      snapshot: () => opened.editor.snapshot(),
      source: () => filesOf(opened),
      saved: () => {},
      failed: (reason) => {
        throw new Error(reason);
      },
      conflict: async () => false,
      reload: async () => "refused",
    });
    const images = Object.entries(opened.board.elements).flatMap(([id, { kind }]) =>
      kind.type === "image" ? [id] : [],
    );
    const assets = copiedAssets(core.copy(opened.editor, images));
    const release = zip.hold();
    const read = reader(opened, assets, saver);
    // As a cut does, which the save after it would leave out of the file.
    opened.editor.beginGesture();
    saver.touched(opened.editor.remove(images));
    opened.editor.endGesture();
    // Not before the reads end.
    expect(await saver.flush()).toBe(false);
    release();
    const got = await read(assets);
    expect([...got.keys()].toSorted()).toEqual(assets.toSorted());
    expect(await saver.flush()).toBe(true);
    expect(await opened.folder.list(3)).not.toContain(`assets/${assets[0]}`);
    await saver.stop();
  });
});

describe("a ZIP file saved in place", () => {
  it("keeps readable an image that an undo brings back once a save left it out, then holds it again", async () => {
    const zip = zipInPlace(new Uint8Array(readFileSync(join(SAMPLES, "demo.zip"))));
    const { opened } = (await open(async () => zipFolder(await zip.home.reread()), new Map()))!;
    const store = zipStore(zip.home, opened);
    const source = () => filesOf(opened);
    const save = async (touched: string[]) => {
      const snapshot = opened.editor.snapshot();
      try {
        return await store.save(snapshot, touched, source);
      } finally {
        snapshot.free();
      }
    };
    const images = Object.entries(opened.board.elements).flatMap(([id, { kind }]) =>
      kind.type === "image" && kind.asset === ASSET ? [id] : [],
    );
    expect(await save(opened.editor.remove(images))).toBe(true);
    expect(await opened.folder.list(3)).not.toContain(`assets/${ASSET}`);
    expect(await save(opened.editor.undo())).toBe(true);
    expect(await opened.folder.list(3)).toContain(`assets/${ASSET}`);
    await expect(readAsset(filesOf(opened), ASSET, NATURAL)).resolves.toMatchObject({
      asset: ASSET,
    });
  });
});

describe("webAddress", () => {
  it.each([
    ["https://example.com/cat.png", "https://example.com/cat.png"],
    ["  HTTP://Example.com/a b  ", "http://example.com/a%20b"],
    ["javascript:alert(1)", undefined],
    ["file:///Applications/Calculator.app", undefined],
    ["data:image/png;base64,AAAA", undefined],
    ["//example.com/cat.png", undefined],
    ["a cat on a mat", undefined],
    [undefined, undefined],
  ])("opens %s as %s", (text, address) => {
    expect(webAddress(text)).toBe(address);
  });
});
