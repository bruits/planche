// A board saving itself as it is edited: into the folder or the ZIP file it lives in, or into
// the app's session while it has neither, a moment after each change. A folder gets only the
// files whose bytes changed, and never loses what another program wrote there unasked.

import * as core from "./core.js";
import type { Bytes, Files, Snapshot } from "./core.js";
import type { Reading } from "./board.js";
import type { Folder, Home, ZipHome } from "./platform.js";
import { writeZip, zipFolder } from "./zip.js";

/** After the last change, in milliseconds. */
const SOON = 1000;
/** A ZIP file is written whole each time. */
const LATER = 10_000;
/** After the first change, or the end of the save it came during, however long the edits go on. */
const AT_LATEST = 10_000;

/** Where a board saves itself. */
export interface Store {
  /** The app's own folder, which no other program writes. */
  session: boolean;
  /** How long after the last change it saves, in milliseconds. */
  delay: number;
  /**
   * Writes the board of `snapshot`, where `touched` names at least the elements changed since the
   * last save, and its images from `source`. `false`, writing nothing, when another program
   * changed what it would write over.
   */
  save(snapshot: Snapshot, touched: string[], source: () => Folder): Promise<boolean>;
  /** Writes the board of `snapshot` over whatever another program wrote. */
  overwrite(snapshot: Snapshot, source: () => Folder): Promise<void>;
  /** Whether another program changed the board since the app read or last wrote it. */
  changed(): Promise<boolean>;
  free(): void;
}

/** The board in `home`, as read from it, or none yet. */
export async function folderStore(home: Home, reading: Reading | undefined, session: boolean): Promise<Store> {
  let known = reading ? core.known(reading.listed, reading.files) : new core.Known();
  // By path, as the app last read or wrote them.
  let stamps = new Map(session ? [] : reading?.stamps);

  const changedAny = async (paths: string[]) => {
    if (session) {
      return false;
    }
    const now = await home.stamps(paths);
    for (const path of paths) {
      const theirs = now.get(path);
      if (theirs === stamps.get(path)) {
        continue;
      }
      const ours = known.bytes(path);
      if (theirs === undefined || ours === undefined || !same(await home.read(path), ours)) {
        return true;
      }
      // Written again, but alike.
      stamps.set(path, theirs);
    }
    return false;
  };

  /** In the order that the core gives them. */
  const write = async (assets: string[], files: Files, deletions: string[], source: Folder) => {
    for (const path of assets) {
      await home.write(path, await source.read(path));
      known.copied(path);
    }
    for (const [path, bytes] of files) {
      stamps.set(path, await home.write(path, bytes));
      known.wrote(path, bytes);
    }
    for (const path of deletions) {
      await home.remove(path);
      known.deleted(path);
      stamps.delete(path);
    }
  };

  return {
    session,
    delay: SOON,
    async save(snapshot, touched, source) {
      const plan = known.save(snapshot, touched);
      try {
        const files = plan.files() as Files;
        const deletions = plan.deletions();
        if (await changedAny([...files.keys(), ...deletions])) {
          return false;
        }
        await write(plan.assets(), files, deletions, source());
        return true;
      } finally {
        plan.free();
      }
    },
    async overwrite(snapshot, source) {
      const listed = await home.list(core.fileDepth());
      const board = listed.filter(core.isBoardFile);
      // Before reading, as `open` does.
      const read = await home.stamps(board);
      const files: Files = new Map();
      for (const path of board) {
        files.set(path, await home.read(path));
      }
      known.free();
      known = core.known(listed, files);
      stamps = read;
      const plan = known.overwrite(snapshot);
      try {
        await write(plan.assets(), plan.files() as Files, plan.deletions(), source());
      } finally {
        plan.free();
      }
    },
    async changed() {
      if (session) {
        return false;
      }
      const listed = (await home.list(core.fileDepth())).filter(core.isBoardFile);
      return listed.length !== stamps.size || listed.some((path) => !stamps.has(path)) || changedAny(listed);
    },
    free: () => known.free(),
  };
}

/** The board in a ZIP file, which reads from `moved` once rewritten. */
export function zipStore(zip: ZipHome, moved: (folder: Folder) => void): Store {
  const rewrite = async (snapshot: Snapshot, source: () => Folder, over: boolean) => {
    const rewriting = await zip.rewrite(over);
    if (rewriting === null) {
      return false;
    }
    await writeZip(snapshot, source(), rewriting.sink);
    const written = rewriting.written();
    if (written === null) {
      return false;
    }
    moved(await zipFolder(written));
    return true;
  };
  return {
    session: false,
    delay: LATER,
    save: (snapshot, _, source) => rewrite(snapshot, source, false),
    async overwrite(snapshot, source) {
      // Its images from the file as another program left it, as where they lay may have moved.
      moved(await zipFolder(await zip.reread()));
      await rewrite(snapshot, source, true);
    },
    changed: () => zip.changed(),
    free() {},
  };
}

export interface SavingHooks {
  snapshot(): Snapshot;
  /** Where the board's images are read from, as it stands. */
  source(): Folder;
  saved(snapshot: Snapshot): void;
  failed(reason: string): void;
  /**
   * Once another program changed the board while it holds changes of its own, whether to read
   * it again and lose those.
   */
  conflict(): Promise<boolean>;
  /** Reads the board again, as another program changed it, then takes this one's place if it still `may`. */
  reload(may: () => boolean): Promise<Reloaded>;
}

/** Whether a board read again took the open one's place, which `may` declined, or nothing read it. */
export type Reloaded = "replaced" | "declined" | "refused";

export interface Saving {
  store: Store;
  /** Once an edit touched these elements, or the background. */
  touched(ids: string[]): void;
  /** Saves what is left at once. Whether the board is all on disk afterwards. */
  flush(): Promise<boolean>;
  /** Whether changes wait to be written, or failed to be. */
  unwritten(): boolean;
  /** Why the last save failed, until one succeeds. */
  failure(): string | undefined;
  /**
   * Reads the board again once another program changed it, unless it holds changes of its own,
   * when `conflict` decides. Nothing while it saves, which checks the files it writes anyway.
   */
  check(): Promise<void>;
  /** Writes nothing while `work` reads the board's files, which a save may move. */
  during<T>(work: () => Promise<T>): Promise<T>;
  /** For good, once the save under way ends, as another board takes this one's place. */
  stop(): Promise<void>;
}

export function saving(store: Store, hooks: SavingHooks): Saving {
  const { delay } = store;
  const dirty = new Set<string>();
  let due = false;
  /** While a save writes what it took from `dirty`. */
  let writing = false;
  let overwriting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let since: number | undefined;
  let running: Promise<void> | undefined;
  /** While it checks the disk or reads the board again, when it writes nothing. */
  let holding = false;
  /** How many reads of the board's files it waits on, see `during`. */
  let held = 0;
  /** Asked for while saving, and only done once the save ends. */
  let rereading = false;
  let failure: string | undefined;
  let stopped = false;
  let passes = 0;
  /** The pass the last flush waits for. */
  let flushed = 0;

  const schedule = (wait: number) => {
    clearTimeout(timer);
    timer = setTimeout(start, wait);
  };
  function start(): void {
    // The save under way writes again at once for a flush, or waits as it ends.
    if (running) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    since = undefined;
    if (holding || held > 0) {
      schedule(delay);
      return;
    }
    running ??= run().finally(() => {
      running = undefined;
      if (rereading) {
        rereading = false;
        void reread(false);
      }
    });
  }

  /**
   * Unless the board read again takes this one's place, its changes wait, at risk. One read again
   * as it was `clean`, but edited meanwhile, meets the other program's changes after all.
   */
  async function reread(clean: boolean): Promise<void> {
    holding = true;
    let then: () => Promise<void> | void = () => {};
    try {
      const reloaded = await hooks.reload(() => !clean || !due);
      if (reloaded === "replaced") {
        stopped = true;
      } else if (reloaded === "refused") {
        // Read again only as clean, which a later check tries again.
        if (!clean) {
          then = () => fail("it changed on disk");
        }
      } else if (await hooks.conflict()) {
        // Asked while nothing saves, as the edits made meanwhile meet the program's after all.
        then = () => reread(false);
      } else {
        then = () => {
          overwriting = true;
          due = true;
          start();
        };
      }
    } catch (error) {
      then = () =>
        fail(`it changed on disk, and could not be read again: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      holding = false;
    }
    if (!stopped) {
      await then();
    }
  }

  function fail(reason: string): void {
    due = true;
    failure = reason;
    hooks.failed(reason);
  }

  async function run(): Promise<void> {
    while (due && !stopped) {
      due = false;
      passes += 1;
      clearTimeout(timer);
      timer = undefined;
      since = undefined;
      writing = true;
      const touched = [...dirty];
      dirty.clear();
      const over = overwriting;
      overwriting = false;
      const snapshot = hooks.snapshot();
      const keep = () => {
        touched.forEach((id) => dirty.add(id));
        due = true;
        overwriting ||= over;
      };
      try {
        if (over) {
          await store.overwrite(snapshot, hooks.source);
        } else if (!(await store.save(snapshot, touched, hooks.source))) {
          if (stopped || (await hooks.conflict())) {
            keep();
            rereading = !stopped;
            return;
          }
          await store.overwrite(snapshot, hooks.source);
        }
        writing = false;
        failure = undefined;
        hooks.saved(snapshot);
      } catch (error) {
        // Tried again once edited or flushed, as trying on its own could ask again and again.
        keep();
        writing = false;
        failure = error instanceof Error ? error.message : String(error);
        hooks.failed(failure);
        return;
      } finally {
        writing = false;
        snapshot.free();
      }
      // Edits made meanwhile wait as if made now, or saves would follow one another while they go on.
      if (due && passes >= flushed && !stopped) {
        since = Date.now();
        schedule(delay);
        return;
      }
    }
  }

  return {
    store,
    touched(ids) {
      if (stopped) {
        return;
      }
      ids.forEach((id) => dirty.add(id));
      due = true;
      const now = Date.now();
      since ??= now;
      schedule(Math.max(0, Math.min(delay, since + AT_LATEST - now)));
    },
    async flush() {
      flushed = passes + 1;
      if (due && !holding && held === 0 && !stopped) {
        start();
      }
      while (running) {
        await running;
      }
      return !due;
    },
    unwritten: () => due || writing,
    failure: () => failure,
    async check() {
      if (stopped || store.session || running || holding) {
        return;
      }
      holding = true;
      let clean = false;
      let reading = false;
      try {
        if (!(await store.changed()) || stopped) {
          return;
        }
        clean = !due && failure === undefined;
        reading = clean || (await hooks.conflict());
        if (!reading && !stopped) {
          overwriting = true;
          due = true;
        }
      } finally {
        holding = false;
      }
      if (stopped) {
        return;
      }
      if (reading) {
        await reread(clean);
      } else {
        start();
      }
    },
    async during(work) {
      held += 1;
      try {
        while (running) {
          await running;
        }
        return await work();
      } finally {
        held -= 1;
      }
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      while (running) {
        await running;
      }
    },
  };
}

function same(a: Bytes, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}
