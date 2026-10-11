import { describe, expect, it, vi } from "vitest";
import {
  clock,
  frameAt,
  sped,
  spanOf,
  startsOf,
  stepped,
  together,
  trimOf,
  type Media,
  type Playback,
} from "./playback.js";

describe("frames", () => {
  const starts = startsOf([40, 100, 60]);

  it("start as long after each other as each shows, the last one ending after", () => {
    expect(starts).toEqual([0, 0.04, 0.14, 0.2]);
    expect(startsOf([100, 100, 100])).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it("show from their start, to a hair, until the next one starts", () => {
    expect([0, 0.0399, 0.039, 0.04, 0.1, 0.19, 5].map((time) => frameAt(starts, time))).toEqual([
      0, 1, 0, 1, 1, 2, 2,
    ]);
  });

  it("step round within a span, from one end to the other", () => {
    expect(stepped(1, 1, [1, 2])).toBe(2);
    expect(stepped(2, 1, [1, 2])).toBe(1);
    expect(stepped(1, -1, [1, 2])).toBe(2);
    expect(stepped(0, 6, [0, 4])).toBe(1);
    expect(stepped(0, -2, [0, 4])).toBe(3);
  });
});

describe("a trim", () => {
  const starts = startsOf([40, 100, 60]);

  it("plays the frames from the one its start falls on to the one before its end", () => {
    expect(spanOf(starts, undefined)).toEqual([0, 2]);
    expect(spanOf(starts, { start: 0.04, end: 0.14 })).toEqual([1, 1]);
    expect(spanOf(starts, { start: 0.05, end: 0.2 })).toEqual([1, 2]);
    expect(spanOf(starts, { start: 0, end: 9 })).toEqual([0, 2]);
  });

  it("is what plays a span of them, which reads back as that span", () => {
    expect(trimOf(starts, [0, 2])).toBeUndefined();
    const trim = trimOf(starts, [1, 1])!;
    expect(trim).toEqual({ start: 0.04, end: 0.14 });
    expect(trimOf(startsOf([100, 100, 100, 100]), [1, 2])).toEqual({ start: 0.1, end: 0.3 });
    expect(spanOf(starts, trim)).toEqual([1, 1]);
    expect(spanOf(starts, trimOf(starts, [0, 1]))).toEqual([0, 1]);
  });
});

describe("a clock", () => {
  it("reads minutes and seconds to the hundredth, and hours past an hour", () => {
    expect([0, 12.041_666, 59.999, 3723.5].map(clock)).toEqual([
      "0:00.00",
      "0:12.04",
      "1:00.00",
      "1:02:03.50",
    ]);
  });
});

describe("speeds", () => {
  it("go a step faster or slower, as far as the last offered", () => {
    expect(sped(1, true)).toBe(1.25);
    expect(sped(1, false)).toBe(0.75);
    expect(sped(1.1, false)).toBe(1);
    expect(sped(2, true)).toBeUndefined();
    expect(sped(0.25, false)).toBeUndefined();
  });
});

function player<Kept>(assets: string[], given: Partial<Media<Kept>> = {}): Media<Kept> {
  return {
    keep() {},
    update() {},
    holds: (asset) => assets.includes(asset),
    playing: () => false,
    play() {},
    reduce() {},
    playback: () => undefined,
    seek() {},
    step() {},
    preview() {},
    reset() {},
    steps: () => false,
    ...given,
  };
}

/** What `keep` was handed, which it reads through as the players do. */
function keeper() {
  return vi.fn<(images: Iterable<{ asset: string }>) => void>((images) => void [...images]);
}

/** Images to keep, read once, as a generator is. */
function* bothKinds() {
  yield { asset: "gif" };
  yield { asset: "mp4" };
}

describe("animated images and videos together", () => {
  const shown: Playback = {
    at: 0,
    count: 3,
    playing: true,
    span: [0, 2],
    starts: [0, 0.1, 0.2, 0.3],
  };

  it("hands every image kept to both, as each asset is one or the other", () => {
    const [kept, filmed] = [keeper(), keeper()];
    together(player(["gif"], { keep: kept }), player(["mp4"], { keep: filmed })).keep(bothKinds());
    expect(kept.mock.calls[0]![0]).toEqual([{ asset: "gif" }, { asset: "mp4" }]);
    expect(filmed.mock.calls[0]![0]).toEqual([{ asset: "gif" }, { asset: "mp4" }]);
  });

  it("asks the videos for a playback only when the animated images have none", () => {
    const asked = vi.fn<(asset: string) => Playback | undefined>(() => undefined);
    const animated = player(["gif"], {
      playback: (asset) => (asset === "gif" ? shown : undefined),
    });
    const media = together(animated, player(["mp4"], { playback: asked }));
    expect(media.playback("gif")).toBe(shown);
    expect(asked).not.toHaveBeenCalled();
    media.playback("mp4");
    expect(asked).toHaveBeenCalledWith("mp4");
  });

  it("holds either's assets, and steps an animated image or a video whose frames are not read yet", () => {
    const media = together(player(["gif"]), player(["mp4"], { steps: (asset) => asset === "new" }));
    expect(["gif", "mp4", "png"].map(media.holds)).toEqual([true, true, false]);
    expect(["gif", "new", "png"].map(media.steps)).toEqual([true, true, false]);
  });
});
