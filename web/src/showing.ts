// A board just read, shown at once, then its images as each is read, checked against its digest,
// and decoded, the largest on screen first. A board whose image cannot be read shows nothing, as
// saving it would fail. Images whose textures were freed are read again the same way once an edit
// brings them back, and only those that fail then show crossed out.

import {
  AT_ONCE,
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
import type { Board, Size } from "./core.js";
import { message } from "./errors.js";
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
  /** Takes `decoded` over, even when it throws, as the renderer cannot hold it. */
  load(into: Into, asset: string, decoded: Decoded, read: Asset): void;
  crossOut(into: Into, asset: string): void;
  /** Whether `into` has the asset loaded or crossed out. */
  holds(into: Into, asset: string): boolean;
  /** Frees what `into` holds of the asset, which no image draws any more. */
  unload(into: Into, asset: string): void;
  /** Whether a gesture is under way, which may yet take its edits back. */
  busy(): boolean;
  redraw(): void;
  /** Leaves nothing of the board on view, which `into` drew if anything. */
  abandon(into: Into | undefined): void;
  changed(touched: string[]): void;
  /** The row `name` of the measurements, which the next draw ends, from `since`. */
  drawn(name: string, since: number): void;
}

export interface Showing {
  /** Shows a board just read, throwing why it cannot. */
  show(next: Opened, camera?: Camera): Promise<void>;
  /**
   * Once an edit stopped images showing the `undrawn` assets, which `free` frees unless one shows
   * them again meanwhile. Reads again those it brought back, once the board shows.
   */
  edited(undrawn: Iterable<string>): void;
  /** Frees the assets edits stopped showing, once the board shows and no gesture is under way. */
  free(): void;
  reloading(): boolean;
}

interface Wanted {
  asset: string;
  natural: Size;
}

type Brought = "loaded" | "undecodable" | "unplayable" | "unloadable" | "undrawn";

/** The board shown once its first reading is over, with what draws it. */
interface Shown<Into> {
  board: Opened;
  into: Into;
  /** The assets being read again. */
  again: Set<string>;
}

/** Shows boards, then their images again as edits bring them back. */
export function showing<Into>(host: Host<Into>): Showing {
  let shown: Shown<Into> | undefined;
  /** The assets edits stopped showing, which other images may still show. */
  const unused = new Set<string>();

  /**
   * Reads, decodes, and loads one of the board's assets once `ready`, throwing when it cannot be
   * read.
   */
  const bring = async (
    board: Opened,
    ready: Promise<Into | undefined>,
    live: () => boolean,
    saving: Pick<Saving, "during"> | undefined,
    { asset, natural }: Wanted,
  ): Promise<Brought | undefined> => {
    const reading = () => readAsset(files(board), asset, natural);
    // Saves wait only while it is read, as one may move a ZIP file's images.
    const read = await (saving ? saving.during(reading) : reading());
    let decoded = await host.decode(read);
    try {
      const into = await ready;
      if (into === undefined || !live()) {
        return undefined;
      }
      // Deleted meanwhile, it is read again once an edit brings it back.
      if (!assetSizes(board.board).has(asset)) {
        return "undrawn";
      }
      if (decoded) {
        const taken = decoded;
        decoded = undefined;
        try {
          host.load(into, asset, taken, read);
          return "loaded";
        } catch (error) {
          // An upload the GPU refuses throws a plain error, anything else being the app's fault.
          if (!(error instanceof Error) || error.name !== "Error") {
            throw error;
          }
          console.warn(`Image ${asset} cannot show here:`, error);
          host.crossOut(into, asset);
          return "unloadable";
        }
      }
      host.crossOut(into, asset);
      return read.video ? "unplayable" : "undecodable";
    } finally {
      host.release(decoded);
    }
  };

  /** Those the board draws that its renderer lacks, but those being read again. */
  const missing = ({ board, into, again }: Shown<Into>) => {
    const sizes = assetSizes(board.board);
    for (const asset of sizes.keys()) {
      if (again.has(asset) || host.holds(into, asset)) {
        sizes.delete(asset);
      }
    }
    return sizes;
  };

  const readAgain = async (current: Shown<Into>, wanted: Wanted) => {
    const { board, into } = current;
    const live = () => shown === current && host.opened() === board;
    let brought: Brought | undefined;
    let failure: string | undefined;
    try {
      brought = await bring(board, Promise.resolve(into), live, host.saver(), wanted);
    } catch (error) {
      if (live() && assetSizes(board.board).has(wanted.asset)) {
        host.crossOut(into, wanted.asset);
        failure = message(error);
      }
    }
    if (brought === "undecodable" || brought === "unplayable" || brought === "unloadable") {
      failure = `this machine cannot ${brought === "unplayable" ? "play" : "show"} it`;
    }
    if (failure !== undefined) {
      host.say(`An image could not be read again: ${failure}`);
    }
    if (brought === "loaded" || failure !== undefined) {
      host.redraw();
    }
  };

  const reload = () => {
    const current = shown;
    if (current === undefined || host.opened() !== current.board) {
      return;
    }
    const { board, again } = current;
    while (again.size < AT_ONCE) {
      const lacking = missing(current);
      if (lacking.size === 0) {
        return;
      }
      const camera = host.camera() ?? fit(extent(board), host.size());
      const wanted = largestFirst(board.board, lacking, camera, host.size())!;
      again.add(wanted.asset);
      void readAgain(current, wanted)
        .finally(() => {
          again.delete(wanted.asset);
          reload();
        })
        .catch((error: unknown) => host.say(message(error)));
    }
  };

  return {
    async show(next, camera) {
      shown = undefined;
      unused.clear();
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
      const crossed = { undecodable: 0, unplayable: 0, unloadable: 0 };
      let loaded = 0;
      let done = 0;
      // The largest of those that show first, as the camera moves meanwhile, then as they draw.
      const nextAsset = () =>
        largestFirst(next.board, pending, host.camera() ?? firstCamera, host.size());
      const showAsset = async (wanted: Wanted) => {
        const brought = await bring(next, ready, live, saving, wanted).catch((error: unknown) => {
          failed = true;
          throw error;
        });
        if (brought === undefined) {
          return;
        }
        if (brought === "loaded") {
          if (loaded === 0) {
            host.drawn("first image", start);
          }
          loaded += 1;
        } else if (brought !== "undrawn") {
          crossed[brought] += 1;
        }
        done += 1;
        if (visible.delete(wanted.asset) && visible.size === 0) {
          host.drawn("visible images", start);
        }
        host.say(`${summary}, ${done} of ${total} images…`, true);
        host.redraw();
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
      const into = await ready;
      if (total > 0) {
        host.drawn("last image", start);
      }
      const said = [
        ...told(crossed.undecodable, "an image", "images", "decode"),
        ...told(crossed.unplayable, "a video", "videos", "play"),
        ...told(crossed.unloadable, "an image", "images", "show"),
      ];
      if (said.length > 0) {
        host.say(`${summary}, ${said.join(", and ")}`);
      } else if (!empty) {
        host.say(summary);
      }
      if (into !== undefined && host.opened() === next) {
        shown = { board: next, into, again: new Set() };
        // Those that edits brought back once their turn had passed.
        reload();
      }
    },
    edited(undrawn) {
      for (const asset of undrawn) {
        unused.add(asset);
      }
      reload();
    },
    free() {
      const current = shown;
      if (
        unused.size === 0 ||
        current === undefined ||
        host.opened() !== current.board ||
        host.busy()
      ) {
        return;
      }
      const drawn = assetSizes(current.board.board);
      for (const asset of unused) {
        if (!drawn.has(asset)) {
          host.unload(current.into, asset);
        }
      }
      unused.clear();
    },
    reloading: () => shown !== undefined && shown.again.size > 0,
  };
}

function told(count: number, one: string, many: string, why: string): string[] {
  return count > 0 ? [`${count === 1 ? one : `${count} ${many}`} this machine cannot ${why}`] : [];
}

/** The largest on screen of `pending`, or else the first, which it takes out. */
function largestFirst(
  board: Board,
  pending: Map<string, Size>,
  camera: Camera,
  size: Size,
): Wanted | undefined {
  const areas = shownAssets(board, camera, size, (asset) => pending.has(asset));
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
}
