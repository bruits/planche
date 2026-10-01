// Text as the renderer draws it. The host lays it out, as it holds the font, in font sizes, so
// that scaling what holds it changes nothing but its size. Each text is rasterised to a texture
// of its own at the zoom it shows at, rounded up to a power of two so that zooming within the
// same power reuses it.

import type { Camera, Viewport } from "./camera.js";
import type { Board, Kind, Point, Rect, Size } from "./core.js";
import { LONGEST_SIDE, overlaps, rounded, settling } from "./raster.js";
import type { Placed, Renderer } from "./renderer.js";

export const FONT = "Inter";
/** In font sizes, as the editing field's `line-height` too. */
export const LINE_HEIGHT = 1.25;
/** Around a sticky note's text, in font sizes. */
const STICKY_PADDING = 0.8;
/** Around a shape's text, in font sizes, within the rectangle that an ellipse holds. */
const SHAPE_PADDING = 0.5;
/** Room around a texture for glyphs that reach past their advance or line, in font sizes. */
const MARGIN = 0.25;
/** Pixels per font size of a text out of view, enough to show until it refines. */
const FAR = 8;
/** Font sizes are measured at this one, in pixels, and scaled. */
const REFERENCE = 100;
/**
 * Up to where a line may break: past spaces and tabs, a hyphen, en dash, or zero-width space
 * before more, and before and after em dashes, but not between two.
 */
const BREAKS = /[ \t]*(?:\u2014+[ \t]*|[^ \t]+?(?:[-\u2010\u2013\u200b]+(?=[^ \t])|(?=\u2014)|[ \t]+|$))|[ \t]+/g;

export type Holder = Extract<Kind, { type: "note" | "sticky" | "shape" }>;

export function holdsText(kind: Kind | undefined): kind is Holder {
  return kind?.type === "note" || kind?.type === "sticky" || kind?.type === "shape";
}

export function isBlank(kind: Holder): boolean {
  return kind.text.content.trim() === "";
}

/** Where a text lies within its frame, in font sizes from the frame's top-left. */
export interface Layout {
  /** What it wraps to, and aligns within. */
  area: Rect;
  centred: boolean;
  lines: string[];
  /** Of the first line. */
  top: number;
}

/** Nothing may measure text before it resolves, or it would measure another font. */
export async function loadFont(): Promise<void> {
  await document.fonts.load(`${REFERENCE}px ${FONT}`).catch(() => []);
}

export function layout(kind: Holder): Layout {
  const { width, height } = inEms(kind);
  const padding = kind.type === "note" ? 0 : kind.type === "sticky" ? STICKY_PADDING : SHAPE_PADDING;
  // The largest rectangle of the ellipse's proportions that it holds.
  const share = kind.type === "shape" && kind.shape === "ellipse" ? Math.SQRT1_2 : 1;
  const area = {
    x: (width * (1 - share)) / 2 + padding,
    y: (height * (1 - share)) / 2 + padding,
    width: Math.max(width * share - 2 * padding, 0),
    height: Math.max(height * share - 2 * padding, 0),
  };
  const lines = wrap(kind.text.content, area.width, (text) => metrics().width(text));
  const centred = kind.type === "shape";
  const top = centred ? area.y + (area.height - lines.length * LINE_HEIGHT) / 2 : area.y;
  return { area, centred, lines, top };
}

/**
 * With its frame grown down, around its top side as turned, until its text fits: a note's to
 * fit its text exactly.
 */
export function fitted(kind: Holder): Holder {
  const size = kind.text.font_size;
  const { lines } = layout(kind);
  const text = lines.length * LINE_HEIGHT;
  const needed =
    kind.type === "note"
      ? text
      : kind.type === "sticky"
        ? text + 2 * STICKY_PADDING
        : (text + 2 * SHAPE_PADDING) * (kind.shape === "ellipse" ? Math.SQRT2 : 1);
  const { frame, rotation } = kind;
  const height = kind.type === "note" ? needed * size : Math.max(frame.height, needed * size);
  return { ...kind, frame: anchored(frame, rotation, { width: frame.width, height }) };
}

/** Resized to `size` around its top left corner, as turned. */
export function anchored(frame: Rect, rotation: number, { width, height }: Size): Rect {
  const shift = turn({ x: (width - frame.width) / 2, y: (height - frame.height) / 2 }, rotation);
  const centre = { x: frame.x + frame.width / 2 + shift.x, y: frame.y + frame.height / 2 + shift.y };
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}

/**
 * Breaks where the editing field does, with `white-space: pre-wrap` and `overflow-wrap:
 * break-word`, at `BREAKS`, where spaces and tabs hang past the end of a line, and within a word
 * only when it fits on no line of its own. It keeps runs of CJK whole, which the font lacks, and
 * measures a tab as the canvas draws it, where the field has tab stops.
 */
export function wrap(content: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of content.split("\n")) {
    let line = "";
    for (const word of paragraph.match(BREAKS) ?? [""]) {
      const joined = line + word;
      if (line === "" || measure(hang(joined)) <= width) {
        line = joined;
      } else {
        lines.push(line);
        line = word;
      }
      while (hang(line) !== "" && measure(hang(line)) > width) {
        const [head, rest] = split(line, width, measure);
        lines.push(head);
        line = rest;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Without the spaces that hang past its end. */
function hang(line: string): string {
  return line.replace(/[ \t]+$/, "");
}

/** Its longest start that fits, of one grapheme at least, and the rest. */
function split(line: string, width: number, measure: (text: string) => number): [string, string] {
  const graphemes = [...new Intl.Segmenter().segment(line)].map(({ segment }) => segment);
  let count = 1;
  while (count < graphemes.length && measure(hang(graphemes.slice(0, count + 1).join(""))) <= width) {
    count += 1;
  }
  return [graphemes.slice(0, count).join(""), graphemes.slice(count).join("")];
}

export interface Texts {
  /** What draws a text, `undefined` until it is rasterised as it now reads. */
  placed(id: string, kind: Holder): Placed | undefined;
  /**
   * Rasterises the texts that changed, but `hidden`, and those that show at a zoom they were
   * not rasterised for. Whether any did.
   */
  update(board: Board, renderer: Renderer, camera: Camera, viewport: Viewport, hidden?: string): boolean;
  /** Forgets them all, as their renderer is gone. */
  reset(): void;
  count(): number;
}

interface Rasterised {
  /** What it was laid out for. */
  kind: Holder;
  /** Pixels per font size. */
  density: number;
  /** What its texture covers, in font sizes from the frame's top-left. */
  covers: Rect;
}

/** `again` asks for another frame, once the camera settles. */
export function texts(again: () => void): Texts {
  const rasterised = new Map<string, Rasterised>();
  const canvas = document.createElement("canvas");
  const settle = settling(again);
  return {
    placed(id, kind) {
      const done = rasterised.get(id);
      if (!done || !sameLayout(done.kind, kind) || isBlank(kind)) {
        return undefined;
      }
      const size = kind.text.font_size;
      const { frame, rotation } = kind;
      const { x, y, width, height } = done.covers;
      const covers = { x: frame.x + x * size, y: frame.y + y * size, width: width * size, height: height * size };
      // Turned around the frame's centre, where the renderer turns it around its own.
      const own = { x: covers.x + covers.width / 2, y: covers.y + covers.height / 2 };
      const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
      const turned = turn({ x: own.x - centre.x, y: own.y - centre.y }, rotation);
      covers.x += centre.x + turned.x - own.x;
      covers.y += centre.y + turned.y - own.y;
      return { kind: "text", id, frame: covers, rotation, paint: kind.type === "sticky" ? "sticky-ink" : "ink" };
    },
    update(board, renderer, camera, viewport, hidden) {
      const shown = settle.follow(camera, viewport);
      let changed = false;
      for (const id of rasterised.keys()) {
        const kind = board.elements[id]?.kind;
        if (!holdsText(kind) || isBlank(kind)) {
          rasterised.delete(id);
          renderer.dropText(id);
          changed = true;
        }
      }
      for (const id of board.draw_order) {
        const kind = board.elements[id]!.kind;
        if (!holdsText(kind) || isBlank(kind) || id === hidden) {
          continue;
        }
        const done = rasterised.get(id);
        const wanted = kind.text.font_size * camera.zoom * devicePixelRatio;
        const visible = overlaps(shown, kind.frame);
        // Out of view, a text drops to a density that costs little, so that memory follows what shows.
        const density = Math.min(rounded(Math.max(wanted, 1)), visible ? Infinity : FAR);
        if (done && sameLayout(done.kind, kind) && (done.density === density || !settle.settled(visible))) {
          continue;
        }
        const laid = layout(kind);
        const covers = {
          x: laid.area.x - MARGIN,
          y: laid.top - MARGIN,
          width: laid.area.width + 2 * MARGIN,
          height: laid.lines.length * LINE_HEIGHT + 2 * MARGIN,
        };
        const capped = Math.min(density, LONGEST_SIDE / Math.max(covers.width, covers.height));
        // A size so small that its frame spans no end of font sizes has nothing to show.
        if (!(capped > 0)) {
          continue;
        }
        draw(canvas, laid, covers, capped);
        covers.width = canvas.width / capped;
        covers.height = canvas.height / capped;
        renderer.setText(id, canvas);
        rasterised.set(id, { kind, density, covers });
        changed = true;
      }
      return changed;
    },
    reset() {
      rasterised.clear();
      settle.reset();
    },
    count: () => rasterised.size,
  };
}

/** White, as only its coverage counts. */
function draw(canvas: HTMLCanvasElement, laid: Layout, covers: Rect, density: number): void {
  canvas.width = Math.max(Math.ceil(covers.width * density), 1);
  canvas.height = Math.max(Math.ceil(covers.height * density), 1);
  const context = canvas.getContext("2d")!;
  context.font = `${density}px ${FONT}`;
  context.fillStyle = "#fff";
  const { ascent, descent } = metrics();
  // As CSS lays a line out, with half the leading above it.
  const baseline = (LINE_HEIGHT - ascent - descent) / 2 + ascent;
  laid.lines.forEach((line, at) => {
    const shown = hang(line);
    const x = laid.centred ? laid.area.x + (laid.area.width - metrics().width(shown)) / 2 : laid.area.x;
    const y = laid.top + at * LINE_HEIGHT + baseline;
    context.fillText(shown, (x - covers.x) * density, (y - covers.y) * density);
  });
}

/** Whether both lay their text out alike, whatever their size, place, or rotation. */
function sameLayout(a: Holder, b: Holder): boolean {
  if (a === b) {
    return true;
  }
  const [one, other] = [inEms(a), inEms(b)];
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y), 1);
  return (
    a.type === b.type &&
    (a.type !== "shape" || b.type !== "shape" || a.shape === b.shape) &&
    a.text.content === b.text.content &&
    close(one.width, other.width) &&
    close(one.height, other.height)
  );
}

/** Its frame's size in font sizes. */
function inEms({ frame, text }: Holder): { width: number; height: number } {
  return { width: frame.width / text.font_size, height: frame.height / text.font_size };
}

/** Clockwise by `degrees`, as y points down. */
function turn({ x, y }: Point, degrees: number): Point {
  const angle = (degrees * Math.PI) / 180;
  const [sin, cos] = [Math.sin(angle), Math.cos(angle)];
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

interface Metrics {
  /** In font sizes. */
  width(text: string): number;
  ascent: number;
  descent: number;
}

let measured: Metrics | undefined;

function metrics(): Metrics {
  if (measured) {
    return measured;
  }
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = `${REFERENCE}px ${FONT}`;
  const widths = new Map<string, number>();
  const { fontBoundingBoxAscent, fontBoundingBoxDescent } = context.measureText("x");
  measured = {
    width(text) {
      let width = widths.get(text);
      if (width === undefined) {
        // Bounded, as every edit measures new words.
        if (widths.size > 10_000) {
          widths.clear();
        }
        width = context.measureText(text).width / REFERENCE;
        widths.set(text, width);
      }
      return width;
    },
    ascent: fontBoundingBoxAscent / REFERENCE,
    descent: fontBoundingBoxDescent / REFERENCE,
  };
  return measured;
}
