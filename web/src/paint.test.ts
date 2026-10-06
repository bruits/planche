// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paints } from "./paint.js";

/** The bytes of a colour as `#rrggbb` or `rgb(r, g, b)`, which is all these tests fill with. */
function bytes(colour: string): number[] {
  if (colour.startsWith("#")) {
    return [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16));
  }
  return colour.match(/\d+/g)!.slice(0, 3).map(Number);
}

/** A 2D context whose one pixel reads back the last colour filled, as happy-dom draws nothing. */
function context(): CanvasRenderingContext2D {
  let fill = "#000000";
  return {
    set fillStyle(colour: string) {
      fill = colour;
    },
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: Uint8ClampedArray.from([...bytes(fill), 255]) }),
  } as unknown as CanvasRenderingContext2D;
}

function host(style: string): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("style", style);
  return document.body.appendChild(element);
}

describe("paints", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context());
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(forced-colors: active)",
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("draws an own colour as the ink under forced colours", () => {
    const painted = paints(host("color: rgb(0, 0, 255)"));
    expect(painted("#ff0000")).toEqual([0, 0, 1]);
  });

  it("keeps an own colour on a host out of forced colours", () => {
    const painted = paints(host("color: rgb(0, 0, 255); forced-color-adjust: none"));
    expect(painted("#ff0000")).toEqual([1, 0, 0]);
  });
});
