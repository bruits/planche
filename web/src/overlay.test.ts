// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { cursor, overlay } from "./overlay.js";

/** 200 by 100, turned clockwise by `degrees` around its top-left. */
function turned(degrees: number) {
  const [cos, sin] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  return [
    [0, 0],
    [200, 0],
    [200, 100],
    [0, 100],
  ].map(([x, y]) => ({ x: x! * cos - y! * sin, y: x! * sin + y! * cos }));
}

const box = turned(0);

describe("the cursor over a handle", () => {
  it("points along what the handle drags, as a mirrored board shows it", () => {
    expect(cursor({ kind: "corner", at: 0 }, box)).toContain("nwse-resize");
    expect(cursor({ kind: "corner", at: 0 }, box, true)).toContain("nesw-resize");
    expect(cursor({ kind: "side", at: 1 }, box, true)).toBe(cursor({ kind: "side", at: 3 }, box));
    expect(cursor({ kind: "turn", at: 1 }, box, true)).toBe(cursor({ kind: "turn", at: 0 }, box));
  });

  it("turns the other way on a mirrored board, its right side showing as its left", () => {
    expect(cursor({ kind: "corner", at: 0 }, turned(30), true)).toBe(
      cursor({ kind: "corner", at: 1 }, turned(-30)),
    );
    expect(cursor({ kind: "side", at: 1 }, turned(30), true)).toBe(
      cursor({ kind: "side", at: 3 }, turned(-30)),
    );
  });
});

describe("what a gesture lines up with", () => {
  it("dash between what lines up from the end that stays put, ticked as wide at any zoom", () => {
    const host = document.createElement("div");
    const shown = overlay(host);
    const drawn = (part: string) => host.querySelector(`.lineup .${part}`)?.getAttribute("d");
    shown.lineup(
      [
        [
          { x: 0, y: 10 },
          { x: 0, y: 50 },
        ],
      ],
      [
        [
          { x: 10, y: 0 },
          { x: 30, y: 0 },
        ],
      ],
    );
    expect(drawn("bridges")).toBe("M0 10L0 50");
    expect(drawn("ticks")).toBe("M5 10L-5 10M5 50L-5 50");
    expect(drawn("gaps")).toBe("M10 0L30 0M10 -4L10 4M30 -4L30 4");
    shown.frame({ x: 0, y: 0, zoom: 2 }, { width: 100, height: 100 });
    expect(drawn("ticks")).toBe("M2.5 10L-2.5 10M2.5 50L-2.5 50");
    shown.lineup([], []);
    expect([drawn("bridges"), drawn("ticks"), drawn("gaps")]).toEqual(["", "", ""]);
  });
});
