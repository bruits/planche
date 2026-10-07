import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { files as filesOf, open, untitled, type Source } from "./board.js";
import * as core from "./core.js";
import type { Home } from "./platform.js";
import { folderStore, saving, type Reloaded, type SavingHooks, type Store } from "./save.js";
import { memoryHome, sample } from "../test/folders.js";

/**
 * Each save ends as `outcomes` say in turn, writing unless another program changed the board
 * (`false`) or it failed (an error), and when `gated`, only once `finish` lets it.
 */
function memoryStore({ outcomes = [] as (boolean | Error)[], gated = false } = {}) {
  const written: string[][] = [];
  const pending: (() => void)[] = [];
  let inFlight = 0;
  let together = 0;
  const store: Store = {
    session: false,
    delay: 1000,
    async save(_snapshot, touched) {
      inFlight += 1;
      together = Math.max(together, inFlight);
      try {
        if (gated) {
          await new Promise<void>((resolve) => pending.push(resolve));
        }
        const outcome = outcomes.shift() ?? true;
        if (outcome instanceof Error) {
          throw outcome;
        }
        if (outcome) {
          written.push(touched.toSorted());
        }
        return outcome;
      } finally {
        inFlight -= 1;
      }
    },
    overwrite: async () => void written.push(["overwritten"]),
    changed: async () => false,
    found() {},
    free() {},
  };
  const finish = async () => {
    pending.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { store, written, finish, together: () => together };
}

/** What the app does around a save, with the user answering a conflict `keepTheirs` or not. */
function hooks({ keepTheirs = false } = {}) {
  const failed: string[] = [];
  const reloads: Reloaded[] = [];
  const asked = vi.fn<() => Promise<boolean>>(async () => keepTheirs);
  const { editor } = untitled();
  const around: SavingHooks = {
    snapshot: () => editor.snapshot(),
    source: () => ({}) as Source,
    saved() {},
    failed: (reason) => void failed.push(reason),
    conflict: asked,
    reload: async () => {
      reloads.push("replaced");
      return "replaced";
    },
  };
  return { around, failed, reloads, asked };
}

describe("saving", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes an edit once, a moment after it and not before", async () => {
    const { store, written } = memoryStore();
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(written).toEqual([]);
    expect(saver.unwritten()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(written).toEqual([["a"]]);
    expect(saver.unwritten()).toBe(false);
  });

  it("writes edits made on and on ten seconds after the first, without waiting for a pause", async () => {
    const { store, written } = memoryStore();
    const saver = saving(store, hooks().around);
    for (let at = 0; at < 10_000; at += 500) {
      expect(written).toEqual([]);
      saver.touched([`at ${at}`]);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(written).toHaveLength(1);
    expect(written[0]).toHaveLength(20);
  });

  it("writes edits made while a save runs once it ends, never two saves at once", async () => {
    const { store, written, finish, together } = memoryStore({ gated: true });
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    await vi.advanceTimersByTimeAsync(1000);
    saver.touched(["b"]);
    saver.touched(["c"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(written).toEqual([]);
    await finish();
    expect(written).toEqual([["a"]]);
    await vi.advanceTimersByTimeAsync(1000);
    await finish();
    expect(written).toEqual([["a"], ["b", "c"]]);
    expect(together()).toBe(1);
    expect(saver.unwritten()).toBe(false);
  });

  it("tells why a save failed, and writes the board again with the next edit", async () => {
    const { store, written } = memoryStore({ outcomes: [new Error("the disk is full")] });
    const { around, failed } = hooks();
    const saver = saving(store, around);
    saver.touched(["a"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed).toEqual(["the disk is full"]);
    expect(saver.failure()).toBe("the disk is full");
    expect(saver.unwritten()).toBe(true);
    // Not on its own, which could fail again and again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(written).toEqual([]);
    saver.touched(["b"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(written).toEqual([["a", "b"]]);
    expect(saver.failure()).toBeUndefined();
    expect(saver.unwritten()).toBe(false);
  });

  it("writes over what another program changed once the user keeps their own changes", async () => {
    const { store, written } = memoryStore({ outcomes: [false] });
    const { around, asked, reloads } = hooks({ keepTheirs: false });
    const saver = saving(store, around);
    saver.touched(["a"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toHaveBeenCalledOnce();
    expect(written).toEqual([["overwritten"]]);
    expect(reloads).toEqual([]);
    expect(saver.unwritten()).toBe(false);
  });

  it("reads the board again once the user takes what another program changed", async () => {
    const { store, written } = memoryStore({ outcomes: [false] });
    const { around, asked, reloads } = hooks({ keepTheirs: true });
    const saver = saving(store, around);
    saver.touched(["a"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toHaveBeenCalledOnce();
    expect(reloads).toEqual(["replaced"]);
    expect(written).toEqual([]);
  });

  it("writes what is left at once when flushed, and tells that the board is all on disk", async () => {
    const { store, written } = memoryStore();
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    expect(await saver.flush()).toBe(true);
    expect(written).toEqual([["a"]]);
  });

  it("writes no edit made once it stopped", async () => {
    const { store, written } = memoryStore();
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    await saver.flush();
    await saver.stop();
    saver.touched(["b"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(written).toEqual([["a"]]);
    expect(saver.unwritten()).toBe(false);
  });

  it("reads the board again without asking when another program changed it and it holds no edits", async () => {
    const { store } = memoryStore();
    store.changed = async () => true;
    const { around, asked, reloads } = hooks();
    await saving(store, around).check();
    expect(asked).not.toHaveBeenCalled();
    expect(reloads).toEqual(["replaced"]);
  });

  it("asks before reading the board again when another program changed it and it holds edits", async () => {
    const { store } = memoryStore();
    store.changed = async () => true;
    const { around, asked } = hooks({ keepTheirs: true });
    const saver = saving(store, around);
    saver.touched(["a"]);
    await saver.check();
    expect(asked).toHaveBeenCalledOnce();
  });

  it("lets an edit made during a flush's pass wait the delay, as the board rests between saves", async () => {
    const { store, written, finish } = memoryStore({ gated: true });
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    const flushing = saver.flush();
    saver.touched(["b"]);
    await finish();
    expect(await flushing).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(written).toEqual([["a"]]);
    await vi.advanceTimersByTimeAsync(1);
    await finish();
    expect(written).toEqual([["a"], ["b"]]);
  });

  it("drains edits made during its passes before it ends", async () => {
    const { store, written, finish } = memoryStore({ gated: true });
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    const draining = saver.drain();
    saver.touched(["b"]);
    await finish();
    await finish();
    expect(await draining).toBe(true);
    expect(written).toEqual([["a"], ["b"]]);
  });

  it("drains once the reads under way end, writing nothing while they run", async () => {
    const { store, written } = memoryStore();
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    let read!: () => void;
    const image = new Promise<void>((resolve) => (read = resolve));
    const reading = saver.during(() => image);
    const draining = saver.drain();
    await vi.advanceTimersByTimeAsync(5000);
    expect(written).toEqual([]);
    read();
    await reading;
    expect(await draining).toBe(true);
    expect(written).toEqual([["a"]]);
  });

  it("holds reads that start while it drains until it has written", async () => {
    const { store, written, finish } = memoryStore({ gated: true });
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    let read!: () => void;
    const image = new Promise<void>((resolve) => (read = resolve));
    const first = saver.during(() => image);
    const draining = saver.drain();
    const seen: number[] = [];
    const second = saver.during(async () => void seen.push(written.length));
    read();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    await finish();
    await draining;
    await second;
    expect(seen).toEqual([1]);
  });

  it("says the board is not all on disk when a save fails as it drains", async () => {
    const { store } = memoryStore({ outcomes: [new Error("the disk is full")] });
    const { around, failed } = hooks();
    const saver = saving(store, around);
    saver.touched(["a"]);
    expect(await saver.drain()).toBe(false);
    expect(failed).toEqual(["the disk is full"]);
  });

  it("drains edits that land during its passes even when a flush comes meanwhile", async () => {
    const { store, written, finish } = memoryStore({ gated: true });
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    const draining = saver.drain();
    // As the window blurs while the board is left.
    void saver.flush();
    saver.touched(["b"]);
    await finish();
    saver.touched(["c"]);
    await finish();
    await finish();
    expect(await draining).toBe(true);
    expect(written).toEqual([["a"], ["b"], ["c"]]);
  });

  it("drains once a check of the disk under way ends", async () => {
    const { store, written, finish } = memoryStore({ gated: true });
    let checked!: (changed: boolean) => void;
    store.changed = () => new Promise<boolean>((resolve) => (checked = resolve));
    const saver = saving(store, hooks().around);
    saver.touched(["a"]);
    // As the window comes back to the front.
    const checking = saver.check();
    const draining = saver.drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual([]);
    checked(false);
    await checking;
    await finish();
    expect(await draining).toBe(true);
    expect(written).toEqual([["a"]]);
  });
});

const STICKY = "b7d4e1f05a2c4c8e9f3a6d2b1c0e5f74";
const NOTE = "47b0c6e291d84f138a5c3e7fd06b2491";
const ASSET = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png";
const CONFLICTED = new TextEncoder().encode("<<<<<<< ours\n");

async function demo(home: Home, session = false) {
  const { opened, reading } = (await open(async () => home, new Map()))!;
  const store = await folderStore(home, reading, session);
  const save = async (touched: string[]) => {
    const snapshot = opened.editor.snapshot();
    try {
      return await store.save(snapshot, touched, () => filesOf(opened));
    } finally {
      snapshot.free();
    }
  };
  return { editor: opened.editor, store, save, source: () => filesOf(opened) };
}

describe("folderStore", () => {
  it("rewrites only the files of the elements an edit changed", async () => {
    const { home, files, written } = memoryHome("demo", sample("demo"));
    const before = new Map(files);
    const { editor, save } = await demo(home);
    expect(await save(editor.translate([STICKY], 10, 0))).toBe(true);
    expect(written).toEqual([`elements/${STICKY}.json`]);
    const changed = [...files.keys()].filter((path) => files.get(path) !== before.get(path));
    // With the `.gitattributes` the folder lacked.
    expect(changed.toSorted()).toEqual([".gitattributes", `elements/${STICKY}.json`]);
  });

  it("never writes or deletes a file the board left out, even keeping its own changes", async () => {
    const contents = sample("demo");
    const resolved = contents.get(`elements/${NOTE}.json`)!;
    contents.set(`elements/${NOTE}.json`, CONFLICTED);
    const { home, files: held, written, removed } = memoryHome("demo", contents);
    const { editor, store, save, source } = await demo(home);
    expect(await save(editor.translate([STICKY], 10, 0))).toBe(true);
    const keepMine = async () => {
      const snapshot = editor.snapshot();
      try {
        await store.overwrite(snapshot, source);
      } finally {
        snapshot.free();
      }
    };
    await keepMine();
    expect(held.get(`elements/${NOTE}.json`)).toBe(CONFLICTED);
    // Resolved by hand meanwhile.
    held.set(`elements/${NOTE}.json`, resolved);
    await keepMine();
    expect(held.get(`elements/${NOTE}.json`)).toBe(resolved);
    expect(written).not.toContain(`elements/${NOTE}.json`);
    expect(removed).toEqual([]);
  });

  it("keeps its own changes once another program removed a file the board left out", async () => {
    const contents = sample("demo");
    contents.set(`elements/${NOTE}.json`, CONFLICTED);
    const { home, files: held, written } = memoryHome("demo", contents);
    const { editor, store, source } = await demo(home);
    // As `git merge --abort` would.
    held.delete(`elements/${NOTE}.json`);
    editor.translate([STICKY], 10, 0);
    const snapshot = editor.snapshot();
    try {
      await store.overwrite(snapshot, source);
    } finally {
      snapshot.free();
    }
    expect(written).toContain(`elements/${STICKY}.json`);
    expect(held.has(`elements/${NOTE}.json`)).toBe(false);
  });

  it("copies into a folder the files the board left out, but not the images it lacks", async () => {
    const contents = sample("demo");
    contents.set(`elements/${NOTE}.json`, CONFLICTED);
    contents.delete(`assets/${ASSET}`);
    const { opened } = (await open(async () => memoryHome("demo", contents).home, new Map()))!;
    const target = memoryHome("copy");
    const store = await folderStore(target.home, undefined, false);
    const snapshot = opened.editor.snapshot();
    try {
      const all = Object.keys(opened.board.elements);
      expect(await store.save(snapshot, all, () => filesOf(opened))).toBe(true);
    } finally {
      snapshot.free();
    }
    expect(target.files.get(`elements/${NOTE}.json`)).toEqual(CONFLICTED);
    expect(target.files.has(`assets/${ASSET}`)).toBe(false);
  });

  it("writes a save in steps, its images, then its board, then all its elements together", async () => {
    const { opened } = (await open(
      async () => memoryHome("demo", sample("demo")).home,
      new Map(),
    ))!;
    const target = memoryHome("copy");
    const steps: string[][] = [];
    let writing = false;
    const home: Home = {
      ...target.home,
      async writeAll(files, wrote) {
        expect(writing).toBe(false);
        writing = true;
        steps.push(files.map(([path]) => path));
        await target.home.writeAll(files, wrote);
        writing = false;
      },
    };
    const store = await folderStore(home, undefined, false);
    const all = Object.keys(opened.board.elements);
    const snapshot = opened.editor.snapshot();
    try {
      expect(await store.save(snapshot, all, () => filesOf(opened))).toBe(true);
    } finally {
      snapshot.free();
    }
    const [images, board, elements] = steps as [string[], string[], string[]];
    expect(steps).toHaveLength(3);
    expect(images.every(core.isAssetFile)).toBe(true);
    expect(board).toEqual(["board.json"]);
    expect(elements.toSorted()).toEqual(all.map((id) => `elements/${id}.json`).toSorted());
  });

  it("writes a large image before it reads the next", async () => {
    const { opened } = (await open(
      async () => memoryHome("demo", sample("demo")).home,
      new Map(),
    ))!;
    const events: string[] = [];
    const source: Source = {
      ...filesOf(opened),
      async read(path) {
        events.push(`read ${path}`);
        // Larger than a save holds at once.
        return new Uint8Array(40 << 20);
      },
    };
    const target = memoryHome("copy");
    const home: Home = {
      ...target.home,
      async writeAll(files, wrote) {
        events.push(...files.map(([path]) => `write ${path}`));
        await target.home.writeAll(files, wrote);
      },
    };
    const store = await folderStore(home, undefined, false);
    const snapshot = opened.editor.snapshot();
    try {
      const all = Object.keys(opened.board.elements);
      expect(await store.save(snapshot, all, () => source)).toBe(true);
    } finally {
      snapshot.free();
    }
    const images = events
      .filter((event) => event.startsWith("read "))
      .map((event) => event.slice(5));
    expect(images.length).toBeGreaterThan(1);
    expect(events.filter((event) => images.some((path) => event.endsWith(path)))).toEqual(
      images.flatMap((path) => [`read ${path}`, `write ${path}`]),
    );
  });

  it("gives a folder lacking a board's .gitattributes one, and leaves its user's alone", async () => {
    const [[path, bytes]] = [...core.newFiles()] as [[string, core.Bytes]];
    const lacking = memoryHome("demo", sample("demo"));
    const first = await demo(lacking.home);
    expect(await first.save(first.editor.translate([STICKY], 10, 0))).toBe(true);
    expect(lacking.files.get(path)).toEqual(bytes);

    const theirs = new TextEncoder().encode("* text=auto\n");
    const holding = memoryHome("demo", new Map([...sample("demo"), [path, theirs]]));
    const second = await demo(holding.home);
    expect(await second.save(second.editor.translate([STICKY], 10, 0))).toBe(true);
    expect(holding.files.get(path)).toBe(theirs);

    // Which no session takes, as it lives in no Git.
    const session = memoryHome("session", sample("demo"));
    const third = await demo(session.home, true);
    expect(await third.save(third.editor.translate([STICKY], 10, 0))).toBe(true);
    expect(session.files.has(path)).toBe(false);
  });

  it("writes nothing over a file another program changed since, and says so", async () => {
    const { home, files, written, overwrite } = memoryHome("demo", sample("demo"));
    const { editor, store, save } = await demo(home);
    overwrite(`elements/${STICKY}.json`, "theirs");
    expect(await save(editor.translate([STICKY], 10, 0))).toBe(false);
    expect(written).toEqual([]);
    expect(new TextDecoder().decode(files.get(`elements/${STICKY}.json`))).toBe("theirs");
    expect(await store.changed()).toBe(true);
  });

  it("leaves alone a file another program changed when the edit is elsewhere", async () => {
    const { home, files, written, overwrite } = memoryHome("demo", sample("demo"));
    const { editor, save } = await demo(home);
    overwrite(`elements/${NOTE}.json`, "theirs");
    expect(await save(editor.translate([STICKY], 10, 0))).toBe(true);
    expect(written).toEqual([`elements/${STICKY}.json`]);
    expect(new TextDecoder().decode(files.get(`elements/${NOTE}.json`))).toBe("theirs");
  });

  it("removes only the file of an element deleted", async () => {
    const { home, files, written, removed } = memoryHome("demo", sample("demo"));
    const { editor, save } = await demo(home);
    expect(await save(editor.remove([STICKY]))).toBe(true);
    expect(removed).toEqual([`elements/${STICKY}.json`]);
    expect(written).toEqual([]);
    expect(files.has(`elements/${STICKY}.json`)).toBe(false);
  });

  it("writes a board that reads back as it was saved", async () => {
    const { home } = memoryHome("demo", sample("demo"));
    const { editor, save } = await demo(home);
    await save(editor.translate([STICKY], 10, 0));
    const again = await open(async () => home, new Map());
    expect(again!.opened.board).toEqual(core.board(editor));
  });

  it("keeps what landed of a save that fails partway, and writes only the rest next", async () => {
    const ELLIPSE = "2e95d0b468a74c1fb6e39d027f18a5c4";
    const STAR = "d06f4b2a91c84e7c8b3f5a2e6c1d0947";
    const inner = memoryHome("demo", sample("demo"));
    const before = new Map(inner.files);
    let failing: string | undefined = `elements/${STICKY}.json`;
    // `memoryHome`'s `writeAll` goes through this `write`, one file after another.
    const home: Home = {
      ...inner.home,
      async write(path, bytes) {
        if (path === failing) {
          failing = undefined;
          throw new Error("the disk is full");
        }
        return inner.home.write(path, bytes);
      },
    };
    const { editor, store, save } = await demo(home);
    core.setBackground(editor, "grid");
    const touched = [...editor.translate([ELLIPSE, STICKY], 10, 0), ...editor.remove([STAR])];
    await expect(save(touched)).rejects.toThrow("the disk is full");
    // The elements before the one that failed landed, and no later step started.
    const landed = touched
      .map((id) => `elements/${id}.json`)
      .filter((path) => path < `elements/${STICKY}.json` && path !== `elements/${STAR}.json`)
      .toSorted();
    expect(landed).toContain(`elements/${ELLIPSE}.json`);
    expect(inner.written).toEqual(landed);
    expect(inner.files.get(`elements/${STICKY}.json`)).toBe(before.get(`elements/${STICKY}.json`));
    expect(inner.files.get("board.json")).toBe(before.get("board.json"));
    expect(inner.removed).toEqual([]);
    // What landed is the app's own.
    expect(await store.changed()).toBe(false);

    inner.written.length = 0;
    expect(await save(touched)).toBe(true);
    expect(inner.written).toEqual([`elements/${STICKY}.json`, "board.json"]);
    expect(inner.removed).toEqual([`elements/${STAR}.json`]);
    expect(await store.changed()).toBe(false);
    const again = await open(async () => home, new Map());
    expect(again!.opened.board).toEqual(core.board(editor));
  });

  it("writes no image whose file came back to the folder once found", async () => {
    const IMAGE = "1a4e83c05f294b76a3d107e89c526b0f";
    const path = `assets/${ASSET}`;
    const contents = sample("demo");
    const bytes = contents.get(path)!;
    contents.delete(path);
    const { home, written, overwrite } = memoryHome("demo", contents);
    const { opened, reading } = (await open(async () => home, new Map()))!;
    const store = await folderStore(home, reading, false);
    // Put back by another program, then found as the app's showing does.
    overwrite(path, bytes);
    opened.missing = new Set([...opened.missing].filter((missing) => missing !== path));
    store.found([path]);
    const touched = opened.editor.translate([IMAGE], 10, 0);
    const snapshot = opened.editor.snapshot();
    try {
      expect(await store.save(snapshot, touched, () => filesOf(opened))).toBe(true);
    } finally {
      snapshot.free();
    }
    expect(written).toEqual([`elements/${IMAGE}.json`]);
  });
});
