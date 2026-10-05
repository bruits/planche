import { describe, expect, it } from "vitest";
import { greyed, scaleOf, sizeOf } from "./still.js";

describe("a still of an image", () => {
  it("keeps a picture's own pixels, or as many as a canvas holds everywhere", () => {
    expect(scaleOf({ width: 3000, height: 2000 }, false)).toBe(1);
    expect(scaleOf({ width: 8000, height: 6000 }, false)).toBeCloseTo(4096 / Math.sqrt(48e6));
    expect(scaleOf({ width: 40_000, height: 10 }, false)).toBeCloseTo(16_384 / 40_000);
  });

  it("stays within what a canvas holds once its sides are whole pixels", () => {
    for (const shown of [
      { width: 8000, height: 6000 },
      { width: 4118, height: 4081 },
      { width: 4097, height: 4097 },
      { width: 40_000, height: 10 },
    ]) {
      const { width, height } = sizeOf(shown, scaleOf(shown, false));
      expect(width * height).toBeLessThanOrEqual(4096 * 4096);
      expect(Math.max(width, height)).toBeLessThanOrEqual(16_384);
    }
  });

  it("draws a small vector large, as it stays sharp", () => {
    expect(scaleOf({ width: 100, height: 50 }, true)).toBe(20.48);
    expect(scaleOf({ width: 3000, height: 2000 }, true)).toBe(1);
  });

  it("greys by the luminance the renderer greys by, leaving alpha alone", () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 0]);
    greyed(pixels);
    expect([...pixels]).toEqual([54, 54, 54, 128, 182, 182, 182, 255, 18, 18, 18, 0]);
  });
});
