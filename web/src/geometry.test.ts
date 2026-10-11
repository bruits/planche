import { describe, expect, it } from "vitest";
import { clamp, direction, distance } from "./geometry.js";

describe("geometry", () => {
  it("keeps a value within its bounds, the lower one when they cross", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(5, 8, 2)).toBe(8);
  });

  it("measures how far and which way, clockwise as the board's y runs down", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(direction({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe(90);
    expect(direction({ x: 0, y: 0 }, { x: -1, y: 0 })).toBe(180);
  });
});
