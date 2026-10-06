import { describe, expect, it } from "vitest";
import { cursor } from "./overlay.js";

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
