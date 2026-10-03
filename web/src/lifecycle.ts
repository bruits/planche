// Which board the app shows from launch on, the one it left, a new one, or one opened in its
// place, and where each saves itself as it is edited, in its own folder or ZIP file, or the session.

import * as core from "./core.js";
import { files, open, untitled, type Opened, type Reading } from "./board.js";
import type { Camera } from "./camera.js";
import { message } from "./errors.js";
import { milliseconds, timed } from "./metrics.js";
import type { Folder, Home, Platform, Reopening, Session, ZipHome } from "./platform.js";
import { recall, remember } from "./preferences.js";
import { folderStore, saving, zipStore, type Reloaded, type Saving, type Store } from "./save.js";
import { zipFolder } from "./zip.js";

/** Where the browser remembers the name of the board in the session, and whether it is saved elsewhere. */
const SESSION = "planche.session";
const QUESTION = "This board isn't saved to a file yet. Leave it anyway?";

/** What the app around the board does for it. */
export interface Host {
  platform: Pick<
    Platform,
    "session" | "reopen" | "forget" | "open" | "openZip" | "pickTarget" | "confirm" | "markUnsaved"
  >;
  /** The board shown, which `show` replaces. */
  opened(): Opened | undefined;
  /** Shows a board just read, or throws why it cannot, such as an image unlike its digest. */
  show(next: Opened, camera?: Camera): Promise<void>;
  camera(): Camera | undefined;
  /** `busy` while what it tells of goes on. */
  say(text: string, busy?: boolean): void;
  loadingChanged(): void;
  /** The board's name changed, or whether leaving it would lose changes. */
  titleChanged(): void;
  timings: Map<string, string>;
}

export interface Lifecycle {
  /** Opens the board the app left, where it was saved, or else the one the session kept. */
  start(): Promise<void>;
  newBoard(): Promise<void>;
  openFolder(): Promise<void>;
  openZip(): Promise<void>;
  /** Into an empty folder, where the board saves itself from then on. */
  saveAs(): Promise<void>;
  /** Where the open board saves itself, `undefined` when nowhere. */
  saver(): Saving | undefined;
  touched(ids: string[]): void;
  /** The open board as written as `snapshot`, unless another board opened meanwhile, which freed `editor`. */
  saved(editor: core.Editor, snapshot: core.Snapshot): void;
  /** Edits come at every pointer move, but the host only hears when these change. */
  showSaved(): void;
  /** Whether a board is opening, which another may not meanwhile. */
  loading(): boolean;
  /** Whether the board holds changes that leaving it would lose. */
  unsaved(): boolean;
  /** Writes what is left before the app closes, and whether all of it is safe. */
  closing(): Promise<boolean>;
}

/** A board picked to open, and where it saves itself, unless in the session. */
interface Picked {
  folder: Folder;
  place?: Place | undefined;
}

/** Where a board saves itself, and reads from again. */
interface Place {
  store(next: Opened, reading: Reading): Promise<Store | undefined>;
  /** Missing for the session, which no other program writes. */
  again?(): Promise<Folder>;
  /** Reopened at launch from then on. */
  remember?: (() => Promise<void>) | undefined;
}

/** A board just read, before it shows. */
interface Read {
  opened: Opened;
  reading: Reading;
}

interface Settling {
  camera?: Camera | undefined;
  /** Whether the session lets go of the board it held. */
  clear?: boolean;
  /** Whether the user left the open board, which first saves edits made since. */
  leaving?: boolean;
}

/** What the session keeps besides the board. */
interface Kept {
  name: string;
  unsaved: boolean;
}

export function lifecycle(host: Host): Lifecycle {
  const { platform, timings } = host;
  let autosave: Saving | undefined;
  /** Where a board without a folder or a file of its own is kept, `null` when nowhere. */
  let session: Session | null = null;
  /** The session held, whose board could not be read, until the user leaves the open one. */
  let unreadable: Session | null = null;
  let unsaved = false;
  /** Whether the board holds changes not yet on disk, so that closing the app first writes them. */
  let unwritten = false;
  /**
   * Two boards opening at once would free each other's editor. The first one opens once the core
   * starts, which nothing may use before.
   */
  let loading = true;

  const fail = (error: unknown) => host.say(message(error));

  /** `restored` when the board was read from it. */
  function sessionPlace(restored: boolean): Place {
    return {
      store: async (_, reading) =>
        session ? folderStore(session, restored ? reading : undefined, true) : undefined,
    };
  }

  async function pickedFolder(): Promise<Picked | null> {
    const folder = await platform.open();
    return folder && { folder, place: "write" in folder ? homePlace(folder) : undefined };
  }

  async function pickedZip(): Promise<Picked | null> {
    const file = await platform.openZip();
    return file && { folder: await zipFolder(file), place: file.home && zipPlace(file.home) };
  }

  async function opening(work: () => Promise<void>): Promise<void> {
    loading = true;
    host.loadingChanged();
    try {
      await work();
    } finally {
      loading = false;
      host.loadingChanged();
    }
  }

  async function start(): Promise<void> {
    session = await platform.session().catch((error: unknown) => {
      fail(error);
      return null;
    });
    const last = await platform.reopen().catch(() => null);
    // A board saved nowhere else comes first, as the one remembered stays on disk.
    let kept = session !== null && recallSession().unsaved ? await restore(session) : undefined;
    if (kept === undefined || kept === "none") {
      if (
        last !== null &&
        "folder" in last &&
        (await resume(() => last.folder, homePlace(last.folder)))
      ) {
        return;
      }
      if (
        last !== null &&
        "zip" in last &&
        (await resume(() => zipFolder(last.zip), zipPlace(last.zip.home!)))
      ) {
        return;
      }
      kept = session === null ? undefined : await restore(session);
    }
    if (kept !== "restored") {
      if (kept instanceof Error) {
        // Left as it was, as it is the board's only copy.
        unreadable = session;
        session = null;
      }
      // Remembered still, should the user not click this time.
      await begin(last !== null && "ask" in last);
    }
    if (kept instanceof Error) {
      host.say(
        `The board kept from last time could not be read, and stays as it was until another board opens or a new one starts: ${kept.message}`,
      );
    } else if (session === null) {
      host.say(
        "This window keeps no board for next time, as another one does or the browser cannot",
      );
    }
    if (last !== null && "ask" in last) {
      offer(last);
    }
  }

  /** Whether the board remembered opened, which is forgotten otherwise. */
  async function resume(folder: () => Promise<Folder> | Folder, place: Place): Promise<boolean> {
    try {
      const read = await open(async () => folder(), timings);
      if (read !== null) {
        await settle(read, place);
        return true;
      }
    } catch (error) {
      host.say(`Planche could not open the last board again: ${message(error)}`);
    }
    if (session !== null) {
      await platform.forget();
    }
    return false;
  }

  /** The board the session kept, opened as it was left, or why it could not open. */
  async function restore(from: Session): Promise<"restored" | "none" | Error> {
    const kept = recallSession();
    try {
      if (!(await from.list(1)).some(core.isBoardFile)) {
        return "none";
      }
      const read = await open(async () => ({ ...from, name: kept.name }), timings);
      if (read === null) {
        return "none";
      }
      if (kept.unsaved) {
        // Against an empty board, as its changes are saved nowhere else.
        const empty = new core.Editor();
        const snapshot = empty.snapshot();
        read.opened.editor.markSaved(snapshot);
        snapshot.free();
        empty.free();
      }
      await settle(read, sessionPlace(true));
      return "restored";
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** A new board, kept in the session, which the next launch opens unless `keepLast`. */
  async function begin(keepLast = false): Promise<void> {
    const blank = untitled();
    const reading = { listed: [], files: new Map(), stamps: new Map() };
    await settle({ opened: blank, reading }, sessionPlace(false), { clear: true, leaving: true });
    await reopenNext(keepLast ? null : undefined, blank.folder.name);
  }

  /**
   * What the next launch opens, `place`, or else the session, which only the window holding the
   * session decides. `null` keeps the board remembered as it is.
   */
  async function reopenNext(place: Place | null | undefined, name: string): Promise<void> {
    if (session !== null) {
      rememberSession({ name, unsaved: false });
      if (place !== null) {
        await (place?.remember ?? platform.forget)();
      }
    }
  }

  /** The remembered folder, which the browser only lets the page write to again after a click. */
  function offer(last: Extract<Reopening, { ask(): unknown }>): void {
    host.say(`Click anywhere to open ${last.name} again`, true);
    addEventListener(
      "pointerdown",
      // Asked within the click, before anything awaits.
      () =>
        void opening(async () => {
          const home = await last.ask();
          host.say("");
          if (home !== null && (await leave())) {
            const read = await open(async () => home, timings);
            if (read !== null) {
              await moveIn(read, homePlace(home));
            }
          }
        }).catch(fail),
      { once: true, capture: true },
    );
  }

  /** Whether another board may take the open one's place, which then takes the session back to empty it. */
  async function leave(): Promise<boolean> {
    await autosave?.drain();
    if (atRisk() && !(await platform.confirm(QUESTION))) {
      return false;
    }
    if (unreadable !== null) {
      session = unreadable;
      unreadable = null;
    }
    return true;
  }

  async function newBoard(): Promise<void> {
    await opening(async () => {
      if (await leave()) {
        await begin();
      }
    });
  }

  async function openBoard(pick: () => Promise<Picked | null>): Promise<void> {
    await opening(async () => {
      let place: Place | undefined;
      // Asked once picked, since a browser only opens a picker right after a click.
      const read = await open(async () => {
        const picked = await pick();
        if (picked === null || !(await leave())) {
          return null;
        }
        place = picked.place;
        return picked.folder;
      }, timings);
      if (read !== null) {
        await moveIn(read, place);
      }
    });
  }

  /** Shows a board just opened, which saves itself in its own place, or else in the session. */
  async function moveIn(read: Read, place: Place | undefined): Promise<void> {
    try {
      await settle(read, place ?? sessionPlace(false), { clear: true, leaving: true });
    } catch (error) {
      await replace(read.opened);
      throw error;
    }
    await reopenNext(place, read.opened.folder.name);
    if (place === undefined) {
      // A copy, as its files may be gone next time, such as those a browser lets a page read.
      autosave?.touched(Object.keys(read.opened.board.elements));
    }
  }

  /**
   * Shows a board just read, which saves itself into `place` from then on. The board it replaces
   * saves itself on until then.
   */
  async function settle(
    { opened: next, reading }: Read,
    place: Place,
    { camera, clear, leaving }: Settling = {},
  ): Promise<void> {
    const store = await place.store(next, reading);
    const old = autosave;
    if (leaving) {
      await old?.drain();
    }
    autosave = undefined;
    await old?.stop();
    old?.store.free();
    try {
      if (clear) {
        await session?.clear();
      }
    } catch (error) {
      store?.free();
      showSaved();
      throw error;
    }
    autosave = store && autosaving(next, store, place);
    try {
      await host.show(next, camera);
    } catch (error) {
      // A board that does not show is not open, so it saves nothing more.
      const failed = autosave;
      autosave = undefined;
      await failed?.stop();
      failed?.store.free();
      throw error;
    }
    const strays = reading.listed.filter(core.isStrayElement);
    if (strays.length > 0) {
      host.say(
        `Left out ${strays.join(", ")}, which no element owns, such as a sync tool's conflicted copy`,
      );
    }
  }

  function autosaving(next: Opened, store: Store, place: Place): Saving {
    const { editor } = next;
    const current = () => host.opened()?.editor === editor;
    return saving(store, {
      snapshot: () => editor.snapshot(),
      // As it stands, as rewriting a ZIP file moves where its images lie.
      source: () => files(next),
      saved(snapshot) {
        if (current()) {
          // The session keeps the board, but it is still saved nowhere else.
          if (!store.session) {
            editor.markSaved(snapshot);
          }
          showSaved();
        }
      },
      failed(reason) {
        if (current()) {
          host.say(`Not saved into ${next.folder.name}: ${reason}`);
          showSaved();
        }
      },
      conflict: () =>
        platform.confirm(
          `${next.folder.name} changed on disk. Read it again, and lose the changes made here? Otherwise they are written over it.`,
          ["Read it again", "Keep mine"],
        ),
      // Not while another board opens, which takes its place anyway.
      reload: async (may) => (current() && !loading ? reload(place, may) : "refused"),
    });
  }

  /**
   * The board as another program changed it, as the camera left it, if it still `may` take the
   * open one's place once read.
   */
  async function reload(place: Place, may: () => boolean): Promise<Reloaded> {
    let reloaded: Reloaded = "refused";
    await opening(async () => {
      const camera = host.camera();
      const read = place.again && (await open(() => place.again!(), timings));
      if (read && !may()) {
        read.opened.editor.free();
        reloaded = "declined";
      } else if (read) {
        const { name } = read.opened.folder;
        try {
          await settle(read, place, { camera });
          host.say(`${name} changed on disk, so it was read again`);
        } catch (error) {
          if (!(await replace(read.opened))) {
            throw error;
          }
          host.say(`${name} changed on disk, and could not be read again: ${message(error)}`);
        }
        reloaded = "replaced";
      }
    });
    return reloaded;
  }

  /**
   * A new board in place of `failed`, if it took the open board's place before failing to show,
   * as the board it replaced is gone. Whether it did.
   */
  async function replace(failed: Opened): Promise<boolean> {
    if (host.opened() !== failed) {
      return false;
    }
    await begin();
    return true;
  }

  function atRisk(): boolean {
    const opened = host.opened();
    if (opened === undefined) {
      return false;
    }
    return autosave === undefined || autosave.store.session
      ? !opened.editor.isSaved()
      : autosave.unwritten();
  }

  async function saveAs(): Promise<void> {
    const current = host.opened();
    if (current === undefined) {
      return;
    }
    const { editor } = current;
    // Before anything awaits, as a browser only opens a picker right after a click.
    const target = await platform.pickTarget();
    if (target === null) {
      return;
    }
    await autosave?.flush();
    const store = await folderStore(target, undefined, false);
    // Editing goes on while the files are written, and another board may even open.
    const snapshot = editor.snapshot();
    const written = Object.keys(current.board.elements);
    try {
      const write = async () => {
        for (const [path, bytes] of core.newFiles()) {
          await target.write(path, bytes);
        }
        if (!(await store.save(snapshot, written, () => files(current)))) {
          throw new Error(`${target.name} is no longer empty`);
        }
      };
      const [, writing] = await timed(() => (autosave ? autosave.during(write) : write()));
      timings.set("save as", milliseconds(writing));
      if (host.opened() !== current) {
        store.free();
        return;
      }
      const old = autosave;
      autosave = undefined;
      await old?.stop();
      old?.store.free();
      current.folder = target;
      const place = homePlace(target);
      autosave = autosaving(current, store, place);
      saved(editor, snapshot);
      // Edits made while it was written, deletions included.
      autosave.touched([...written, ...Object.keys(current.board.elements)]);
      host.titleChanged();
      host.say(`Saved as ${target.name}, where it saves itself from now on`);
      await reopenNext(place, target.name);
      if (old?.store.session) {
        await session?.clear();
      }
    } catch (error) {
      if (autosave?.store !== store) {
        store.free();
      }
      throw error;
    } finally {
      snapshot.free();
    }
  }

  function saved(editor: core.Editor, snapshot: core.Snapshot): void {
    if (host.opened()?.editor === editor) {
      editor.markSaved(snapshot);
      showSaved();
    }
  }

  function showSaved(): void {
    const risk = atRisk();
    if (risk !== unsaved) {
      unsaved = risk;
      host.titleChanged();
      if (autosave?.store.session) {
        rememberSession({ ...recallSession(), unsaved });
      }
    }
    const opened = host.opened();
    const waiting =
      opened !== undefined && (autosave ? autosave.unwritten() : !opened.editor.isSaved());
    if (waiting !== unwritten) {
      unwritten = waiting;
      platform.markUnsaved(unwritten);
    }
  }

  return {
    start: () => opening(start),
    newBoard,
    openFolder: () => openBoard(pickedFolder),
    openZip: () => openBoard(pickedZip),
    saveAs,
    saver: () => autosave,
    touched(ids) {
      autosave?.touched(ids);
      showSaved();
    },
    saved,
    showSaved,
    loading: () => loading,
    unsaved: () => unsaved,
    closing: async () => (autosave ? autosave.drain() : !unwritten),
  };
}

function homePlace(home: Home): Place {
  return {
    store: (_, reading) => folderStore(home, reading, false),
    again: async () => home,
    remember: home.remember,
  };
}

function zipPlace(zip: ZipHome): Place {
  return {
    async store(next) {
      // As read again, should another program have changed it.
      await zip.adopt();
      return zipStore(zip, (folder) => {
        next.folder = folder;
      });
    },
    again: async () => zipFolder(await zip.reread()),
    remember: () => zip.remember(),
  };
}

function recallSession(): Kept {
  try {
    const kept = JSON.parse(recall(SESSION) ?? "") as Partial<Kept>;
    return {
      name: typeof kept.name === "string" ? kept.name : "Untitled",
      unsaved: kept.unsaved === true,
    };
  } catch {
    return { name: "Untitled", unsaved: false };
  }
}

function rememberSession(kept: Kept): void {
  remember(SESSION, JSON.stringify(kept));
}
