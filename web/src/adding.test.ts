// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rectangleKind } from "../test/kinds.js";
import { boardOf } from "../test/boards.js";
import { fakeRenderer } from "../test/renderers.js";
import { sample } from "../test/folders.js";
import { adding, type Host } from "./adding.js";
import { imageKind, type Opened, type Reader } from "./board.js";
import * as core from "./core.js";
import type { Edits } from "./edit.js";
import type { Renderer } from "./renderer.js";

const IMAGE = "a".repeat(32);
const SHAPE = "c".repeat(32);
const ASSET = "f".repeat(64);
const shape = rectangleKind();

const PNG = (() => {
  const [bytes] = [...sample("demo")]
    .filter(([path]) => path.endsWith(".png"))
    .map(([, one]) => one);
  return new Blob([bytes!], { type: "image/png" });
})();
const NATURAL = { width: 320, height: 240 };

const incoming = () => Promise.resolve([{ name: "a.png", bytes: PNG }]);

class Bitmap {
  closed = false;
  readonly width = NATURAL.width;
  readonly height = NATURAL.height;
  close(): void {
    this.closed = true;
  }
}

interface Shown {
  board: Opened | undefined;
  renderer: Renderer | undefined;
}

function intake(
  opened: Opened,
  {
    selected = [],
    stopped = () => false,
    renderer = fakeRenderer(),
    later,
    heldSize = () => undefined,
    idle = () => {},
  }: {
    selected?: string[];
    stopped?: () => boolean;
    renderer?: Renderer;
    /**
     * What draws the board only once an edit under way ends, nothing drawing it before, which leaves
     * the bitmaps decoded to the board.
     */
    later?: Renderer;
    heldSize?: Host["heldSize"];
    idle?: (shown: Shown) => void;
  } = {},
) {
  const shown: Shown = { board: opened, renderer: later ? undefined : renderer };
  const said: string[] = [];
  const select = vi.fn<Edits["select"]>();
  const keep = vi.fn<Host["keep"]>();
  const load = vi.fn<Host["load"]>();
  const editing = {
    selection: () => selected,
    entered: () => undefined,
    async idle() {
      shown.renderer ??= later;
      idle(shown);
    },
    apply(work: (editor: core.Editor, touched: string[]) => void) {
      const touched: string[] = [];
      work(opened.editor, touched);
      opened.board = core.board(opened.editor);
      return touched;
    },
    select,
  };
  const taking = adding({
    hold() {
      const board = shown.board;
      return board && { board, shows: () => shown.board === board && shown.renderer !== undefined };
    },
    renderer: () => shown.renderer,
    load,
    keep,
    heldSize,
    editing,
    viewport: {
      zoom: () => 1,
      camera: () => ({ x: 0, y: 0, zoom: 1 }),
      size: () => ({ width: 800, height: 600 }),
      centre: () => ({ x: 400, y: 300 }),
    },
    between: () => ({ top: 0, bottom: 560 }),
    savesToFiles: () => false,
    stopped,
    say: (text) => void said.push(text),
    drawn() {},
  });
  return { taking, said, select, keep, load, shown };
}

describe("what the board takes in", () => {
  it("duplicates the selection right and down of it, as one edit that selects the copy", () => {
    const opened = boardOf([[SHAPE, shape]]);
    const { taking, select } = intake(opened, { selected: [SHAPE] });
    taking.duplicate();
    const [copy] = select.mock.calls[0]![0];
    expect(copy).toBeDefined();
    expect(copy).not.toBe(SHAPE);
    const kind = opened.board.elements[copy!]?.kind;
    expect(kind?.type === "shape" && kind.frame.x > 0 && kind.frame.y > 0).toBe(true);
    expect(opened.editor.canUndo()).toBe(true);
  });

  it("pastes centred where asked, leaving out the images whose files are out of reach", async () => {
    const source = boardOf([
      [
        IMAGE,
        imageKind(ASSET, { width: 320, height: 240 }, { x: 0, y: 0, width: 320, height: 240 }),
      ],
      [SHAPE, shape],
    ]);
    const copied = core.copy(source.editor, [IMAGE, SHAPE]);
    const opened = boardOf([]);
    const { taking, said, select } = intake(opened);
    await taking.paste({ copied, assets: async () => new Map() }, { x: 500, y: 500 });
    const pasted = select.mock.calls[0]![0];
    expect(pasted.map((id) => opened.board.elements[id]?.kind.type)).toEqual(["shape"]);
    // By whole steps of the grid.
    const area = core.extent(opened.editor, pasted)!;
    const step = core.gridLevel(1).spacing;
    expect(Math.abs(area.x + area.width / 2 - 500)).toBeLessThanOrEqual(step);
    expect(Math.abs(area.y + area.height / 2 - 500)).toBeLessThanOrEqual(step);
    expect(said).toEqual(["Not pasted, the images whose files are out of reach here"]);
  });

  it("pastes nothing once another board shows meanwhile", async () => {
    const copied = core.copy(boardOf([[SHAPE, shape]]).editor, [SHAPE]);
    const opened = boardOf([]);
    const { taking, said, select, keep } = intake(opened, {
      idle: (shown) => {
        shown.board = boardOf([]);
      },
    });
    await taking.paste({ copied, assets: async () => new Map() }, { x: 0, y: 0 });
    expect(opened.board.draw_order).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
    expect(said).toEqual([]);
  });

  it("says which images it could not add, and why", async () => {
    const opened = boardOf([]);
    const { taking, said, select, keep } = intake(opened);
    await taking.images(
      Promise.resolve([
        { name: "a.txt", failure: "this is no image" },
        { name: "b.txt", failure: "nor this" },
      ]),
      { x: 0, y: 0 },
    );
    expect(opened.board.draw_order).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
    expect(said.at(-1)).toBe("Not added, a.txt: this is no image; b.txt: nor this");
  });

  describe("images decoded", () => {
    const decoded: Bitmap[] = [];
    let meanwhile: () => void;

    beforeEach(() => {
      meanwhile = () => {};
      vi.stubGlobal("ImageBitmap", Bitmap);
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => {
          meanwhile();
          decoded.push(new Bitmap());
          return decoded.at(-1);
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      decoded.length = 0;
    });

    it("lands in the renderer as soon as it is decoded, then on the board, selected, as one edit", async () => {
      const opened = boardOf([]);
      const renderer = fakeRenderer();
      const { taking, select, keep, load } = intake(opened, { renderer });
      await taking.images(incoming(), { x: 400, y: 300 });
      const [bitmap] = decoded;
      const [id] = opened.board.draw_order;
      const kind = opened.board.elements[id!]?.kind;
      expect(kind?.type === "image" && kind.natural_size).toEqual(NATURAL);
      expect(select).toHaveBeenCalledWith([id]);
      expect(opened.editor.canUndo()).toBe(true);
      const asset = kind?.type === "image" ? kind.asset : undefined;
      expect(load).toHaveBeenCalledExactlyOnceWith(renderer, new Map([[asset, bitmap]]));
      expect(load.mock.invocationCallOrder[0]).toBeLessThan(keep.mock.invocationCallOrder[0]!);
      // The renderer took it over, so that the board's copy of it is gone.
      expect(keep).toHaveBeenCalledOnce();
      expect(keep.mock.calls[0]![0]).toBe(opened);
      expect(keep.mock.calls[0]![1].map(({ decoded: left }) => left)).toEqual([undefined]);
      expect(bitmap!.closed).toBe(false);
    });

    it("lands in the renderer that draws the board once the image is decoded, though none did when adding began", async () => {
      const opened = boardOf([]);
      const renderer = fakeRenderer();
      const { taking, select, keep, load, shown } = intake(opened, { renderer });
      shown.renderer = undefined;
      meanwhile = () => {
        shown.renderer = renderer;
      };
      await taking.images(incoming(), { x: 400, y: 300 });
      const [bitmap] = decoded;
      const [id] = opened.board.draw_order;
      const kind = opened.board.elements[id!]?.kind;
      const asset = kind?.type === "image" ? kind.asset : undefined;
      expect(load).toHaveBeenCalledExactlyOnceWith(renderer, new Map([[asset, bitmap]]));
      expect(load.mock.invocationCallOrder[0]).toBeLessThan(keep.mock.invocationCallOrder[0]!);
      // The renderer took it over, so that the board's copy of it is gone.
      expect(keep.mock.calls[0]![1].map(({ decoded: left }) => left)).toEqual([undefined]);
      expect(select).toHaveBeenCalledWith([id]);
      expect(bitmap!.closed).toBe(false);
    });

    it("hands an image added over to the board when the renderer draws only once it is decoded", async () => {
      const opened = boardOf([]);
      const { taking, select, keep, load } = intake(opened, { later: fakeRenderer() });
      await taking.images(incoming(), { x: 400, y: 300 });
      expect(load).not.toHaveBeenCalled();
      expect(keep).toHaveBeenCalledOnce();
      expect(keep.mock.calls[0]![0]).toBe(opened);
      expect(keep.mock.calls[0]![1].map(({ decoded: left }) => left)).toEqual(decoded);
      expect(select).toHaveBeenCalledOnce();
      expect(opened.board.draw_order).toHaveLength(1);
      expect(decoded.map(({ closed }) => closed)).toEqual([false]);
    });

    it("is not added, but freed, when no renderer ever draws the board", async () => {
      const opened = boardOf([]);
      const { taking, select, keep, load, shown } = intake(opened);
      shown.renderer = undefined;
      await taking.images(incoming(), { x: 400, y: 300 });
      expect(load).not.toHaveBeenCalled();
      expect(keep).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(opened.board.draw_order).toEqual([]);
      expect(decoded.map(({ closed }) => closed)).toEqual([true]);
    });

    it("is not loaded into the renderer, nor added, once another board shows, and is freed", async () => {
      const opened = boardOf([]);
      const { taking, select, keep, load, shown } = intake(opened);
      meanwhile = () => {
        shown.board = boardOf([]);
      };
      await taking.images(incoming(), { x: 400, y: 300 });
      expect(load).not.toHaveBeenCalled();
      expect(keep).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(opened.board.draw_order).toEqual([]);
      expect(decoded.map(({ closed }) => closed)).toEqual([true]);
    });

    it("is not added, but freed, when another board shows while an edit under way ends", async () => {
      const opened = boardOf([]);
      const { taking, select, keep } = intake(opened, {
        later: fakeRenderer(),
        idle: (shown) => {
          shown.board = boardOf([]);
        },
      });
      await taking.images(incoming(), { x: 400, y: 300 });
      expect(keep).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(opened.board.draw_order).toEqual([]);
      expect(decoded.map(({ closed }) => closed)).toEqual([true]);
    });

    it("is not added, but freed, once the app stopped", async () => {
      const opened = boardOf([]);
      const { taking, select, keep } = intake(opened, {
        later: fakeRenderer(),
        stopped: () => true,
      });
      await taking.images(incoming(), { x: 400, y: 300 });
      expect(keep).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(opened.board.draw_order).toEqual([]);
      expect(decoded.map(({ closed }) => closed)).toEqual([true]);
    });

    it("is not decoded when the board shows its asset already", async () => {
      const opened = boardOf([]);
      const { taking, select, keep, load } = intake(opened, { heldSize: () => NATURAL });
      await taking.images(incoming(), { x: 400, y: 300 });
      expect(decoded).toEqual([]);
      expect(load).not.toHaveBeenCalled();
      expect(keep.mock.calls[0]![1]).toHaveLength(1);
      expect(select).toHaveBeenCalledOnce();
      expect(opened.board.draw_order).toHaveLength(1);
    });

    async function copiedImage() {
      const source = boardOf([]);
      await intake(source).taking.images(incoming(), { x: 0, y: 0 });
      decoded.length = 0;
      const [id] = source.board.draw_order;
      const kind = source.board.elements[id!]!.kind;
      return {
        copied: core.copy(source.editor, [id!]),
        asset: kind.type === "image" ? kind.asset : "",
      };
    }

    it("pastes an image copied in another window from its bytes, loaded as soon as it is decoded", async () => {
      const { copied, asset } = await copiedImage();
      const opened = boardOf([]);
      const renderer = fakeRenderer();
      const { taking, said, select, keep, load } = intake(opened, { renderer });
      const assets = vi.fn<Reader>(async () => new Map([[asset, PNG]]));
      await taking.paste({ copied, assets }, { x: 500, y: 500 });
      expect(assets).toHaveBeenCalledExactlyOnceWith([asset]);
      const [bitmap] = decoded;
      expect(bitmap).toBeDefined();
      expect(load).toHaveBeenCalledExactlyOnceWith(renderer, new Map([[asset, bitmap]]));
      expect(load.mock.invocationCallOrder[0]).toBeLessThan(keep.mock.invocationCallOrder[0]!);
      // The renderer took it over, so that the board's copy of it is gone.
      expect(keep.mock.calls[0]![1].map((one) => [one.asset, one.decoded])).toEqual([
        [asset, undefined],
      ]);
      const [id] = select.mock.calls[0]![0];
      const kind = opened.board.elements[id!]?.kind;
      expect(kind?.type === "image" && kind.asset).toBe(asset);
      expect(opened.board.draw_order).toEqual([id]);
      expect(said).toEqual([]);
    });

    it("hands an image pasted over to the board when the renderer draws only once it is decoded", async () => {
      const { copied, asset } = await copiedImage();
      const opened = boardOf([]);
      const { taking, select, keep, load } = intake(opened, { later: fakeRenderer() });
      await taking.paste(
        { copied, assets: async () => new Map([[asset, PNG]]) },
        { x: 500, y: 500 },
      );
      expect(load).not.toHaveBeenCalled();
      expect(keep).toHaveBeenCalledOnce();
      expect(keep.mock.calls[0]![0]).toBe(opened);
      expect(keep.mock.calls[0]![1].map((one) => one.decoded)).toEqual(decoded);
      expect(decoded).toHaveLength(1);
      expect(decoded.map(({ closed }) => closed)).toEqual([false]);
      expect(select).toHaveBeenCalledOnce();
      expect(opened.board.draw_order).toHaveLength(1);
    });

    it("pastes nothing, but frees what it decoded, when no renderer ever draws the board", async () => {
      const { copied, asset } = await copiedImage();
      const opened = boardOf([]);
      const { taking, said, select, keep, load, shown } = intake(opened);
      shown.renderer = undefined;
      await taking.paste(
        { copied, assets: async () => new Map([[asset, PNG]]) },
        { x: 500, y: 500 },
      );
      expect(load).not.toHaveBeenCalled();
      expect(keep).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(opened.board.draw_order).toEqual([]);
      expect(decoded.map(({ closed }) => closed)).toEqual([true]);
      expect(said).toEqual([]);
    });

    it("pastes nothing, but frees what it decoded, once the app stopped", async () => {
      const { copied, asset } = await copiedImage();
      const opened = boardOf([]);
      const { taking, said, select, keep } = intake(opened, {
        later: fakeRenderer(),
        stopped: () => true,
      });
      await taking.paste(
        { copied, assets: async () => new Map([[asset, PNG]]) },
        { x: 500, y: 500 },
      );
      expect(keep).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(opened.board.draw_order).toEqual([]);
      expect(decoded.map(({ closed }) => closed)).toEqual([true]);
      expect(said).toEqual([]);
    });

    it("asks for the bytes of the images the board lacks only", async () => {
      const { copied, asset } = await copiedImage();
      const opened = boardOf([[IMAGE, imageKind(asset, NATURAL, { x: 0, y: 0, ...NATURAL })]]);
      const { taking, said, select } = intake(opened);
      const assets = vi.fn<Reader>(async () => new Map());
      await taking.paste({ copied, assets }, { x: 500, y: 500 });
      expect(assets).not.toHaveBeenCalled();
      expect(decoded).toEqual([]);
      expect(select).toHaveBeenCalledOnce();
      expect(opened.board.draw_order).toHaveLength(2);
      expect(said).toEqual([]);
    });

    it("leaves out an image whose bytes are another file's, freeing what it decoded", async () => {
      const { copied, asset } = await copiedImage();
      const other = new Blob([PNG, new Uint8Array([0])], { type: "image/png" });
      const opened = boardOf([]);
      const { taking, said, select, keep, load } = intake(opened);
      await taking.paste(
        { copied, assets: async () => new Map([[asset, other]]) },
        { x: 500, y: 500 },
      );
      expect(decoded.map(({ closed }) => closed)).toEqual([true]);
      expect(load).not.toHaveBeenCalled();
      expect(keep.mock.calls[0]![1]).toEqual([]);
      expect(select).not.toHaveBeenCalled();
      expect(opened.board.draw_order).toEqual([]);
      expect(said).toEqual(["Not pasted, the images whose files are out of reach here"]);
    });

    it("leaves out an image the browser cannot decode", async () => {
      const { copied, asset } = await copiedImage();
      vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("no image"));
      const opened = boardOf([]);
      const { taking, said, select, keep } = intake(opened);
      await taking.paste({ copied, assets: async () => new Map([[asset, PNG]]) }, { x: 0, y: 0 });
      expect(keep.mock.calls[0]![1]).toEqual([]);
      expect(select).not.toHaveBeenCalled();
      expect(opened.board.draw_order).toEqual([]);
      expect(said).toEqual(["Not pasted, the images whose files are out of reach here"]);
    });
  });
});
