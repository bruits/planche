import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { open, placed, prepare, readAsset, row } from "./board.js";
import * as core from "./core.js";
import type { Board, Bytes, Kind } from "./core.js";
import { memoryHome, sample, SAMPLES } from "../test/folders.js";

const bytes = (text: string): Bytes => new TextEncoder().encode(text);

/** One of the demo's images. */
const ASSET = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f";
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
    const ids = assets.map((asset) => core.assetId(asset));
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
    const id = core.assetId(gif);
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
  it("refuses markup that is not an SVG", async () => {
    await expect(prepare(new Blob(["<html></html>"]), 2048)).rejects.toThrow(
      "markup that is not an SVG",
    );
  });
});

/** What a board holding `kind` alone draws, its text left out. */
function drawn(kind: Kind) {
  const board: Board = {
    elements: { a: { z: "a0", kind } },
    draw_order: ["a"],
    background: "plain",
  };
  return placed(board, { placed: () => undefined });
}

describe("placed", () => {
  const frame = { x: 0, y: 0, width: 100, height: 50 };
  const text = { content: "", font_size: 20 };

  it("draws each part of a style as it comes when left out", () => {
    const shape: Kind = { type: "shape", frame, rotation: 0, shape: "rectangle", text };
    expect(drawn(shape)).toMatchObject([{ kind: "rectangle", paint: "ink", dashed: false }]);
    const sticky: Kind = { type: "sticky", frame, rotation: 0, text };
    expect(drawn(sticky)).toMatchObject([{ kind: "fill", paint: "paper-yellow" }]);
    const arrow: Kind = { type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
    expect(drawn(arrow)).toMatchObject([
      { kind: "line", paint: "ink", dashed: false },
      { kind: "line", paint: "ink", dashed: false },
      { kind: "line", paint: "ink", dashed: false },
    ]);
    expect(drawn({ ...arrow, heads: "both" })).toHaveLength(5);
  });

  it("fills no cross, though one from an older file may hold a fill", () => {
    const cross: Kind = { type: "shape", frame, rotation: 0, shape: "cross", text, fill: "solid" };
    expect(drawn(cross)).toMatchObject([{ kind: "cross" }]);
    expect(drawn({ ...cross, shape: "ellipse" })).toMatchObject([
      { kind: "fill", shape: "ellipse" },
      { kind: "ellipse" },
    ]);
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
