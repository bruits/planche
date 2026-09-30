// The renderer bake-off: every candidate draws the same images through this interface, and
// only loads when picked.

import type { Rect } from "../core.js";
import type { Camera } from "../bench/camera.js";

/** An image to draw, in draw order. */
export interface Quad {
  bitmap: ImageBitmap;
  frame: Rect;
  /** Clockwise, in degrees, around the frame's centre. */
  rotation: number;
}

export interface Renderer {
  /** What it runs on, such as the GPU's name. */
  readonly backend: string;
  /** Takes the bitmaps over. */
  load(quads: Quad[]): Promise<void>;
  draw(camera: Camera): void;
  /** In CSS pixels. */
  resize(width: number, height: number): void;
  destroy(): void;
}

/** Appends its output to `host`, sized in CSS pixels. */
export type Create = (host: HTMLElement, width: number, height: number) => Promise<Renderer>;

export interface Candidate {
  name: string;
  /** Why it cannot run here, if it cannot. */
  unavailable?: string;
  /** Loads its code, which only the first run of a page pays for, apart from creating it. */
  load(): Promise<Create>;
}

const noWebGpu = "gpu" in navigator ? undefined : "no WebGPU here";

export const candidates: Candidate[] = [
  { name: "DOM", load: async () => (await import("./dom.js")).create },
  { name: "Canvas2D", load: async () => (await import("./canvas2d.js")).create },
  { name: "WebGL2", load: async () => (await import("./webgl2.js")).create },
  { name: "PixiJS (WebGL)", load: async () => (await import("./pixi.js")).load(false) },
  {
    name: "PixiJS (WebGPU)",
    unavailable: noWebGpu,
    load: async () => (await import("./pixi.js")).load(true),
  },
  { name: "Three.js (WebGL)", load: async () => (await import("./three.js")).load(false) },
  {
    name: "Three.js (WebGPU)",
    unavailable: noWebGpu,
    load: async () => (await import("./three.js")).load(true),
  },
  { name: "wgpu (WebGL2)", load: async () => (await import("./wgpu.js")).load(false) },
  {
    name: "wgpu (WebGPU)",
    unavailable: noWebGpu,
    load: async () => (await import("./wgpu.js")).load(true),
  },
];

/** A canvas of `width` × `height` CSS pixels, backed by device pixels. */
export function canvas(host: HTMLElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  size(canvas, width, height);
  host.append(canvas);
  return canvas;
}

export function size(canvas: HTMLCanvasElement, width: number, height: number): void {
  canvas.width = Math.round(width * devicePixelRatio);
  canvas.height = Math.round(height * devicePixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

/** Frees a WebGL context now rather than when collected, which the next run would pay for. */
export function lose(gl: WebGL2RenderingContext | null): void {
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
}

export function gpuName(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown GPU";
}
