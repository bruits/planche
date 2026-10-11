import { describe, expect, it } from "vitest";
import { toBoard, toScreen, topLeft } from "./camera.js";

const camera = { x: -10, y: 5, zoom: 2 };
const viewport = { width: 300, height: 200 };

describe("camera", () => {
  it("shows a board point where it lies on screen, mirrored or not, and finds it back", () => {
    expect(toScreen(camera, { x: 0, y: 10 })).toEqual({ x: 20, y: 10 });
    expect(toScreen(camera, { x: 0, y: 10 }, viewport)).toEqual({ x: 280, y: 10 });
    for (const mirrored of [undefined, viewport]) {
      const point = { x: 7, y: -3 };
      expect(toBoard(camera, toScreen(camera, point, mirrored), mirrored)).toEqual(point);
    }
  });

  it("finds the corner of a frame that shows at its top-left, its right one once mirrored", () => {
    const frame = { x: 10, y: 20, width: 30, height: 40 };
    expect(topLeft(frame, false)).toEqual({ x: 10, y: 20 });
    expect(topLeft(frame, true)).toEqual({ x: 40, y: 20 });
  });
});
