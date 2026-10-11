// Arithmetic of points and of numbers that the interface shares. What elements draw, and where,
// is the core's.

import type { Point } from "./core.js";

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** In degrees clockwise from across, as the board's y runs down. */
export function direction(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/** `low` when `high` is below it. */
export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}
