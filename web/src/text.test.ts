// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { alignment, defaultAlignment, layout, needed, paint, type Holder } from "./text.js";

const frame = { x: 0, y: 0, width: 100, height: 50 };
const text = { content: "Hello", font_size: 20 };
const note: Holder = { type: "note", frame, rotation: 0, text };
const sticky: Holder = { type: "sticky", frame, rotation: 0, text };
const rectangle: Holder = { type: "shape", frame, rotation: 0, shape: "rectangle", text };
/** Text fits what holds it as a font of fixed widths would. */
const measure = (content: string) => ({
  width: content.length * 50,
  fontBoundingBoxAscent: 80,
  fontBoundingBoxDescent: 20,
  actualBoundingBoxAscent: 70,
});

/** Where its text wraps, in font sizes from its frame's top-left. */
function area(kind: Holder) {
  return layout(kind).area;
}

describe("text", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aligns as what holds it chooses unless told", () => {
    expect(alignment(note)).toBe("left");
    expect(alignment(sticky)).toBe("left");
    expect(alignment(rectangle)).toBe("centre");
    const right: Holder = { ...note, text: { ...text, align: "right" } };
    expect(alignment(right)).toBe("right");
    expect(defaultAlignment(right)).toBe("left");
  });

  it("lies within a shape's outline, low in a triangle, and grows a star more than a rectangle", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: measure,
    } as unknown as CanvasRenderingContext2D);
    const square = { ...rectangle, frame: { x: 0, y: 0, width: 200, height: 200 } };
    const shaped = (shape: "ellipse" | "triangle" | "star"): Holder => ({ ...square, shape });
    // Half a font size within.
    expect(area(square)).toEqual({ x: 0.5, y: 0.5, width: 9, height: 9 });
    expect(area(shaped("ellipse")).width).toBeCloseTo(10 * Math.SQRT1_2 - 1);
    const triangle = area(shaped("triangle"));
    expect(triangle.x + triangle.width / 2).toBeCloseTo(5);
    expect(triangle.y + triangle.height / 2).toBeCloseTo(10 * (2 / 3));
    expect(area(shaped("star")).width).toBeLessThan(triangle.width);
    expect(needed(shaped("star"))).toBeGreaterThan(needed(square));
  });

  it("is written in ink, or on the colour of a shape it fills", () => {
    expect(paint(note)).toBe("ink");
    expect(paint({ ...rectangle, colour: "red", fill: "solid" })).toEqual({ on: "red" });
    expect(paint({ ...rectangle, fill: "tint" })).toBe("ink");
    // A cross takes no fill, though one from an older file may hold one.
    expect(paint({ ...rectangle, shape: "cross", fill: "solid" })).toBe("ink");
    expect(paint(sticky)).toBe("sticky-ink");
  });
});
