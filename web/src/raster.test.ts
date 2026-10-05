// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOST_AREA } from "./raster.js";
import { lettered, type Holder } from "./text.js";
import { vectors } from "./vector.js";

afterEach(() => vi.restoreAllMocks());

describe("a texture drawn for a picture", () => {
  it("stays within what a canvas holds, however many pixels it is asked for", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      fillStyle: "",
      drawImage() {},
      fillText() {},
      fillRect() {},
      measureText: (text: string) => ({
        width: 60 * text.length,
        fontBoundingBoxAscent: 90,
        fontBoundingBoxDescent: 20,
        actualBoundingBoxAscent: 50,
      }),
    } as unknown as CanvasRenderingContext2D);
    const asset = "a".repeat(64);
    const drawings = vectors(() => {});
    drawings.keep(asset, { image: new Image(), natural: { width: 1000, height: 1000 } });
    const vector = drawings.drawn(asset, 20, 16_384)!;
    const note: Holder = {
      type: "note",
      frame: { x: 0, y: 0, width: 40, height: 25 },
      rotation: 0,
      text: { content: "Hi", font_size: 20 },
    };
    const text = lettered("note", note, 2000, 16_384)!.canvas;
    for (const { width, height } of [vector, text]) {
      // Rounded up a pixel a side at most.
      expect(width * height).toBeLessThanOrEqual(MOST_AREA + width + height + 1);
      expect(width * height).toBeGreaterThan(MOST_AREA / 2);
    }
  });
});
