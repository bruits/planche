import { describe, expect, it } from "vitest";
import { clock, frameAt, sped, spanOf, startsOf, stepped, trimOf } from "./playback.js";

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
