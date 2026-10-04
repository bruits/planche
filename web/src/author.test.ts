// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { write, type Writing } from "./author.js";
import { untitled, type Opened } from "./board.js";
import * as core from "./core.js";

const arrow = { type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };
const comment = { type: "comment", at: { x: 40, y: 60 }, text: "Why here?" };
/** Text fits what holds it as a font of fixed widths would. */
const measure = (text: string) => ({
  width: text.length * 50,
  fontBoundingBoxAscent: 80,
  fontBoundingBoxDescent: 20,
  actualBoundingBoxAscent: 70,
});
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
    vi.restoreAllMocks();
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

  it("moves and scales what an agent names as one edit, comments included", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const { added } = (await write("add", { elements: [arrow, comment] }, writing, later())) as {
      added: { id: string; bounds: core.Rect }[];
    };
    const ids = added.map(({ id }) => id);
    // A comment covers nothing, so it is where it is pinned.
    expect(added[1]!.bounds).toEqual({ x: 40, y: 60, width: 0, height: 0 });
    const before = opened.editor.json();
    await write("transform", { ids, width: 50, move_to: { x: 10, y: 20 } }, writing, later());
    expect(core.extent(opened.editor, ids)).toEqual({ x: 10, y: 20, width: 50, height: 30 });
    opened.editor.undo();
    expect(opened.editor.json()).toBe(before);
  });

  it("lines up and spaces what an agent names, each as one edit", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const pins = [
      { type: "comment", at: { x: 0, y: 0 }, text: "One" },
      { type: "comment", at: { x: 30, y: 50 }, text: "Two" },
      { type: "comment", at: { x: 100, y: 20 }, text: "Three" },
    ];
    const { added } = (await write("add", { elements: pins }, writing, later())) as {
      added: { id: string }[];
    };
    const ids = added.map(({ id }) => id);
    const pinned = () =>
      ids.map((id) => {
        const kind = core.element(opened.editor, id)?.kind;
        return kind?.type === "comment" ? kind.at : undefined;
      });
    await write("align", { ids, to: "top" }, writing, later());
    await write("distribute", { ids, axis: "horizontal" }, writing, later());
    expect(pinned()).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ]);
    opened.editor.undo();
    expect(pinned()[1]).toEqual({ x: 30, y: 0 });
  });

  it("refuses a transform that cannot be made, which changes nothing", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const { added } = (await write("add", { elements: [arrow] }, writing, later())) as {
      added: { id: string }[];
    };
    const ids = added.map(({ id }) => id);
    const before = opened.editor.json();
    await expect(write("transform", { ids, scale: 2, width: 5 }, writing, later())).rejects.toThrow(
      "not both",
    );
    await expect(write("transform", { ids, width: 0 }, writing, later())).rejects.toThrow(
      "positive",
    );
    expect(opened.editor.json()).toBe(before);
  });

  it("fades what an agent names, but no comment, which takes no opacity", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const line = { type: "line", from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, opacity: 40 };
    const { added } = (await write("add", { elements: [line, comment] }, writing, later())) as {
      added: { id: string }[];
    };
    const [drawn, pinned] = added.map(({ id }) => id);
    expect(opened.board.elements[drawn!]!.kind).toMatchObject({ opacity: 40 });
    await write("update", { updates: [{ id: drawn, opacity: 100 }] }, writing, later());
    expect(opened.board.elements[drawn!]!.kind).not.toHaveProperty("opacity");
    await expect(
      write("update", { updates: [{ id: pinned, opacity: 50 }] }, writing, later()),
    ).rejects.toThrow("opacity");
  });

  it("writes a style an agent chooses as it comes as nothing", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: measure,
    } as unknown as CanvasRenderingContext2D);
    const opened = untitled();
    const { writing } = page(opened);
    const filled = { type: "shape", x: 0, y: 0, shape: "rectangle", fill: "solid", text: "Hi" };
    const note = { type: "note", x: 0, y: 200, text: "Hello", align: "left" };
    const { added } = (await write("add", { elements: [filled, note] }, writing, later())) as {
      added: { id: string }[];
    };
    const [shape, written] = added.map(({ id }) => id);
    const kindOf = (id: string) => opened.board.elements[id]!.kind;
    expect(kindOf(written!)).not.toHaveProperty("text.align");
    await write("update", { updates: [{ id: shape, shape: "cross" }] }, writing, later());
    expect(kindOf(shape!)).toMatchObject({ shape: "cross" });
    expect(kindOf(shape!)).not.toHaveProperty("fill");
  });
});
