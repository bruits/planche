// Animated images as the renderer draws them. Not every webview hands their frames over, so the
// renderer decodes them, one at a time, onto the texture of the first frame the browser gave. It
// keeps its place while an image of the asset shows, and starts over once one shows again.

import type { Camera, Viewport } from "./camera.js";
import * as core from "./core.js";
import type { Board, Bytes, Size } from "./core.js";
import { LONGEST_SIDE, shownAssets } from "./raster.js";
import type { Playing, Renderer } from "./renderer.js";

/** How long a frame spends on frames of animated images before it starts no more, in milliseconds. */
const BUDGET = 8;

/** An animated image's bytes, and how many times it plays through. */
export interface Moving {
  bytes: Bytes;
  plays: number;
}

export interface Animations {
  /** Plays those that move from now on, unless one already does, or its texture is smaller than it. */
  keep(images: Iterable<{ asset: string; natural: Size; moving?: Moving | undefined }>): void;
  /** Draws the frames due of those that show, and asks for a frame once the next one is. */
  update(board: Board, renderer: Renderer, camera: Camera, viewport: Viewport): void;
  holds(asset: string): boolean;
  /** Whether `asset` plays, which one that played through does not. */
  playing(asset: string): boolean;
  /** Plays or pauses them, which motion being reduced then leaves as they are. */
  play(assets: string[], playing: boolean): void;
  /** Whether motion is reduced, which pauses those the user did not play. */
  reduce(reduced: boolean): void;
  /** Forgets them all, as their renderer is gone. */
  reset(): void;
}

interface Clip {
  moving: Moving;
  paused: boolean;
  /** Played or paused by the user, or played through, which motion being reduced leaves as it is. */
  chosen: boolean;
  /** While it shows, from when it plays. */
  run?: { frames: Playing; played: number; due: number } | undefined;
}

/** `again` asks for another frame, and `changed` tells that one stopped on its own. */
export function animations(again: () => void, changed: () => void): Animations {
  const clips = new Map<string, Clip>();
  let reduced = false;
  let waiting: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
  const stop = (clip: Clip) => {
    clip.run?.frames.free();
    clip.run = undefined;
  };
  const pause = (clip: Clip, paused: boolean) => {
    if (clip.paused && !paused && clip.run !== undefined) {
      // Its frame showed all the while, so the next one is due at once.
      clip.run.due = performance.now();
    }
    clip.paused = paused;
  };
  const wake = (at: number, now: number) => {
    if (waiting !== undefined && waiting.at <= at) {
      return;
    }
    clearTimeout(waiting?.timer);
    const timer = setTimeout(() => {
      waiting = undefined;
      again();
    }, at - now);
    waiting = { at, timer };
  };
  /** Whether it still plays. */
  const advance = (clip: Clip, run: NonNullable<Clip["run"]>, now: number): boolean => {
    let delay = run.frames.next();
    if (delay === undefined) {
      run.played += 1;
      if (run.played >= clip.moving.plays) {
        clip.paused = true;
        clip.chosen = true;
        return false;
      }
      run.frames.restart();
      delay = run.frames.next();
      // One whose frames ran out as soon as it started over would start over forever.
      if (delay === undefined) {
        throw new Error("no frame to play");
      }
    }
    const shows = core.frameDelay(delay);
    // A frame late by all it shows, as once a hidden window shows again, shows in full from now.
    run.due = (run.due + shows <= now ? now : run.due) + shows;
    return true;
  };
  return {
    keep(images) {
      for (const { asset, natural, moving } of images) {
        if (
          moving &&
          !clips.has(asset) &&
          Math.max(natural.width, natural.height) <= LONGEST_SIDE
        ) {
          clips.set(asset, { moving, paused: reduced, chosen: false });
        }
      }
    },
    update(board, renderer, camera, viewport) {
      if (clips.size === 0) {
        return;
      }
      const shown = shownAssets(board, camera, viewport, (asset) => clips.has(asset));
      const now = performance.now();
      let next = Infinity;
      // The most overdue first, so that one a frame had no time left for goes first in the next.
      const queue = [...clips].toSorted(
        ([, a], [, b]) => (a.run?.due ?? now) - (b.run?.due ?? now),
      );
      for (const [asset, clip] of queue) {
        if (!shown.has(asset)) {
          stop(clip);
          continue;
        }
        if (clip.paused) {
          continue;
        }
        try {
          clip.run ??= { frames: renderer.animate(asset, clip.moving.bytes), played: 0, due: now };
          // Past the budget, one that is due waits for the next frame, and shows longer.
          const spent = performance.now() - now > BUDGET;
          if (now < clip.run.due || spent || advance(clip, clip.run, now)) {
            next = Math.min(next, clip.run.due);
          } else {
            stop(clip);
            changed();
          }
        } catch (error) {
          stop(clip);
          clips.delete(asset);
          changed();
          // One that does not decode, or fit its texture, throws a plain error, and stays as the
          // browser showed it.
          if (!(error instanceof Error) || error.name !== "Error") {
            throw error;
          }
          console.warn(`Animated image ${asset} cannot play here:`, error);
        }
      }
      if (next < Infinity) {
        wake(next, now);
      }
    },
    holds: (asset) => clips.has(asset),
    playing: (asset) => clips.get(asset)?.paused === false,
    play(assets, playing) {
      for (const asset of assets) {
        const clip = clips.get(asset);
        if (clip) {
          pause(clip, !playing);
          clip.chosen = true;
        }
      }
      again();
    },
    reduce(reduce) {
      reduced = reduce;
      for (const clip of clips.values()) {
        if (!clip.chosen) {
          pause(clip, reduced);
        }
      }
      again();
    },
    reset() {
      clips.forEach(stop);
      clips.clear();
      clearTimeout(waiting?.timer);
      waiting = undefined;
    },
  };
}
