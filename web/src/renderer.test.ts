import { describe, expect, it } from "vitest";
import type { Point } from "./core.js";
import { packed, type Placed } from "./renderer.js";

/** Floats per item, its kind first, its extra then its opacity last. */
const STRIDE = 14;

function pen(points: Point[], opacity: number): Placed {
  return { kind: "stroke", points, width: 2, paint: "ink", opacity };
}

function items(placed: Placed[]): number[][] {
  const floats = packed(placed, new Map(), new Map(), () => [0, 0, 0]);
  return Array.from({ length: floats.length / STRIDE }, (_, at) => [
    ...floats.subarray(at * STRIDE, (at + 1) * STRIDE),
  ]);
}

describe("the pen strokes the renderer takes", () => {
  const bent = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it("draw see-through ones once, each apart from the next, and opaque ones as other strokes", () => {
    const [first, second, third, fourth, ...opaque] = items([
      pen(bent, 0.5),
      pen(bent, 0.5),
      pen(bent, 1),
    ]);
    // One line from each point to the next.
    expect(opaque).toHaveLength(2);
    expect([first, second, third, fourth].map((item) => item![0])).toEqual([3, 3, 3, 3]);
    expect(opaque.map((item) => item[0])).toEqual([1, 1]);
    expect(first![STRIDE - 2]).toBe(second![STRIDE - 2]);
    expect(third![STRIDE - 2]).not.toBe(second![STRIDE - 2]);
    expect([first, fourth, ...opaque].map((item) => item![STRIDE - 1])).toEqual([0.5, 0.5, 1, 1]);
  });

  it("draw a dot as one line from its point to itself", () => {
    const [dot, ...rest] = items([pen([{ x: 4, y: 5 }], 1)]);
    expect(rest).toEqual([]);
    expect(dot!.slice(3, 7)).toEqual([4, 5, 4, 5]);
  });
});
