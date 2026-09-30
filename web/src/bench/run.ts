// Only rAF timestamps and the time spent in `draw` are measured, since no timer sees the GPU
// on every platform.

import type { Candidate, Quad, Renderer } from "../render/renderer.js";
import { path, type Camera, type Viewport } from "./camera.js";
import { decode, type Scene } from "./scene.js";

export interface Options {
  /** Paced runs follow the clock and may skip frames, stepped runs draw every frame. */
  mode: "paced" | "stepped";
  /** Longest image side, in pixels. */
  cap: number;
}

export interface Stats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface Result {
  candidate: string;
  backend: string;
  scene: string;
  cap: number;
  mode: Options["mode"];
  /** In CSS pixels, at the device pixel ratio. */
  viewport: string;
  /** The display's frame interval, measured before the candidate drew anything. */
  interval: number;
  frames: Stats;
  /** Share of frames that took over one and a half intervals. */
  slow: number;
  /** CPU time only: DOM and Canvas2D leave most of their work to the browser's paint. */
  draws: Stats;
  /** From loading its code to its first frame on screen, in order. */
  phases: [string, number][];
  decodedMegabytes: number;
}

const SECONDS = 10;
const WARM_UP_SECONDS = 1;
const IDLE_FRAMES = 30;

export async function run(
  candidate: Candidate,
  scene: Scene,
  host: HTMLElement,
  options: Options,
): Promise<{ result: Result; renderer: Renderer }> {
  const viewport: Viewport = { width: host.clientWidth, height: host.clientHeight };
  const interval = await idleInterval();
  const phases: [string, number][] = [];
  let last = performance.now();
  const phase = (name: string) => {
    const now = performance.now();
    phases.push([name, now - last]);
    last = now;
  };
  const create = await candidate.load();
  phase("import");
  const renderer = await create(host, viewport.width, viewport.height);
  phase("create");
  let quads: Quad[] = [];
  try {
    quads = await decode(scene, options.cap);
    const decodedMegabytes =
      quads.reduce((sum, { bitmap }) => sum + bitmap.width * bitmap.height * 4, 0) / 2 ** 20;
    phase("decode");
    await renderer.load(quads);
    phase("upload");
    const camera = (t: number): Camera => path(scene.bounds, viewport, t);
    renderer.draw(camera(0));
    // The first callback comes before that frame's paint, where DOM and Canvas2D do their work.
    await frame();
    await frame();
    phase("first frame");

    await follow(renderer, camera, WARM_UP_SECONDS, "paced");
    const measured = await follow(renderer, camera, SECONDS, options.mode);
    const result: Result = {
      candidate: candidate.name,
      backend: renderer.backend,
      scene: scene.name,
      cap: options.cap,
      mode: options.mode,
      viewport: `${viewport.width}×${viewport.height} at ${devicePixelRatio}×`,
      interval,
      frames: stats(measured.frames),
      slow:
        measured.frames.filter((duration) => duration > 1.5 * interval).length /
        measured.frames.length,
      draws: stats(measured.draws),
      phases,
      decodedMegabytes,
    };
    return { result, renderer };
  } catch (error) {
    renderer.destroy();
    // Those a failed load did not take over yet. Closing one twice does nothing.
    quads.forEach(({ bitmap }) => bitmap.close());
    throw error;
  }
}

/** Before a candidate draws anything, whose own pace would otherwise pass for the display's. */
async function idleInterval(): Promise<number> {
  const deltas: number[] = [];
  let previous = await frame();
  for (let at = 0; at < IDLE_FRAMES; at += 1) {
    const now = await frame();
    deltas.push(now - previous);
    previous = now;
  }
  return percentile(deltas, 0.5);
}

async function follow(
  renderer: Renderer,
  camera: (t: number) => Camera,
  seconds: number,
  mode: Options["mode"],
): Promise<{ frames: number[]; draws: number[] }> {
  const frames: number[] = [];
  const draws: number[] = [];
  const steps = seconds * 60;
  const start = await frame();
  let previous = start;
  for (let step = 1; ; step += 1) {
    const now = await frame();
    if (document.visibilityState === "hidden") {
      throw new Error("The page was hidden during the run");
    }
    const t = mode === "paced" ? (now - start) / (seconds * 1000) : step / steps;
    if (t >= 1) {
      return { frames, draws };
    }
    const before = performance.now();
    renderer.draw(camera(t));
    draws.push(performance.now() - before);
    frames.push(now - previous);
    previous = now;
  }
}

function frame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function stats(samples: number[]): Stats {
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: Math.max(...samples),
  };
}

function percentile(samples: number[], rank: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(rank * sorted.length))] ?? NaN;
}
