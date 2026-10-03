import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { open, readAsset, row } from "./board.js";
import { memoryHome, sample, SAMPLES } from "../test/folders.js";

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

  it("refuses a missing asset", async () => {
    const files = sample("demo");
    files.delete(`assets/${ASSET}`);
    const { home } = memoryHome("demo", files);
    await expect(readAsset(home, ASSET, NATURAL)).rejects.toThrow("missing");
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
