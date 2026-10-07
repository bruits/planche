// Where the viewport looks.

import type { Rect } from "./core.js";

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
  return Math.min(Math.max(zoom, SMALLEST_ZOOM), LARGEST_ZOOM);
}
