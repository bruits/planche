// Where the viewport looks, and where the board's points show on it, mirrored or not.

import type { Point, Rect } from "./core.js";
import { clamp } from "./geometry.js";

/** The board point at the viewport's top-left, and CSS pixels per board unit. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

const SMALLEST_ZOOM = 0.01;
const LARGEST_ZOOM = 100;

/** What of the board shows. */
export function onScreen(camera: Camera, { width, height }: Viewport): Rect {
  return { x: camera.x, y: camera.y, width: width / camera.zoom, height: height / camera.zoom };
}

/**
 * Where `point` shows, in CSS pixels from the viewport's top-left, across the viewport `mirrored`
 * when the board shows mirrored.
 */
export function toScreen(camera: Camera, point: Point, mirrored?: Viewport): Point {
  return {
    x: flipped((point.x - camera.x) * camera.zoom, mirrored),
    y: (point.y - camera.y) * camera.zoom,
  };
}

export function toBoard(camera: Camera, screen: Point, mirrored?: Viewport): Point {
  return {
    x: camera.x + flipped(screen.x, mirrored) / camera.zoom,
    y: camera.y + screen.y / camera.zoom,
  };
}

export function flipped(x: number, mirrored?: Viewport): number {
  return mirrored ? mirrored.width - x : x;
}

export function topLeft(rect: Rect, mirrored: boolean): Point {
  return { x: mirrored ? rect.x + rect.width : rect.x, y: rect.y };
}

/** Centred on `bounds`, or on the origin at 1:1 when there is nothing to fit. */
export function fit(bounds: Rect | undefined, viewport: Viewport): Camera {
  const { x, y, width, height } = bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  const fitted = 0.9 * Math.min(viewport.width / width, viewport.height / height);
  const zoom = Number.isFinite(fitted) ? clampZoom(fitted) : 1;
  return {
    x: x + (width - viewport.width / zoom) / 2,
    y: y + (height - viewport.height / zoom) / 2,
    zoom,
  };
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

/** Zoomed by `factor`, keeping the board point under `x` and `y`, in CSS pixels from the viewport's top-left. */
export function zoomAbout(camera: Camera, factor: number, x: number, y: number): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  return {
    x: camera.x + x / camera.zoom - x / zoom,
    y: camera.y + y / camera.zoom - y / zoom,
    zoom,
  };
}

function clampZoom(zoom: number): number {
  return clamp(zoom, SMALLEST_ZOOM, LARGEST_ZOOM);
}
