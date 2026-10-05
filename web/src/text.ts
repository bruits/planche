// Text as the renderer draws it. The host lays it out, as it holds the font, in font sizes, so
// that scaling what holds it changes nothing but its size. Each text is rasterised to a texture
// of its own at the zoom it shows at, rounded up to a power of two so that zooming within the
// same power reuses it.

import type { Camera, Viewport } from "./camera.js";
import * as core from "./core.js";
import type { Align, Board, Kind, Point, Rect, Size } from "./core.js";
import type { Paint } from "./paint.js";
import { LONGEST_SIDE, MOST_AREA, overlaps, rounded, settling } from "./raster.js";
import type { Lettering, Renderer } from "./renderer.js";

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
/** How thick the stroke through struck text is, in font sizes. */
const STRIKE = 0.06;
/**
 * Up to where a line may break: past spaces and tabs, a hyphen, en dash, or zero-width space
 * before more, and before and after em dashes, but not between two.
 */
const BREAKS =
  /[ \t]*(?:\u2014+[ \t]*|[^ \t]+?(?:[-\u2010\u2013\u200b]+(?=[^ \t])|(?=\u2014)|[ \t]+|$))|[ \t]+/g;

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
  align: Align;
  lines: string[];
  /** Of the first line. */
  top: number;
}

export interface Face {
  bold: boolean;
  italic: boolean;
}

/** Nothing may measure text before they resolve, or it would measure another font. */
export async function loadFont(): Promise<void> {
  const faces = [false, true].flatMap((bold) =>
    [false, true].map((italic) => font({ bold, italic }, REFERENCE)),
  );
  await Promise.all(faces.map((css) => document.fonts.load(css).catch(() => [])));
}

/** As CSS and the canvas write a font. */
function font({ bold, italic }: Face, pixels: number): string {
  return `${italic ? "italic " : ""}${bold ? 700 : 400} ${pixels}px ${FONT}`;
}

export function face({ text }: Holder): Face {
  return { bold: text.bold ?? false, italic: text.italic ?? false };
}

export function alignment(kind: Holder): Align {
  return kind.text.align ?? defaultAlignment(kind);
}

export function defaultAlignment(kind: Holder): Align {
  // Whatever holds text aligns it some way.
  return core.plain(kind).align!;
}

export function paint(kind: Holder): Paint {
  if (kind.type === "sticky") {
    return "sticky-ink";
  }
  const plain = core.plain(kind);
  const colour = kind.colour ?? plain.colour!;
  // A cross takes no fill, though one written before crosses took none may hold one.
  const filled = kind.type === "shape" && kind.shape !== "cross" && (kind.fill ?? plain.fill);
  return filled === "solid" ? { on: colour } : colour;
}

export function layout(kind: Holder): Layout {
  const { width, height } = inEms(kind);
  const padding =
    kind.type === "note" ? 0 : kind.type === "sticky" ? STICKY_PADDING : SHAPE_PADDING;
  // The largest rectangle of the ellipse's proportions that it holds.
  const share = kind.type === "shape" && kind.shape === "ellipse" ? Math.SQRT1_2 : 1;
  const area = {
    x: (width * (1 - share)) / 2 + padding,
    y: (height * (1 - share)) / 2 + padding,
    width: Math.max(width * share - 2 * padding, 0),
    height: Math.max(height * share - 2 * padding, 0),
  };
  const measured = metrics(face(kind));
  const lines = wrap(kind.text.content, area.width, (text) => measured.width(text));
  const top =
    kind.type === "shape" ? area.y + (area.height - lines.length * LINE_HEIGHT) / 2 : area.y;
  return { area, align: alignment(kind), lines, top };
}

/**
 * With its frame grown down, around its top side as turned, until its text fits: a note's to
 * fit its text exactly.
 */
export function fitted(kind: Holder): Holder {
  const { frame, rotation } = kind;
  const height = kind.type === "note" ? needed(kind) : Math.max(frame.height, needed(kind));
  return { ...kind, frame: anchored(frame, rotation, { width: frame.width, height }, [0, 0]) };
}

/** How tall its frame must be for its text, which wraps to the frame's width. */
export function needed(kind: Holder): number {
  const text = layout(kind).lines.length * LINE_HEIGHT;
  const ems =
    kind.type === "note"
      ? text
      : kind.type === "sticky"
        ? text + 2 * STICKY_PADDING
        : (text + 2 * SHAPE_PADDING) * (kind.shape === "ellipse" ? Math.SQRT2 : 1);
  return ems * kind.text.font_size;
}

/** Resized to `size`, as turned, around the point that lies `across` its width and `down` its height, in parts of them. */
export function anchored(
  frame: Rect,
  rotation: number,
  { width, height }: Size,
  [across, down]: [number, number],
): Rect {
  const shift = turn(
    { x: (width - frame.width) * (0.5 - across), y: (height - frame.height) * (0.5 - down) },
    rotation,
  );
  const centre = {
    x: frame.x + frame.width / 2 + shift.x,
    y: frame.y + frame.height / 2 + shift.y,
  };
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
  while (
    count < graphemes.length &&
    measure(hang(graphemes.slice(0, count + 1).join(""))) <= width
  ) {
    count += 1;
  }
  return [graphemes.slice(0, count).join(""), graphemes.slice(count).join("")];
}

export interface Texts {
  /** What draws a text, `undefined` until it is rasterised as it now reads. */
  placed(id: string, kind: Holder): Lettering | undefined;
  /**
   * Rasterises the texts that changed, but `hidden`, and those that show at a zoom they were
   * not rasterised for. Whether any did.
   */
  update(
    board: Board,
    renderer: Renderer,
    camera: Camera,
    viewport: Viewport,
    hidden?: string,
  ): boolean;
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
      return done && sameLayout(done.kind, kind) && !isBlank(kind)
        ? framed(id, kind, done.covers)
        : undefined;
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
        if (
          done &&
          sameLayout(done.kind, kind) &&
          (done.density === density || !settle.settled(visible))
        ) {
          continue;
        }
        const covers = rasterise(canvas, kind, density);
        // A size so small that its frame spans no end of font sizes has nothing to show.
        if (covers === undefined) {
          continue;
        }
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

/** What draws a text of `kind` whose texture covers `covers`, in font sizes from its frame's top-left. */
function framed(id: string, kind: Holder, covers: Rect): Lettering {
  const size = kind.text.font_size;
  const { frame, rotation } = kind;
  const { x, y, width, height } = covers;
  const placed = {
    x: frame.x + x * size,
    y: frame.y + y * size,
    width: width * size,
    height: height * size,
  };
  // Turned around the frame's centre, where the renderer turns it around its own.
  const own = { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 };
  const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const turned = turn({ x: own.x - centre.x, y: own.y - centre.y }, rotation);
  placed.x += centre.x + turned.x - own.x;
  placed.y += centre.y + turned.y - own.y;
  return { id, frame: placed, rotation, paint: paint(kind) };
}

/**
 * Draws `kind` onto `canvas` at `density` pixels per font size, fewer where its longest side would
 * pass `side` or a canvas would not hold it. What it covers, in font sizes from the frame's
 * top-left, `undefined` when nothing.
 */
function rasterise(
  canvas: HTMLCanvasElement,
  kind: Holder,
  density: number,
  side = LONGEST_SIDE,
): Rect | undefined {
  const laid = layout(kind);
  const covers = {
    x: laid.area.x - MARGIN,
    y: laid.top - MARGIN,
    width: laid.area.width + 2 * MARGIN,
    height: laid.lines.length * LINE_HEIGHT + 2 * MARGIN,
  };
  const capped = Math.min(
    density,
    side / Math.max(covers.width, covers.height),
    Math.sqrt(MOST_AREA / (covers.width * covers.height)),
  );
  if (!(capped > 0)) {
    return undefined;
  }
  draw(canvas, laid, face(kind), kind.text.strike ?? false, covers, capped);
  return { ...covers, width: canvas.width / capped, height: canvas.height / capped };
}

/**
 * A text on a canvas of its own, at `density` pixels per font size, within `side` pixels a side,
 * with what draws it. Nothing is kept. `undefined` when there is nothing to show.
 */
export function lettered(
  id: string,
  kind: Holder,
  density: number,
  side?: number,
): { canvas: HTMLCanvasElement; placed: Lettering } | undefined {
  if (isBlank(kind)) {
    return undefined;
  }
  const canvas = document.createElement("canvas");
  const covers = rasterise(canvas, kind, density, side);
  return covers && { canvas, placed: framed(id, kind, covers) };
}

/** White, as only its coverage counts. */
function draw(
  canvas: HTMLCanvasElement,
  laid: Layout,
  look: Face,
  strike: boolean,
  covers: Rect,
  density: number,
): void {
  canvas.width = Math.max(Math.ceil(covers.width * density), 1);
  canvas.height = Math.max(Math.ceil(covers.height * density), 1);
  const context = canvas.getContext("2d")!;
  context.font = font(look, density);
  context.fillStyle = "#fff";
  const measured = metrics(look);
  const { ascent, descent, middle } = measured;
  // As CSS lays a line out, with half the leading above it.
  const baseline = (LINE_HEIGHT - ascent - descent) / 2 + ascent;
  const share = { left: 0, centre: 0.5, right: 1 }[laid.align];
  laid.lines.forEach((line, at) => {
    const shown = hang(line);
    const width = measured.width(shown);
    const x = laid.area.x + (laid.area.width - width) * share;
    const y = laid.top + at * LINE_HEIGHT + baseline;
    context.fillText(shown, (x - covers.x) * density, (y - covers.y) * density);
    if (strike && shown !== "") {
      const through = y - middle - STRIKE / 2;
      context.fillRect(
        (x - covers.x) * density,
        (through - covers.y) * density,
        width * density,
        Math.max(STRIKE * density, 1),
      );
    }
  });
}

/** Whether both lay their text out alike, whatever their size, place, or rotation. */
function sameLayout(a: Holder, b: Holder): boolean {
  if (a === b) {
    return true;
  }
  const [one, other] = [inEms(a), inEms(b)];
  const [lookA, lookB] = [face(a), face(b)];
  return (
    a.type === b.type &&
    (a.type !== "shape" || b.type !== "shape" || a.shape === b.shape) &&
    a.text.content === b.text.content &&
    lookA.bold === lookB.bold &&
    lookA.italic === lookB.italic &&
    // The texture holds it too.
    (a.text.strike ?? false) === (b.text.strike ?? false) &&
    alignment(a) === alignment(b) &&
    close(one.width, other.width) &&
    close(one.height, other.height)
  );
}

function close(x: number, y: number): boolean {
  return Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y), 1);
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
  /** Half the height of an x above the baseline, where a stroke strikes text through. */
  middle: number;
}

/** By face, as each lays text out its own way. */
const measured = new Map<string, Metrics>();

function metrics(look: Face): Metrics {
  const key = font(look, REFERENCE);
  const known = measured.get(key);
  if (known) {
    return known;
  }
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = key;
  const widths = new Map<string, number>();
  const { fontBoundingBoxAscent, fontBoundingBoxDescent, actualBoundingBoxAscent } =
    context.measureText("x");
  const made: Metrics = {
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
    middle: actualBoundingBoxAscent / 2 / REFERENCE,
  };
  measured.set(key, made);
  return made;
}
