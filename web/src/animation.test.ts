import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { animations, type Moving } from "./animation.js";
import { imageKind, newId, refresh, untitled } from "./board.js";
import * as core from "./core.js";
import type { Trim } from "./core.js";
import type { Playing, Renderer } from "./renderer.js";

const ASSET = "a".repeat(64);
const OTHER = "b".repeat(64);
const NATURAL = { width: 10, height: 10 };
const FRAMES = 5;

/** Each frame shown for a tenth of a second. */
function gif(frames: number): Uint8Array<ArrayBuffer> {
  const frame =
    "\x21\xF9\x04\x00\x0A\x00\x00\x00\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x4C\x01\x00";
  return Uint8Array.from(`GIF89a\x01\x00\x01\x00\x00\x00\x00${frame.repeat(frames)};`, (c) =>
    c.charCodeAt(0),
  );
}

function moving(frames = FRAMES, plays = Infinity): Moving {
  return { bytes: gif(frames), plays };
}

interface Shown {
  asset: string;
  trim?: Trim;
  speed?: number;
  x?: number;
  /** Of its frames, those that decode, as many as its delays unless told. */
  decodes?: number;
}

/**
 * A board showing an image of each asset, played as told, and a renderer that may hold their
 * textures, which records each frame it draws and how often it starts over.
 */
function scene(...images: Shown[]) {
  const board = untitled();
  for (const { asset, trim, speed, x = 0 } of images) {
    const id = newId();
    const kind = imageKind(asset, NATURAL, { x, y: 0, ...NATURAL });
    refresh(board, board.editor.add(id, undefined, JSON.stringify(kind)));
    if (trim) {
      refresh(board, core.setTrim(board.editor, [id], trim));
    }
    if (speed) {
      refresh(board, board.editor.setSpeed([id], speed));
    }
  }
  let held = false;
  const drawn = new Map(images.map(({ asset }) => [asset, [] as number[]]));
  const restarts = vi.fn<() => void>();
  const animate = vi.fn<Renderer["animate"]>((asset): Playing => {
    const decodes = images.find((image) => image.asset === asset)?.decodes ?? Infinity;
    let position = 0;
    const decode = () => {
      // Some time on each, as a frame of an image 1000 px a side takes.
      clock += 2.5;
      return position < decodes ? position++ : undefined;
    };
    return {
      next() {
        // As the renderer finds no frame to draw without the texture.
        const at = held ? decode() : undefined;
        if (at !== undefined) {
          drawn.get(asset)!.push(at);
        }
        return at === undefined ? undefined : 100;
      },
      skip: (count) => Array.from({ length: count }).filter(() => decode() !== undefined).length,
      pixels() {
        const at = decode();
        return at === undefined ? undefined : Uint8Array.of(at);
      },
      get position() {
        return position;
      },
      restart() {
        restarts();
        position = 0;
      },
      free() {},
    };
  });
  const renderer = {
    holds: () => held,
    animate,
    show: (asset: string, pixels: Uint8Array) => drawn.get(asset)!.push(pixels[0]!),
  } as unknown as Renderer;
  return {
    board,
    renderer,
    animate,
    hold: (holding = true) => void (held = holding),
    drawn: (asset = ASSET) => drawn.get(asset)!,
    restarts,
  };
}

const viewport = { width: 100, height: 100 };
let clock = 0;

describe("animations", () => {
  const playing = animations(vi.fn(), vi.fn());

  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    playing.reset();
    vi.restoreAllMocks();
  });

  const keep = (asset: string, frames = FRAMES) =>
    playing.keep([{ asset, natural: NATURAL, moving: moving(frames) }]);

  const at = (shown: ReturnType<typeof scene>, time: number, x = 0) => {
    clock = time;
    playing.update(shown.board.board, shown.renderer, { x, y: 0, zoom: 1 }, viewport);
  };

  it("wait for their texture, which an undo brings back after the image, then play", () => {
    keep(ASSET);
    const shown = scene({ asset: ASSET });
    at(shown, 0);
    expect(shown.animate).not.toHaveBeenCalled();
    expect(playing.playing(ASSET)).toBe(true);
    shown.hold();
    // The first frame shows in full, as the browser gave it.
    at(shown, 0);
    expect(shown.drawn()).toEqual([]);
    at(shown, 100);
    expect(shown.drawn()).toEqual([1]);
    expect(playing.playing(ASSET)).toBe(true);
  });

  it("play what their trim leaves of them, round and round, keeping its frames", () => {
    keep(ASSET);
    const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.4 } });
    shown.hold();
    // A little over a tenth apart, as going to its first frame took some time.
    for (const time of [0, 110, 220, 330, 440]) {
      at(shown, time);
    }
    expect(shown.drawn()).toEqual([1, 2, 3, 1, 2]);
    expect(playing.playback(ASSET)?.span).toEqual([1, 3]);
    expect(shown.restarts).not.toHaveBeenCalled();
  });

  it("play as fast as their speed says, and let frames whose time went by go unseen", () => {
    keep(ASSET);
    const shown = scene({ asset: ASSET, speed: 2 });
    shown.hold();
    for (const time of [0, 50, 100, 200]) {
      at(shown, time);
    }
    // The fourth showed from 150 to 200, unseen.
    expect(shown.drawn()).toEqual([1, 2, 4]);
    expect(playing.playback(ASSET)?.at).toBe(4);
  });

  it("stop once played through, on their last frame, and play from the start again", () => {
    const changed = vi.fn<() => void>();
    const once = animations(vi.fn(), changed);
    once.keep([{ asset: ASSET, natural: NATURAL, moving: moving(FRAMES, 1) }]);
    const shown = scene({ asset: ASSET });
    shown.hold();
    for (let time = 0; time <= 500; time += 100) {
      clock = time;
      once.update(shown.board.board, shown.renderer, { x: 0, y: 0, zoom: 1 }, viewport);
    }
    expect(once.playing(ASSET)).toBe(false);
    expect(once.playback(ASSET)?.at).toBe(4);
    expect(changed).toHaveBeenCalledOnce();
    once.play([ASSET], true);
    expect(once.playback(ASSET)?.at).toBe(0);
    once.reset();
  });

  it("step a frame at a time once paused, round within what plays", () => {
    keep(ASSET);
    const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.3 } });
    shown.hold();
    at(shown, 0);
    playing.step([ASSET], 1);
    at(shown, 1000);
    expect(playing.playing(ASSET)).toBe(false);
    expect(playing.playback(ASSET)?.at).toBe(2);
    playing.step([ASSET], 1);
    at(shown, 2000);
    playing.step([ASSET], -1);
    at(shown, 3000);
    expect(shown.drawn()).toEqual([1, 2, 1, 2]);
  });

  it("go back by decoding again from the first frame, drawing only the one it goes to", () => {
    keep(ASSET);
    const shown = scene({ asset: ASSET });
    shown.hold();
    playing.play([ASSET], false);
    playing.seek(ASSET, 3);
    at(shown, 0);
    playing.seek(ASSET, 1);
    at(shown, 1000);
    expect(shown.drawn()).toEqual([3, 1]);
    expect(shown.restarts).toHaveBeenCalledOnce();
  });

  it("go on to a far frame over several frames, as far as the budget lets them in each", () => {
    keep(ASSET, 20);
    const shown = scene({ asset: ASSET });
    shown.hold();
    playing.play([ASSET], false);
    playing.seek(ASSET, 19);
    let frames = 0;
    for (; shown.drawn().length === 0 && frames < 10; frames += 1) {
      at(shown, frames * 1000);
    }
    expect(shown.drawn()).toEqual([19]);
    expect(frames).toBeGreaterThan(1);
    expect(shown.restarts).not.toHaveBeenCalled();
  });

  it("draw the next frame of each before one that goes far takes what time is left", () => {
    keep(ASSET);
    keep(OTHER, 20);
    const shown = scene({ asset: ASSET }, { asset: OTHER, x: 20 });
    shown.hold();
    playing.play([OTHER], false);
    playing.seek(OTHER, 19);
    for (const time of [0, 100, 200]) {
      at(shown, time);
    }
    expect(shown.drawn(ASSET)).toEqual([1, 2]);
    expect(shown.drawn(OTHER)).toEqual([]);
  });

  it("keep their place out of sight, but where their texture was freed", () => {
    keep(ASSET);
    const shown = scene({ asset: ASSET });
    shown.hold();
    playing.play([ASSET], false);
    playing.seek(ASSET, 3);
    at(shown, 0);
    at(shown, 1000, 500);
    at(shown, 2000);
    expect(shown.drawn()).toEqual([3]);
    at(shown, 3000, 500);
    // No image draws it while it is out of sight.
    shown.hold(false);
    at(shown, 4000, 500);
    shown.hold();
    at(shown, 5000);
    expect(shown.drawn()).toEqual([3, 3]);
  });

  it("end at the last frame that decodes", () => {
    keep(ASSET);
    const shown = scene({ asset: ASSET, decodes: 3 });
    shown.hold();
    playing.play([ASSET], false);
    playing.seek(ASSET, 4);
    at(shown, 0);
    at(shown, 1000);
    expect(playing.playback(ASSET)).toMatchObject({ count: 3, at: 2 });
    expect(shown.drawn()).toEqual([2]);
  });

  it("play a span of them while one is previewed, which a frame sought at once falls within", () => {
    keep(ASSET);
    const shown = scene({ asset: ASSET, trim: { start: 0, end: 0.2 } });
    shown.hold();
    at(shown, 0);
    playing.preview(ASSET, [2, 3]);
    playing.seek(ASSET, 3);
    expect(playing.playback(ASSET)?.at).toBe(3);
    playing.seek(ASSET, 2);
    for (const time of [110, 220, 330]) {
      at(shown, time);
    }
    playing.preview(ASSET, undefined);
    at(shown, 440);
    expect(shown.drawn()).toEqual([2, 3, 2, 0]);
  });
});
