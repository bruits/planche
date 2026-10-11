// What the board takes in: images side by side, elements pasted or duplicated, each as one edit that
// selects them, with their images loaded as soon as each is decoded.

import type { Incoming } from "./add.js";
import {
  assetSizes,
  centring,
  copiedAssets,
  duplicateOffset,
  imageKind,
  newId,
  prepare,
  release,
  renamed,
  row,
  type Added,
  type Decoded,
  type Hold,
  type Opened,
} from "./board.js";
import { onScreen, toBoard } from "./camera.js";
import type { Pasted } from "./clipboard.js";
import * as core from "./core.js";
import type { Copied, Point, Rect, Size } from "./core.js";
import type { Edits } from "./edit.js";
import { message } from "./errors.js";
import { timed } from "./metrics.js";
import { testPhotos } from "./photos.js";
import { pool } from "./pool.js";
import { TEXTURE_SIDE } from "./raster.js";
import type { Renderer } from "./renderer.js";
import type { View } from "./view.js";

/** Left around images added, in CSS pixels, past the zones outside their corners that turn them. */
const ADDED_MARGIN = 48;
/** How far right and down a duplicate lies from what it copies, at least, in CSS pixels. */
const DUPLICATE_OFFSET = 16;

export interface Host {
  hold(): Hold | undefined;
  renderer(): Renderer | undefined;
  /** Bitmaps to `into`, which takes them over, and SVGs to rasterise as they show. */
  load(into: Renderer, decoded: Map<string, Decoded>): void;
  /** Hands the images to the board `target`, whose renderer takes what is decoded of them. */
  keep(target: Opened, added: Added[]): void;
  /** The size of the asset's texture, when the renderer holds one already, which needs no decoding. */
  heldSize(asset: string): Size | undefined;
  editing: Pick<Edits, "idle" | "apply" | "select" | "selection" | "entered">;
  viewport: Pick<View, "zoom" | "camera" | "size" | "centre">;
  /**
   * The band of the window between the handle and the toolbar, in CSS pixels from its top, where
   * images added show.
   */
  between(): { top: number; bottom: number };
  savesToFiles(): boolean;
  stopped(): boolean;
  /** `busy` while what it tells of goes on. */
  say(text: string, busy?: boolean): void;
  /** The row `name` of the measurements, which the next draw ends, from `since`. */
  drawn(name: string, since: number): void;
}

export interface Adding {
  /** Side by side around `at`, at their natural size unless they would not show whole, and as one edit. */
  images(incoming: Promise<Incoming[]>, at: Point): Promise<void>;
  /**
   * Centred on `at` by whole steps of the grid, as one edit that selects them. Images whose assets
   * the board lacks take them from the bytes copied, or are left out without them, as when copied
   * in another window.
   */
  paste(pasted: Pasted, at: Point): Promise<void>;
  /** The selection again, right and down of it, as one edit that selects it. */
  duplicate(): void;
  /**
   * Into the board shown when asked, as `images` adds, unless it saves into a folder or a file once
   * they are made. A Save as while they are prepared still lets them in, as one right after they are
   * added would.
   */
  testPhotos(count: number): Promise<void>;
}

export function adding(host: Host): Adding {
  const { editing, viewport } = host;

  /** At once, so that bitmaps do not pile up. */
  function loadAtOnce(one: Added, held: Hold | undefined): void {
    const into = host.renderer();
    if (one.decoded && into && held?.shows()) {
      host.load(into, new Map([[one.asset, one.decoded]]));
      one.decoded = undefined;
    }
  }

  /** Into the group gone into, moved by what `by` gives for its extent, as one edit that selects it. */
  function placeCopy(copied: Copied, by: (extent: Rect) => Point): void {
    const group = editing.entered();
    let pasted: string[] = [];
    editing.apply((editor, touched) => {
      const ids = renamed(copied);
      touched.push(...core.paste(editor, copied, ids, group));
      pasted = core.outermost(editor, ids, group);
      const area = core.extent(editor, pasted);
      if (area) {
        touched.push(...core.transform(editor, pasted, { place: { by: by(area) } }));
      }
    });
    editing.select(pasted);
  }

  /** What of the board shows between the handle and the toolbar, less a margin, `undefined` when none of it shows. */
  function room(): Rect | undefined {
    const camera = viewport.camera();
    if (camera === undefined) {
      return undefined;
    }
    const { width, height } = viewport.size();
    const { top, bottom } = host.between();
    const under = toBoard(camera, { x: 0, y: top });
    const shown = onScreen(
      { ...camera, y: under.y },
      { width, height: Math.min(height, bottom) - top },
    );
    if (shown.width <= 0 || shown.height <= 0) {
      return undefined;
    }
    const margin = Math.min(ADDED_MARGIN / camera.zoom, Math.min(shown.width, shown.height) / 10);
    return {
      x: shown.x + margin,
      y: shown.y + margin,
      width: shown.width - 2 * margin,
      height: shown.height - 2 * margin,
    };
  }

  async function images(incoming: Promise<Incoming[]>, at: Point): Promise<void> {
    const held = host.hold();
    // By where each came, which they are laid out in.
    const prepared: (Added | undefined)[] = [];
    const notAdded: (string | undefined)[] = [];
    const read = await incoming;
    // Once read, as the user's pace and the platform's reading are not the app's.
    const since = performance.now();
    const pending = read.entries();
    let done = 0;
    await pool(
      () => pending.next().value,
      async ([index, image]) => {
        try {
          if ("failure" in image) {
            notAdded[index] = `${image.name}: ${image.failure}`;
            return;
          }
          const one: Added = {
            ...(await prepare(image.bytes, TEXTURE_SIDE, host.heldSize)),
            filename: image.filename,
            source: image.source,
          };
          loadAtOnce(one, held);
          prepared[index] = one;
        } catch (error) {
          notAdded[index] = `${image.name}: this app cannot open it here (${message(error)})`;
        } finally {
          done += 1;
          if (read.length > 1) {
            host.say(`Adding ${done} of ${read.length} images…`, true);
          }
        }
      },
    );
    const added = prepared.filter((one) => one !== undefined);
    // Nor the time an edit under way takes to end.
    const [, waited] = await timed(() => editing.idle());
    if (added.length > 0 && held?.shows() && !host.stopped()) {
      host.keep(held.board, added);
      const frames = row(
        added.map(({ natural }) => natural),
        at,
        room(),
      );
      const ids = added.map(() => newId());
      // Into the group gone into, where they stay selected.
      const group = editing.entered();
      editing.apply((editor, touched) =>
        added.forEach(({ asset, natural, filename, source }, index) => {
          touched.push(
            ...editor.add(
              ids[index]!,
              group,
              JSON.stringify(imageKind(asset, natural, frames[index]!, { filename, source })),
            ),
          );
        }),
      );
      editing.select(ids);
      host.drawn(`add ${added.length} images`, since + waited);
    } else {
      added.forEach(({ decoded }) => release(decoded));
    }
    const failed = notAdded.filter((failure) => failure !== undefined);
    if (failed.length > 0) {
      host.say(`Not added, ${failed.join("; ")}`);
    } else if (read.length > 1) {
      host.say("");
    }
  }

  return {
    images,
    async paste({ copied, assets }, at) {
      const held = host.hold();
      if (held === undefined) {
        return;
      }
      const target = held.board;
      const shown = assetSizes(target.board);
      const lacking = copiedAssets(copied).filter((asset) => !shown.has(asset));
      const bytes = lacking.length > 0 ? await assets(lacking) : new Map<string, Blob>();
      const prepared: Added[] = [];
      const pending = lacking.values();
      await pool(
        () => pending.next().value,
        async (asset) => {
          const blob = bytes.get(asset);
          const one =
            blob && (await prepare(blob, TEXTURE_SIDE, host.heldSize).catch(() => undefined));
          if (one?.asset === asset) {
            loadAtOnce(one, held);
            prepared.push(one);
          } else {
            release(one?.decoded);
          }
        },
      );
      await editing.idle();
      const zoom = viewport.zoom();
      if (!held.shows() || zoom === undefined || host.stopped()) {
        prepared.forEach(({ decoded }) => release(decoded));
        return;
      }
      host.keep(target, prepared);
      const kept = [...assetSizes(target.board).keys(), ...prepared.map(({ asset }) => asset)];
      const pasting = core.keeping(copied, kept);
      if (Object.keys(pasting.elements).length > 0) {
        placeCopy(pasting, (area) => centring(area, at, zoom));
      }
      if (Object.keys(pasting.elements).length < Object.keys(copied.elements).length) {
        host.say("Not pasted, the images whose files are out of reach here");
      }
    },
    duplicate() {
      const held = host.hold();
      const zoom = viewport.zoom();
      if (held === undefined || zoom === undefined) {
        return;
      }
      const by = duplicateOffset(zoom, DUPLICATE_OFFSET);
      placeCopy(core.copy(held.board.editor, editing.selection()), () => ({ x: by, y: by }));
    },
    async testPhotos(count) {
      const at = viewport.centre();
      if (at === undefined) {
        return;
      }
      const photos = testPhotos(count, (done) =>
        host.say(`Making test photos, ${done} of ${count}…`, true),
      );
      await images(
        photos.then((made) => {
          if (!host.savesToFiles()) {
            return made;
          }
          host.say("Not added, as the board now saves into a folder or a ZIP file");
          return [];
        }),
        at,
      );
    },
  };
}
