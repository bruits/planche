// A board just read, shown at once, then its images as each is read, checked against its digest,
// and decoded, the largest on screen first. A board whose image cannot be read shows nothing, as
// saving it would fail.

import {
  assetSizes,
  extent,
  files,
  pool,
  readAsset,
  type Asset,
  type Decoded,
  type Opened,
} from "./board.js";
import { fit, type Camera } from "./camera.js";
import type { Size } from "./core.js";
import { shownAssets } from "./raster.js";
import type { Saving } from "./save.js";

/** What the view does for a board as it shows, drawing it `Into` a renderer. */
export interface Host<Into> {
  opened(): Opened | undefined;
  /** Where the open board saves itself, which waits while an image is read. */
  saver(): Pick<Saving, "during"> | undefined;
  camera(): Camera | undefined;
  size(): Size;
  say(text: string, busy?: boolean): void;
  /** Leaves the view and the edits to `next`, which is open from then on. */
  reset(next: Opened): void;
  /** What draws `next`, seen from `camera` or else whole, unless no longer `wanted` once there. */
  attach(
    next: Opened,
    camera: Camera | undefined,
    wanted: () => boolean,
  ): Promise<Into | undefined>;
  /** `undefined` when this machine cannot decode or play it. */
  decode(read: Asset): Promise<Decoded | undefined>;
  release(decoded: Decoded | undefined): void;
  /** Takes `decoded` over. */
  load(into: Into, asset: string, decoded: Decoded, read: Asset): void;
  crossOut(into: Into, asset: string): void;
  redraw(): void;
  /** Leaves nothing of the board on view, which `into` drew if anything. */
  abandon(into: Into | undefined): void;
  changed(touched: string[]): void;
  /** The row `name` of the measurements, which the next draw ends, from `since`. */
  drawn(name: string, since: number): void;
}

/** Shows boards, each throwing why it cannot show. */
export function showing<Into>(host: Host<Into>): (next: Opened, camera?: Camera) => Promise<void> {
  return async (next, camera) => {
    const start = performance.now();
    host.reset(next);
    const summary = `${next.folder.name}: ${next.board.draw_order.length} elements`;
    const empty = next.board.draw_order.length === 0;
    if (!empty) {
      host.say(summary, true);
    }
    const size = host.size();
    const firstCamera = camera ?? fit(extent(next), size);
    // Whether an image failed the opening, which then shows nothing.
    let failed = false;
    const live = () => !failed && host.opened() === next;
    const ready = host.attach(next, camera, live);
    // Handled at once, as the images may fail the opening before anything awaits the renderer.
    const settled = ready.catch(() => undefined);
    // Its own, as a Save as or another board may replace it meanwhile.
    const saving = host.saver();
    const pending = assetSizes(next.board);
    const total = pending.size;
    const visible = new Set(shownAssets(next.board, firstCamera, size, () => true).keys());
    let undecodable = 0;
    let unplayable = 0;
    let shown = 0;
    let done = 0;
    // The largest of those that show first, as the camera moves meanwhile, then as they draw.
    const nextAsset = () => {
      const areas = shownAssets(next.board, host.camera() ?? firstCamera, host.size(), (asset) =>
        pending.has(asset),
      );
      let asset = pending.keys().next().value;
      let largest = -1;
      for (const [candidate, area] of areas) {
        if (area > largest) {
          [asset, largest] = [candidate, area];
        }
      }
      if (asset === undefined) {
        return undefined;
      }
      const natural = pending.get(asset)!;
      pending.delete(asset);
      return { asset, natural };
    };
    const showAsset = async ({ asset, natural }: { asset: string; natural: Size }) => {
      const reading = () => readAsset(files(next), asset, natural);
      // Saves wait only while it is read, as one may move a ZIP file's images.
      const read = await (saving ? saving.during(reading) : reading()).catch((error: unknown) => {
        failed = true;
        throw error;
      });
      let decoded = await host.decode(read);
      try {
        const created = await ready;
        if (created === undefined || !live()) {
          return;
        }
        if (decoded) {
          host.load(created, asset, decoded, read);
          decoded = undefined;
          if (shown === 0) {
            host.drawn("first image", start);
          }
          shown += 1;
        } else {
          if (read.video) {
            unplayable += 1;
          } else {
            undecodable += 1;
          }
          host.crossOut(created, asset);
        }
        done += 1;
        if (visible.delete(asset) && visible.size === 0) {
          host.drawn("visible images", start);
        }
        host.say(`${summary}, ${done} of ${total} images…`, true);
        host.redraw();
      } finally {
        host.release(decoded);
      }
    };
    try {
      await pool(nextAsset, showAsset);
    } catch (error) {
      failed = true;
      const created = await settled;
      if (host.opened() === next) {
        host.abandon(created);
        // What the user began on its images meanwhile ends where it began.
        host.changed(next.editor.rewindGesture());
        next.editor.endGesture();
      }
      throw error;
    }
    await ready;
    if (total > 0) {
      host.drawn("last image", start);
    }
    const crossed = [
      ...(undecodable > 0
        ? [`${undecodable === 1 ? "an image" : `${undecodable} images`} this machine cannot decode`]
        : []),
      ...(unplayable > 0
        ? [`${unplayable === 1 ? "a video" : `${unplayable} videos`} this machine cannot play`]
        : []),
    ];
    if (crossed.length > 0) {
      host.say(`${summary}, ${crossed.join(", and ")}`);
    } else if (!empty) {
      host.say(summary);
    }
  };
}
