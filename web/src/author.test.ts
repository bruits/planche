// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { write, type Writing } from "./author.js";
import { untitled, type Opened } from "./board.js";
import * as core from "./core.js";

const arrow = { type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
const comment = { type: "comment", at: { x: 40, y: 60 }, text: "Why here?" };
/** As far as the shell's deadline usually is. */
const later = () => Date.now() + 60_000;

/** The page as agents see it, showing `opened` until `show` shows another board. */
function page(
  opened: Opened,
  {
    busy = () => false,
    idle = async () => {},
    loading = false,
  }: Partial<Pick<Writing, "busy" | "idle">> & { loading?: boolean } = {},
) {
  let shown = opened;
  const writing: Writing = {
    opened: () => shown,
    loading: () => loading,
    busy,
    idle,
    apply(work) {
      const touched: string[] = [];
      work(shown.editor, touched);
      shown.board = core.board(shown.editor);
      return touched;
    },
    keep() {},
    zoom: () => 1,
    centre: () => ({ x: 0, y: 0 }),
    select() {},
    selection: () => [],
    entered: () => undefined,
    frame() {},
  };
  return { writing, show: (next: Opened) => void (shown = next) };
}

describe("write", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds what an agent describes, and tells the ids of what it added", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const answer = (await write("add", { elements: [arrow, comment] }, writing, later())) as {
      added: { id: string; type: string }[];
    };
    expect(answer.added.map(({ type }) => type)).toEqual(["arrow", "comment"]);
    const [drawn, written] = answer.added.map(({ id }) => opened.board.elements[id]?.kind);
    expect(drawn).toMatchObject(arrow);
    expect(written).toMatchObject(comment);
  });

  it("changes nothing when an agent names an element the board lacks", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const { added } = (await write("add", { elements: [arrow] }, writing, later())) as {
      added: { id: string }[];
    };
    const before = opened.editor.json();
    const removing = write("remove", { ids: [added[0]!.id, "nowhere"] }, writing, later());
    await expect(removing).rejects.toThrow("Untitled has no element nowhere");
    expect(opened.editor.json()).toBe(before);
  });

  it("changes nothing, and asks the agent to try again, while the user goes on dragging", async () => {
    vi.useFakeTimers();
    const opened = untitled();
    const { writing } = page(opened, { busy: () => true, idle: () => new Promise(() => {}) });
    const before = opened.editor.json();
    const adding = write("add", { elements: [arrow] }, writing, later());
    await Promise.all([
      expect(adding).rejects.toThrow("try again"),
      vi.advanceTimersByTimeAsync(10_000),
    ]);
    expect(opened.editor.json()).toBe(before);
  });

  it("changes nothing when another board opened while the user finished dragging", async () => {
    const opened = untitled();
    let dragging = true;
    const { writing, show } = page(opened, {
      busy: () => dragging,
      idle: async () => {
        show(untitled());
        dragging = false;
      },
    });
    const before = opened.editor.json();
    await expect(write("add", { elements: [arrow] }, writing, later())).rejects.toThrow(
      "Another board opened",
    );
    expect(opened.editor.json()).toBe(before);
  });

  it("changes nothing while a board opens", async () => {
    const opened = untitled();
    const { writing } = page(opened, { loading: true });
    await expect(write("add", { elements: [arrow] }, writing, later())).rejects.toThrow(
      "A board is opening",
    );
    expect(Object.keys(opened.board.elements)).toEqual([]);
  });

  it("changes nothing when the shell is about to give up on the call", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    await expect(write("add", { elements: [arrow] }, writing, Date.now() + 1000)).rejects.toThrow(
      "took too long",
    );
    expect(Object.keys(opened.board.elements)).toEqual([]);
  });
});
