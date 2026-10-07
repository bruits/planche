// An image as the board shows it, as a PNG to copy. Its turn and its opacity only place it on the
// board, which the picture leaves out. It decodes the whole image at its crop's scale, as engines
// decode a Blob whole even when cropping it, so a small crop of a 100 MP photo takes 400 MB or more
// to copy.

import {
  decodeAsset,
  files,
  readAsset,
  release,
  type Decoded,
  type Image,
  type Opened,
} from "./board.js";
import * as core from "./core.js";
import type { ImageEdits, Rect, Size } from "./core.js";
import { encode, linear, luminance } from "./paint.js";
import { MOST_AREA, MOST_SIDE } from "./raster.js";

/** A vector's longest side at the least, as sharp as one pasted from a design tool. */
export const SMALLEST_VECTOR = 2048;

export async function still(opened: Opened, image: Image): Promise<Blob> {
  const { natural_size: natural } = image;
  const edits = core.editsOf(image);
  const asset = await readAsset(files(opened), image.asset, natural);
  const shown = edits.crop ?? { x: 0, y: 0, ...natural };
  const scale = scaleOf(shown, asset.vector);
  const decoded = await decodeAsset(asset, Math.max(natural.width, natural.height) * scale);
  try {
    const canvas = drawn(decoded, natural, shown, sizeOf(shown, scale), edits);
    return await png(canvas);
  } finally {
    release(decoded);
  }
}

export function scaleOf(shown: Size, vector: boolean): number {
  const longest = Math.max(shown.width, shown.height);
  const wanted = vector ? Math.max(1, SMALLEST_VECTOR / longest) : 1;
  return Math.min(wanted, MOST_SIDE / longest, Math.sqrt(MOST_AREA / (shown.width * shown.height)));
}

/** Rounded down, as rounding up can pass what a canvas holds. */
export function sizeOf(shown: Size, scale: number): Size {
  return {
    width: Math.max(1, Math.floor(shown.width * scale)),
    height: Math.max(1, Math.floor(shown.height * scale)),
  };
}

const LINEAR = Array.from({ length: 256 }, (_, value) => linear(value / 255));

/** As the renderer greys it, by the luminance of its linear light. */
export function greyed(pixels: Uint8ClampedArray): void {
  for (let at = 0; at < pixels.length; at += 4) {
    const luma = luminance(
      LINEAR[pixels[at]!]!,
      LINEAR[pixels[at + 1]!]!,
      LINEAR[pixels[at + 2]!]!,
    );
    const grey = 255 * encode(luma);
    pixels[at] = grey;
    pixels[at + 1] = grey;
    pixels[at + 2] = grey;
  }
}

function drawn(
  decoded: Decoded,
  natural: Size,
  shown: Rect,
  { width, height }: Size,
  edits: Readonly<ImageEdits>,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  if (edits.crop_shape === "ellipse") {
    context.beginPath();
    context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, 2 * Math.PI);
    context.clip();
  }
  context.translate(edits.flip_horizontal ? width : 0, edits.flip_vertical ? height : 0);
  context.scale(edits.flip_horizontal ? -1 : 1, edits.flip_vertical ? -1 : 1);
  // A bitmap decoded at its own size, each side rounded apart, an SVG drawn sharp at any.
  const [source, across, down] =
    decoded instanceof ImageBitmap
      ? [decoded, decoded.width / natural.width, decoded.height / natural.height]
      : [decoded.image, 1, 1];
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    shown.x * across,
    shown.y * down,
    shown.width * across,
    shown.height * down,
    0,
    0,
    width,
    height,
  );
  if (edits.greyscale) {
    const pixels = context.getImageData(0, 0, width, height);
    greyed(pixels.data);
    context.putImageData(pixels, 0, 0);
  }
  return canvas;
}

export function png(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Planche could not encode the image"))),
      "image/png",
    ),
  );
}
