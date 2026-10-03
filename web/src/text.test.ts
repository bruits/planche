import { describe, it, expect } from "vitest";
import { alignment, defaultAlignment, paint, type Holder } from "./text.js";

const frame = { x: 0, y: 0, width: 100, height: 50 };
const text = { content: "Hello", font_size: 20 };
const note: Holder = { type: "note", frame, rotation: 0, text };
const sticky: Holder = { type: "sticky", frame, rotation: 0, text };
const rectangle: Holder = { type: "shape", frame, rotation: 0, shape: "rectangle", text };

describe("text", () => {
  it("aligns as what holds it chooses unless told", () => {
    expect(alignment(note)).toBe("left");
    expect(alignment(sticky)).toBe("left");
    expect(alignment(rectangle)).toBe("centre");
    const right: Holder = { ...note, text: { ...text, align: "right" } };
    expect(alignment(right)).toBe("right");
    expect(defaultAlignment(right)).toBe("left");
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
