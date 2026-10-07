// A board saving itself as it is edited: into the folder or the ZIP file it lives in, or into
// the app's session while it has neither, a moment after each change. A folder gets only the
// files whose bytes changed, and never loses what another program wrote there unasked.

import * as core from "./core.js";
import type { Bytes, Files, Snapshot } from "./core.js";
import { carried, retain, type Opened, type Reading, type Source } from "./board.js";
import { message } from "./errors.js";
import type { Folder, Home, ZipHome } from "./platform.js";
import { FILES_AT_ONCE, pool } from "./pool.js";
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
  save(snapshot: Snapshot, touched: string[], source: () => Source): Promise<boolean>;
  /** Writes the board of `snapshot` over whatever another program wrote. */
  overwrite(snapshot: Snapshot, source: () => Source): Promise<void>;
  /** Whether another program changed the board since the app read or last wrote it. */
  changed(): Promise<boolean>;
  free(): void;
}

/** The board in `home`, as read from it, or none yet. */
export async function folderStore(
  home: Home,
  reading: Reading | undefined,
  session: boolean,
): Promise<Store> {
  let known = reading ? core.known(reading.listed, reading.files) : new core.Known();
  // By path, as the app last read or wrote them.
  let stamps = new Map(session ? [] : reading?.stamps);
  // A session keeps no Git.
  let attributed = session;
  // A folder the board was read from holds the files it left out, which another one starts without.
  let holdsLeftOut = reading !== undefined;

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

  const together = async (files: [string, Bytes][]) => {
    const bytes = new Map(files);
    await home.writeAll(files, (path, stamp) => {
      stamps.set(path, stamp);
      known.wrote(path, bytes.get(path)!);
    });
  };

  /**
   * In the order that the core gives them, after the files a board folder starts with, which a
   * home only writes into a folder that lacks them. Each step lands before the next one starts.
   */
  const write = async (assets: string[], files: Files, deletions: string[], source: Source) => {
    if (!attributed) {
      for (const [path, bytes] of core.newFiles()) {
        await home.write(path, bytes);
      }
      attributed = true;
    }
    const lacking = new Set(source.lacking);
    for await (const batch of batches(
      assets.filter((asset) => !lacking.has(asset)),
      source,
    )) {
      await home.writeAll(batch, (path) => known.copied(path));
    }
    if (!holdsLeftOut) {
      for await (const batch of batches(await carried(source), source)) {
        await together(batch);
      }
      holdsLeftOut = true;
    }
    for (const step of steps(files)) {
      await together(step);
    }
    const pending = deletions.values();
    await pool(
      () => pending.next().value,
      async (path) => {
        await home.remove(path);
        known.deleted(path);
        stamps.delete(path);
      },
      FILES_AT_ONCE,
    );
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
      const { files, stamps: read } = await home.readAll(listed.filter(core.isBoardFile));
      known.free();
      known = core.known(listed, files);
      stamps = read;
      const plan = known.overwrite(snapshot, [...source().leftOut]);
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
      return (
        listed.length !== stamps.size ||
        listed.some((path) => !stamps.has(path)) ||
        changedAny(listed)
      );
    },
    free: () => known.free(),
  };
}

/** How many bytes of images a save holds at once, past which it writes them before reading more. */
const BATCH = 32 << 20;

/** The files at `paths` from `source`, read a batch at a time, each but a lone larger one under `BATCH`. */
async function* batches(paths: string[], source: Folder): AsyncGenerator<[string, Bytes][]> {
  let [batch, size] = [[] as [string, Bytes][], 0];
  for (const path of paths) {
    const bytes = await source.read(path);
    if (batch.length > 0 && size + bytes.length > BATCH) {
      yield batch;
      [batch, size] = [[], 0];
    }
    batch.push([path, bytes]);
    size += bytes.length;
    if (size >= BATCH) {
      yield batch;
      [batch, size] = [[], 0];
    }
  }
  if (batch.length > 0) {
    yield batch;
  }
}

/** The element files apart from the board's own, which the core's plan puts first or last. */
function steps(files: Files): [string, Bytes][][] {
  const split: [string, Bytes][][] = [];
  for (const file of files) {
    const last = split.at(-1);
    if (last !== undefined && core.isElementFile(file[0]) && core.isElementFile(last[0]![0])) {
      last.push(file);
    } else {
      split.push([file]);
    }
  }
  return split;
}

/**
 * The board `opened` in a ZIP file, which it reads from once rewritten. The file holds only the
 * assets the board shows, so those that undo or redo may bring back stay in memory.
 */
export function zipStore(zip: ZipHome, opened: Opened): Store {
  const rewrite = async (snapshot: Snapshot, source: () => Source, over: boolean) => {
    const { leftOut, lacking } = source();
    const holds = new Set(snapshot.zipPaths([...leftOut], [...lacking]));
    // While the file is as it was, as a rewrite moves what it held out of reach.
    await retain(opened, source(), (path) => holds.has(path));
    const rewriting = await zip.rewrite(over);
    if (rewriting === null) {
      return false;
    }
    await writeZip(snapshot, source(), rewriting.sink);
    const written = rewriting.written();
    if (written === null) {
      return false;
    }
    opened.folder = await zipFolder(written);
    return true;
  };
  return {
    session: false,
    delay: LATER,
    save: (snapshot, _, source) => rewrite(snapshot, source, false),
    async overwrite(snapshot, source) {
      // Its images from the file as another program left it, as where they lay may have moved.
      opened.folder = await zipFolder(await zip.reread());
      await rewrite(snapshot, source, true);
    },
    changed: () => zip.changed(),
    free() {},
  };
}

export interface SavingHooks {
  snapshot(): Snapshot;
  /** Where the board's images are read from, as it stands. */
  source(): Source;
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
  /**
   * Saves what is left at once, though edits made during its last pass wait as a timer's would.
   * Whether the board is all on disk afterwards.
   */
  flush(): Promise<boolean>;
  /**
   * Saves until nothing is left, once the reads under way end, as the saver is about to go. Whether
   * the board is all on disk afterwards.
   */
  drain(): Promise<boolean>;
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
  /** Woken once no read or check holds it. */
  let unheld: (() => void)[] = [];
  /** While a drain runs, which new reads wait for. */
  let draining: Promise<void> | undefined;
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
    let then: (() => Promise<void> | void) | undefined;
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
      then = () => fail(`it changed on disk, and could not be read again: ${message(error)}`);
    } finally {
      holding = false;
      release();
    }
    if (!stopped) {
      await then?.();
    }
  }

  function fail(reason: string): void {
    due = true;
    failure = reason;
    hooks.failed(reason);
  }

  function release(): void {
    if (held === 0 && !holding) {
      const waking = unheld;
      unheld = [];
      waking.forEach((wake) => wake());
    }
  }

  /** Once no save runs, as one ending may start another. */
  async function idle(): Promise<void> {
    // `start` sets it, and each run clears it as it ends.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (running) {
      await running;
    }
  }

  async function run(): Promise<void> {
    // Edits and `stop` set these while a save is awaited.
    // oxlint-disable-next-line no-unmodified-loop-condition
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
        failure = message(error);
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
      // Never below a drain's, which a flush meanwhile would cut short.
      flushed = Math.max(flushed, passes + 1);
      if (due && !holding && held === 0 && !stopped) {
        start();
      }
      await idle();
      return !due;
    },
    async drain() {
      let drained!: () => void;
      draining = new Promise((resolve) => (drained = resolve));
      try {
        // No read starts meanwhile, though a check may read the board again once it ends.
        // oxlint-disable-next-line no-unmodified-loop-condition
        while (held > 0 || holding) {
          await new Promise<void>((wake) => unheld.push(wake));
        }
        flushed = Infinity;
        if (due && !holding && !stopped) {
          start();
        }
        await idle();
        return !due;
      } finally {
        flushed = passes;
        draining = undefined;
        drained();
      }
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
        release();
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
      // Another drain may start as one ends.
      // oxlint-disable-next-line no-unmodified-loop-condition
      while (draining) {
        await draining;
      }
      held += 1;
      try {
        await idle();
        return await work();
      } finally {
        held -= 1;
        release();
      }
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await idle();
    },
  };
}

function same(a: Bytes, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}
