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

function fill(light: boolean): Placed {
  return {
    kind: "fill",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    paint: "ink",
    opacity: 1,
    light,
  };
}

describe("the colours the renderer takes", () => {
  it("are the light theme's for what draws light, whatever the theme", () => {
    const floats = packed(
      [fill(false), fill(true)],
      new Map(),
      new Map(),
      () => [1, 1, 1],
      () => [0, 0, 0],
    );
    // Its colour after its kind, texture, shape, frame, rotation, and width.
    expect([...floats.subarray(9, 12)]).toEqual([1, 1, 1]);
    expect([...floats.subarray(STRIDE + 9, STRIDE + 12)]).toEqual([0, 0, 0]);
  });
});

describe("the board in greys the renderer takes", () => {
  const image: Placed = {
    kind: "image",
    asset: "a",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    texture: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    greyscale: false,
    elliptical: false,
    opacity: 1,
  };
  const both = (grey: boolean) =>
    packed([fill(false), image], new Map([["a", 0]]), new Map(), () => [1, 0, 0], undefined, grey);

  it("draws each colour as its grey, and each image in greyscale", () => {
    const floats = both(true);
    const [red, green, blue] = floats.subarray(9, 12);
    expect(red).toBeCloseTo(127 / 255, 2);
    expect([green, blue]).toEqual([red, red]);
    // Its flag after its kind, texture, frame, rotation, and the part of its texture it shows.
    expect(floats[STRIDE + 11]).toBe(1);
  });

  it("keeps their own colours otherwise", () => {
    const floats = both(false);
    expect([...floats.subarray(9, 12)]).toEqual([1, 0, 0]);
    expect(floats[STRIDE + 11]).toBe(0);
  });
});
