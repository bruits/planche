// What shows over the board without being part of it: the outlines of the selection, the dots on
// its corners, what of it the pointer is on or holds, the outline of what a click would select,
// the rectangle that selects, the bounds of the group gone into, the box a gesture started from,
// the outlines of what the ends being drawn or moved stick to, and the crop of an image being
// cropped. It lies in board space, so following the camera only moves its view box, and its
// strokes keep their width at any zoom.

import type { Camera, Viewport } from "./camera.js";
import type { Point, Rect } from "./core.js";

const SVG = "http://www.w3.org/2000/svg";
/** Of the handles on the ends of an arrow or a line, and of a crop's grips, in CSS pixels. */
const HANDLE_SIZE = 8;
/** Across a corner's dot, in CSS pixels. */
const DOT = 7;
/** Across a corner's dot under the pointer or held, in CSS pixels. */
const GRABBED_DOT = 10;
/** Of the arc outside a corner that turns the box, in CSS pixels. */
const ARC = 15;
/** Half across the cross a box scales around, in CSS pixels. */
const PIVOT = 6;
/** Below this diagonal, in CSS pixels, dots and sides would leave no room to grab the box. */
const SMALLEST_SCALABLE = 24;
/** A double arrow across, centred in 24 pixels, as a cursor draws it. */
const ARROWS =
  "<path d='M3.5 12 8 7.5v2.7h8V7.5l4.5 4.5-4.5 4.5v-2.7H8v2.7Z' fill='black' stroke='white' stroke-width='1.2' stroke-linejoin='round'/>";
/** A double arrow curled around a top-left corner, centred in 24 pixels, as a cursor draws it. */
const CURL =
  "<path d='M6 16A8 8 0 0 1 16 6' fill='none' stroke='white' stroke-width='4' stroke-linecap='round'/>" +
  "<path d='M6 16A8 8 0 0 1 16 6' fill='none' stroke='black' stroke-width='1.6'/>" +
  "<path d='M13.5 2.8 18.2 6 13.5 9.2ZM2.8 13.5 6 18.2 9.2 13.5Z' fill='black' stroke='white' stroke-linejoin='round'/>";
/** The system's own, for where an image cannot be a cursor, by eighths of a turn. */
const RESIZES = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];

/**
 * The dot on a corner of the selection's box, which scales it, a side, which stretches it, or the
 * zone just outside a corner, which turns it. Each counts clockwise from the top-left, a side from
 * the corner it starts at.
 */
export interface Grab {
  kind: "corner" | "side" | "turn";
  at: number;
}

export interface Overlay {
  frame(camera: Camera, viewport: Viewport): void;
  /** Each outline as the core gives it, each point's x then y. Empty ones show nothing. */
  outline(outlines: Float64Array[]): void;
  /** The selection's box, clockwise from its top-left, or `undefined` to hide its dots. */
  box(corners: Point[] | undefined): void;
  /** What of the box the pointer is on, or holds, which then shows alone, `undefined` for nothing. */
  grab(grab: Grab | undefined, held: boolean): void;
  /** The box a gesture started from, and what it scales around when that is its centre, `undefined` to hide them. */
  start(corners: Point[] | undefined, pivot?: Point): void;
  /** What a click would select, as `outline` takes it, `undefined` for nothing. */
  preview(outline: Float64Array | undefined): void;
  /** The ends of an arrow or a line, each with a handle, or `undefined` to hide them. */
  ends(points: Point[] | undefined): void;
  /** `undefined` hides it. */
  marquee(area: Rect | undefined): void;
  /** The corners of the group gone into, `undefined` to hide them. */
  entered(corners: Point[] | undefined): void;
  /** What ends stick to, as `outline` takes them. */
  targets(outlines: Float64Array[]): void;
  /** `undefined` hides it. */
  crop(crop: Crop | undefined): void;
}

/**
 * An image being cropped, the corners of the whole image, the outline of what its crop keeps, and
 * the grips on the corners and edges of its crop. Flipped once, they run the other way, which the
 * shade's even-odd fill ignores.
 */
export interface Crop {
  image: Point[];
  kept: Point[];
  grips: Point[];
}

/** Whether `box` shows large enough for its dots and sides, which would cover it otherwise. */
export function dotted(box: Point[], zoom: number): boolean {
  return distance(box[0]!, box[2]!) * zoom >= SMALLEST_SCALABLE;
}

/**
 * As a CSS `cursor`, arrows along which `grab` drags `box`, or curled around the corner it turns
 * from, turned with the box by steps of 15°.
 */
export function cursor(grab: Grab, box: Point[]): string {
  // Across its top, which its corners and sides keep their angles to, whatever its proportions.
  const across = direction(box[0]!, box[1]!);
  if (grab.kind === "turn") {
    // Drawn curled around the top-left corner, a quarter turn from each corner to the next.
    return drawn(CURL, stepped(across + 90 * grab.at), "grab");
  }
  // Out of a corner halfway between its sides, or square out of a side.
  const degrees = stepped(across + (grab.kind === "corner" ? 225 : 270) + 90 * grab.at) % 180;
  return drawn(ARROWS, degrees, RESIZES[Math.round(degrees / 45) % 4]!);
}

export function overlay(host: HTMLElement): Overlay {
  const svg = document.createElementNS(SVG, "svg");
  const selection = document.createElementNS(SVG, "g");
  selection.classList.add("selection");
  // One for all, as a selection of hundreds would otherwise make as many elements at each move.
  const outlined = document.createElementNS(SVG, "path");
  selection.append(outlined);
  const grips = document.createElementNS(SVG, "g");
  grips.classList.add("handles");
  const preview = document.createElementNS(SVG, "g");
  preview.classList.add("preview");
  const started = document.createElementNS(SVG, "polygon");
  started.classList.add("start");
  const pivot = document.createElementNS(SVG, "path");
  pivot.classList.add("pivot");
  const start = document.createElementNS(SVG, "g");
  start.append(started, pivot);
  start.setAttribute("display", "none");
  const marquee = document.createElementNS(SVG, "rect");
  marquee.classList.add("marquee");
  marquee.setAttribute("display", "none");
  const entered = document.createElementNS(SVG, "polygon");
  entered.classList.add("entered");
  entered.setAttribute("display", "none");
  const targets = document.createElementNS(SVG, "g");
  targets.classList.add("targets");
  const shade = document.createElementNS(SVG, "path");
  shade.classList.add("crop-shade");
  const kept = document.createElementNS(SVG, "polygon");
  kept.classList.add("crop-frame");
  const cropGrips = document.createElementNS(SVG, "g");
  cropGrips.classList.add("handles");
  const cropping = document.createElementNS(SVG, "g");
  cropping.append(shade, kept, cropGrips);
  cropping.setAttribute("display", "none");
  svg.append(entered, targets, preview, start, selection, grips, marquee, cropping);
  host.append(svg);
  let zoom = 1;
  let corners: Point[] | undefined;
  let grabbed: Grab | undefined;
  let held = false;
  let centre: Point | undefined;
  let ends: Point[] | undefined;
  let crop: Crop | undefined;
  const placeCrop = () => {
    const size = HANDLE_SIZE / zoom;
    cropGrips.replaceChildren(...(crop?.grips ?? []).map((point) => square(point, size)));
  };
  const place = () => {
    if (ends) {
      grips.replaceChildren(...ends.map((point) => circle(point, HANDLE_SIZE / zoom / 2)));
      return;
    }
    const shown: SVGElement[] = [];
    if (corners && grabbed?.kind === "side") {
      shown.push(segment(corners[grabbed.at]!, corners[(grabbed.at + 1) % 4]!, "side"));
    } else if (corners && grabbed?.kind === "turn") {
      shown.push(path(arc(corners, grabbed.at, ARC / zoom), "turn"));
    }
    const dots = corners !== undefined && !held && dotted(corners, zoom);
    corners?.forEach((corner, at) => {
      if (grabbed?.kind === "corner" && grabbed.at === at) {
        shown.push(circle(corner, GRABBED_DOT / zoom / 2, "grabbed"));
      } else if (dots) {
        shown.push(circle(corner, DOT / zoom / 2));
      }
    });
    grips.replaceChildren(...shown);
  };
  const placePivot = () => {
    const size = PIVOT / zoom;
    pivot.setAttribute("d", centre ? `M${centre.x - size} ${centre.y}h${2 * size}M${centre.x} ${centre.y - size}v${2 * size}` : "");
  };
  return {
    frame(camera, { width, height }) {
      svg.setAttribute("viewBox", `${camera.x} ${camera.y} ${width / camera.zoom} ${height / camera.zoom}`);
      if (camera.zoom !== zoom) {
        zoom = camera.zoom;
        place();
        placeCrop();
        placePivot();
      }
    },
    outline(outlines) {
      outlined.setAttribute("d", traced(outlines));
    },
    box(box) {
      corners = box;
      place();
    },
    grab(grab, holding) {
      grabbed = grab;
      held = holding && grab !== undefined;
      place();
    },
    start(box, around) {
      centre = around;
      placePivot();
      if (box === undefined) {
        start.setAttribute("display", "none");
        return;
      }
      started.setAttribute("points", box.flatMap(({ x, y }) => [x, y]).join(" "));
      start.removeAttribute("display");
    },
    preview(outline) {
      preview.replaceChildren(...shapes(outline ? [outline] : []));
    },
    ends(points) {
      ends = points;
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
    entered(corners) {
      if (corners === undefined) {
        entered.setAttribute("display", "none");
        return;
      }
      entered.setAttribute("points", corners.flatMap(({ x, y }) => [x, y]).join(" "));
      entered.removeAttribute("display");
    },
    targets(outlines) {
      targets.replaceChildren(...shapes(outlines));
    },
    crop(shown) {
      crop = shown;
      placeCrop();
      if (shown === undefined) {
        cropping.setAttribute("display", "none");
        return;
      }
      const path = (points: Point[]) => `M${points.map(({ x, y }) => `${x} ${y}`).join("L")}Z`;
      shade.setAttribute("d", path(shown.image) + path(shown.kept));
      kept.setAttribute("points", shown.kept.flatMap(({ x, y }) => [x, y]).join(" "));
      cropping.removeAttribute("display");
    },
  };
}

/** The outlines as one path, but an arrow's two ends, a line that closing would draw twice. */
function traced(outlines: Float64Array[]): string {
  return outlines
    .filter((points) => points.length > 0)
    .map((points) => {
      let path = `M${points[0]} ${points[1]}`;
      for (let at = 2; at < points.length; at += 2) {
        path += `L${points[at]} ${points[at + 1]}`;
      }
      return points.length > 4 ? `${path}Z` : path;
    })
    .join("");
}

function shapes(outlines: Float64Array[]): SVGElement[] {
  return outlines
    .filter((points) => points.length > 0)
    .map((points) => {
      // An arrow's two ends make a line, which a polygon would draw twice.
      const shape = document.createElementNS(SVG, points.length > 4 ? "polygon" : "polyline");
      shape.setAttribute("points", points.join(" "));
      return shape;
    });
}

function circle({ x, y }: Point, radius: number, name?: string): SVGElement {
  const circle = document.createElementNS(SVG, "circle");
  circle.setAttribute("cx", String(x));
  circle.setAttribute("cy", String(y));
  circle.setAttribute("r", String(radius));
  if (name) {
    circle.classList.add(name);
  }
  return circle;
}

function square({ x, y }: Point, size: number): SVGElement {
  const square = document.createElementNS(SVG, "rect");
  square.setAttribute("x", String(x - size / 2));
  square.setAttribute("y", String(y - size / 2));
  square.setAttribute("width", String(size));
  square.setAttribute("height", String(size));
  return square;
}

function segment(from: Point, to: Point, name: string): SVGElement {
  const line = document.createElementNS(SVG, "line");
  line.setAttribute("x1", String(from.x));
  line.setAttribute("y1", String(from.y));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y));
  line.classList.add(name);
  return line;
}

function path(d: string, name: string): SVGElement {
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.classList.add(name);
  return path;
}

/** A quarter of a circle around the corner `at` of `box`, from one of its sides drawn on to the other. */
function arc(box: Point[], at: number, radius: number): string {
  const corner = box[at]!;
  const beyond = (from: Point) => {
    const length = distance(corner, from);
    return length === 0
      ? corner
      : { x: corner.x + ((corner.x - from.x) / length) * radius, y: corner.y + ((corner.y - from.y) / length) * radius };
  };
  const [start, end] = [beyond(box[(at + 1) % 4]!), beyond(box[(at + 3) % 4]!)];
  // Clockwise, as the box runs.
  return `M${start.x} ${start.y}A${radius} ${radius} 0 0 1 ${end.x} ${end.y}`;
}

function drawn(glyph: string, degrees: number, fallback: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><g transform='rotate(${degrees} 12 12)'>${glyph}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ${fallback}`;
}

/** In degrees clockwise from across, as the board's y runs down. */
function direction(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/** To the nearest 15°, within a turn. */
function stepped(degrees: number): number {
  return (((Math.round(degrees / 15) * 15) % 360) + 360) % 360;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
