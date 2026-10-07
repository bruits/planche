// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { answer, type Reading } from "./agent.js";
import type { Writing } from "./author.js";
import { open, type Opened } from "./board.js";
import type { Bytes } from "./core.js";
import { memoryHome, sample } from "../test/folders.js";

const MISSING = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png";
const STICKY = "b7d4e1f05a2c4c8e9f3a6d2b1c0e5f74";

async function page(change: (files: Map<string, Bytes>) => void, halfDrawn = false) {
  const files = sample("demo");
  change(files);
  const opened = (await open(async () => memoryHome("demo", files).home, new Map()))!.opened;
  return {
    opened: () => opened as Opened | undefined,
    unsaved: () => false,
    shown: () => undefined,
    halfDrawn: () => halfDrawn,
    crossedOut: (asset: string) => (asset === MISSING ? "its file is missing" : undefined),
  } as unknown as Reading & Writing;
}

interface Outline {
  images_read: boolean;
  left_out: { path: string; reason: string }[];
  elements: { image?: { crossed_out?: { path: string; reason: string } } }[];
}

async function outline(reading: Reading & Writing): Promise<Outline> {
  const call = { id: 1, tool: "board", args: {}, deadline: Date.now() + 60_000 };
  return (await answer(call, reading)) as Outline;
}

describe("answer", () => {
  it("tells which files the board left out, and which images show crossed out, with why", async () => {
    const read = await outline(
      await page((files) => {
        files.delete(`assets/${MISSING}`);
        files.set(`elements/${STICKY}.json`, new TextEncoder().encode("<<<<<<< ours\n"));
      }),
    );
    expect(read.images_read).toBe(true);
    expect(read.left_out).toEqual([
      {
        path: `elements/${STICKY}.json`,
        reason: expect.stringContaining("unresolved Git conflict"),
      },
    ]);
    const crossed = read.elements.flatMap(({ image }) => image?.crossed_out ?? []);
    expect(crossed).toEqual([{ path: `assets/${MISSING}`, reason: "its file is missing" }]);
  });

  it("says when the images are not all read yet", async () => {
    const read = await outline(await page(() => {}, true));
    expect(read.images_read).toBe(false);
    expect(read.left_out).toEqual([]);
  });
});
