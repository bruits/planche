import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { files, open } from "./board.js";
import type { Bytes } from "./core.js";
import type { Folder, Sink, Slices } from "./platform.js";
import { writeZip, zipFolder } from "./zip.js";
import { memoryHome, sample, SAMPLES } from "../test/folders.js";

/** One of the demo's images, 12 kB. */
const ASSET = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f";

function demoZip(): Bytes {
  return new Uint8Array(readFileSync(join(SAMPLES, "demo.zip")));
}

function slices(name: string, bytes: Bytes): Slices {
  return { name, size: bytes.length, read: async (start, end) => bytes.slice(start, end) };
}

function memorySink() {
  const parts: Bytes[] = [];
  let state: "open" | "closed" | "discarded" = "open";
  const sink: Sink = {
    name: "demo.zip",
    append: async (bytes) => void parts.push(bytes.slice()),
    close: async () => void (state = "closed"),
    discard: async () => {
      parts.length = 0;
      state = "discarded";
    },
  };
  return { sink, bytes: () => Buffer.concat(parts), state: () => state };
}

async function exported(folder: Folder) {
  const { opened } = (await open(async () => folder, new Map()))!;
  const snapshot = opened.editor.snapshot();
  const written = memorySink();
  try {
    await writeZip(snapshot, files(opened), written.sink);
  } finally {
    snapshot.free();
  }
  return written;
}

describe("writeZip", () => {
  it("exports the demo board to the exact bytes of samples/demo.zip", async () => {
    const written = await exported(memoryHome("demo", sample("demo")).home);
    expect(written.state()).toBe("closed");
    expect(Buffer.compare(written.bytes(), demoZip())).toBe(0);
  });

  it("leaves nothing behind when an asset cannot be read", async () => {
    const contents = sample("demo");
    const { home } = memoryHome("demo", contents);
    const { opened } = (await open(async () => home, new Map()))!;
    contents.delete(`assets/${ASSET}`);
    const snapshot = opened.editor.snapshot();
    const written = memorySink();
    try {
      await expect(writeZip(snapshot, home, written.sink)).rejects.toThrow("missing");
    } finally {
      snapshot.free();
    }
    expect(written.state()).toBe("discarded");
    expect(written.bytes()).toHaveLength(0);
  });
});

describe("zipFolder", () => {
  it("reads a board's ZIP file as the board its folder holds", async () => {
    const fromFolder = await open(async () => memoryHome("demo", sample("demo")).home, new Map());
    const fromZip = await open(() => zipFolder(slices("demo.zip", demoZip())), new Map());
    expect(fromZip!.opened.folder.name).toBe("demo");
    expect(fromZip!.opened.board).toEqual(fromFolder!.opened.board);
  });

  it("refuses an asset whose bytes were damaged in the file", async () => {
    const bytes = demoZip();
    // Into the asset's own bytes, past its name in the header before them.
    const at = Buffer.from(bytes).indexOf(`assets/${ASSET}`) + 2000;
    bytes[at]! ^= 0xff;
    const folder = await zipFolder(slices("demo.zip", bytes));
    await expect(folder.read(`assets/${ASSET}`)).rejects.toThrow("does not match its checksum");
    await expect(folder.read("board.json")).resolves.toBeDefined();
  });
});
