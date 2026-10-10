// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { imageKind, newId, refresh, untitled } from "./board.js";
import * as core from "./core.js";
import type { Trim } from "./core.js";
import type { Renderer } from "./renderer.js";
import { frameTimes, videos } from "./video.js";

const ASSET = "a".repeat(64);
const OTHER = "b".repeat(64);
const NATURAL = { width: 10, height: 10 };
/** Whether a page refuses to play sound unasked. */
let quiet = false;
/** Whether the host tells each frame it presents. */
let tells = true;

function joined(parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

function ascii(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function words(...values: number[]): number[] {
  return values.flatMap((value) => [
    value >>> 24,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]);
}

function box(kind: string, ...contents: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  const inside = joined(contents);
  return joined([words(8 + inside.length), ascii(kind), inside]);
}

/** `frames` a tenth of a second each, its index after its data. */
function movie(frames = 5): Blob {
  const header = (scale: number) => box("mdhd", words(0, 0, 0, scale, frames * 100));
  const track = box(
    "trak",
    box("tkhd", words(1)),
    box(
      "mdia",
      header(1000),
      box("hdlr", words(0, 0), ascii("vide")),
      box("minf", box("stbl", box("stts", words(0, 1, frames, 100)))),
    ),
  );
  const index = box("moov", box("mvhd", words(0, 0, 0, 1000, frames * 100)), track);
  const data = box("mdat", new Uint8Array(1000));
  return new Blob([box("ftyp", ascii("isom"), words(0)), data, index], { type: "video/mp4" });
}

/** Its id, then its size on 8 bytes. */
function element(id: number[], ...contents: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  const inside = joined(contents);
  return joined([id, [1, 0, 0, 0], words(inside.length), inside]);
}

/** Three frames 40 ms apart, typed as the core types it. */
function matroska(kind: "webm" | "matroska"): Blob {
  const block = (at: number) =>
    element([0xa3], [0x81, at >> 8, at & 255, 0x80], new Uint8Array(30));
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    element([0xae], element([0xd7], [1]), element([0x83], [1])),
  );
  const cluster = element(
    [0x1f, 0x43, 0xb6, 0x75],
    element([0xe7], [0]),
    block(0),
    block(40),
    block(80),
  );
  const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii(kind)));
  const bytes = joined([header, element([0x18, 0x53, 0x80, 0x67], tracks, cluster)]);
  const told = core.media(bytes, true);
  return new Blob([bytes], { type: told?.kind === "video" ? told.type : "" });
}

/**
 * A `<video>` that shows a frame only once told, as the page draws it, and that seeks once it
 * knows its frames, as one with its metadata does, in a host that tells no frame it presents.
 */
class Video extends EventTarget {
  preload = "";
  muted = false;
  playsInline = false;
  loop = false;
  playbackRate = 1;
  paused = true;
  ended = false;
  seeking = false;
  src = "";
  closed = false;
  readyState = 0;
  /** When the frame it shows starts. */
  shows = 0;
  protected presented: ((now: number, metadata: { mediaTime: number }) => void)[] = [];
  #time = 0;

  get currentTime(): number {
    return this.#time;
  }

  set currentTime(time: number) {
    this.#time = time;
    this.seeking = this.readyState > 0;
  }

  play(): Promise<void> {
    if (quiet && !this.muted) {
      return Promise.reject(new DOMException("No sound unasked", "NotAllowedError"));
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {}

  removeAttribute(): void {
    this.closed = true;
  }

  /** Has the frame it went to, which it may not present. */
  land(): void {
    this.shows = Math.floor(this.#time * 10) / 10;
    if (this.readyState === 0) {
      this.readyState = 2;
      this.dispatchEvent(new Event("loadeddata"));
    } else if (this.seeking) {
      this.seeking = false;
      this.dispatchEvent(new Event("seeked"));
    }
  }

  /** Plays on to `time`. */
  reach(time: number): void {
    this.#time = time;
    this.shows = Math.floor(time * 10) / 10;
  }

  present(mediaTime: number): void {
    this.land();
    this.shows = mediaTime;
    const callbacks = this.presented;
    this.presented = [];
    callbacks.forEach((callback) => callback(0, { mediaTime }));
  }
}

/** One in a host that tells each frame it presents. */
class Telling extends Video {
  requestVideoFrameCallback(callback: (now: number, metadata: { mediaTime: number }) => void) {
    this.presented.push(callback);
    return 0;
  }
}

/**
 * A board showing an image of each asset, played as told, and a renderer that copies the frames
 * they show, by number, while it holds their textures.
 */
function scene(...images: { asset: string; trim?: Trim; speed?: number }[]) {
  const board = untitled();
  const ids: string[] = [];
  for (const { asset, trim, speed } of images) {
    const id = newId();
    ids.push(id);
    refresh(
      board,
      board.editor.add(
        id,
        undefined,
        JSON.stringify(imageKind(asset, NATURAL, { x: 0, y: 0, ...NATURAL })),
      ),
    );
    if (trim) {
      refresh(board, core.setTrim(board.editor, [id], trim));
    }
    if (speed) {
      refresh(board, board.editor.setSpeed([id], speed));
    }
  }
  let held = true;
  const copied: number[] = [];
  const renderer = {
    holds: () => held,
    // Only once it has a frame, as copying one without throws.
    copyVideo: (_: string, video: Video) =>
      video.readyState >= 2 && copied.push(Math.round(video.shows * 10)) > 0,
  } as unknown as Renderer;
  const trim = (to: Trim) => refresh(board, core.setTrim(board.editor, ids, to));
  return { board, renderer, copied, trim, hold: (holding: boolean) => void (held = holding) };
}

describe("frameTimes", () => {
  it("tells when each frame of a movie starts, past the data before its index", async () => {
    expect(await frameTimes(movie())).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it.each(["webm", "matroska"] as const)(
    "tells when each frame of a %s video starts",
    async (kind) => {
      expect(await frameTimes(matroska(kind))).toEqual([0, 0.04, 0.08, 0.12]);
    },
  );

  it("tells nothing of a video it cannot read", async () => {
    expect(await frameTimes(new Blob([new Uint8Array(64)], { type: "video/mp4" }))).toBeUndefined();
  });
});

describe("videos", () => {
  const elements: Video[] = [];
  const changed = vi.fn<() => void>();
  const films = videos(vi.fn(), changed, vi.fn());

  beforeEach(() => {
    const make = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag !== "video") {
        return make(tag);
      }
      const made = tells ? new Telling() : new Video();
      elements.push(made);
      return made as unknown as HTMLVideoElement;
    });
  });

  afterEach(() => {
    films.reset();
    elements.length = 0;
    quiet = false;
    tells = true;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Once its frames are read, which tells. */
  const kept = async (asset = ASSET, video = movie()) => {
    films.keep([{ asset, video }]);
    changed.mockClear();
    films.playback(asset);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  };

  const update = (shown: ReturnType<typeof scene>) =>
    films.update(
      shown.board.board,
      shown.renderer,
      { x: 0, y: 0, zoom: 1 },
      { width: 100, height: 100 },
    );

  /** Has the frame it went to, then draws once the page would have said so. */
  const landed = (shown: ReturnType<typeof scene>, video: Video) => {
    video.land();
    vi.advanceTimersByTime(150);
    update(shown);
  };

  const frame = (shown: ReturnType<typeof scene>, video: Video, mediaTime: number) => {
    video.present(mediaTime);
    update(shown);
  };

  it("plays at its speed what its trim leaves of it, its last frame shown before its first again", async () => {
    await kept();
    const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.4 }, speed: 2 });
    update(shown);
    const [video] = elements;
    expect(video).toMatchObject({ playbackRate: 2, loop: false, paused: false });
    // A quarter into its first frame.
    expect(video!.currentTime).toBeCloseTo(0.125);
    frame(shown, video!, 0.1);
    frame(shown, video!, 0.2);
    expect(films.playback(ASSET)).toMatchObject({ at: 2, span: [1, 3], playing: true });
    frame(shown, video!, 0.3);
    expect(video!.currentTime).toBeCloseTo(0.125);
    frame(shown, video!, 0.1);
    expect(shown.copied).toEqual([1, 2, 3, 1]);
  });

  it("plays what its trim leaves of it once it reads its frames, unasked", async () => {
    films.keep([{ asset: ASSET, video: movie() }]);
    const shown = scene({ asset: ASSET, trim: { start: 0.2, end: 0.4 } });
    changed.mockClear();
    update(shown);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    update(shown);
    expect(elements[0]!.currentTime).toBeCloseTo(0.225);
    expect(films.playback(ASSET)?.span).toEqual([2, 3]);
  });

  it("plays a span while it is previewed, a frame sought at once within it, then its trim's again", async () => {
    await kept();
    const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.3 } });
    update(shown);
    const [video] = elements;
    frame(shown, video!, 0.1);
    // As the card trims it.
    films.play([ASSET], false);
    films.preview(ASSET, [3, 4]);
    films.seek(ASSET, 4);
    expect(films.playback(ASSET)).toMatchObject({ at: 4, span: [3, 4] });
    update(shown);
    frame(shown, video!, 0.4);
    // Left as it was, as Esc leaves it.
    films.preview(ASSET, undefined);
    update(shown);
    expect(films.playback(ASSET)).toMatchObject({ at: 1, span: [1, 2] });
    frame(shown, video!, 0.1);
    expect(shown.copied).toEqual([1, 4, 1]);
  });

  it("shows nothing past its trim, as one that played on between two frame callbacks", async () => {
    await kept();
    const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.4 } });
    update(shown);
    const [video] = elements;
    frame(shown, video!, 0.1);
    frame(shown, video!, 0.4);
    expect(video!.currentTime).toBeCloseTo(0.125);
    expect(films.playback(ASSET)?.at).toBe(1);
    frame(shown, video!, 0.1);
    expect(shown.copied).toEqual([1, 1]);
  });

  it("shows the frame it went to as the host gives it, though it tells the one before", async () => {
    await kept();
    const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.4 } });
    films.play([ASSET], false);
    films.seek(ASSET, 1);
    update(shown);
    frame(shown, elements[0]!, 0);
    update(shown);
    expect(elements[0]!.closed).toBe(true);
    expect(shown.copied).toEqual([0]);
  });

  it("shows a trim to one frame without playing it, its decoder let go", async () => {
    await kept();
    const shown = scene({ asset: ASSET, trim: { start: 0.2, end: 0.3 } });
    update(shown);
    const [video] = elements;
    expect(video).toMatchObject({ paused: true });
    frame(shown, video!, 0.2);
    update(shown);
    expect(video!.closed).toBe(true);
    expect(films.playing(ASSET)).toBe(true);
  });

  it("goes back at once when the first frame told after going back is past its trim", async () => {
    await kept();
    const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.3 }, speed: 2 });
    update(shown);
    const [video] = elements;
    frame(shown, video!, 0.1);
    frame(shown, video!, 0.2);
    // It played on past frame 2 before its first frame callback.
    frame(shown, video!, 0.3);
    expect(video!.currentTime).toBeCloseTo(0.125);
    frame(shown, video!, 0.1);
    expect(shown.copied).toEqual([1, 2, 1]);
  });

  it("keeps the frame a paused one went to, though the host tells the one before late", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    films.select(ASSET);
    films.step([ASSET], 2);
    update(shown);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    landed(shown, elements[0]!);
    frame(shown, elements[0]!, 0.1);
    expect(films.playback(ASSET)?.at).toBe(2);
    films.step([ASSET], 1);
    update(shown);
    expect(elements[0]!.currentTime).toBeCloseTo(0.325);
  });

  it("tells the frame one paused as it played stopped on, and goes to one sought since", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    films.select(ASSET);
    update(shown);
    const [video] = elements;
    frame(shown, video!, 0.1);
    films.play([ASSET], false);
    update(shown);
    // Presented before the pause took, told after it.
    frame(shown, video!, 0.2);
    expect(films.playback(ASSET)?.at).toBe(2);
    films.seek(ASSET, 4);
    frame(shown, video!, 0.2);
    expect(video!.currentTime).toBeCloseTo(0.425);
    expect(shown.copied).toEqual([1, 2, 2]);
  });

  it("goes a frame at a time once paused, and lets its decoder go once it shows it", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    update(shown);
    const [video] = elements;
    frame(shown, video!, 0);
    films.step([ASSET], -1);
    update(shown);
    expect(video).toMatchObject({ paused: true, seeking: true });
    expect(video!.currentTime).toBeCloseTo(0.425);
    expect(films.playback(ASSET)).toMatchObject({ at: 4, playing: false });
    frame(shown, video!, 0.4);
    update(shown);
    expect(video!.closed).toBe(true);
    films.step([ASSET], 1);
    update(shown);
    expect(elements[1]!.currentTime).toBeCloseTo(0.025);
    frame(shown, elements[1]!, 0);
    expect(shown.copied).toEqual([0, 4, 0]);
  });

  it("shows each frame it goes to on the way to the one asked for last", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    films.select(ASSET);
    films.play([ASSET], false);
    films.seek(ASSET, 1);
    update(shown);
    const [video] = elements;
    films.seek(ASSET, 2);
    films.seek(ASSET, 3);
    frame(shown, video!, 0.1);
    expect(video!.currentTime).toBeCloseTo(0.325);
    frame(shown, video!, 0.3);
    expect(shown.copied).toEqual([1, 3]);
  });

  it("keeps the decoder of the lone video selected while paused, even selected before it loads", async () => {
    films.select(ASSET);
    await kept();
    const shown = scene({ asset: ASSET });
    films.play([ASSET], false);
    films.step([ASSET], 1);
    update(shown);
    frame(shown, elements[0]!, 0.1);
    update(shown);
    expect(elements[0]!.closed).toBe(false);
    films.select(undefined);
    update(shown);
    expect(elements[0]!.closed).toBe(true);
  });

  it("counts a frame gone to as shown a moment after it went there, when the page draws none", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    films.select(ASSET);
    films.step([ASSET], 2);
    update(shown);
    vi.useFakeTimers();
    elements[0]!.land();
    update(shown);
    expect(shown.copied).toEqual([]);
    vi.advanceTimersByTime(150);
    update(shown);
    expect(shown.copied).toEqual([2]);
  });

  it("goes back to the frame it showed once its freed texture loads again", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    films.step([ASSET], 3);
    update(shown);
    frame(shown, elements[0]!, 0.3);
    shown.hold(false);
    update(shown);
    shown.hold(true);
    update(shown);
    expect(elements[1]!.currentTime).toBeCloseTo(0.325);
    frame(shown, elements[1]!, 0.3);
    expect(shown.copied).toEqual([3, 3]);
  });

  it("goes to the start of a trim an undo brings back, paused", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    films.play([ASSET], false);
    update(shown);
    expect(elements).toHaveLength(0);
    shown.trim({ start: 0.2, end: 0.4 });
    update(shown);
    expect(elements[0]!.currentTime).toBeCloseTo(0.225);
    frame(shown, elements[0]!, 0.2);
    expect(shown.copied).toEqual([2]);
  });

  it("steps those stepped before their frames were read, once they are", async () => {
    films.keep([{ asset: ASSET, video: movie() }]);
    films.step([ASSET], 1);
    expect(films.playback(ASSET)?.playing).toBe(false);
    await vi.waitFor(() => expect(films.playback(ASSET)?.count).toBe(5));
    const shown = scene({ asset: ASSET });
    update(shown);
    expect(films.playback(ASSET)?.at).toBe(1);
    expect(elements[0]!.currentTime).toBeCloseTo(0.125);
  });

  it("plays a whole video of one frame, sound and all, without stepping it", async () => {
    await kept(ASSET, movie(1));
    const shown = scene({ asset: ASSET });
    expect(films.steps(ASSET)).toBe(false);
    films.step([ASSET], 1);
    update(shown);
    expect(elements[0]).toMatchObject({ loop: true, paused: false });
  });

  it("plays one whose frames it cannot tell whole, and steps none of it", async () => {
    await kept(OTHER, new Blob([new Uint8Array(64)], { type: "video/mp4" }));
    const shown = scene({ asset: OTHER });
    expect(films.steps(OTHER)).toBe(false);
    films.step([OTHER], 1);
    update(shown);
    expect(elements[0]).toMatchObject({ loop: true, paused: false });
    expect(films.playback(OTHER)).toMatchObject({ count: 0, playing: true, sound: false });
  });

  it("takes a pause from the system's media keys as the user's, but not its own at its end", async () => {
    await kept();
    const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.5 } });
    update(shown);
    const [video] = elements;
    frame(shown, video!, 0.1);
    Object.assign(video!, { paused: true, ended: true });
    video!.dispatchEvent(new Event("pause"));
    video!.dispatchEvent(new Event("ended"));
    expect(video!.currentTime).toBeCloseTo(0.125);
    expect(films.playing(ASSET)).toBe(true);
    Object.assign(video!, { paused: true, ended: false });
    update(shown);
    video!.paused = true;
    video!.dispatchEvent(new Event("pause"));
    expect(films.playing(ASSET)).toBe(false);
  });

  it("stops playing, sound and all, once halted, and still holds what it played", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    films.sound([ASSET], true);
    update(shown);
    const [video] = elements;
    expect(video).toMatchObject({ paused: false, muted: false });
    films.halt();
    expect(video!.paused).toBe(true);
    expect(films.holds(ASSET)).toBe(true);
  });

  it("plays on without sound once the page refuses it", async () => {
    await kept();
    const shown = scene({ asset: ASSET });
    films.sound([ASSET], true);
    quiet = true;
    update(shown);
    const [video] = elements;
    expect(video!.muted).toBe(false);
    await vi.waitFor(() => expect(films.sounding(ASSET)).toBe(false));
    update(shown);
    expect(video).toMatchObject({ muted: true, paused: false });
    expect(elements).toHaveLength(1);
  });

  describe("where the host tells no frame it presents", () => {
    beforeEach(() => {
      tells = false;
      vi.useFakeTimers({ toFake: ["setTimeout"] });
    });

    it("plays what its trim leaves of it, its last frame shown before its first again", async () => {
      await kept();
      const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.4 } });
      update(shown);
      const [video] = elements;
      landed(shown, video!);
      video!.reach(0.2);
      update(shown);
      expect(films.playback(ASSET)).toMatchObject({ at: 2, span: [1, 3], playing: true });
      video!.reach(0.3);
      update(shown);
      expect(video!.currentTime).toBeCloseTo(0.125);
      landed(shown, video!);
      expect(shown.copied).toEqual([1, 2, 3, 1]);
    });

    it("follows where it plays to after going to a frame, and goes there again", async () => {
      await kept();
      const shown = scene({ asset: ASSET });
      update(shown);
      const [video] = elements;
      landed(shown, video!);
      films.seek(ASSET, 2);
      update(shown);
      landed(shown, video!);
      video!.reach(0.3);
      update(shown);
      expect(films.playback(ASSET)).toMatchObject({ at: 3, playing: true });
      films.seek(ASSET, 2);
      update(shown);
      expect(video!.currentTime).toBeCloseTo(0.225);
      expect(shown.copied).toEqual([0, 2, 3]);
    });

    it("goes back from its trim's end within a draw, and lets its decoder go once paused", async () => {
      await kept();
      // Frames 1 and 2 at twice their speed, 100 ms in all, shorter than a seek's grace.
      const shown = scene({ asset: ASSET, trim: { start: 0.1, end: 0.3 }, speed: 2 });
      update(shown);
      const [video] = elements;
      video!.land();
      update(shown);
      video!.reach(0.2);
      update(shown);
      expect(video!.currentTime).toBeCloseTo(0.125);
      expect(shown.copied).toEqual([1, 2]);
      video!.land();
      update(shown);
      video!.reach(0.3);
      films.play([ASSET], false);
      update(shown);
      update(shown);
      expect(video!.closed).toBe(true);
      expect(shown.copied.at(-1)).toBe(films.playback(ASSET)?.at);
    });

    it("lets the decoder of one paused go once stepped twice in a row", async () => {
      await kept();
      const shown = scene({ asset: ASSET });
      films.step([ASSET], 1);
      update(shown);
      const [video] = elements;
      video!.land();
      update(shown);
      films.step([ASSET], 1);
      update(shown);
      // The first goes on to the second.
      landed(shown, video!);
      expect(video!.currentTime).toBeCloseTo(0.225);
      landed(shown, video!);
      update(shown);
      expect(shown.copied).toEqual([1, 2]);
      expect(video!.closed).toBe(true);
    });
  });
});
