import { afterEach, describe, it, expect, vi } from "vitest";
import { animations } from "./animation.js";
import { imageKind, newId, refresh, untitled } from "./board.js";
import type { Playing, Renderer } from "./renderer.js";

const ASSET = "a".repeat(64);
const NATURAL = { width: 10, height: 10 };

/** A board showing one image of `ASSET`, and a renderer that may hold its texture. */
function scene() {
  const board = untitled();
  const kind = imageKind(ASSET, NATURAL, { x: 0, y: 0, ...NATURAL });
  refresh(board, board.editor.add(newId(), undefined, JSON.stringify(kind)));
  let held = false;
  let drawn = 0;
  const animate = vi.fn<Renderer["animate"]>((): Playing => ({
    next() {
      // As the renderer finds no frame to draw without the texture.
      if (!held) {
        return undefined;
      }
      drawn += 1;
      return 100;
    },
    restart() {},
    free() {},
  }));
  const renderer = { holds: () => held, animate } as unknown as Renderer;
  return {
    board: board.board,
    renderer,
    animate,
    hold: () => void (held = true),
    drawn: () => drawn,
  };
}

const camera = { x: 0, y: 0, zoom: 1 };
const viewport = { width: 100, height: 100 };

describe("animations", () => {
  const playing = animations(vi.fn(), vi.fn());

  afterEach(() => playing.reset());

  it("wait for their texture, which an undo brings back after the image, then play", () => {
    const { board, renderer, animate, hold, drawn } = scene();
    playing.keep([
      { asset: ASSET, natural: NATURAL, moving: { bytes: new Uint8Array(), plays: 1 } },
    ]);
    playing.update(board, renderer, camera, viewport);
    expect(animate).not.toHaveBeenCalled();
    expect(playing.playing(ASSET)).toBe(true);
    hold();
    playing.update(board, renderer, camera, viewport);
    expect(drawn()).toBe(1);
    expect(playing.playing(ASSET)).toBe(true);
  });
});
