import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, refresh, stacked, untitled, type Opened } from "./board.js";
import * as core from "./core.js";
import type { Board, Kind, Rect } from "./core.js";
import {
  drawnOver,
  exported,
  pictureName,
  render as forAgent,
  sizing,
  standInSide,
  type Scene,
  type Textures,
} from "./render.js";
import type { Placed, Renderer } from "./renderer.js";
import type { Vectors } from "./vector.js";

const fakes = vi.hoisted(() => {
  class Bitmap {
    closed = false;
    readonly asset: string;
    readonly cap: number;
    constructor(asset: string, cap: number) {
      this.asset = asset;
      this.cap = cap;
    }
    close(): void {
      this.closed = true;
    }
  }
  return { Bitmap, decoded: [] as Bitmap[], meanwhile: () => {} };
});

// As long as reading and decoding an image takes, during which the window may change.
vi.mock("./board.js", async (original) => ({
  ...(await original<typeof import("./board.js")>()),
  readAsset: async (_folder: unknown, asset: string, natural: unknown) => {
    await new Promise((done) => setTimeout(done));
    fakes.meanwhile();
    return { asset, blob: new Blob([]), natural, vector: false };
  },
  decodeAsset: async ({ asset }: { asset: string }, cap: number) => {
    const bitmap = new fakes.Bitmap(asset, cap);
    fakes.decoded.push(bitmap);
    return bitmap;
  },
}));

const ASSET = "a".repeat(64);
const text = { content: "Dusk", font_size: 20 };

function boardOf(kinds: Record<string, Kind>): Board {
  const ids = Object.keys(kinds);
  return {
    elements: Object.fromEntries(ids.map((id, at) => [id, { z: `a${at}`, kind: kinds[id]! }])),
    draw_order: ids,
    background: "plain",
  };
}

/** A board holding `kinds`, back to front, each under an id of its own, by its key. */
function openedOf(kinds: Record<string, Kind>): { opened: Opened; ids: Record<string, string> } {
  const opened = untitled();
  const ids: Record<string, string> = {};
  for (const [name, kind] of Object.entries(kinds)) {
    ids[name] = newId();
    refresh(opened, opened.editor.add(ids[name], undefined, JSON.stringify(kind)));
  }
  return { opened, ids };
}

function image(frame: Rect, more: Partial<Extract<Kind, { type: "image" }>> = {}): Kind {
  return {
    type: "image",
    asset: ASSET,
    natural_size: { width: 400, height: 200 },
    frame,
    rotation: 0,
    edits: { crop: null, flip_horizontal: false, flip_vertical: false, greyscale: false },
    ...more,
  };
}

function bounds(kinds: Record<string, Kind>, crossedOut = new Set<string>()) {
  const { opened } = openedOf(kinds);
  return drawnOver(opened, opened.board.draw_order, crossedOut);
}

function drawnArrow(arrow: Kind): Extract<Placed, { kind: "arrow" }> {
  const [drawn] = stacked(openedOf({ a: arrow }).opened);
  return drawn as Extract<Placed, { kind: "arrow" }>;
}

describe("what a picture of the selection covers", () => {
  it("is an image's frame, as turned", () => {
    expect(bounds({ a: image({ x: 0, y: 0, width: 200, height: 100 }) })).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
    const turned = bounds({ a: image({ x: 0, y: 0, width: 200, height: 100 }, { rotation: 90 }) });
    expect(turned?.x).toBeCloseTo(50);
    expect(turned?.y).toBeCloseTo(-50);
    expect(turned?.width).toBeCloseTo(100);
    expect(turned?.height).toBeCloseTo(200);
  });

  it("takes in half a stroke past a line's ends and a shape's outline", () => {
    const half = core.strokeWidth("thick") / 2;
    const line: Kind = {
      type: "line",
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      weight: "thick",
    };
    expect(bounds({ a: line })).toEqual({
      x: -half,
      y: -half,
      width: 100 + 2 * half,
      height: 2 * half,
    });
    const frame = { x: 0, y: 0, width: 100, height: 50 };
    const shape: Kind = {
      type: "shape",
      frame,
      rotation: 0,
      shape: "ellipse",
      text,
      weight: "thick",
    };
    expect(bounds({ a: shape })).toEqual({
      x: -half,
      y: -half,
      width: 100 + 2 * half,
      height: 50 + 2 * half,
    });
  });

  it("takes in half a stroke past each point of a pen stroke", () => {
    const half = core.strokeWidth("thick") / 2;
    const stroke: Kind = {
      type: "stroke",
      frame: { x: 10, y: 20, width: 100, height: 50 },
      rotation: 0,
      points: [0, 1, 0.5, 0, 1, 1],
      weight: "thick",
    };
    expect(bounds({ a: stroke })).toEqual({
      x: 10 - half,
      y: 20 - half,
      width: 100 + 2 * half,
      height: 50 + 2 * half,
    });
  });

  it("reaches as far across as an arrow's heads spread, at both ends when it has two", () => {
    const arrow: Kind = {
      type: "arrow",
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      heads: "both",
    };
    const { head, width } = drawnArrow(arrow);
    const across = head / 2 + width / 2;
    const covered = bounds({ a: arrow })!;
    expect(covered.x).toBeCloseTo(-width / 2);
    expect(covered.y).toBeCloseTo(-across);
    expect(covered.width).toBeCloseTo(100 + width);
    expect(covered.height).toBeCloseTo(2 * across);
  });

  it("holds a text's frame, but neither a blank text nor a comment", () => {
    const frame = { x: 10, y: 20, width: 100, height: 30 };
    const note: Kind = { type: "note", frame, rotation: 0, text };
    const blank: Kind = {
      ...note,
      frame: { x: 500, y: 500, width: 10, height: 10 },
      text: { ...text, content: " " },
    };
    const comment: Kind = { type: "comment", at: { x: -900, y: -900 }, text: "Later" };
    expect(bounds({ a: note, b: blank, c: comment })).toEqual(frame);
    expect(bounds({ c: comment })).toBeUndefined();
  });

  it("outlines an image crossed out, as it draws one", () => {
    const half = core.strokeWidth() / 2;
    const frame = { x: 0, y: 0, width: 200, height: 100 };
    expect(bounds({ a: image(frame) }, new Set([ASSET]))).toEqual({
      x: -half,
      y: -half,
      width: 200 + 2 * half,
      height: 100 + 2 * half,
    });
  });
  it("bounds a turned ellipse by its curve, an image cut to one as an outline holding text", () => {
    const half = core.strokeWidth("thick") / 2;
    const frame = { x: 0, y: 0, width: 100, height: 100 };
    const circle: Kind = {
      type: "shape",
      frame,
      rotation: 45,
      shape: "ellipse",
      text,
      weight: "thick",
    };
    const cut = image(frame, {
      rotation: 45,
      edits: {
        crop: null,
        flip_horizontal: false,
        flip_vertical: false,
        greyscale: false,
        crop_shape: "ellipse",
      },
    });
    for (const [kind, width] of [
      [circle, 100 + 2 * half],
      [cut, 100],
    ] as const) {
      const covered = bounds({ a: kind })!;
      expect(covered.x).toBeCloseTo(50 - width / 2);
      expect(covered.width).toBeCloseTo(width);
      expect(covered.height).toBeCloseTo(width);
    }
    // Longer than wide, at an angle that tells across from down.
    const long: Kind = { ...circle, frame: { x: 0, y: 0, width: 200, height: 100 }, rotation: 30 };
    const [across, down] = [25 * Math.sqrt(13), 25 * Math.sqrt(7)];
    const covered = bounds({ a: long })!;
    expect(covered.x).toBeCloseTo(100 - across - half);
    expect(covered.y).toBeCloseTo(50 - down - half);
    expect(covered.width).toBeCloseTo(2 * (across + half));
    expect(covered.height).toBeCloseTo(2 * (down + half));
  });
});

describe("the size of a picture of the selection", () => {
  it("shows every pixel of the sharpest image", () => {
    expect(sizing({ width: 1000, height: 500 }, [1, 2], 16_384)).toEqual({
      zoom: 2,
      size: { width: 2000, height: 1000 },
      capped: false,
    });
  });

  it("gives an image alone exactly its pixels, past the floats' error, and a part pixel whole", () => {
    expect(sizing({ width: 400.000_000_000_1, height: 200 }, [1], 16_384).size).toEqual({
      width: 400,
      height: 200,
    });
    expect(sizing({ width: 100.4, height: 50.2 }, [1], 16_384).size).toEqual({
      width: 101,
      height: 51,
    });
  });

  it("draws one without images 2048 pixels along its longest side", () => {
    expect(sizing({ width: 400, height: 100 }, [], 16_384)).toEqual({
      zoom: 2048 / 400,
      size: { width: 2048, height: 512 },
      capped: false,
    });
  });

  it("stays within what a canvas and a texture hold, and says so", () => {
    expect(sizing({ width: 10_000, height: 10_000 }, [1], 16_384)).toMatchObject({
      size: { width: 4096, height: 4096 },
      capped: true,
    });
    expect(sizing({ width: 40_000, height: 10 }, [1], 8192)).toMatchObject({
      size: { width: 8192, height: 3 },
      capped: true,
    });
    for (const area of [
      { width: 8000.3, height: 6000.7 },
      { width: 4118, height: 4081 },
      { width: 4096.5, height: 4096.5 },
    ]) {
      const { size } = sizing(area, [1], 8192);
      expect(size.width * size.height).toBeLessThanOrEqual(4096 * 4096);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(8192);
    }
  });
});

describe("the name of a picture of the selection", () => {
  const frame = { x: 0, y: 0, width: 10, height: 10 };

  it("is a lone image's file's, else the board's", () => {
    const board = boardOf({
      a: image(frame, { filename: "Dusk light.jpeg" }),
      b: image(frame, { filename: "archive.tar.gz" }),
      c: image(frame),
      d: image(frame, { filename: ".jpg" }),
      e: image(frame, { filename: "boards/refs\\x.webp" }),
    });
    expect(pictureName(board, ["a"], "Moodboard")).toBe("Dusk light.png");
    expect(pictureName(board, ["b"], "Moodboard")).toBe("archive.tar.png");
    expect(pictureName(board, ["e"], "Moodboard")).toBe("x.png");
    for (const ids of [["a", "b"], ["c"], ["d"]]) {
      expect(pictureName(board, ids, "Moodboard")).toBe("Moodboard.png");
    }
  });
});

describe("what a picture of the selection decodes again", () => {
  const side = 16_384;

  it("decodes an image the window holds no texture of, small as it is", () => {
    expect(standInSide({ width: 400, height: 200 }, 1, side, false)).toBe(400);
    expect(standInSide({ width: 400, height: 200 }, 0.5, side, false)).toBe(200);
  });

  it("leaves an image to the window's texture while it holds as many pixels as the picture shows", () => {
    expect(standInSide({ width: 400, height: 200 }, 1, side, true)).toBeUndefined();
    expect(standInSide({ width: 2048, height: 1000 }, 1, side, true)).toBeUndefined();
    expect(standInSide({ width: 6000, height: 4000 }, 0.25, side, true)).toBeUndefined();
  });

  it("decodes a large one at the size the picture shows it, never past its own pixels", () => {
    expect(standInSide({ width: 6000, height: 4000 }, 0.5, side, true)).toBe(3000);
    expect(standInSide({ width: 3000, height: 2000 }, 3, side, true)).toBe(3000);
  });

  it("stays within what a texture and a canvas hold", () => {
    expect(standInSide({ width: 40_000, height: 100 }, 1, 8192, true)).toBe(8192);
    expect(standInSide({ width: 8000, height: 6000 }, 1, side, true)).toBeCloseTo(
      4096 * Math.sqrt(8000 / 6000),
    );
  });
});

function sceneOf(opened: Opened, render: Renderer["render"]): Scene {
  return {
    opened,
    renderer: { maxTextureSide: 16_384, render } as unknown as Renderer,
    drawings: { holds: () => false, drawn: () => undefined } as unknown as Vectors,
    crossedOut: new Set(),
    background: "rgb(0, 0, 0)",
  };
}

/** A board of one image, which the window holds no texture of, so that it is read again. */
function picture(render: Renderer["render"], current: () => boolean) {
  const { opened, ids } = openedOf({ a: image({ x: 0, y: 0, width: 400, height: 200 }) });
  const textures: Textures = { holds: () => false, plays: () => false, current };
  return { opened, made: exported(sceneOf(opened, render), [ids["a"]!], textures) };
}

describe("a picture of the selection", () => {
  const DRAWN = "drawn";

  beforeEach(() => vi.stubGlobal("ImageBitmap", fakes.Bitmap));

  afterEach(() => {
    vi.unstubAllGlobals();
    fakes.meanwhile = () => {};
    fakes.decoded.length = 0;
  });

  it("draws the selection as it stood, though an edit removed it while its image was read", async () => {
    const render = vi.fn<Renderer["render"]>().mockRejectedValue(new Error(DRAWN));
    const { opened, made } = picture(render, () => true);
    fakes.meanwhile = () => refresh(opened, opened.editor.remove(opened.board.draw_order));
    await expect(made).rejects.toThrow(DRAWN);
    expect(render.mock.calls[0]![0].items).toMatchObject([{ kind: "image", asset: ASSET }]);
  });

  it("draws nothing once another board took the window while its image was read", async () => {
    const render = vi.fn<Renderer["render"]>();
    let current = true;
    fakes.meanwhile = () => (current = false);
    await expect(picture(render, () => current).made).rejects.toThrow(
      "Another board opened meanwhile",
    );
    expect(render).not.toHaveBeenCalled();
    expect(fakes.decoded).toHaveLength(1);
    expect(fakes.decoded.every((bitmap) => bitmap.closed)).toBe(true);
  });

  it("shares a budget between the images it decodes, leaving one to the window's texture once it would hold more", async () => {
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => ({ putImageData() {} }) }),
    });
    // Five 4096 px images stacked, and a 2100 px one, all at their own pixels in a picture that a
    // canvas holds whole, though not their stand-ins, past the 2048 px textures the window holds.
    const kinds: Record<string, Kind> = {
      small: image(
        { x: 0, y: 0, width: 2100, height: 2100 },
        { natural_size: { width: 2100, height: 2100 } },
      ),
    };
    for (const at of [1, 2, 3, 4, 5]) {
      kinds[`big${at}`] = image(
        { x: 0, y: 0, width: 4096, height: 4096 },
        { asset: String(at).repeat(64), natural_size: { width: 4096, height: 4096 } },
      );
    }
    const { opened } = openedOf(kinds);
    const render = vi.fn<Renderer["render"]>().mockResolvedValue({} as ImageData);
    const textures: Textures = { holds: () => true, plays: () => false, current: () => true };
    const { capped } = await exported(sceneOf(opened, render), opened.board.draw_order, textures);
    expect(fakes.decoded.map(({ asset }) => asset)).not.toContain(ASSET);
    expect(fakes.decoded).toHaveLength(5);
    for (const { cap } of fakes.decoded) {
      expect(cap).toBeCloseTo(4096 * Math.sqrt(4 / 5));
    }
    expect(capped).toBe(true);
  });
});

async function framing(kinds: Record<string, Kind>, crossedOut = new Set<string>()) {
  const { opened } = openedOf(kinds);
  const draw = vi.fn<Renderer["render"]>().mockResolvedValue({} as ImageData);
  const scene = { ...sceneOf(opened, draw), crossedOut };
  const { area } = await forAgent(scene, { ids: opened.board.draw_order });
  return { area, drawn: draw.mock.calls[0]![0].area };
}

describe("a picture for an agent", () => {
  beforeEach(() =>
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => ({ putImageData() {} }) }),
    }),
  );

  afterEach(() => vi.unstubAllGlobals());

  it("frames an arrow by its stroke and its head, nothing past its tail, the thick stroke around", async () => {
    const arrow: Kind = { type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
    const { head, width } = drawnArrow(arrow);
    const across = head / 2 + width / 2;
    const margin = core.strokeWidth("thick");
    expect(0.02 * (100 + width)).toBeLessThan(margin);
    const { area, drawn } = await framing({ a: arrow });
    expect(area.x).toBeCloseTo(-width / 2 - margin);
    expect(area.y).toBeCloseTo(-across - margin);
    expect(area.width).toBeCloseTo(100 + width + 2 * margin, 0);
    expect(area.height).toBeCloseTo(2 * (across + margin), 0);
    expect(drawn).toEqual(area);
  });

  it("frames a turned ellipse and an image crossed out as they draw, 2% of the longest side around", async () => {
    const kinds: Record<string, Kind> = {
      // Left of the ellipse, so that where the picture starts shows the outline it is crossed out with.
      image: image({ x: -300, y: 0, width: 200, height: 100 }),
      ellipse: {
        type: "shape",
        frame: { x: 0, y: 0, width: 200, height: 100 },
        rotation: 30,
        shape: "ellipse",
        text: { content: "", font_size: 20 },
      },
    };
    const half = core.strokeWidth() / 2;
    const [across, down] = [25 * Math.sqrt(13), 25 * Math.sqrt(7)];
    const [left, right] = [-300 - half, 100 + across + half];
    const [top, bottom] = [50 - down - half, 50 + down + half];
    const margin = 0.02 * (right - left);
    const { area } = await framing(kinds, new Set([ASSET]));
    expect(area.x).toBeCloseTo(left - margin);
    expect(area.y).toBeCloseTo(top - margin);
    expect(area.width).toBeCloseTo(right - left + 2 * margin, 0);
    expect(area.height).toBeCloseTo(bottom - top + 2 * margin, 0);
  });

  it("refuses elements that draw nothing, and no elements at all", async () => {
    const draw = vi.fn<Renderer["render"]>();
    const { opened, ids: named } = openedOf({
      blank: {
        type: "note",
        frame: { x: 0, y: 0, width: 100, height: 40 },
        rotation: 0,
        text: { content: " ", font_size: 20 },
      },
      comment: { type: "comment", at: { x: 0, y: 0 }, text: "Later" },
    });
    for (const [ids, reason] of [
      [[named["blank"]!, named["comment"]!], "Those elements draw nothing to show"],
      [[], "Give an area or some ids"],
    ] as const) {
      await expect(forAgent(sceneOf(opened, draw), { ids: [...ids] })).rejects.toThrow(reason);
    }
    expect(draw).not.toHaveBeenCalled();
  });

  it("refuses a request of neither area nor ids, even on a board that draws", async () => {
    const draw = vi.fn<Renderer["render"]>();
    const arrow: Kind = { type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
    const { opened } = openedOf({ a: arrow });
    await expect(forAgent(sceneOf(opened, draw), {})).rejects.toThrow("Give an area or some ids");
    expect(draw).not.toHaveBeenCalled();
  });
});
