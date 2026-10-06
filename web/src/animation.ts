// Animated images as the renderer draws them. Not every webview hands their frames over, so the
// renderer decodes them, one at a time, onto the texture of the first frame the browser gave. Each
// keeps its place while an image of the asset shows. Frames only decode onwards, so going back
// decodes again from the first one, in the time those that only draw their next frame leave, and a
// loop that starts past the first frame keeps its frames, as far as memory allows, so as not to
// decode those before it each time.

import { assetPlayback } from "./board.js";
import type { Camera, Viewport } from "./camera.js";
import * as core from "./core.js";
import type { Board, Bytes, Size, Trim } from "./core.js";
import { LONGEST_SIDE, shownAssets } from "./raster.js";
import type { Playing, Renderer } from "./renderer.js";

/** How long a frame spends on frames of animated images before it starts no more, in milliseconds. */
const BUDGET = 8;
/** How far a time may fall before the frame it means, in milliseconds, as one in seconds rounds. */
const LEEWAY = 0.5;
/** How much one keeps of the frames of a loop that starts past its first frame, in bytes. */
const KEPT = 64 * 1024 * 1024;
/** The speeds offered, slowest first. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** An animated image's bytes, and how many times it plays through. */
export interface Moving {
  bytes: Bytes;
  plays: number;
}

/** From one frame to another, both shown. */
export type Span = [first: number, last: number];

export interface Playback {
  /** The frame it shows, or goes to. */
  at: number;
  /** Of its frames, those that decode. */
  count: number;
  playing: boolean;
  span: Span;
  /** How long each frame shows, in milliseconds, of its first `count`. */
  delays: readonly number[];
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
  playback(asset: string): Playback | undefined;
  /** Goes to frame `at`, within what plays of it, and plays on from there if it plays. */
  seek(asset: string, at: number): void;
  /** Pauses them, and goes `by` frames on within what plays of each, round from one end to the other. */
  step(assets: string[], by: number): void;
  /** Plays `span` of it, whatever its trim, until `undefined`. */
  preview(asset: string, span: Span | undefined): void;
  /** Forgets them all, as their renderer is gone. */
  reset(): void;
}

interface Run {
  frames: Playing;
  played: number;
  /** When the frame after the one it shows is due. */
  due: number;
}

interface Clip {
  moving: Moving;
  /** How long each frame shows, in milliseconds. */
  delays: number[];
  /** What a frame takes in memory, in bytes. */
  weight: number;
  paused: boolean;
  /** Played or paused by the user, or played through, which motion being reduced leaves as it is. */
  chosen: boolean;
  /** Played through, which playing again starts over. */
  over: boolean;
  /** Of its frames, those that decode, which a broken one leaves fewer of than its delays. */
  count: number;
  span: Span;
  at: number;
  /** The frame its texture holds. */
  shown: number;
  /** The frames of its span decoded so far, while it keeps them. */
  kept?: Map<number, Uint8Array> | undefined;
  /** While it shows, from when it plays or goes to another frame. */
  run?: Run | undefined;
}

/** The speed offered after `speed`, or before it, `undefined` past the last. */
export function sped(speed: number, faster: boolean): number | undefined {
  return faster
    ? SPEEDS.find((offered) => offered > speed)
    : SPEEDS.findLast((offered) => offered < speed);
}

/** When each frame starts, in milliseconds, then when the last one ends. */
function starts(delays: readonly number[]): number[] {
  let time = 0;
  return [0, ...delays.map((delay) => (time += delay))];
}

/** The frames `trim` plays of one whose frames show as `delays` say, all of them without one. */
export function spanOf(delays: readonly number[], trim: Trim | undefined): Span {
  const last = delays.length - 1;
  if (trim === undefined) {
    return [0, last];
  }
  const begins = starts(delays).slice(0, -1);
  const before = (milliseconds: number) =>
    begins.findLastIndex((start) => start <= milliseconds + LEEWAY);
  const first = Math.max(0, before(trim.start * 1000));
  return [first, Math.min(last, Math.max(first, before(trim.end * 1000 - 2 * LEEWAY)))];
}

/** What plays `span` of one whose frames show as `delays` say, `undefined` for all of them. */
export function trimOf(delays: readonly number[], [first, last]: Span): Trim | undefined {
  if (first <= 0 && last >= delays.length - 1) {
    return undefined;
  }
  const at = starts(delays);
  return { start: at[first]! / 1000, end: at[last + 1]! / 1000 };
}

/** `again` asks for another frame, and `changed` tells that one stopped on its own. */
export function animations(again: () => void, changed: () => void): Animations {
  const clips = new Map<string, Clip>();
  const previews = new Map<string, Span>();
  let reduced = false;
  let waiting: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
  const stop = (clip: Clip) => {
    clip.run?.frames.free();
    clip.run = undefined;
    clip.kept = undefined;
  };
  const pause = (clip: Clip, paused: boolean) => {
    if (clip.paused && !paused && clip.run !== undefined) {
      // Its frame showed all the while, so the next one is due at once.
      clip.run.due = performance.now();
    }
    if (!paused && clip.over) {
      clip.over = false;
      clip.at = clip.span[0];
    }
    clip.paused = paused;
  };
  const wake = (at: number, now: number) => {
    if (waiting !== undefined && waiting.at <= at) {
      return;
    }
    clearTimeout(waiting?.timer);
    const timer = setTimeout(
      () => {
        waiting = undefined;
        again();
      },
      Math.max(0, at - now),
    );
    waiting = { at, timer };
  };
  /** Whether it keeps the frames of its span, as a loop that starts past its first frame. */
  const keeps = ({ span: [first, last], weight }: Clip) =>
    first > 0 && (last - first + 1) * weight <= KEPT;
  const span = (clip: Clip, [first, last]: Span) => {
    const end = clip.count - 1;
    clip.span = [Math.min(first, end), Math.min(last, end)];
    if (!keeps(clip)) {
      clip.kept = undefined;
    }
    for (const at of clip.kept?.keys() ?? []) {
      if (at < clip.span[0] || at > clip.span[1]) {
        clip.kept?.delete(at);
      }
    }
  };
  /**
   * Takes it to the frame that is due, past those whose time went by unseen, as at a speed or in a
   * window that drew late. Whether it still plays.
   */
  const onward = (clip: Clip, run: Run, speed: number, now: number): boolean => {
    const [first, last] = clip.span;
    let { at } = clip;
    let { due } = run;
    for (let passed = 0; ; passed += 1) {
      if (at < last) {
        at += 1;
      } else {
        run.played += 1;
        if (run.played >= clip.moving.plays) {
          clip.paused = true;
          clip.chosen = true;
          clip.over = true;
          return false;
        }
        at = first;
      }
      const shows = clip.delays[at]! / speed;
      if (due + shows > now) {
        run.due = due + shows;
        break;
      }
      // One late by a whole pass, as once a hidden window shows again, shows in full from now.
      if (passed > clip.count) {
        run.due = now + shows;
        break;
      }
      due += shows;
    }
    clip.at = at;
    return true;
  };
  /** Whether drawing its frame decodes one frame at most. */
  const near = (clip: Clip, run: Run) =>
    clip.kept?.has(clip.at) === true || run.frames.position === clip.at;
  /** As a frame that does not decode ends it there, which the next update takes in. */
  const fewer = (clip: Clip, count: number): false => {
    // One whose frames ran out as soon as it started over would start over forever.
    if (count === 0) {
      throw new Error("no frame to play");
    }
    clip.count = count;
    clip.at = Math.min(clip.at, count - 1);
    return false;
  };
  /** Draws its frame, unless the budget runs out first, as going back decodes from the first. */
  const reach = (
    asset: string,
    clip: Clip,
    run: Run,
    renderer: Renderer,
    started: number,
  ): boolean => {
    const kept = clip.kept?.get(clip.at);
    if (kept) {
      renderer.show(asset, kept);
      clip.shown = clip.at;
      return true;
    }
    const { frames } = run;
    if (frames.position > clip.at) {
      frames.restart();
    }
    const [first, last] = clip.span;
    const keeping = () => keeps(clip) && frames.position >= first && frames.position <= last;
    while (frames.position < clip.at) {
      if (performance.now() - started > BUDGET) {
        return false;
      }
      if (keeping()) {
        const at = frames.position;
        const pixels = frames.pixels();
        if (pixels === undefined) {
          return fewer(clip, frames.position);
        }
        (clip.kept ??= new Map()).set(at, pixels);
      } else if (frames.skip(1) === 0) {
        return fewer(clip, frames.position);
      }
    }
    if (keeping()) {
      const pixels = frames.pixels();
      if (pixels === undefined) {
        return fewer(clip, frames.position);
      }
      (clip.kept ??= new Map()).set(clip.at, pixels);
      renderer.show(asset, pixels);
    } else if (frames.next() === undefined) {
      return fewer(clip, frames.position);
    }
    clip.shown = clip.at;
    return true;
  };
  const fail = (asset: string, clip: Clip, error: unknown) => {
    stop(clip);
    clips.delete(asset);
    changed();
    // One that does not decode, or fit its texture, throws a plain error, and stays as the
    // browser showed it.
    if (!(error instanceof Error) || error.name !== "Error") {
      throw error;
    }
    console.warn(`Animated image ${asset} cannot play here:`, error);
  };
  return {
    keep(images) {
      for (const { asset, natural, moving } of images) {
        if (!moving || clips.has(asset) || Math.max(natural.width, natural.height) > LONGEST_SIDE) {
          continue;
        }
        // Once it is known to play, as reading copies its bytes into the core.
        const delays = core.frameDelays(moving.bytes);
        if (delays === undefined) {
          continue;
        }
        clips.set(asset, {
          moving,
          delays,
          weight: natural.width * natural.height * 4,
          paused: reduced,
          chosen: false,
          over: false,
          count: delays.length,
          span: [0, delays.length - 1],
          at: 0,
          shown: 0,
        });
      }
    },
    update(board, renderer, camera, viewport) {
      if (clips.size === 0) {
        return;
      }
      // Only with its texture, which a frame drawn without would take as the last one, and which
      // an undo brings back a moment after the image.
      const shown = shownAssets(
        board,
        camera,
        viewport,
        (asset) => clips.has(asset) && renderer.holds(asset),
      );
      const played = assetPlayback(board);
      const now = performance.now();
      const spent = () => performance.now() - now > BUDGET;
      let next = Infinity;
      /** Those going further than their next frame, which take the time the others leave. */
      const behind: { asset: string; clip: Clip; run: Run; speed: number; seeking: boolean }[] = [];
      // The most overdue first, so that one a frame had no time left for goes first in the next.
      const queue = [...clips].toSorted(
        ([, a], [, b]) => (a.run?.due ?? now) - (b.run?.due ?? now),
      );
      for (const [asset, clip] of queue) {
        if (!shown.has(asset)) {
          stop(clip);
          // Freed once no image draws it, it loads again on the frame the browser gives.
          if (!renderer.holds(asset)) {
            clip.shown = 0;
          }
          continue;
        }
        const edits = played.get(asset);
        const [first, last] =
          previews.get(asset) ?? spanOf(clip.delays.slice(0, clip.count), edits?.trim);
        if (first !== clip.span[0] || last !== clip.span[1]) {
          span(clip, [first, last]);
        }
        if (clip.at < clip.span[0] || clip.at > clip.span[1]) {
          clip.at = clip.span[0];
        }
        if (clip.paused && clip.shown === clip.at) {
          continue;
        }
        const speed = edits?.speed ?? 1;
        try {
          // Its frame shows in full from now, as it may have only just shown.
          clip.run ??= {
            frames: renderer.animate(asset, clip.moving.bytes),
            played: 0,
            due: now + clip.delays[clip.at]! / speed,
          };
          const { run } = clip;
          if (clip.shown !== clip.at) {
            behind.push({ asset, clip, run, speed, seeking: true });
          } else if (now < run.due) {
            next = Math.min(next, run.due);
          } else if (!onward(clip, run, speed, now)) {
            stop(clip);
            changed();
          } else if (!near(clip, run) || spent()) {
            behind.push({ asset, clip, run, speed, seeking: false });
          } else {
            next = reach(asset, clip, run, renderer, now) ? Math.min(next, run.due) : now;
          }
        } catch (error) {
          fail(asset, clip, error);
        }
      }
      for (const { asset, clip, run, speed, seeking } of behind) {
        try {
          // Past the budget, one waits for the next frame, and shows longer.
          if (spent() || !reach(asset, clip, run, renderer, now)) {
            next = now;
            continue;
          }
          if (seeking) {
            run.due = performance.now() + clip.delays[clip.at]! / speed;
          }
          if (!clip.paused) {
            next = Math.min(next, run.due);
          }
        } catch (error) {
          fail(asset, clip, error);
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
    playback(asset) {
      const clip = clips.get(asset);
      return (
        clip && {
          at: clip.at,
          count: clip.count,
          playing: !clip.paused,
          span: clip.span,
          delays: clip.delays,
        }
      );
    },
    seek(asset, at) {
      const clip = clips.get(asset);
      if (clip) {
        const [first, last] = clip.span;
        clip.at = Math.min(last, Math.max(first, at));
        clip.over = false;
        again();
      }
    },
    step(assets, by) {
      for (const asset of assets) {
        const clip = clips.get(asset);
        if (clip) {
          pause(clip, true);
          clip.chosen = true;
          clip.over = false;
          const [first, last] = clip.span;
          const at = clip.at + by;
          clip.at = at > last ? first : at < first ? last : at;
        }
      }
      again();
    },
    preview(asset, shown) {
      if (shown === undefined) {
        previews.delete(asset);
      } else {
        previews.set(asset, shown);
        const clip = clips.get(asset);
        // At once, so that a frame sought next is sought within it.
        if (clip) {
          span(clip, shown);
        }
      }
      again();
    },
    reset() {
      clips.forEach(stop);
      clips.clear();
      previews.clear();
      clearTimeout(waiting?.timer);
      waiting = undefined;
    },
  };
}
