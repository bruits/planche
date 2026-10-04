// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import type { Kind } from "./core.js";
import { restyled, settings, styleOf, styles, valueOf } from "./style.js";

const frame = { x: 0, y: 0, width: 100, height: 50 };
const arrow: Kind = { type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
const shape = (form: "rectangle" | "cross", content = ""): Kind => ({
  type: "shape",
  frame,
  rotation: 0,
  shape: form,
  text: { content, font_size: 20 },
});
const note: Kind = { type: "note", frame, rotation: 0, text: { content: "Hi", font_size: 20 } };
const bold: Kind = {
  type: "note",
  frame,
  rotation: 0,
  text: { content: "Hi", font_size: 20, bold: true },
};
const sticky: Kind = { type: "sticky", frame, rotation: 0, text: { content: "", font_size: 20 } };
/** Text fits what holds it as a font of fixed widths would. */
const measure = (text: string) => ({
  width: text.length * 50,
  fontBoundingBoxAscent: 80,
  fontBoundingBoxDescent: 20,
  actualBoundingBoxAscent: 70,
});

describe("a style", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("offers what each element takes, but no text style for a blank shape", () => {
    expect(settings(arrow)).toEqual(["colour", "weight", "dash", "heads", "opacity"]);
    expect(settings(shape("rectangle"))).toEqual(["colour", "weight", "dash", "fill", "opacity"]);
    expect(settings(shape("cross", "X"))).toEqual([
      "colour",
      "weight",
      "dash",
      "size",
      "bold",
      "italic",
      "strike",
      "align",
      "opacity",
    ]);
  });

  it("shows each part as the element draws it, at the zoom it is seen at", () => {
    expect(valueOf(arrow, "colour", 1)).toBe("ink");
    expect(valueOf(arrow, "heads", 1)).toBe("end");
    const loud: Kind = { ...arrow, colour: "red", heads: "both" };
    expect(valueOf(loud, "colour", 1)).toBe("red");
    expect(valueOf(loud, "heads", 1)).toBe("both");
    expect(valueOf(loud, "dash", 1)).toBe("solid");
    expect(valueOf(note, "colour", 1)).toBe("ink");
    expect(valueOf(note, "bold", 1)).toBe(false);
    expect(valueOf(note, "strike", 1)).toBe(false);
    expect(valueOf(bold, "bold", 1)).toBe(true);
    expect(valueOf(note, "align", 1)).toBe("left");
    expect(valueOf(shape("rectangle"), "align", 1)).toBe("centre");
    expect(valueOf(shape("rectangle"), "size", 2)).toBe(40);
    expect(valueOf(sticky, "paper", 1)).toBe("yellow");
  });

  it("shows none of the parts the element does not take", () => {
    expect(valueOf(arrow, "bold", 1)).toBeUndefined();
    expect(valueOf(arrow, "size", 1)).toBeUndefined();
    expect(valueOf(sticky, "colour", 1)).toBeUndefined();
    expect(valueOf(shape("cross"), "fill", 1)).toBeUndefined();
    // A fill a cross holds from an older file, which it takes no more.
    const filled: Kind = {
      type: "shape",
      frame,
      rotation: 0,
      shape: "cross",
      text: { content: "", font_size: 20 },
      fill: "solid",
    };
    expect(valueOf(filled, "fill", 1)).toBeUndefined();
  });

  it("copies a style that sets the element as it was", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: measure,
    } as unknown as CanvasRenderingContext2D);
    const loud: Kind = { ...arrow, colour: "#12ab9f", weight: "thick", dash: "dashed" };
    expect(restyled(loud, styleOf(loud, 1), 1)).toEqual(loud);
    expect(restyled(loud, styleOf(arrow, 1), 1)).toEqual(arrow);
    // Plain text, which writes nothing.
    expect(restyled(bold, styleOf(note, 1), 1)).not.toHaveProperty("text.bold");
  });

  it("sets only what the element takes", () => {
    expect(restyled(arrow, { colour: "red", paper: "pink", heads: "both" }, 1)).toEqual({
      ...arrow,
      colour: "red",
      heads: "both",
    });
    expect(restyled(shape("cross"), { fill: "solid" }, 1)).toEqual(shape("cross"));
  });

  it("dresses what a tool draws in the style it learnt, but what the core would refuse", () => {
    localStorage.setItem(
      "planche.styles",
      JSON.stringify({
        arrow: { colour: "#12ab9f", size: 30 },
        line: { colour: "#12AB9F" },
        cross: { weight: "heavy" },
      }),
    );
    const dressed = styles();
    expect(dressed.dressed(arrow, 1)).toEqual({ ...arrow, colour: "#12ab9f" });
    const line: Kind = { ...arrow, type: "line" };
    expect(dressed.dressed(line, 1)).toEqual(line);
    expect(dressed.dressed(shape("cross"), 1)).toEqual(shape("cross"));
  });

  it("dresses a blank shape in the text style its tool learnt, for what is written in it later", () => {
    localStorage.setItem(
      "planche.styles",
      JSON.stringify({ rectangle: { bold: true, align: "centre", size: 40 } }),
    );
    expect(styles().dressed(shape("rectangle"), 2)).toEqual({
      ...shape("rectangle"),
      text: { content: "", font_size: 20, bold: true },
    });
  });
});
