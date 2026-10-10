// Videos as the renderer draws them. The host plays each in a `<video>` the page never shows, and
// the renderer copies its frames onto the texture of the first one, only while it shows and plays,
// or goes to another frame, the largest on screen first, as decoders are few. It goes on from
// where it got to. Its frames come from its container, as no browser tells them.

import { assetPlayback } from "./board.js";
import type { Camera, Viewport } from "./camera.js";
import * as core from "./core.js";
import type { Board, Bytes, Size, Trim } from "./core.js";
import { frameAt, spanOf, stepped, type Playback, type Span } from "./playback.js";
import { shownAssets } from "./raster.js";
import type { Renderer } from "./renderer.js";

/** In bytes. */
export const VIDEO_LIMIT = 300e6;
/** Nearly every GPU takes textures this large, and a video's frames go onto one as large as them. */
const LONGEST_SIDE = 4096;
/** Decoders are few, and Chromium allows 75 in a page. */
const MOST_PLAYING = 8;
/** How long a video may take to show a frame before it counts as one this machine cannot play, in milliseconds. */
const PATIENCE = 10_000;
/** How far into its frame a video goes to show it, as one sent to its very start shows the one before in Chromium. */
const INTO_FRAME = 0.25;
/**
 * How long a video that went to a frame may take to say it shows it before it counts as shown, in
 * milliseconds, as a page that draws nothing hears of no frame.
 */
const SEEK_GRACE = 150;
/** Boxes before a movie's index, past which it counts as one without. */
const MOST_BOXES = 64;
/** In bytes, past which a movie's index counts as broken. */
const MOST_INDEX = 1 << 26;
/** In bytes, what a Matroska video is read by. */
const CHUNK = 1 << 22;

/** Its first frame and its natural size, as it shows turned. Throws when this machine cannot play it. */
export async function firstFrame(video: Blob): Promise<{ bitmap: ImageBitmap; natural: Size }> {
  const element = open(video);
  try {
    await loaded(element);
    const natural = { width: element.videoWidth, height: element.videoHeight };
    if (Math.max(natural.width, natural.height) > LONGEST_SIDE) {
      throw new Error(`it is larger than ${LONGEST_SIDE} px a side`);
    }
    return { bitmap: await createImageBitmap(element), natural };
  } finally {
    close(element);
  }
}

/** Muted, as a page may not play sound unasked. */
function open(video: Blob): HTMLVideoElement {
  const element = document.createElement("video");
  // Before its source, as one that loads its metadata only throws when copied, even once ready, in
  // Chromium, and loads no frame until it plays in WKWebView.
  element.preload = "auto";
  element.muted = true;
  element.playsInline = true;
  element.loop = true;
  element.src = URL.createObjectURL(video);
  return element;
}

/**
 * When each frame of `video` starts, in seconds, in the order they show, then when the last one
 * ends, `undefined` when its container does not tell. Read a part at a time, as the core keeps the
 * memory it once took.
 */
export async function frameTimes(video: Blob): Promise<number[] | undefined> {
  if (video.type === "video/webm" || video.type === "video/x-matroska") {
    const frames = new core.MatroskaFrames();
    try {
      for (let start = 0; start < video.size; start += CHUNK) {
        frames.read(await bytesOf(video.slice(start, start + CHUNK)));
      }
      const times = frames.frames();
      return times && Array.from(times);
    } finally {
      frames.free();
    }
  }
  let start = 0;
  for (let boxes = 0; boxes < MOST_BOXES; boxes += 1) {
    const found = core.movieIndex(video.size, start, await bytesOf(video.slice(start, start + 16)));
    if (typeof found === "number") {
      start = found;
    } else if (found === undefined || found[1] - found[0] > MOST_INDEX) {
      return undefined;
    } else {
      const times = core.movieFrames(await bytesOf(video.slice(...found)));
      return times && Array.from(times);
    }
  }
  return undefined;
}

async function bytesOf(blob: Blob): Promise<Bytes> {
  return new Uint8Array(await blob.arrayBuffer());
}

function close(element: HTMLVideoElement): void {
  const url = element.src;
  element.pause();
  element.removeAttribute("src");
  element.load();
  URL.revokeObjectURL(url);
}

/**
 * Once it has its first frame. Chromium loads none while the page hides, until it shows, so only
 * the time it shows counts.
 */
function loaded(element: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = document.hidden
        ? undefined
        : setTimeout(() => done("this machine cannot play it"), PATIENCE);
    };
    const shown = () => done(element.videoWidth > 0 ? undefined : "it holds no picture");
    const failed = () => done("this machine cannot play it");
    const done = (failure?: string) => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
      element.removeEventListener("loadeddata", shown);
      element.removeEventListener("error", failed);
      if (failure === undefined) {
        resolve();
      } else {
        reject(new Error(failure));
      }
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    element.addEventListener("loadeddata", shown);
    element.addEventListener("error", failed);
  });
}

export interface Videos {
  /** Plays those that are videos from now on, unless one already does. */
  keep(images: Iterable<{ asset: string; video?: Blob }>): void;
  /** Copies the new frames of those that show, and starts or stops them as they show. */
  update(board: Board, renderer: Renderer, camera: Camera, viewport: Viewport): void;
  holds(asset: string): boolean;
  playing(asset: string): boolean;
  /** Plays or pauses them, which motion being reduced then leaves as they are. */
  play(assets: string[], playing: boolean): void;
  /** Whether motion is reduced, which pauses those the user did not play. */
  reduce(reduced: boolean): void;
  /** Whether those the user did not play play only while the pointer is on them. */
  playOnHover(on: boolean): void;
  /** What the pointer is on, `undefined` when no image. */
  hover(asset: string | undefined): void;
  /** Without frames until they are read, which asking starts. */
  playback(asset: string): Playback | undefined;
  /** Goes to frame `at`, within what plays of it, and plays on from there if it plays. */
  seek(asset: string, at: number): void;
  /** Whether it goes frame by frame, as one whose frames are not read yet may. */
  steps(asset: string): boolean;
  /**
   * Pauses them, and goes `by` frames on within what plays of each, round from one end to the
   * other, once their frames are read.
   */
  step(assets: string[], by: number): void;
  /** Plays `span` of it, whatever its trim, until `undefined`. */
  preview(asset: string, span: Span | undefined): void;
  /** The lone video selected, which keeps its decoder while paused, to go to another frame at once. */
  select(asset: string | undefined): void;
  /** Whether `asset` plays with its sound, which it does from when asked until the board closes. */
  sounding(asset: string): boolean;
  sound(assets: string[], on: boolean): void;
  /** Forgets them all, as their renderer is gone. */
  reset(): void;
  /**
   * Stops them all, once nothing draws any more to start or stop them. It calls into no renderer,
   * which may have just panicked.
   */
  halt(): void;
}

interface Clip {
  /** Typed, as WKWebView refuses some untyped ones. */
  video: Blob;
  paused: boolean;
  /** Played or paused by the user, which motion being reduced leaves as it is. */
  chosen: boolean;
  sound: boolean;
  /** Where it got to, in seconds, while its frames are not known. */
  time: number;
  /** When each frame starts, in seconds, then when the last one ends, empty when its container does not tell. */
  starts?: number[] | undefined;
  reading: boolean;
  span: Span;
  /** The trim its span follows, as working it out again each frame would cost. */
  spanned?: { trim: Trim | undefined } | undefined;
  /** The frame it shows, or goes to. */
  at: number;
  /** The frame its texture holds, once known. */
  shown?: number | undefined;
  /** The frame to go to, until it shows. */
  seek?: number | undefined;
  /** Frames to step by once they are read. */
  stepping?: number | undefined;
  /** While it shows and plays, or goes to another frame, or is selected alone. */
  run?: Run | undefined;
}

interface Run {
  element: HTMLVideoElement;
  /** Whether the host tells each frame it presents, which some engines do not. */
  tells: boolean;
  /** Whether it shows a frame not copied yet, where the host tells. */
  fresh: boolean;
  since: number;
  /** The time of the frame last copied. */
  copied?: number;
  /** Whether it was asked to play. */
  playing: boolean;
  /** The frame it goes to, while it does. */
  seeking?: { at: number } | undefined;
  /** The frame it was sent to while paused, which it shows until it plays. */
  went?: number | undefined;
  /** The frame it shows, where the host tells. */
  presents?: number | undefined;
}

/** Of its frames, those it knows. */
const counted = (clip: Clip) => Math.max(0, (clip.starts?.length ?? 0) - 1);

const unseen = ({ element, tells, fresh, copied }: Run) =>
  tells ? fresh : element.currentTime !== copied;

/**
 * `again` asks for another frame, `changed` tells that one stopped on its own, started or stopped
 * as the pointer came or went, or that its frames were read, and `failed` that this machine cannot
 * play one.
 */
export function videos(again: () => void, changed: () => void, failed: () => void): Videos {
  const clips = new Map<string, Clip>();
  const previews = new Map<string, Span>();
  let reduced = false;
  let onHover = false;
  let hovered: string | undefined;
  let held: string | undefined;
  /** Whether it plays while it shows. */
  const runs = (asset: string) => {
    const clip = clips.get(asset);
    return clip !== undefined && !clip.paused && (clip.chosen || !onHover || asset === hovered);
  };
  /** Whether what plays of it moves, which a trim to one frame of several does not. */
  const moves = (clip: Clip) => counted(clip) <= 1 || clip.span[0] < clip.span[1];
  /** Whether it needs its element while it shows, until the frame it went to is copied. */
  const wants = (asset: string) => {
    const clip = clips.get(asset);
    return (
      clip !== undefined &&
      ((runs(asset) && moves(clip)) ||
        asset === held ||
        clip.seek !== undefined ||
        (clip.run !== undefined && unseen(clip.run) && clip.shown !== clip.at))
    );
  };
  const timeOf = ({ starts }: Clip, at: number) =>
    starts![at]! + (starts![at + 1]! - starts![at]!) * INTO_FRAME;
  const stop = (clip: Clip) => {
    if (clip.run !== undefined) {
      clip.time = clip.run.element.currentTime;
      close(clip.run.element);
      clip.run = undefined;
    }
  };
  /** It stays on the frame it showed. */
  const drop = (asset: string, clip: Clip) => {
    stop(clip);
    clips.delete(asset);
    changed();
    failed();
  };
  const go = (clip: Clip, run: Run, at: number) => {
    run.element.currentTime = timeOf(clip, at);
    run.seeking = { at };
    run.went = run.playing ? undefined : at;
    clip.at = at;
  };
  const arrived = (clip: Clip, run: Run) => {
    if (clip.seek === run.seeking?.at) {
      clip.seek = undefined;
    }
    run.seeking = undefined;
  };
  const span = (clip: Clip, [first, last]: Span) => {
    const end = counted(clip) - 1;
    clip.span = [Math.min(first, end), Math.min(last, end)];
  };
  const read = (asset: string, clip: Clip) => {
    if (clip.reading || clip.starts !== undefined) {
      return;
    }
    clip.reading = true;
    const known = (starts: number[] | undefined) => {
      if (clips.get(asset) !== clip) {
        return;
      }
      clip.starts = starts ?? [];
      if (counted(clip) < 2) {
        clip.stepping = undefined;
      }
      if (starts !== undefined) {
        clip.span = [0, starts.length - 2];
        clip.at = frameAt(starts, clip.run?.element.currentTime ?? clip.time);
      }
      changed();
      again();
    };
    frameTimes(clip.video).then(known, (error: unknown) => {
      console.warn(`Video ${asset} tells no frames:`, error);
      known(undefined);
    });
  };
  const play = (asset: string, clip: Clip, run: Run) => {
    const { element } = run;
    run.playing = true;
    run.went = undefined;
    run.since = performance.now();
    element.play().catch((error: unknown) => {
      if (clip.run !== run) {
        return;
      }
      const reason = error instanceof DOMException ? error.name : undefined;
      if (reason === "NotAllowedError" && !element.muted) {
        // The page may no longer play sound unasked, so the next update starts it again without.
        clip.sound = false;
        element.muted = true;
        run.playing = false;
        changed();
        again();
      } else if (reason === "AbortError") {
        // Paused before it started, which the next update takes in.
        run.playing = false;
      } else {
        drop(asset, clip);
      }
    });
  };
  const start = (asset: string, clip: Clip): Run => {
    const element = open(clip.video);
    const run: Run = {
      element,
      tells: "requestVideoFrameCallback" in element,
      fresh: false,
      since: performance.now(),
      playing: false,
    };
    const { tells } = run;
    const known = counted(clip) > 0;
    // Where it starts, which it reads back until its metadata loads, for a stop before then to keep.
    element.currentTime = known ? timeOf(clip, clip.seek ?? clip.at) : clip.time;
    if (known && clip.seek !== undefined) {
      run.seeking = { at: clip.seek };
    }
    run.went = known ? (clip.seek ?? clip.at) : undefined;
    element.addEventListener("error", () => clip.run === run && drop(asset, clip));
    // Paused by the system's media keys counts as by the user, and a window that hides pauses it
    // too, to go on once it shows again. One that played to its end goes on from its span's start.
    element.addEventListener("pause", () => {
      if (clip.run === run && run.playing && element.paused && !element.ended && !document.hidden) {
        run.playing = false;
        clip.paused = true;
        clip.chosen = true;
        changed();
        again();
      }
    });
    element.addEventListener("ended", () => {
      if (clip.run === run && run.playing && counted(clip) > 0) {
        run.playing = false;
        go(clip, run, clip.span[0]);
        again();
      }
    });
    const landed = () => {
      const { seeking } = run;
      if (clip.run !== run || seeking === undefined || element.seeking) {
        return;
      }
      // Where the host tells none, a new time at the next draw tells it.
      if (!tells) {
        arrived(clip, run);
        again();
        return;
      }
      setTimeout(() => {
        if (clip.run === run && run.seeking === seeking) {
          run.fresh = true;
          run.presents = seeking.at;
          arrived(clip, run);
          again();
        }
      }, SEEK_GRACE);
    };
    element.addEventListener("seeked", landed);
    element.addEventListener("loadeddata", landed);
    if (tells) {
      const presented = (_: number, { mediaTime }: VideoFrameCallbackMetadata) => {
        if (clip.run !== run) {
          return;
        }
        run.fresh = true;
        if (counted(clip) > 0 && !element.seeking) {
          const told = frameAt(clip.starts!, mediaTime);
          const [first, last] = clip.span;
          // As the host shows it, though it may tell the one before. Paused, the frame it was sent
          // to, and playing, no earlier than the one it went to, as it may have played on since.
          const frame =
            !run.playing && run.went !== undefined
              ? run.went
              : Math.max(run.seeking?.at ?? 0, told);
          run.presents = frame;
          if (run.seeking !== undefined) {
            arrived(clip, run);
          }
          if (clip.seek === undefined) {
            if (element.loop || (frame >= first && frame <= last)) {
              clip.at = frame;
            }
            // Once its last frame is copied, which shows while it goes back, about as long.
            if (run.playing && !element.loop && (frame >= last || frame < first)) {
              clip.seek = first;
            }
          }
        }
        again();
        element.requestVideoFrameCallback(presented);
      };
      element.requestVideoFrameCallback(presented);
    }
    element.muted = !clip.sound;
    return run;
  };
  // A hidden window draws no frame, so its frame hook would not stop what plays, sound included.
  document.addEventListener("visibilitychange", () =>
    document.hidden ? clips.forEach(stop) : again(),
  );
  return {
    keep(images) {
      for (const { asset, video } of images) {
        if (video !== undefined && !clips.has(asset)) {
          clips.set(asset, {
            video,
            paused: reduced,
            chosen: false,
            sound: false,
            time: 0,
            reading: false,
            span: [0, 0],
            at: 0,
          });
          if (asset === held) {
            read(asset, clips.get(asset)!);
          }
        }
      }
    },
    update(board, renderer, camera, viewport) {
      if (clips.size === 0) {
        return;
      }
      const played = assetPlayback(board);
      // Of all, as a trim an undo changes sends one paused out of sight back to its start.
      for (const [asset, clip] of clips) {
        const trim = played.get(asset)?.trim;
        // Read for what its trim leaves, which it plays whole until then.
        if (trim !== undefined) {
          read(asset, clip);
        }
        if (counted(clip) === 0) {
          continue;
        }
        const preview = previews.get(asset);
        if (preview) {
          span(clip, preview);
        } else if (
          clip.spanned === undefined ||
          clip.spanned.trim?.start !== trim?.start ||
          clip.spanned.trim?.end !== trim?.end
        ) {
          clip.spanned = { trim };
          span(clip, spanOf(clip.starts!, trim));
        }
        if (clip.stepping !== undefined) {
          clip.at = stepped(clip.at, clip.stepping, clip.span);
          clip.seek = clip.at;
          clip.stepping = undefined;
        }
        if (clip.at < clip.span[0] || clip.at > clip.span[1]) {
          clip.seek = clip.span[0];
          clip.at = clip.span[0];
        }
      }
      // Only with its texture, which an undo brings back a moment after the image.
      const shown = shownAssets(
        board,
        camera,
        viewport,
        (asset) => wants(asset) && renderer.holds(asset),
      );
      // The one selected first, as it waits on the user.
      const largest = [...shown]
        .toSorted(([a, x], [b, y]) => Number(b === held) - Number(a === held) || y - x)
        .slice(0, MOST_PLAYING);
      const playing = new Set(largest.map(([asset]) => asset));
      const now = performance.now();
      let polled = false;
      for (const [asset, clip] of clips) {
        const count = counted(clip);
        if (document.hidden || !playing.has(asset)) {
          stop(clip);
          // Freed once no image draws it, it loads again on its first frame, then goes back.
          if (!renderer.holds(asset) && clip.shown !== undefined) {
            clip.shown = undefined;
            clip.seek ??= count > 0 && clip.at > 0 ? clip.at : undefined;
          }
          continue;
        }
        const run = (clip.run ??= start(asset, clip));
        const { element } = run;
        const [first, last] = clip.span;
        const speed = played.get(asset)?.speed ?? 1;
        if (element.playbackRate !== speed) {
          element.playbackRate = speed;
        }
        element.loop = count === 0 || (first === 0 && last === count - 1);
        const plays = runs(asset) && moves(clip);
        if (plays && !run.playing) {
          play(asset, clip, run);
        } else if (!plays && run.playing) {
          run.playing = false;
          element.pause();
        }
        // As going to the frame it shows shows no other.
        if (
          clip.seek !== undefined &&
          run.seeking === undefined &&
          run.presents === clip.seek &&
          !element.seeking
        ) {
          clip.seek = undefined;
          run.fresh ||= clip.shown !== clip.at;
        }
        const { tells } = run;
        const showing =
          run.presents ?? (count > 0 ? frameAt(clip.starts!, element.currentTime) : undefined);
        // Not past its span, as one that played on between two frame callbacks may be.
        const within =
          element.loop || showing === undefined || (showing >= first && showing <= last);
        try {
          // Not while it seeks, as some show no frame then.
          if (unseen(run) && within && !element.seeking && renderer.copyVideo(asset, element)) {
            run.fresh = false;
            run.copied = element.currentTime;
            clip.shown = showing;
            // One that went to a frame lets its decoder go on the next.
            if (!wants(asset)) {
              again();
            }
          } else if (run.copied === undefined && run.playing && now - run.since > PATIENCE) {
            drop(asset, clip);
            continue;
          }
        } catch (error) {
          drop(asset, clip);
          // One that does not fit its texture throws a plain error.
          if (!(error instanceof Error) || error.name !== "Error") {
            throw error;
          }
          console.warn(`Video ${asset} cannot play here:`, error);
          continue;
        }
        // After the copy, so that the frame it went to shows before it goes on to the next.
        if (clip.seek !== undefined && run.seeking === undefined) {
          go(clip, run, clip.seek);
        }
        if (!tells && showing !== undefined && run.seeking === undefined && !element.seeking) {
          if (clip.seek === undefined && within) {
            clip.at = showing;
          }
          if (run.playing && !element.loop && (showing >= last || showing < first)) {
            go(clip, run, first);
          }
        }
        polled ||= !tells && (run.playing || run.seeking !== undefined || element.seeking);
      }
      if (polled) {
        again();
      }
    },
    holds: (asset) => clips.has(asset),
    playing: runs,
    play(assets, playing) {
      for (const asset of assets) {
        const clip = clips.get(asset);
        if (clip) {
          clip.paused = !playing;
          clip.chosen = true;
        }
      }
      again();
    },
    reduce(reduce) {
      reduced = reduce;
      for (const clip of clips.values()) {
        if (!clip.chosen) {
          clip.paused = reduced;
        }
      }
      again();
    },
    playOnHover(on) {
      onHover = on;
      again();
    },
    hover(asset) {
      const moved =
        asset !== hovered && [hovered, asset].some((one) => one !== undefined && clips.has(one));
      hovered = asset;
      if (onHover && moved) {
        changed();
        again();
      }
    },
    playback(asset) {
      const clip = clips.get(asset);
      if (!clip) {
        return undefined;
      }
      read(asset, clip);
      return {
        at: clip.at,
        count: counted(clip),
        playing: runs(asset),
        span: clip.span,
        starts: clip.starts ?? [],
        sound: clip.sound,
      };
    },
    seek(asset, at) {
      const clip = clips.get(asset);
      if (clip && counted(clip) > 0) {
        const [first, last] = clip.span;
        clip.at = Math.min(last, Math.max(first, at));
        clip.seek = clip.at;
        again();
      }
    },
    steps(asset) {
      const clip = clips.get(asset);
      return clip !== undefined && (clip.starts === undefined || counted(clip) > 1);
    },
    step(assets, by) {
      for (const asset of assets) {
        const clip = clips.get(asset);
        if (!clip || (clip.starts !== undefined && counted(clip) < 2)) {
          continue;
        }
        read(asset, clip);
        clip.paused = true;
        clip.chosen = true;
        if (clip.starts === undefined) {
          clip.stepping = (clip.stepping ?? 0) + by;
        } else {
          clip.at = stepped(clip.at, by, clip.span);
          clip.seek = clip.at;
        }
      }
      again();
    },
    preview(asset, shown) {
      const clip = clips.get(asset);
      if (shown === undefined) {
        previews.delete(asset);
        if (clip) {
          clip.spanned = undefined;
        }
      } else {
        previews.set(asset, shown);
        // At once, so that a frame sought next is sought within it.
        if (clip && counted(clip) > 0) {
          span(clip, shown);
        }
      }
      again();
    },
    select(asset) {
      // Kept even before it is, as a board that opens loads its videos after it shows.
      held = asset;
      const clip = asset === undefined ? undefined : clips.get(asset);
      if (clip) {
        read(asset!, clip);
      }
      again();
    },
    sounding: (asset) => clips.get(asset)?.sound === true,
    sound(assets, on) {
      for (const asset of assets) {
        const clip = clips.get(asset);
        if (clip) {
          clip.sound = on;
          if (clip.run !== undefined) {
            clip.run.element.muted = !on;
          }
        }
      }
      again();
    },
    reset() {
      clips.forEach(stop);
      clips.clear();
      previews.clear();
      held = undefined;
    },
    halt() {
      clips.forEach(stop);
    },
  };
}
