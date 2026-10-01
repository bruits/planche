// Videos as the renderer draws them. The host plays each in a `<video>` the page never shows, and
// the renderer copies its frames onto the texture of the first one, only while it shows and plays,
// the largest on screen first, as decoders are few. It goes on from where it got to.

import type { Camera, Viewport } from "./camera.js";
import type { Board, Size } from "./core.js";
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
      timer = document.hidden ? undefined : setTimeout(() => done("this machine cannot play it"), PATIENCE);
    };
    const done = (failure?: string) => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
      element.onloadeddata = element.onerror = null;
      if (failure === undefined) {
        resolve();
      } else {
        reject(new Error(failure));
      }
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    element.onloadeddata = () => done(element.videoWidth > 0 ? undefined : "it holds no picture");
    element.onerror = () => done("this machine cannot play it");
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
  /** Whether `asset` plays with its sound, which it does from when asked until the board closes. */
  sounding(asset: string): boolean;
  sound(assets: string[], on: boolean): void;
  /** Forgets them all, as their renderer is gone. */
  reset(): void;
}

interface Clip {
  /** Typed, as WKWebView refuses some untyped ones. */
  video: Blob;
  paused: boolean;
  /** Played or paused by the user, which motion being reduced leaves as it is. */
  chosen: boolean;
  sound: boolean;
  /** Where it got to, in seconds. */
  time: number;
  /** While it shows and plays. */
  run?: Run;
}

interface Run {
  element: HTMLVideoElement;
  /** Whether it shows a frame not copied yet, where the host tells. */
  fresh: boolean;
  since: number;
  /** The time of the frame last copied. */
  copied?: number;
}

/** `again` asks for another frame, `changed` tells that one stopped on its own, and `failed` that this machine cannot play one. */
export function videos(again: () => void, changed: () => void, failed: () => void): Videos {
  const clips = new Map<string, Clip>();
  let reduced = false;
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
  const start = (asset: string, clip: Clip): Run => {
    const element = open(clip.video);
    const run: Run = { element, fresh: false, since: performance.now() };
    // Where it starts, which it reads back until its metadata loads, for a stop before then to keep.
    element.currentTime = clip.time;
    element.addEventListener("error", () => clip.run === run && drop(asset, clip));
    // Paused by the system's media keys counts as by the user, and a window that hides pauses it
    // too, to go on once it shows again.
    element.addEventListener("pause", () => {
      if (clip.run === run && !document.hidden) {
        clip.paused = true;
        clip.chosen = true;
        changed();
        again();
      }
    });
    if ("requestVideoFrameCallback" in element) {
      const presented = () => {
        if (clip.run === run) {
          run.fresh = true;
          again();
          element.requestVideoFrameCallback(presented);
        }
      };
      element.requestVideoFrameCallback(presented);
    }
    element.muted = !clip.sound;
    element.play().catch((error: unknown) => {
      if (clip.run !== run) {
        return;
      }
      const reason = error instanceof DOMException ? error.name : undefined;
      if (reason === "NotAllowedError" && !element.muted) {
        // The page may no longer play sound unasked, so the next update starts it again without.
        clip.sound = false;
        changed();
        stop(clip);
        again();
      } else if (reason === "AbortError") {
        // Paused as the window hid, to go on once it shows again.
        stop(clip);
      } else {
        drop(asset, clip);
      }
    });
    return run;
  };
  // A hidden window draws no frame, so its frame hook would not stop what plays, sound included.
  document.addEventListener("visibilitychange", () => (document.hidden ? clips.forEach(stop) : again()));
  return {
    keep(images) {
      for (const { asset, video } of images) {
        if (video !== undefined && !clips.has(asset)) {
          clips.set(asset, { video, paused: reduced, chosen: false, sound: false, time: 0 });
        }
      }
    },
    update(board, renderer, camera, viewport) {
      if (clips.size === 0) {
        return;
      }
      const shown = shownAssets(board, camera, viewport, (asset) => clips.get(asset)?.paused === false);
      const largest = [...shown].sort(([, a], [, b]) => b - a).slice(0, MOST_PLAYING);
      const playing = new Set(largest.map(([asset]) => asset));
      const now = performance.now();
      let polled = false;
      for (const [asset, clip] of clips) {
        if (document.hidden || !playing.has(asset)) {
          stop(clip);
          continue;
        }
        const run = (clip.run ??= start(asset, clip));
        const tells = "requestVideoFrameCallback" in run.element;
        const fresh = tells ? run.fresh : run.element.currentTime !== run.copied;
        try {
          if (fresh && renderer.copyVideo(asset, run.element)) {
            run.fresh = false;
            run.copied = run.element.currentTime;
          } else if (run.copied === undefined && now - run.since > PATIENCE) {
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
        polled ||= !tells;
      }
      if (polled) {
        again();
      }
    },
    holds: (asset) => clips.has(asset),
    playing: (asset) => clips.get(asset)?.paused === false,
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
    },
    reset() {
      clips.forEach(stop);
      clips.clear();
    },
  };
}
