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

/** Centred on `bounds`, or on the origin at 1:1 when there is nothing to fit. */
export function fit(bounds: Rect | undefined, viewport: Viewport): Camera {
  const { x, y, width, height } = bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  const fitted = 0.9 * Math.min(viewport.width / width, viewport.height / height);
  const zoom = Number.isFinite(fitted) ? fitted : 1;
  return {
    x: x + (width - viewport.width / zoom) / 2,
    y: y + (height - viewport.height / zoom) / 2,
    zoom,
  };
}
