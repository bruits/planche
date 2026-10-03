// @vitest-environment happy-dom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { refresh, type Opened } from "./board.js";
import type { Camera } from "./camera.js";
import { lifecycle, type Host } from "./lifecycle.js";
import type { Folder, Home, Reopening, Session } from "./platform.js";
import { memoryHome, memorySession, sample } from "../test/folders.js";

/** One of the demo's sticky notes. */
const STICKY = "b7d4e1f05a2c4c8e9f3a6d2b1c0e5f74";
const STICKY_FILE = `elements/${STICKY}.json`;

/** The demo's sticky note as another program rewrote it. */
const THEIRS = JSON.stringify({
  z: "a4",
  kind: {
    type: "sticky",
    frame: { x: 0, y: 0, width: 180, height: 180 },
    rotation: 0,
    text: { content: "Theirs", font_size: 20 },
  },
});

/** What the browser remembers of the board in the session from the last launch. */
function remembered(kept: { name: string; unsaved: boolean }): void {
  localStorage.setItem("planche.session", JSON.stringify(kept));
}

function sticky(opened: Opened | undefined, id: string): string | undefined {
  const kind = opened?.board.elements[id]?.kind;
  return kind?.type === "sticky" ? kind.text.content : undefined;
}

/**
 * The app around the boards, launched with `session`, or none where another window holds it,
 * `reopen` to open again, `picked` as the board the user opens, and `target` as the folder they
 * save it as, answering `answer` when asked, and looking at the board shown from `camera`.
 */
function app({
  session,
  reopen,
  picked,
  target,
  answer = true,
  camera,
}: {
  session?: Session;
  reopen?: Reopening;
  picked?: Folder | Home;
  target?: Home;
  answer?: boolean;
  camera?: Camera;
}) {
  let opened: Opened | undefined;
  const said: string[] = [];
  const shownAt: (Camera | undefined)[] = [];
  const confirm = vi.fn<(question: string) => Promise<boolean>>(async () => answer);
  const forget = vi.fn<() => Promise<void>>(async () => {});
  const platform: Host["platform"] = {
    session: async () => session ?? null,
    reopen: async () => reopen ?? null,
    forget,
    open: async () => picked ?? null,
    openZip: async () => null,
    pickTarget: async () => target ?? null,
    confirm,
    markUnsaved() {},
  };
  const life = lifecycle({
    platform,
    opened: () => opened,
    async show(next, at) {
      opened?.editor.free();
      opened = next;
      shownAt.push(at);
      life.showSaved();
    },
    camera: () => camera,
    say: (text) => void said.push(text),
    loadingChanged() {},
    titleChanged() {},
    timings: new Map(),
  });
  const move = (id: string) => {
    const touched = opened!.editor.translate([id], 10, 0);
    refresh(opened!, touched);
    life.touched(touched);
  };
  return { life, opened: () => opened, said, confirm, forget, move, shownAt };
}

describe("lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reopens at launch the board the session kept", async () => {
    remembered({ name: "demo", unsaved: false });
    const { life, opened } = app({ session: memorySession(sample("demo")).session });
    await life.start();
    expect(opened()?.folder.name).toBe("demo");
    expect(opened()?.board.draw_order).toHaveLength(8);
    expect(life.unsaved()).toBe(false);
  });

  it("reopens at launch the board remembered in its own folder, leaving the session's on disk", async () => {
    remembered({ name: "Untitled", unsaved: false });
    const { session, files: kept } = memorySession(sample("demo"));
    const before = new Map(kept);
    const { home } = memoryHome("demo", sample("demo"));
    const { life, opened } = app({ session, reopen: { folder: home } });
    await life.start();
    expect(opened()?.folder).toBe(home);
    expect(kept).toEqual(before);
  });

  it("reopens at launch a session board saved nowhere else before the folder remembered", async () => {
    remembered({ name: "demo", unsaved: true });
    const { home } = memoryHome("elsewhere", sample("demo"));
    const { life, opened } = app({
      session: memorySession(sample("demo")).session,
      reopen: { folder: home },
    });
    await life.start();
    expect(opened()?.folder.name).toBe("demo");
    expect(life.unsaved()).toBe(true);
  });

  it("leaves a session board it cannot read as it is, and says why, until a new board starts", async () => {
    remembered({ name: "demo", unsaved: true });
    const files = sample("demo");
    files.set(`elements/${STICKY}.json`, new TextEncoder().encode("{"));
    const { session, files: kept } = memorySession(files);
    const before = new Map(kept);
    const { life, opened, said } = app({ session });
    await life.start();
    expect(said).toEqual([
      expect.stringMatching(
        /^The board kept from last time could not be read, and stays as it was/,
      ),
    ]);
    expect(opened()?.folder.name).toBe("Untitled");
    expect(kept).toEqual(before);
    await life.newBoard();
    expect(kept.size).toBe(0);
  });

  it("starts a blank board when nothing is left to reopen", async () => {
    const { life, opened, said } = app({ session: memorySession().session });
    await life.start();
    expect(opened()?.folder.name).toBe("Untitled");
    expect(opened()?.board.draw_order).toEqual([]);
    expect(said).toEqual([]);
  });

  it("says when the board will not reopen next time, as another window holds the session", async () => {
    const { life, said } = app({});
    await life.start();
    expect(said).toEqual([
      "This window keeps no board for next time, as another one does or the browser cannot",
    ]);
  });

  it("asks before leaving a board saved nowhere else, and keeps it when the user declines", async () => {
    remembered({ name: "demo", unsaved: false });
    const { life, opened, confirm, move } = app({
      session: memorySession(sample("demo")).session,
      answer: false,
    });
    await life.start();
    const board = opened();
    move(STICKY);
    await life.newBoard();
    expect(confirm).toHaveBeenCalledOnce();
    expect(opened()).toBe(board);
    expect(life.unsaved()).toBe(true);
  });

  it("leaves a board saved into its own folder without asking", async () => {
    const { home } = memoryHome("demo", sample("demo"));
    const { life, opened, confirm, move } = app({ session: memorySession().session, picked: home });
    await life.start();
    await life.openFolder();
    expect(opened()?.folder).toBe(home);
    move(STICKY);
    await life.newBoard();
    expect(confirm).not.toHaveBeenCalled();
    expect(opened()?.folder.name).toBe("Untitled");
  });

  it("writes the open board's edits into its folder before another board takes its place", async () => {
    const { home, written } = memoryHome("demo", sample("demo"));
    const { life, move } = app({ session: memorySession().session, picked: home });
    await life.start();
    await life.openFolder();
    move(STICKY);
    expect(written).toEqual([]);
    await life.newBoard();
    expect(written).toEqual([`elements/${STICKY}.json`]);
  });
});

describe("saveAs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("saves a session board into an empty folder, which gets its later edits, and empties the session", async () => {
    remembered({ name: "demo", unsaved: true });
    const { session, files: kept } = memorySession(sample("demo"));
    const { home, files, written } = memoryHome("target");
    const remember = vi.fn<() => Promise<void>>(async () => {});
    const { life, opened, said, forget, move } = app({
      session,
      target: { ...home, remember },
    });
    await life.start();
    move(STICKY);
    await life.saveAs();
    expect(files.get("board.json")).toEqual(sample("demo").get("board.json"));
    expect(files.has(`elements/${STICKY}.json`)).toBe(true);
    expect(kept.size).toBe(0);
    expect(opened()?.folder.name).toBe("target");
    expect(said).toContain("Saved as target, where it saves itself from now on");
    expect(remember).toHaveBeenCalledOnce();
    expect(forget).not.toHaveBeenCalled();
    expect(life.unsaved()).toBe(false);
    written.length = 0;
    move(STICKY);
    expect(await life.closing()).toBe(true);
    expect(written).toEqual([`elements/${STICKY}.json`]);
    expect(kept.size).toBe(0);
  });

  it("saves a folder's board into an empty folder, leaving the first one as it was from then on", async () => {
    const first = memoryHome("demo", sample("demo"));
    const second = memoryHome("target");
    const { life, opened, move } = app({
      session: memorySession().session,
      picked: first.home,
      target: second.home,
    });
    await life.start();
    await life.openFolder();
    move(STICKY);
    await life.saveAs();
    expect(first.written).toEqual([`elements/${STICKY}.json`]);
    expect(second.files.has(`elements/${STICKY}.json`)).toBe(true);
    expect(opened()?.folder.name).toBe("target");
    second.written.length = 0;
    move(STICKY);
    expect(await life.closing()).toBe(true);
    expect(first.written).toEqual([`elements/${STICKY}.json`]);
    expect(second.written).toEqual([`elements/${STICKY}.json`]);
  });

  it("says a folder filled meanwhile is no longer empty, and keeps saving into the session", async () => {
    remembered({ name: "demo", unsaved: true });
    const { session, files: kept, written: keptWritten } = memorySession(sample("demo"));
    const other = sample("demo");
    other.set("board.json", new TextEncoder().encode("theirs"));
    const { home, files } = memoryHome("taken", other);
    const before = new Map(files);
    const { life, opened, move } = app({ session, target: home });
    await life.start();
    move(STICKY);
    await expect(life.saveAs()).rejects.toThrow("taken is no longer empty");
    expect(new Map([...files].filter(([path]) => !path.startsWith(".")))).toEqual(before);
    expect(opened()?.folder.name).toBe("demo");
    expect(kept.size).toBeGreaterThan(0);
    expect(life.unsaved()).toBe(true);
    keptWritten.length = 0;
    move(STICKY);
    expect(await life.closing()).toBe(true);
    expect(keptWritten).toEqual([`elements/${STICKY}.json`]);
  });
});

describe("closing", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("lets the app close once the board's last edits are written into its folder", async () => {
    const { home, written } = memoryHome("demo", sample("demo"));
    const { life, move } = app({ session: memorySession().session, picked: home });
    await life.start();
    await life.openFolder();
    move(STICKY);
    expect(await life.closing()).toBe(true);
    expect(written).toEqual([`elements/${STICKY}.json`]);
  });

  it("holds the app open while the board's last edits fail to be written", async () => {
    const { home } = memoryHome("demo", sample("demo"));
    const { life, said, move } = app({
      session: memorySession().session,
      picked: {
        ...home,
        write: async () => {
          throw new Error("the disk is full");
        },
      },
    });
    await life.start();
    await life.openFolder();
    move(STICKY);
    expect(await life.closing()).toBe(false);
    expect(said).toContain("Not saved into demo: the disk is full");
  });

  it("holds the app open while a board saved nowhere holds edits", async () => {
    const { home } = memoryHome("demo", sample("demo"));
    const { list, read, name } = home;
    const { life, move } = app({ picked: { name, list, read } });
    await life.start();
    await life.openFolder();
    expect(await life.closing()).toBe(true);
    move(STICKY);
    expect(await life.closing()).toBe(false);
  });
});

describe("reload", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads a clean folder board again once another program changed it, at the same camera, and says so", async () => {
    const { home, overwrite, written } = memoryHome("demo", sample("demo"));
    const camera = { x: 12, y: 34, zoom: 2 };
    const { life, opened, said, confirm, shownAt } = app({
      session: memorySession().session,
      picked: home,
      camera,
    });
    await life.start();
    await life.openFolder();
    const before = opened();
    overwrite(STICKY_FILE, THEIRS);
    await life.saver()?.check();
    expect(opened()).not.toBe(before);
    expect(opened()?.folder).toBe(home);
    expect(sticky(opened(), STICKY)).toBe("Theirs");
    expect(said).toContain("demo changed on disk, so it was read again");
    expect(confirm).not.toHaveBeenCalled();
    expect(shownAt.at(-1)).toEqual(camera);
    expect(written).toEqual([]);
    expect(life.unsaved()).toBe(false);
  });

  it("asks before reading a board with edits again, and shows the other program's version when the user agrees", async () => {
    const { home, overwrite, files } = memoryHome("demo", sample("demo"));
    const { life, opened, said, confirm, move } = app({
      session: memorySession().session,
      picked: home,
      answer: true,
    });
    await life.start();
    await life.openFolder();
    move(STICKY);
    overwrite(STICKY_FILE, THEIRS);
    await life.saver()?.check();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toMatch(/^demo changed on disk/);
    expect(sticky(opened(), STICKY)).toBe("Theirs");
    expect(said).toContain("demo changed on disk, so it was read again");
    expect(await life.closing()).toBe(true);
    expect(new TextDecoder().decode(files.get(STICKY_FILE))).toBe(THEIRS);
  });

  it("asks before reading a board with edits again, and writes the user's edits over when they keep theirs", async () => {
    const { home, overwrite, files } = memoryHome("demo", sample("demo"));
    const { life, opened, confirm, move } = app({
      session: memorySession().session,
      picked: home,
      answer: false,
    });
    await life.start();
    await life.openFolder();
    const board = opened();
    move(STICKY);
    overwrite(STICKY_FILE, THEIRS);
    await life.saver()?.check();
    expect(confirm).toHaveBeenCalledOnce();
    expect(opened()).toBe(board);
    expect(await life.closing()).toBe(true);
    const written = JSON.parse(new TextDecoder().decode(files.get(STICKY_FILE))) as {
      kind: { frame: { x: number }; text: { content: string } };
    };
    expect(written.kind.frame.x).toBe(650);
    expect(written.kind.text.content).toBe("Try a warmer grade for the dusk shots");
    expect(life.unsaved()).toBe(false);
  });

  it("keeps the board shown, and asks, when the user edits it while it is read again", async () => {
    const { home, overwrite } = memoryHome("demo", sample("demo"));
    let editing: (() => void) | undefined;
    const reading: Home = {
      ...home,
      async read(path) {
        const bytes = await home.read(path);
        if (path === STICKY_FILE && editing) {
          const edit = editing;
          editing = undefined;
          edit();
        }
        return bytes;
      },
    };
    const { life, opened, said, confirm, move } = app({
      session: memorySession().session,
      picked: reading,
      answer: false,
    });
    await life.start();
    await life.openFolder();
    const board = opened();
    overwrite(STICKY_FILE, THEIRS);
    editing = () => move(STICKY);
    await life.saver()?.check();
    expect(opened()).toBe(board);
    expect(confirm).toHaveBeenCalledOnce();
    expect(said).not.toContain("demo changed on disk, so it was read again");
    expect(await life.closing()).toBe(true);
    expect(sticky(opened(), STICKY)).toBe("Try a warmer grade for the dusk shots");
  });
});

describe("resume", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("forgets a remembered folder it cannot open at launch, says why, and starts a blank board", async () => {
    const files = sample("demo");
    files.set(STICKY_FILE, new TextEncoder().encode("{"));
    const { home } = memoryHome("demo", files);
    const { life, opened, said, forget } = app({
      session: memorySession().session,
      reopen: { folder: home },
    });
    await life.start();
    expect(said).toEqual([expect.stringMatching(/^Planche could not open the last board again: /)]);
    expect(forget).toHaveBeenCalled();
    expect(opened()?.folder.name).toBe("Untitled");
    expect(opened()?.board.draw_order).toEqual([]);
  });

  it("forgets a remembered folder it cannot open at launch, and reopens the session's board instead", async () => {
    remembered({ name: "demo", unsaved: false });
    const files = sample("demo");
    files.set(STICKY_FILE, new TextEncoder().encode("{"));
    const { home } = memoryHome("elsewhere", files);
    const { life, opened, said, forget } = app({
      session: memorySession(sample("demo")).session,
      reopen: { folder: home },
    });
    await life.start();
    expect(said).toEqual([expect.stringMatching(/^Planche could not open the last board again: /)]);
    expect(forget).toHaveBeenCalledOnce();
    expect(opened()?.folder.name).toBe("demo");
  });
});

describe("offer", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("offers to open the remembered folder again, and opens it once the user clicks", async () => {
    const { home } = memoryHome("demo", sample("demo"));
    const remember = vi.fn<() => Promise<void>>(async () => {});
    const ask = vi.fn<() => Promise<Home | null>>(async () => ({ ...home, remember }));
    const { life, opened, said, forget } = app({
      session: memorySession().session,
      reopen: { name: "demo", ask },
    });
    await life.start();
    expect(said).toEqual(["Click anywhere to open demo again"]);
    expect(opened()?.folder.name).toBe("Untitled");
    expect(forget).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(opened()?.folder.name).toBe("demo"));
    await vi.waitFor(() => expect(life.loading()).toBe(false));
    expect(ask).toHaveBeenCalledOnce();
    expect(remember).toHaveBeenCalledOnce();
    expect(forget).not.toHaveBeenCalled();
    expect(said.at(-1)).toBe("");
    dispatchEvent(new Event("pointerdown"));
    expect(ask).toHaveBeenCalledOnce();
  });
});
