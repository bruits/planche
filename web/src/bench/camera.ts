// Where the viewport looks, and the path it follows during a run: a pure function of time, so
// that every candidate draws the same frames.

import type { Rect } from "../core.js";

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
  return centred(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, zoom, viewport);
}

/** At `t` from 0 to 1. */
export function path(bounds: Rect, viewport: Viewport, t: number): Camera {
  const whole = fit(bounds, viewport).zoom;
  const at = (u: number, v: number) => [bounds.x + u * bounds.width, bounds.y + v * bounds.height];
  const stops: [number, number[], number][] = [
    [0, at(0.5, 0.5), whole],
    [0.2, at(0.25, 0.25), whole * 6],
    [0.6, at(0.75, 0.75), whole * 6],
    [0.8, at(0.5, 0.5), whole / 2],
    [1, at(0.5, 0.5), whole],
  ];
  const next = stops.findIndex(([time]) => time >= t);
  const [start, from, zoomFrom] = stops[Math.max(next - 1, 0)]!;
  const [end, to, zoomTo] = stops[Math.max(next, 0)]!;
  const u = end > start ? smooth((t - start) / (end - start)) : 1;
  const zoom = Math.exp(lerp(Math.log(zoomFrom), Math.log(zoomTo), u));
  return centred(lerp(from[0]!, to[0]!, u), lerp(from[1]!, to[1]!, u), zoom, viewport);
}

export function bounds(frames: Rect[]): Rect {
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.width));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function centred(x: number, y: number, zoom: number, viewport: Viewport): Camera {
  return { x: x - viewport.width / 2 / zoom, y: y - viewport.height / 2 / zoom, zoom };
}

function lerp(from: number, to: number, u: number): number {
  return from + (to - from) * u;
}

function smooth(u: number): number {
  return u * u * (3 - 2 * u);
}
