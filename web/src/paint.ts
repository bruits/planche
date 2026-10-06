// The colours the board draws in, as the theme resolves them, for the renderer and for what the
// page shows over the board alike.

import type * as core from "./core.js";

/**
 * A colour of the theme, its host's property of that name, or its text colour for the ink, one of
 * its own, alike in every theme, or what reads `on` one, as text on a solid fill. Forced colours
 * draw every colour as the ink.
 */
export type Paint = core.Paint | "sticky-ink" | "board" | { on: core.Colour };

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
  const resolve = (paint: Exclude<Paint, { on: core.Colour }>): number[] => {
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

let probe: HTMLElement | undefined;

/** As `paints`, those of the light theme in its contrast, whatever the theme or forced colours. */
export function lightPaints(): Paints {
  probe ??= document.body.appendChild(
    Object.assign(document.createElement("div"), { className: "light", hidden: true }),
  );
  return paints(probe);
}

/** As CSS writes it, following the theme where the palette's colours do, in greys when `grey`. */
export function css(paint: Paint, host: HTMLElement, grey = false): string {
  if (grey || typeof paint !== "string") {
    const colours = grey ? greyed(paints(host)) : paints(host);
    const [red, green, blue] = colours(paint).map((channel) => Math.round(channel * 255));
    return `rgb(${red} ${green} ${blue})`;
  }
  return paint.startsWith("#") && !forced()
    ? paint
    : `var(--${paint.startsWith("#") ? "ink" : paint})`;
}

function resolved(paint: Exclude<Paint, { on: core.Colour }>, style: CSSStyleDeclaration): string {
  if (
    paint === "ink" ||
    (paint.startsWith("#") && forced() && style.forcedColorAdjust !== "none")
  ) {
    return style.color;
  }
  return paint.startsWith("#") ? paint : style.getPropertyValue(`--${paint}`);
}

function forced(): boolean {
  return matchMedia("(forced-colors: active)").matches;
}

/** The linear light of an sRGB value, both from 0 to 1. */
export function linear(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

/** The sRGB value of linear light, both from 0 to 1. */
export function encode(light: number): number {
  return light <= 0.0031308 ? light * 12.92 : 1.055 * light ** (1 / 2.4) - 0.055;
}

/** Of linear red, green, and blue, which greyscale keeps. */
export function luminance(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** As `paints`, each as the grey an image in greyscale turns it. */
export function greyed(colours: Paints): Paints {
  return (paint) => {
    const [red, green, blue] = colours(paint).map(linear);
    return Array<number>(3).fill(encode(luminance(red!, green!, blue!)));
  };
}

/** The sticky notes' ink, or white where that would not show. */
function readable(on: number[], ink: number[]): number[] {
  const [red, green, blue] = on.map(linear);
  // Where black and white contrast alike with it.
  return luminance(red!, green!, blue!) > 0.18 ? ink : [1, 1, 1];
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
