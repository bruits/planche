// A board just read, shown at once, then its images as each is read, checked against its digest,
// and decoded, the largest on screen first. An image whose file is missing, unlike its digest, or
// that this machine cannot show, shows crossed out. Images whose textures were freed are read again
// the same way once an edit brings them back, and those crossed out for their files once another
// program changed those.

import {
  assetNames,
  assetSizes,
  extent,
  files,
  readAsset,
  Unreadable,
  type Asset,
  type Decoded,
  type Opened,
} from "./board.js";
import { AT_ONCE, pool } from "./pool.js";
import { fit, type Camera } from "./camera.js";
import * as core from "./core.js";
import type { Board, Size } from "./core.js";
import { clipped, message } from "./errors.js";
import type { Home } from "./platform.js";
import { shownAssets } from "./raster.js";
import type { Saving, Store } from "./save.js";

/** What the view does for a board as it shows, drawing it `Into` a renderer. */
export interface Host<Into> {
  opened(): Opened | undefined;
  /** Where the open board saves itself, which waits while an image is read. */
  saver(): (Pick<Saving, "during"> & { store: Pick<Store, "found"> }) | undefined;
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
  crossed(asset: string): boolean;
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
  /**
   * Reads again the images crossed out for their files, once the board shows and another program
   * changed those, and says which show again.
   */
  recheck(): Promise<void>;
  /** Why the asset's images show crossed out, as this board's showing found. */
  crossedOut(asset: string): string | undefined;
}

interface Wanted {
  asset: string;
  natural: Size;
}

type Crossed = "undecodable" | "unplayable" | "unloadable" | Unreadable["reason"] | "unread";

type Brought = "loaded" | "undrawn" | Crossed;

/** What another program may fix, by changing the file. */
const FILES: ReadonlySet<Crossed> = new Set(["missing", "pointer", "differs", "unread"]);

const MOST_NAME = 80;

/**
 * What the board's line says of the images crossed out, one, then many, in this order, then what
 * to do.
 */
const CROSSED: Record<Crossed, [string, string, string?]> = {
  undecodable: ["an image this machine cannot decode", "images this machine cannot decode"],
  unplayable: ["a video this machine cannot play", "videos this machine cannot play"],
  unloadable: ["an image this machine cannot show", "images this machine cannot show"],
  missing: ["an image whose file is missing", "images whose files are missing"],
  pointer: [
    "an image left as a Git LFS pointer",
    "images left as Git LFS pointers",
    "so run `git lfs pull`",
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
  const reasons = new Map<string, Crossed>();
  /** The stamps of their files, absent when missing, as last read or looked at. */
  const stamped = new Map<string, string | undefined>();
  let rechecking: Promise<void> | undefined;

  const crossOut = (into: Into, asset: string, why: Crossed) => {
    host.crossOut(into, asset);
    reasons.set(asset, why);
    if (why === "missing") {
      stamped.set(asset, undefined);
    }
  };

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
        crossOut(into, asset, read);
        return read;
      }
      if (decoded) {
        const taken = decoded;
        decoded = undefined;
        try {
          host.load(into, asset, taken, read);
          reasons.delete(asset);
          stamped.delete(asset);
          return "loaded";
        } catch (error) {
          // An upload the GPU refuses throws a plain error, anything else being the app's fault.
          if (!(error instanceof Error) || error.name !== "Error") {
            throw error;
          }
          console.warn(`Image ${asset} cannot show here:`, error);
          crossOut(into, asset, "unloadable");
          return "unloadable";
        }
      }
      const why = read.video ? "unplayable" : "undecodable";
      crossOut(into, asset, why);
      return why;
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
        crossOut(into, wanted.asset, "unread");
        failure = message(error);
      }
    }
    if (brought !== undefined && brought !== "loaded" && brought !== "undrawn") {
      failure = AGAIN[brought];
    }
    if (failure !== undefined) {
      const name = assetNames(board.board).get(wanted.asset) ?? core.assetPath(wanted.asset);
      host.say(`${named(name)} could not be read again: ${failure}`);
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

  const recheck = async () => {
    const current = shown;
    if (current === undefined || host.opened() !== current.board) {
      return;
    }
    const { board, into } = current;
    // Only a folder the app can stamp gains files, which a ZIP file or a folder read once cannot.
    if (!("stamps" in board.folder)) {
      return;
    }
    const folder = board.folder as Home;
    const live = () => shown === current && host.opened() === board && board.folder === folder;
    const sizes = assetSizes(board.board);
    const crossed = [...reasons]
      .filter(([asset, why]) => FILES.has(why) && sizes.has(asset) && host.crossed(asset))
      .map(([asset]) => asset);
    if (crossed.length === 0) {
      return;
    }
    const now = await folder.stamps(crossed.map(core.assetPath)).catch(() => undefined);
    if (now === undefined || !live()) {
      return;
    }
    // Before they are read, so that a change meanwhile is read next time.
    const changed = crossed.filter((asset) => {
      const stamp = now.get(core.assetPath(asset));
      const same = stamped.has(asset) && stamped.get(asset) === stamp;
      stamped.set(asset, stamp);
      return !same;
    });
    const saving = host.saver();
    const back = changed
      .map(core.assetPath)
      .filter((path) => board.missing.has(path) && now.has(path));
    // Once no save runs, as one may have taken them as lacking.
    const found = async () => {
      if (live()) {
        board.missing = new Set([...board.missing].filter((path) => !back.includes(path)));
        saving?.store.found(back);
      }
    };
    if (back.length > 0) {
      await (saving ? saving.during(found) : found());
    }
    const shows: string[] = [];
    const pending = changed.values();
    await pool(
      () => pending.next().value,
      async (asset) => {
        const wanted = { asset, natural: sizes.get(asset)! };
        if ((await bring(board, Promise.resolve(into), live, saving, wanted)) === "loaded") {
          shows.push(asset);
        }
      },
    );
    if (shows.length > 0 && live()) {
      const name = assetNames(board.board).get(shows[0]!) ?? core.assetPath(shows[0]!);
      host.say(
        shows.length === 1
          ? `${named(name)} shows again`
          : `${shows.length} images show again, the first ${named(name)}`,
      );
      host.redraw();
    }
  };

  return {
    async show(next, camera) {
      shown = undefined;
      unused.clear();
      reasons.clear();
      stamped.clear();
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
      const names = assetNames(next.board);
      const crossed = new Map<Crossed, string[]>();
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
          const name = names.get(wanted.asset) ?? core.assetPath(wanted.asset);
          crossed.set(brought, [...(crossed.get(brought) ?? []), name]);
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
    recheck() {
      rechecking ??= recheck().finally(() => (rechecking = undefined));
      return rechecking;
    },
    crossedOut(asset) {
      const why = reasons.get(asset);
      return why && AGAIN[why];
    },
  };
}

function told(crossed: ReadonlyMap<Crossed, string[]>): string[] {
  return Object.entries(CROSSED).flatMap(([why, [one, many, then]]) => {
    const names = crossed.get(why as Crossed) ?? [];
    names.forEach((name) => console.warn(`Crossed out, as ${name}: ${AGAIN[why as Crossed]}`));
    if (names.length === 0) {
      return [];
    }
    const first = named(names[0]!);
    const said =
      names.length === 1 ? `${one}, ${first}` : `${names.length} ${many}, the first ${first}`;
    return [then === undefined ? said : `${said}, ${then}`];
  });
}

function named(name: string): string {
  return `\`${clipped(name, MOST_NAME)}\``;
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
