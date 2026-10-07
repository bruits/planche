// A board just read, shown at once, then its images as each is read, checked against its digest,
// and decoded, the largest on screen first. An image whose file is missing, unlike its digest, or
// that this machine cannot show, shows crossed out. Images whose textures were freed are read again
// the same way once an edit brings them back.

import {
  AT_ONCE,
  assetSizes,
  extent,
  files,
  pool,
  readAsset,
  Unreadable,
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
  /**
   * Shows a board just read, throwing why it cannot, then says what it holds. Returns what went
   * wrong, the images crossed out and the files left out, if anything did.
   */
  show(next: Opened, camera?: Camera): Promise<string | undefined>;
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

type Crossed = "undecodable" | "unplayable" | "unloadable" | Unreadable["reason"] | "unread";

type Brought = "loaded" | "undrawn" | Crossed;

/** What the board's line says of the images crossed out, one, then many, in this order. */
const CROSSED: Record<Crossed, [string, string]> = {
  undecodable: ["an image this machine cannot decode", "images this machine cannot decode"],
  unplayable: ["a video this machine cannot play", "videos this machine cannot play"],
  unloadable: ["an image this machine cannot show", "images this machine cannot show"],
  missing: ["an image whose file is missing", "images whose files are missing"],
  pointer: [
    "an image left as a Git LFS pointer, so run `git lfs pull`",
    "images left as Git LFS pointers, so run `git lfs pull`",
  ],
  differs: ["an image whose file differs from its digest", "images whose files differ from theirs"],
  unread: ["an image whose file cannot be read", "images whose files cannot be read"],
};

/** Why an image read again shows crossed out. */
const AGAIN: Record<Crossed, string> = {
  undecodable: "this machine cannot show it",
  unplayable: "this machine cannot play it",
  unloadable: "this machine cannot show it",
  missing: "its file is missing",
  pointer: "its file is a Git LFS pointer, so run `git lfs pull`",
  differs: "its file differs from its digest",
  unread: "its file cannot be read",
};

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

  /** Reads, decodes, and loads one of the board's assets once `ready`, or crosses it out. */
  const bring = async (
    board: Opened,
    ready: Promise<Into | undefined>,
    live: () => boolean,
    saving: Pick<Saving, "during"> | undefined,
    { asset, natural }: Wanted,
  ): Promise<Brought | undefined> => {
    const reading = () => readAsset(files(board), asset, natural);
    // Saves wait only while it is read, as one may move a ZIP file's images.
    const read = await (saving ? saving.during(reading) : reading()).catch(
      (error: unknown): Crossed => {
        // The app's own faults, its bugs and the core's panics, stop the board showing.
        if (error instanceof TypeError || error instanceof WebAssembly.RuntimeError) {
          throw error;
        }
        if (error instanceof Unreadable) {
          return error.reason;
        }
        console.warn(`Image ${asset} cannot be read:`, error);
        return "unread";
      },
    );
    let decoded = typeof read === "string" ? undefined : await host.decode(read);
    try {
      const into = await ready;
      if (into === undefined || !live()) {
        return undefined;
      }
      // Deleted meanwhile, it is read again once an edit brings it back.
      if (!assetSizes(board.board).has(asset)) {
        return "undrawn";
      }
      if (typeof read === "string") {
        host.crossOut(into, asset);
        return read;
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
    if (brought !== undefined && brought !== "loaded" && brought !== "undrawn") {
      failure = AGAIN[brought];
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
      // Whether the app failed the opening, which then shows nothing.
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
      const crossed = new Map<Crossed, number>();
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
          crossed.set(brought, (crossed.get(brought) ?? 0) + 1);
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
      const said = [...told(crossed), ...toldLeftOut(next)];
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
      return said.length > 0 ? said.join(", and ") : undefined;
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

function told(crossed: ReadonlyMap<Crossed, number>): string[] {
  return Object.entries(CROSSED).flatMap(([why, [one, many]]) => {
    const count = crossed.get(why as Crossed) ?? 0;
    return count > 0 ? [count === 1 ? one : `${count} ${many}`] : [];
  });
}

function toldLeftOut({ leftOut }: Opened): string[] {
  const reasons = [...leftOut.values()];
  reasons.forEach((reason) => console.warn(`Left out, as ${reason}`));
  if (reasons.length === 0) {
    return [];
  }
  return [
    reasons.length === 1
      ? `a file left out, as ${reasons[0]}`
      : `${reasons.length} files left out, the first as ${reasons[0]}`,
  ];
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
