// What shows over the board without being part of it: the outlines of the selection, and the
// rectangle that selects. It lies in board space, so following the camera only moves its view
// box, and its strokes keep their width at any zoom.

import type { Camera, Viewport } from "./camera.js";
import type { Rect } from "./core.js";

const SVG = "http://www.w3.org/2000/svg";

export interface Overlay {
  frame(camera: Camera, viewport: Viewport): void;
  /** Each outline as the core gives it, each point's x then y. Empty ones show nothing. */
  outline(outlines: Float64Array[]): void;
  /** `undefined` hides it. */
  marquee(area: Rect | undefined): void;
}

export function overlay(host: HTMLElement): Overlay {
  const svg = document.createElementNS(SVG, "svg");
  const selection = document.createElementNS(SVG, "g");
  selection.classList.add("selection");
  const marquee = document.createElementNS(SVG, "rect");
  marquee.classList.add("marquee");
  marquee.setAttribute("display", "none");
  svg.append(selection, marquee);
  host.append(svg);
  return {
    frame({ x, y, zoom }, { width, height }) {
      svg.setAttribute("viewBox", `${x} ${y} ${width / zoom} ${height / zoom}`);
    },
    outline(outlines) {
      selection.replaceChildren(
        ...outlines
          .filter((points) => points.length > 0)
          .map((points) => {
            // An arrow's two ends make a line, which a polygon would draw twice.
            const shape = document.createElementNS(SVG, points.length > 4 ? "polygon" : "polyline");
            shape.setAttribute("points", points.join(" "));
            return shape;
          }),
      );
    },
    marquee(area) {
      if (area === undefined) {
        marquee.setAttribute("display", "none");
        return;
      }
      const { x, y, width, height } = area;
      marquee.setAttribute("x", String(x));
      marquee.setAttribute("y", String(y));
      marquee.setAttribute("width", String(width));
      marquee.setAttribute("height", String(height));
      marquee.removeAttribute("display");
    },
  };
}
