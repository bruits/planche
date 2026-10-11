// Canvases that measure text, as happy-dom measures none.

import { vi } from "vitest";

export function fixedWidths(text: string) {
  return {
    width: text.length * 50,
    fontBoundingBoxAscent: 80,
    fontBoundingBoxDescent: 20,
    actualBoundingBoxAscent: 70,
  };
}

export function unsized() {
  return { width: 0, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 };
}

export function measuring(
  measure: (text: string) => Partial<TextMetrics> = fixedWidths,
  drawing: Partial<CanvasRenderingContext2D> = {},
): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: measure,
    ...drawing,
  } as unknown as CanvasRenderingContext2D);
}
