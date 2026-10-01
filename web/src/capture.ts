// Pictures for agents, opaque as JPEG drops alpha, and in JPEG or PNG, whichever is smaller.

import type { Size } from "./core.js";
import { scaled } from "./board.js";

/**
 * Small enough that no Claude model scales it down, so its pixels are the ones reported. Claude
 * takes 1568 pixels a side, and 1568 tokens of 28 by 28 pixels, which this area stays within.
 */
export const MOST_SIDE = 1568;
const MOST_AREA = 1_150_000;

export interface Capture {
  mime: string;
  /** In base64. */
  data: string;
  width: number;
  height: number;
}

export function capture(source: CanvasImageSource, size: Size, background: string): Capture {
  const longest = Math.max(size.width, size.height);
  const scale = Math.min(1, MOST_SIDE / longest, Math.sqrt(MOST_AREA / (size.width * size.height)));
  const { width, height } = scaled(size, scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  // WebKit averages pixels only from medium on, and "high" gives what "low" does.
  context.imageSmoothingQuality = "medium";
  // An SVG draws sharp at the size it is drawn at, from its markup.
  const shrunk = source instanceof HTMLImageElement ? source : halved(source, size, width);
  context.drawImage(shrunk, 0, 0, width, height);
  const urls = [canvas.toDataURL("image/jpeg", 0.85), canvas.toDataURL("image/png")];
  const smallest = urls.reduce((best, url) => (url.length < best.length ? url : best));
  // Engines need only encode PNG, and give it for any type they do not encode.
  const [, mime, data] = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(smallest) ?? [];
  if (mime === undefined || data === undefined) {
    throw new Error("Planche could not encode the picture");
  }
  return { mime, data, width, height };
}

/** Halved until within twice `width`, as Chromium shrinks a canvas without averaging its pixels. */
function halved(source: CanvasImageSource, size: Size, width: number): CanvasImageSource {
  let [current, at] = [source, size];
  while (at.width > 2 * width) {
    at = { width: Math.ceil(at.width / 2), height: Math.ceil(at.height / 2) };
    const half = document.createElement("canvas");
    half.width = at.width;
    half.height = at.height;
    const context = half.getContext("2d")!;
    context.imageSmoothingQuality = "medium";
    context.drawImage(current, 0, 0, at.width, at.height);
    current = half;
  }
  return current;
}
