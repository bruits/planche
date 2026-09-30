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

export function fit(bounds: Rect, viewport: Viewport): Camera {
  const zoom = 0.9 * Math.min(viewport.width / bounds.width, viewport.height / bounds.height);
  return {
    x: bounds.x + (bounds.width - viewport.width / zoom) / 2,
    y: bounds.y + (bounds.height - viewport.height / zoom) / 2,
    zoom,
  };
}

export function bounds(frames: Rect[]): Rect {
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.width));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
