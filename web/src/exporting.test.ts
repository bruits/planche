// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { untitled, type Opened } from "./board.js";
import * as core from "./core.js";
import type { Kind } from "./core.js";
import { exporting, type Host } from "./exporting.js";
import type { Sink } from "./platform.js";
import type { Renderer } from "./renderer.js";
import type { Vectors } from "./vector.js";

const SHAPE = "c".repeat(32);
const shape: Kind = {
  type: "shape",
  frame: { x: 0, y: 0, width: 100, height: 100 },
  shape: "rectangle",
  text: { content: "", font_size: 20 },
};
const OPTIONS = { longest: undefined, background: "board", margin: false } as const;

function file(name: string) {
  const parts: Uint8Array[] = [];
  let state: "open" | "closed" | "discarded" = "open";
  const sink: Sink = {
    name,
    append: async (bytes) => void parts.push(bytes),
    close: async () => void (state = "closed"),
    discard: async () => void (state = "discarded"),
  };
  return { sink, state: () => state, bytes: () => parts.flatMap((part) => [...part]) };
}

type CopyImage = ReturnType<Host["clip"]>["copyImage"];

function exports(
  pick: Host["platform"]["pickExport"],
  { shows = () => true, copy = async () => true }: { shows?: () => boolean; copy?: CopyImage } = {},
) {
  const opened: Opened = untitled();
  opened.editor.add(SHAPE, undefined, JSON.stringify(shape));
  opened.board = core.board(opened.editor);
  const said: string[] = [];
  const saved = vi.fn<Host["life"]["saved"]>();
  const closed = vi.fn<() => void>();
  const reported: Promise<unknown>[] = [];
  const out = exporting({
    platform: { pickExport: pick },
    opened: () => opened,
    hold: () => ({ board: opened, shows }),
    ready: () =>
      ({ maxTextureSide: 16_384, render: async () => ({}) as ImageData }) as unknown as Renderer,
    editing: { selection: () => [SHAPE] },
    showsAnnotations: () => true,
    life: { saver: () => undefined, saved },
    drawings: {} as Vectors,
    crossedOut: () => new Set(),
    loaded: () => false,
    media: { holds: () => false },
    clip: () => ({ copyImage: copy }),
    pictureCard: () => ({ close: closed }),
    timings: new Map(),
    say: (text) => void said.push(text),
    report: (work) => void reported.push(work),
  });
  return { out, opened, said, saved, closed, settled: () => Promise.all(reported) };
}

describe("what the board exports", () => {
  it("writes a ZIP file of the board as it stood, which it marks as saved", async () => {
    const written = file("Untitled.zip");
    const pick = vi.fn<Host["platform"]["pickExport"]>(async () => written.sink);
    const { out, opened, said, saved } = exports(pick);
    await out.zip();
    expect(pick).toHaveBeenCalledWith("Untitled.zip", "zip");
    expect(written.state()).toBe("closed");
    // A ZIP file opens with its first local header.
    expect(written.bytes().slice(0, 2)).toEqual([0x50, 0x4b]);
    expect(said).toEqual(["Exporting Untitled.zip…", "Exported Untitled.zip"]);
    expect(saved.mock.calls[0]![0]).toBe(opened.editor);
    expect(out.busy()).toBe(false);
  });

  it("refuses another export while one waits for where to go", async () => {
    let answer: ((sink: Sink | null) => void) | undefined;
    const pick = vi.fn<Host["platform"]["pickExport"]>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { out } = exports(pick);
    const first = out.zip();
    expect(out.busy()).toBe(true);
    await expect(out.png(OPTIONS)).rejects.toThrow("An export is under way");
    await out.zip();
    expect(pick).toHaveBeenCalledOnce();
    answer?.(null);
    await first;
    expect(out.busy()).toBe(false);
  });

  it("leaves no file behind of a picture of a board no longer shown", async () => {
    const written = file("Untitled.png");
    let shown = true;
    const { out, closed } = exports(
      async () => {
        shown = false;
        return written.sink;
      },
      { shows: () => shown },
    );
    await expect(out.png(OPTIONS)).rejects.toThrow("Another board opened meanwhile");
    expect(written.state()).toBe("discarded");
    expect(written.bytes()).toEqual([]);
    expect(closed).not.toHaveBeenCalled();
    expect(out.busy()).toBe(false);
  });

  it("ends quietly when the user picks nowhere", async () => {
    const { out, said } = exports(async () => null);
    await out.png(OPTIONS);
    await out.zip();
    expect(said).toEqual([]);
    expect(out.busy()).toBe(false);
  });
});

const flush = () => new Promise((done) => setTimeout(done));

const taking =
  (answer: () => boolean | Promise<boolean>): CopyImage =>
  async (png) => {
    await png;
    return answer();
  };

/** The browser's canvas, which happy-dom draws nothing on. */
function pictured() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    putImageData() {},
  })) as unknown as HTMLCanvasElement["getContext"]);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) =>
    done(new Blob(["png"], { type: "image/png" })),
  );
}

describe("what the board saves as a picture", () => {
  beforeEach(pictured);

  afterEach(() => vi.restoreAllMocks());

  it("writes the picture, then says its size and closes the card that asked for it", async () => {
    const written = file("Untitled.png");
    const pick = vi.fn<Host["platform"]["pickExport"]>(async () => written.sink);
    const { out, said, closed } = exports(pick);
    await out.png(OPTIONS);
    expect(pick).toHaveBeenCalledWith("Untitled.png", "png");
    expect(written.state()).toBe("closed");
    // The bytes of "png".
    expect(written.bytes()).toEqual([0x70, 0x6e, 0x67]);
    expect(said).toEqual(["Exporting Untitled.png…", "Exported Untitled.png, 2048 × 2048"]);
    expect(closed).toHaveBeenCalledOnce();
    expect(out.busy()).toBe(false);
  });
});

describe("what the board copies as a picture", () => {
  beforeEach(pictured);

  afterEach(() => vi.restoreAllMocks());

  it("says it copies, then the size of what it copied", async () => {
    const { out, said, settled } = exports(async () => null, { copy: taking(() => true) });
    out.copyPng(OPTIONS);
    expect(said).toEqual(["Copying as PNG…"]);
    await settled();
    expect(said).toEqual(["Copying as PNG…", "Copied as PNG, 2048 × 2048"]);
  });

  it("clears its message once the copy is cancelled", async () => {
    const { out, said, settled } = exports(async () => null, { copy: taking(() => false) });
    out.copyPng(OPTIONS);
    await settled();
    expect(said).toEqual(["Copying as PNG…", ""]);
  });

  it("reports a copy that the browser refuses, which it does not say it made", async () => {
    const refusal = new Error("The browser did not let Planche copy the image");
    const { out, said, settled } = exports(async () => null, {
      copy: taking(() => {
        throw refusal;
      }),
    });
    out.copyPng(OPTIONS);
    await expect(settled()).rejects.toBe(refusal);
    expect(said).toEqual(["Copying as PNG…"]);
  });

  it("reports a picture that fails, which it does not say it copied", async () => {
    // The clipboard would write it, had it a picture.
    const { out, said, settled } = exports(async () => null, {
      shows: () => false,
      copy: taking(() => true),
    });
    out.copyPng(OPTIONS);
    await expect(settled()).rejects.toThrow("Another board opened meanwhile");
    expect(said).toEqual(["Copying as PNG…"]);
  });

  it("leaves the message of a later copy alone when an earlier one is cancelled", async () => {
    // As the clipboard cancels a copy that another one follows.
    const answers: ((written: boolean) => void)[] = [];
    const copy = taking(() => new Promise((resolve) => answers.push(resolve)));
    const { out, said, settled } = exports(async () => null, { copy });
    out.copyPng(OPTIONS);
    out.copyPng(OPTIONS);
    // Once both pictures are made, which is when the clipboard has them to answer for.
    await flush();
    answers[0]!(false);
    await flush();
    expect(said).toEqual(["Copying as PNG…", "Copying as PNG…"]);
    answers[1]!(true);
    await settled();
    expect(said).toEqual(["Copying as PNG…", "Copying as PNG…", "Copied as PNG, 2048 × 2048"]);
  });
});
