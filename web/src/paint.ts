// The colours the board draws in, as the theme resolves them, for the renderer and for what the
// page shows over the board alike.

import type { Colour, Paper } from "./core.js";

/**
 * A colour of the theme, its host's property of that name, or its text colour for the ink, one of
 * its own, alike in every theme, or what reads `on` one, as text on a solid fill. Forced colours
 * draw every colour as the ink.
 */
export type Paint = Colour | `paper-${Paper}` | "sticky-ink" | { on: Colour };

/** Straight red, green, and blue from 0 to 1. */
export type Paints = (paint: Paint) => number[];

/**
 * As `host`'s style resolves them now. Drawn to a pixel and read back, as a computed colour may be
 * in any colour space.
 */
export function paints(host: HTMLElement): Paints {
  const read = reader();
  const style = getComputedStyle(host);
  const known = new Map<string, number[]>();
  const resolve = (paint: Exclude<Paint, { on: Colour }>): number[] => {
    let rgb = known.get(paint);
    if (rgb === undefined) {
      rgb = read(resolved(paint, style));
      known.set(paint, rgb);
    }
    return rgb;
  };
  return (paint) =>
    typeof paint === "string" ? resolve(paint) : readable(resolve(paint.on), resolve("sticky-ink"));
}

/** As CSS writes it, following the theme where the palette's colours do. */
export function css(paint: Paint, host: HTMLElement): string {
  if (typeof paint !== "string") {
    const [red, green, blue] = paints(host)(paint).map((channel) => Math.round(channel * 255));
    return `rgb(${red} ${green} ${blue})`;
  }
  return paint.startsWith("#") && !forced()
    ? paint
    : `var(--${paint.startsWith("#") ? "ink" : paint})`;
}

function resolved(paint: Exclude<Paint, { on: Colour }>, style: CSSStyleDeclaration): string {
  if (paint === "ink" || (paint.startsWith("#") && forced())) {
    return style.color;
  }
  return paint.startsWith("#") ? paint : style.getPropertyValue(`--${paint}`);
}

function forced(): boolean {
  return matchMedia("(forced-colors: active)").matches;
}

/** The sticky notes' ink, or white where that would not show. */
function readable(on: number[], ink: number[]): number[] {
  const linear = on.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  // Where black and white contrast alike with it.
  return luminance > 0.18 ? ink : [1, 1, 1];
}

let read: ((colour: string) => number[]) | undefined;

/** One pixel for every colour read, made once. */
export function reader(): (colour: string) => number[] {
  if (read) {
    return read;
  }
  const canvas = Object.assign(document.createElement("canvas"), { width: 1, height: 1 });
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  read = (colour) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    // Mapped out of the clamped array, which would round the fractions back to bytes.
    return Array.from(
      context.getImageData(0, 0, 1, 1).data.slice(0, 3),
      (channel) => channel / 255,
    );
  };
  return read;
}
