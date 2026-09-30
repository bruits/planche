// The images a run draws, kept encoded and decoded afresh for each candidate, the same way
// for all of them.

import * as core from "../core.js";
import type { Board, Rect } from "../core.js";
import type { Folder } from "../platform.js";
import type { Quad } from "../render/renderer.js";
import { bounds } from "./camera.js";

interface SceneImage {
  blob: Blob;
  natural: { width: number; height: number };
  frame: Rect;
  rotation: number;
}

export interface Scene {
  name: string;
  images: SceneImage[];
  bounds: Rect;
}

export async function fromBoard(name: string, folder: Folder, board: Board): Promise<Scene> {
  const images: SceneImage[] = [];
  for (const id of board.draw_order) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image") {
      const bytes = await folder.read(core.assetPath(kind.asset));
      core.verifyAsset(kind.asset, bytes);
      const { natural_size: natural, frame, rotation } = kind;
      images.push({ blob: new Blob([bytes]), natural, frame, rotation });
    }
  }
  return scene(name, images);
}

const PHOTO = { width: 4000, height: 3000 };
/** Photos are slow to generate, so a few repeat, each drawn from its own bitmap all the same. */
const DISTINCT = 8;
let photos: Promise<Blob[]> | undefined;

export async function stress(count: number): Promise<Scene> {
  photos ??= generate();
  const blobs = await photos;
  const columns = Math.ceil(Math.sqrt(count));
  const images = Array.from({ length: count }, (_, at) => ({
    blob: blobs[at % DISTINCT]!,
    natural: PHOTO,
    frame: { x: (at % columns) * 440, y: Math.floor(at / columns) * 340, width: 400, height: 300 },
    rotation: at % 7 === 0 ? 8 : 0,
  }));
  return scene(`${count} photos`, images);
}

/** A few at a time, to bound the memory. */
export async function decode(scene: Scene, cap: number): Promise<Quad[]> {
  const quads: Quad[] = [];
  const pending = scene.images.entries();
  const worker = async () => {
    for (const [at, { blob, natural, frame, rotation }] of pending) {
      const scale = Math.min(1, cap / Math.max(natural.width, natural.height));
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
        resizeWidth: Math.round(natural.width * scale),
        resizeHeight: Math.round(natural.height * scale),
        resizeQuality: "high",
      });
      quads[at] = { bitmap, frame, rotation };
    }
  };
  const done = await Promise.allSettled(Array.from({ length: 4 }, worker));
  const failed = done.find((result) => result.status === "rejected");
  if (failed) {
    quads.forEach(({ bitmap }) => bitmap.close());
    throw failed.reason;
  }
  return quads;
}

function scene(name: string, images: SceneImage[]): Scene {
  if (images.length === 0) {
    throw new Error(`${name} holds no image`);
  }
  return { name, images, bounds: bounds(images.map(({ frame }) => frame)) };
}

async function generate(): Promise<Blob[]> {
  const blobs = [];
  for (let seed = 1; seed <= DISTINCT; seed += 1) {
    const canvas = new OffscreenCanvas(PHOTO.width, PHOTO.height);
    const context = canvas.getContext("2d")!;
    const random = mulberry32(seed);
    const gradient = context.createLinearGradient(0, 0, PHOTO.width, PHOTO.height);
    gradient.addColorStop(0, `hsl(${seed * 45} 60% 55%)`);
    gradient.addColorStop(1, `hsl(${seed * 45 + 120} 50% 25%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, PHOTO.width, PHOTO.height);
    // Detail everywhere, so that the JPEG weighs about what a photo does.
    for (let shape = 0; shape < 4000; shape += 1) {
      context.fillStyle = `hsl(${random() * 360} 70% ${random() * 100}% / 0.35)`;
      context.beginPath();
      context.arc(random() * PHOTO.width, random() * PHOTO.height, 5 + random() * 120, 0, 2 * Math.PI);
      context.fill();
    }
    blobs.push(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }));
  }
  return blobs;
}

/** A seeded generator, so that every platform generates the same photos. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
