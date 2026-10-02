// Photos made up on the spot, to measure how the app copes with many large images.

import type { Incoming } from "./add.js";

/** As a camera of 12 megapixels takes them. */
const WIDTH = 4000;
const HEIGHT = 3000;
/** The side of the noise tiled over each, which makes them weigh about 3 MB, as a photo of their size does. */
const GRAIN = 512;
const QUALITY = 0.85;

/**
 * `count` JPEGs whose bytes differ from each other's and from those of any count made before, as
 * assets with the same bytes are one. `made` hears how many are made so far.
 */
export async function testPhotos(count: number, made: (done: number) => void): Promise<Incoming[]> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  const noise = context?.createPattern(grain(), "repeat");
  if (!context || !noise) {
    throw new Error("This browser cannot draw test photos");
  }
  const batch = Math.random().toString(36).slice(2, 8);
  const photos: Incoming[] = [];
  for (let at = 0; at < count; at++) {
    const hue = (at * 37) % 360;
    const gradient = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
    gradient.addColorStop(0, `hsl(${hue} 60% 55%)`);
    gradient.addColorStop(1, `hsl(${(hue + 140) % 360} 55% 35%)`);
    context.globalAlpha = 1;
    context.fillStyle = gradient;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    // Shifted for each, so that no two share their noise.
    context.globalAlpha = 0.18;
    context.fillStyle = noise;
    context.setTransform(1, 0, 0, 1, -((at * 29) % GRAIN), -((at * 13) % GRAIN));
    context.fillRect(0, 0, WIDTH + GRAIN, HEIGHT + GRAIN);
    context.resetTransform();
    context.globalAlpha = 1;
    context.fillStyle = "#fff";
    context.font = "bold 400px sans-serif";
    context.fillText(`${at + 1}`, 200, 600);
    const name = `test-${batch}-${at + 1}.jpg`;
    photos.push({ name, filename: name, bytes: await jpeg(canvas) });
    made(at + 1);
  }
  return photos;
}

function grain(): HTMLCanvasElement {
  const tile = document.createElement("canvas");
  tile.width = GRAIN;
  tile.height = GRAIN;
  const pixels = new ImageData(GRAIN, GRAIN);
  for (let at = 0; at < pixels.data.length; at += 4) {
    pixels.data.set([Math.random() * 256, Math.random() * 256, Math.random() * 256, 255], at);
  }
  tile.getContext("2d")?.putImageData(pixels, 0, 0);
  return tile;
}

function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("A test photo could not be encoded"))),
      "image/jpeg",
      QUALITY,
    ),
  );
}
