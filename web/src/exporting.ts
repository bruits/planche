// What the board exports: a ZIP file of all of it, and pictures of the selection as the board shows
// them, saved as PNG files or copied.

import { files, type Hold, type Opened } from "./board.js";
import type { Clipboard } from "./clipboard.js";
import type { Size } from "./core.js";
import type { Edits } from "./edit.js";
import type { ExportCard } from "./exportcard.js";
import type { Lifecycle } from "./lifecycle.js";
import { milliseconds, timed } from "./metrics.js";
import type { Media } from "./playback.js";
import type { Platform } from "./platform.js";
import { exported, pictureName, type Options } from "./render.js";
import type { Renderer } from "./renderer.js";
import { png } from "./still.js";
import type { Vectors } from "./vector.js";
import { writeZip } from "./zip.js";

export interface Host {
  platform: Pick<Platform, "pickExport">;
  opened(): Opened | undefined;
  hold(): Hold | undefined;
  /** Throws while the board opens. */
  ready(): Renderer;
  editing: Pick<Edits, "selection">;
  showsAnnotations(): boolean;
  life: Pick<Lifecycle, "saver" | "saved">;
  drawings: Vectors;
  crossedOut(): ReadonlySet<string>;
  /** Whether the renderer holds a texture or a drawing of the asset. */
  loaded(asset: string): boolean;
  media: Pick<Media<never>, "holds">;
  clip(): Pick<Clipboard, "copyImage">;
  pictureCard(): Pick<ExportCard, "close">;
  timings: Map<string, string>;
  /** `busy` while what it tells of goes on. */
  say(text: string, busy?: boolean): void;
  report(work: Promise<unknown>): void;
}

export interface Exporting {
  /**
   * Whether an export is under way, as on the desktop a second one to the same file would take over
   * the first one's draft.
   */
  busy(): boolean;
  zip(): Promise<void>;
  png(options: Options): Promise<void>;
  copyPng(options: Options): void;
}

interface Picture {
  blob: Blob;
  size: Size;
  /** Whether it is smaller than its images would have it. */
  capped: boolean;
}

export function exporting(host: Host): Exporting {
  const { platform, editing, life } = host;
  let busy = false;
  /** Copies as PNG asked for, so that one cancelled clears no later one's message. */
  let pngCopies = 0;

  /** The elements `ids` as the board shows them, the annotations if `shown`, as `options` frame them. */
  async function picture(
    held: Hold,
    ids: string[],
    options: Options,
    shown: boolean,
  ): Promise<Picture> {
    const scene = {
      opened: held.board,
      renderer: host.ready(),
      drawings: host.drawings,
      crossedOut: host.crossedOut(),
      background: getComputedStyle(document.body).backgroundColor,
    };
    const textures = { holds: host.loaded, plays: host.media.holds, current: held.shows };
    // Its images from where they lie once no save moves them.
    const draw = () => exported(scene, ids, textures, options, shown);
    const saver = life.saver();
    const { canvas, capped } = await (saver ? saver.during(draw) : draw());
    return {
      blob: await png(canvas),
      size: { width: canvas.width, height: canvas.height },
      capped,
    };
  }

  return {
    busy: () => busy,
    async zip() {
      const current = host.opened();
      if (current === undefined || busy) {
        return;
      }
      const { editor } = current;
      busy = true;
      const snapshot = editor.snapshot();
      try {
        const sink = await platform.pickExport(`${current.folder.name}.zip`, "zip");
        if (sink === null) {
          return;
        }
        host.say(`Exporting ${sink.name}…`, true);
        // Its images from where they lie once no save moves them.
        const write = () => writeZip(snapshot, files(current), sink);
        const saver = life.saver();
        const [count, writing] = await timed(() => (saver ? saver.during(write) : write()));
        host.timings.set(`export ${count} files`, milliseconds(writing));
        host.say(`Exported ${sink.name}`);
        life.saved(editor, snapshot);
      } finally {
        snapshot.free();
        busy = false;
      }
    },
    async png(options) {
      const held = host.hold();
      if (held === undefined) {
        return;
      }
      if (busy) {
        throw new Error("An export is under way");
      }
      // Before the user picks where, which would be in vain.
      host.ready();
      const ids = editing.selection();
      const shown = host.showsAnnotations();
      busy = true;
      try {
        const { board, folder } = held.board;
        const sink = await platform.pickExport(pictureName(board, ids, folder.name), "png");
        if (sink === null) {
          return;
        }
        host.say(`Exporting ${sink.name}…`, true);
        let made: Picture;
        try {
          if (!held.shows()) {
            throw new Error("Another board opened meanwhile");
          }
          made = await picture(held, ids, options, shown);
          await sink.append(new Uint8Array(await made.blob.arrayBuffer()));
        } catch (error) {
          await sink.discard().catch(() => {});
          throw error;
        }
        await sink.close();
        host.say(`Exported ${sink.name}, ${sized(made)}`);
        host.pictureCard().close();
      } finally {
        busy = false;
      }
    },
    copyPng(options) {
      const held = host.hold();
      if (held === undefined) {
        return;
      }
      pngCopies += 1;
      const copy = pngCopies;
      const made = picture(held, editing.selection(), options, host.showsAnnotations());
      const written = host.clip().copyImage(made.then(({ blob }) => blob));
      host.say("Copying as PNG…", true);
      host.report(
        (async () => {
          if (await written) {
            host.say(`Copied as PNG, ${sized(await made)}`);
          } else if (copy === pngCopies) {
            host.say("");
          }
        })(),
      );
    },
  };
}

function sized({ size, capped }: Picture): string {
  return `${size.width} × ${size.height}${capped ? ", scaled down to fit" : ""}`;
}
