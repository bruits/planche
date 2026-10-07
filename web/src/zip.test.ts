import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, it, expect, vi } from "vitest";
import { files, open } from "./board.js";
import * as core from "./core.js";
import type { Bytes } from "./core.js";
import type { Folder, Sink, Slices } from "./platform.js";
import { writeZip, zipFolder } from "./zip.js";
import { memoryHome, sample, SAMPLES } from "../test/folders.js";

/** One of the demo's images, 12 kB. */
const ASSET = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png";

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

/**
 * The ZIP file another tool makes of `entries`, each deflated, in `folder`, with the sizes it
 * `claims`.
 */
function rezipped(
  entries: Map<string, Bytes>,
  { folder = "demo", claims = (_: string, size: number) => size } = {},
): Bytes {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const [path, bytes] of entries) {
    const name = new TextEncoder().encode(`${folder}/${path}`);
    const data = deflateRawSync(bytes);
    const fields = (record: DataView, at: number) => {
      record.setUint16(at, 20, true); // version needed
      record.setUint16(at + 4, 8, true); // deflated
      record.setUint32(at + 10, core.crc32(bytes), true);
      record.setUint32(at + 14, data.length, true);
      record.setUint32(at + 18, claims(path, bytes.length), true);
      record.setUint16(at + 22, name.length, true);
    };
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    fields(local, 4);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    fields(central, 6);
    central.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    directory.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.size, true);
  end.setUint16(10, entries.size, true);
  end.setUint32(12, Buffer.concat(directory).length, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...parts, ...directory, new Uint8Array(end.buffer)]));
}

/** As many bytes as asked, that deflate cannot shrink. */
function noise(length: number): Bytes {
  const bytes = new Uint8Array(length);
  let state = 1;
  for (let at = 0; at < length; at++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[at] = state >>> 24;
  }
  return bytes;
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

describe("zipFolder, of a ZIP file another tool made", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the board that tool deflated in a folder, which exports as the app zips it", async () => {
    const zipped = slices("demo.zip", rezipped(sample("demo")));
    const fromZip = await open(() => zipFolder(zipped), new Map());
    const fromFolder = await open(async () => memoryHome("demo", sample("demo")).home, new Map());
    expect(fromZip!.opened.board).toEqual(fromFolder!.opened.board);
    const written = await exported(await zipFolder(zipped));
    expect(Buffer.compare(written.bytes(), demoZip())).toBe(0);
  });

  it("inflates a large file whole", async () => {
    const big = new Uint8Array(200_000).fill(7);
    const board = sample("demo").get("board.json")!;
    const zipped = rezipped(
      new Map([
        ["assets/big", big],
        ["board.json", board],
      ]),
    );
    const folder = await zipFolder(slices("big.zip", zipped));
    expect(await folder.read("assets/big")).toEqual(big);
  });

  it("refuses an entry that inflates to more or less than its ZIP file says", async () => {
    const board = sample("demo").get("board.json")!;
    for (const [by, refusal] of [
      [-1, "larger than its ZIP file says"],
      [1, "does not match its checksum"],
    ] as const) {
      const claims = (_: string, size: number) => size + by;
      const zipped = rezipped(new Map([["board.json", board]]), { claims });
      const folder = await zipFolder(slices("demo.zip", zipped));
      await expect(folder.read("board.json")).rejects.toThrow(refusal);
    }
  });

  it("refuses to inflate past the largest file a board takes", async () => {
    const board = sample("demo").get("board.json")!;
    const zipped = rezipped(
      new Map([
        ["assets/big", noise(300_000)],
        ["board.json", board],
      ]),
      {
        claims: (path, size) => (path === "board.json" ? size : 300e6 + 1),
      },
    );
    const folder = await zipFolder(slices("big.zip", zipped));
    await expect(folder.read("assets/big")).rejects.toThrow("is over 300 MB once unzipped");
  });

  it("says to unzip it where the browser cannot inflate", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    const folder = await zipFolder(slices("demo.zip", rezipped(sample("demo"))));
    await expect(folder.read("board.json")).rejects.toThrow("unzip it and open its folder");
  });
});
