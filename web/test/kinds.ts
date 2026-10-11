// Elements as the core takes them, each as plain as it comes, for tests that need one of a kind.

import type { Kind } from "../src/core.js";

type Of<T extends Kind["type"]> = Extract<Kind, { type: T }>;

export function rectangleKind(y = 0): Of<"shape"> {
  return {
    type: "shape",
    frame: { x: 0, y, width: 100, height: 100 },
    shape: "rectangle",
    text: { content: "", font_size: 20 },
  };
}

export function arrowKind(): Of<"arrow"> {
  return { type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
}

export function lineKind(y = 0): Of<"line"> {
  return { type: "line", from: { x: 0, y }, to: { x: 100, y } };
}

export function commentKind(): Of<"comment"> {
  return { type: "comment", at: { x: 40, y: 60 }, text: "Why here?" };
}
