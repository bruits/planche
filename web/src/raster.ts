// What texts and vector images share as the renderer draws them. Each is rasterised to a texture
// of its own at the zoom it shows at, rounded up to a power of two so that zooming within the same
// power reuses it, and follows the camera only once it settles.

import type { Camera, Viewport } from "./camera.js";
import type { Board, Rect } from "./core.js";

/** WebGL2 guarantees textures this large. */
export const LONGEST_SIDE = 2048;
/** Within what a canvas holds in every engine, Safari's area being the least. */
export const MOST_AREA = 4096 * 4096;
export const MOST_SIDE = 16_384;
/** How long the camera stays put before rasters follow it, in milliseconds. */
const SETTLE = 150;

export function rounded(wanted: number): number {
  return 2 ** Math.ceil(Math.log2(wanted));
}

/** When rasters that no longer match the zoom may be redone. */
export interface Settling {
  /** Takes the camera of this frame. What of the board it shows. */
  follow(camera: Camera, viewport: Viewport): Rect;
  /**
   * Whether a raster in view may be redone, once the zoom settles, or one out of view, once the
   * camera does. Otherwise asks for a frame then.
   */
  settled(visible: boolean): boolean;
  reset(): void;
}

/** `again` asks for another frame. */
export function settling(again: () => void): Settling {
  let seen: Camera | undefined;
  /** Once the zoom settles, and once the camera does. */
  let zoomed = 0;
  let moved = 0;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  return {
    follow(camera, viewport) {
      const now = performance.now();
      if (camera.zoom !== seen?.zoom) {
        zoomed = now + SETTLE;
      }
      if (camera.x !== seen?.x || camera.y !== seen?.y || camera.zoom !== seen?.zoom) {
        moved = now + SETTLE;
      }
      seen = camera;
      return onScreen(camera, viewport);
    },
    settled(visible) {
      const now = performance.now();
      const until = visible ? zoomed : moved;
      if (now >= until) {
        return true;
      }
      if (waiting === undefined) {
        waiting = setTimeout(() => {
          waiting = undefined;
          again();
        }, until - now);
      }
      return false;
    },
    reset() {
      seen = undefined;
    },
  };
}

/** What of the board shows. */
export function onScreen(camera: Camera, { width, height }: Viewport): Rect {
  return { x: camera.x, y: camera.y, width: width / camera.zoom, height: height / camera.zoom };
}

/** The assets of the images that show, among those `kept`, each with its largest image's area. */
export function shownAssets(
  board: Board,
  camera: Camera,
  viewport: Viewport,
  kept: (asset: string) => boolean,
): Map<string, number> {
  const area = onScreen(camera, viewport);
  const shown = new Map<string, number>();
  for (const id of board.draw_order) {
    const { kind } = board.elements[id]!;
    if (kind.type === "image" && kept(kind.asset) && overlaps(area, kind.frame)) {
      shown.set(
        kind.asset,
        Math.max(shown.get(kind.asset) ?? 0, kind.frame.width * kind.frame.height),
      );
    }
  }
  return shown;
}

/** Whether the frame, however it turns, may show in `area`. */
export function overlaps(area: Rect, frame: Rect): boolean {
  const reach = Math.hypot(frame.width, frame.height) / 2;
  const [x, y] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
  const across = x + reach >= area.x && x - reach <= area.x + area.width;
  return across && y + reach >= area.y && y - reach <= area.y + area.height;
}
