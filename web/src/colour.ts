// The colour each image shows on average, which arranging by colour sorts on. It is read again
// each time, from a small copy, as the renderer keeps only its textures, and never saved.

import {
  capped,
  decode,
  files,
  readAsset,
  release,
  type Asset,
  type Decoded,
  type Opened,
} from "./board.js";
import { halved } from "./capture.js";
import type { Kind, Size } from "./core.js";

type Image = Extract<Kind, { type: "image" }>;
type Colour = [number, number, number];

/** The longest side of the copy, in pixels, enough for a crop to keep a colour of its own. */
const SIDE = 32;

/**
 * By the id of each image among `ids`, in sRGB, but for those that show nothing opaque, and those
 * this machine cannot decode or play. Throws when an asset is missing or does not match its digest.
 */
export async function meanColours(opened: Opened, ids: string[]): Promise<Record<string, Colour>> {
  const images = new Map<string, Image>();
  for (const id of ids) {
    const kind = opened.board.elements[id]?.kind;
    if (kind?.type === "image") {
      images.set(id, kind);
    }
  }
  const assets = new Map<string, Asset>();
  for (const { asset, natural_size } of images.values()) {
    if (!assets.has(asset)) {
      assets.set(asset, await readAsset(files(opened), asset, natural_size));
    }
  }
  const decoded = await decode([...assets.values()], SIDE);
  try {
    const copies = new Map(
      [...decoded].map(([asset, picture]) => [asset, small(picture, assets.get(asset)!.natural)]),
    );
    const colours: Record<string, Colour> = {};
    for (const [id, kind] of images) {
      const pixels = copies.get(kind.asset);
      const colour = pixels && mean(pixels, kind);
      if (colour) {
        colours[id] = colour;
      }
    }
    return colours;
  } finally {
    decoded.forEach(release);
  }
}

function small(decoded: Decoded, natural: Size): ImageData {
  const { width, height } = capped(natural, SIDE);
  const context = Object.assign(document.createElement("canvas"), { width, height }).getContext(
    "2d",
    {
      willReadFrequently: true,
    },
  )!;
  // WebKit averages pixels only from medium on, and a video's first frame comes at its own size.
  context.imageSmoothingQuality = "medium";
  const source =
    decoded instanceof ImageBitmap
      ? halved(decoded, { width: decoded.width, height: decoded.height }, width)
      : decoded.image;
  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

function mean(
  { data, width, height }: ImageData,
  { natural_size: natural, edits }: Image,
): Colour | undefined {
  const crop = edits.crop ?? { x: 0, y: 0, ...natural };
  const [across, down] = [width / natural.width, height / natural.height];
  const [left, right] = span(crop.x, crop.width, across, width);
  const [top, bottom] = span(crop.y, crop.height, down, height);
  const sum: Colour = [0, 0, 0];
  let weight = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const outside =
        off(x, crop.x, crop.width, across) ** 2 + off(y, crop.y, crop.height, down) ** 2 > 1;
      if (edits.crop_shape === "ellipse" && outside) {
        continue;
      }
      const at = (y * width + x) * 4;
      const alpha = data[at + 3]!;
      for (let channel = 0; channel < 3; channel++) {
        sum[channel]! += data[at + channel]! * alpha;
      }
      weight += alpha;
    }
  }
  return weight === 0 ? undefined : (sum.map((channel) => Math.round(channel / weight)) as Colour);
}

/**
 * How far the nearest point of a pixel lies from the ellipse's centre, in its radius, so that it
 * keeps the pixels it reaches into, as a crop does. Flips mirror it onto itself.
 */
function off(at: number, start: number, length: number, scale: number): number {
  const centre = (start + length / 2) * scale;
  return (Math.min(Math.max(centre, at), at + 1) - centre) / ((length / 2) * scale);
}

function span(start: number, length: number, scale: number, size: number): [number, number] {
  const from = Math.min(size - 1, Math.max(0, Math.floor(start * scale)));
  return [from, Math.min(size, Math.max(from + 1, Math.ceil((start + length) * scale)))];
}
