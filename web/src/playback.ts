// What animated images and videos share as they play: their frames, by when each starts, what
// their trim leaves of them, and the speeds they play at.

import type { Trim } from "./core.js";

/** How far a time may fall before the frame it means, in seconds, as one rounds. */
const LEEWAY = 0.0005;
/** The speeds offered, slowest first. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** From one frame to another, both shown. */
export type Span = [first: number, last: number];

export interface Playback {
  /** The frame it shows, or goes to. */
  at: number;
  /** Of its frames, those it knows, none for a video whose frames it cannot tell. */
  count: number;
  playing: boolean;
  span: Span;
  /** When each frame starts, in seconds of its own time, then when the last one ends. */
  starts: ArrayLike<number>;
  /** Whether its sound plays, `undefined` for an animated image. */
  sound?: boolean | undefined;
}

/** The speed offered after `speed`, or before it, `undefined` past the last. */
export function sped(speed: number, faster: boolean): number | undefined {
  return faster
    ? SPEEDS.find((offered) => offered > speed)
    : SPEEDS.findLast((offered) => offered < speed);
}

/** When each frame starts, in seconds, then when the last one ends, from how long each shows. */
export function startsOf(delays: readonly number[]): number[] {
  // In milliseconds until each is told, as tenths of seconds add up to more than they say.
  let time = 0;
  return [0, ...delays.map((delay) => (time += delay) / 1000)];
}

/** The frame showing at `time`, the first one before it starts, of those `starts` tells. */
export function frameAt(starts: ArrayLike<number>, time: number): number {
  let low = 0;
  let high = starts.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= time + LEEWAY) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** The frames `trim` plays of one whose frames start as `starts` says, all of them without one. */
export function spanOf(starts: ArrayLike<number>, trim: Trim | undefined): Span {
  const last = starts.length - 2;
  if (trim === undefined) {
    return [0, last];
  }
  const first = frameAt(starts, trim.start);
  return [first, Math.max(first, frameAt(starts, trim.end - 2 * LEEWAY))];
}

/** What plays `span` of one whose frames start as `starts` says, `undefined` for all of them. */
export function trimOf(starts: ArrayLike<number>, [first, last]: Span): Trim | undefined {
  if (first <= 0 && last >= starts.length - 2) {
    return undefined;
  }
  return { start: starts[first]!, end: starts[last + 1]! };
}

/** `seconds` as a clock reads them, to the hundredth, which every frame step changes up to 100 a second. */
export function clock(seconds: number): string {
  const hundredths = Math.round(seconds * 100);
  const minutes = Math.floor(hundredths / 6000);
  const rest = ((hundredths % 6000) / 100).toFixed(2).padStart(5, "0");
  return minutes < 60
    ? `${minutes}:${rest}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
}

export function stepped(at: number, by: number, [first, last]: Span): number {
  const length = last - first + 1;
  return first + ((((at + by - first) % length) + length) % length);
}
