// What shows over the board without being part of it: the outlines of the selection, its
// handles, and the rectangle that selects. It lies in board space, so following the camera
// only moves its view box, and its strokes keep their width at any zoom.

import type { Camera, Viewport } from "./camera.js";
import type { Point, Rect } from "./core.js";

const SVG = "http://www.w3.org/2000/svg";
/** In CSS pixels. */
const HANDLE_SIZE = 8;
/** How far above its box the rotation handle sits, in CSS pixels. */
const ROTATION_OFFSET = 24;
/** Below this diagonal, in CSS pixels, corner handles would leave no room to grab the box. */
const SMALLEST_SCALABLE = 24;

export interface Overlay {
  frame(camera: Camera, viewport: Viewport): void;
  /** Each outline as the core gives it, each point's x then y. Empty ones show nothing. */
  outline(outlines: Float64Array[]): void;
  /** The selection's box, clockwise from its top-left, or `undefined` to hide the handles. */
  box(corners: Point[] | undefined): void;
  /** `undefined` hides it. */
  marquee(area: Rect | undefined): void;
}

/** The four corners of `box` unless it is too small, then the rotation handle above its top side. */
export function handles(box: Point[], zoom: number): Point[] {
  const [topLeft, topRight] = [box[0]!, box[1]!];
  const [dx, dy] = [topRight.x - topLeft.x, topRight.y - topLeft.y];
  const length = Math.hypot(dx, dy);
  // Outwards from the top side, which points up when the box is upright.
  const [nx, ny] = length === 0 ? [0, -1] : [dy / length, -dx / length];
  const offset = ROTATION_OFFSET / zoom;
  const rotation = {
    x: (topLeft.x + topRight.x) / 2 + nx * offset,
    y: (topLeft.y + topRight.y) / 2 + ny * offset,
  };
  const scalable = Math.hypot(box[2]!.x - topLeft.x, box[2]!.y - topLeft.y) * zoom >= SMALLEST_SCALABLE;
  return [...(scalable ? box : []), rotation];
}

export function overlay(host: HTMLElement): Overlay {
  const svg = document.createElementNS(SVG, "svg");
  const selection = document.createElementNS(SVG, "g");
  selection.classList.add("selection");
  const grips = document.createElementNS(SVG, "g");
  grips.classList.add("handles");
  const marquee = document.createElementNS(SVG, "rect");
  marquee.classList.add("marquee");
  marquee.setAttribute("display", "none");
  svg.append(selection, grips, marquee);
  host.append(svg);
  let zoom = 1;
  let corners: Point[] | undefined;
  const place = () => {
    const points = corners ? handles(corners, zoom) : [];
    const size = HANDLE_SIZE / zoom;
    grips.replaceChildren(
      ...points.map((point, at) => {
        const corner = at < points.length - 1;
        const grip = document.createElementNS(SVG, corner ? "rect" : "circle");
        if (corner) {
          grip.setAttribute("x", String(point.x - size / 2));
          grip.setAttribute("y", String(point.y - size / 2));
          grip.setAttribute("width", String(size));
          grip.setAttribute("height", String(size));
        } else {
          grip.setAttribute("cx", String(point.x));
          grip.setAttribute("cy", String(point.y));
          grip.setAttribute("r", String(size / 2));
        }
        return grip;
      }),
    );
  };
  return {
    frame(camera, { width, height }) {
      svg.setAttribute("viewBox", `${camera.x} ${camera.y} ${width / camera.zoom} ${height / camera.zoom}`);
      if (camera.zoom !== zoom) {
        zoom = camera.zoom;
        place();
      }
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
    box(box) {
      corners = box;
      place();
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
