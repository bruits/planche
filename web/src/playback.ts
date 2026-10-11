// What animated images and videos share as they play: their frames, by when each starts, what
// their trim leaves of them, the speeds they play at, and how the app plays both alike.

import type { Camera, Viewport } from "./camera.js";
import type { Board, Trim } from "./core.js";
import type { Renderer } from "./renderer.js";

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

/**
 * What plays the board's animated images, or its videos, by asset. `Kept` is what it takes of an
 * image to play it.
 */
export interface Player<Kept> {
  keep(images: Iterable<Kept>): void;
  update(board: Board, renderer: Renderer, camera: Camera, viewport: Viewport): void;
  holds(asset: string): boolean;
  playing(asset: string): boolean;
  /** Plays or pauses them, which motion being reduced then leaves as they are. */
  play(assets: string[], playing: boolean): void;
  /** Whether motion is reduced, which pauses those the user did not play. */
  reduce(reduced: boolean): void;
  /** `undefined` for one that does not play. */
  playback(asset: string): Playback | undefined;
  /** Goes to frame `at`, within what plays of it, and plays on from there if it plays. */
  seek(asset: string, at: number): void;
  step(assets: string[], by: number): void;
  /** Plays `span` of it, whatever its trim, until `undefined`. */
  preview(asset: string, span: Span | undefined): void;
  /** Forgets them all, as their renderer is gone. */
  reset(): void;
}

export interface Media<Kept> extends Player<Kept> {
  /** Whether it goes frame by frame, as a video whose frames are not read yet may. */
  steps(asset: string): boolean;
}

export function together<Animated, Film>(
  animated: Player<Animated>,
  films: Player<Film> & Pick<Media<Film>, "steps">,
): Media<Animated & Film> {
  return {
    keep(images) {
      const kept = [...images];
      animated.keep(kept);
      films.keep(kept);
    },
    update(board, renderer, camera, viewport) {
      animated.update(board, renderer, camera, viewport);
      films.update(board, renderer, camera, viewport);
    },
    holds: (asset) => animated.holds(asset) || films.holds(asset),
    playing: (asset) => animated.playing(asset) || films.playing(asset),
    steps: (asset) => animated.holds(asset) || films.steps(asset),
    play(assets, playing) {
      animated.play(assets, playing);
      films.play(assets, playing);
    },
    reduce(reduced) {
      animated.reduce(reduced);
      films.reduce(reduced);
    },
    // A video's starts reading its frames, which an animated image's spares it.
    playback: (asset) => animated.playback(asset) ?? films.playback(asset),
    seek(asset, at) {
      animated.seek(asset, at);
      films.seek(asset, at);
    },
    step(assets, by) {
      animated.step(assets, by);
      films.step(assets, by);
    },
    preview(asset, span) {
      animated.preview(asset, span);
      films.preview(asset, span);
    },
    reset() {
      animated.reset();
      films.reset();
    },
  };
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
