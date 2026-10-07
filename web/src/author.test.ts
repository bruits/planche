// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { answer as reply, type Reading } from "./agent.js";
import { write, type Writing } from "./author.js";
import { imageKind, newId, untitled, type Opened } from "./board.js";
import * as core from "./core.js";

// Decoding needs a browser, which a refusal comes before.
vi.mock("./board.js", async (original) => ({
  ...(await original<typeof import("./board.js")>()),
  prepare: async () => ({
    asset: "a".repeat(64),
    bytes: new Blob([]),
    natural: { width: 10, height: 10 },
  }),
}));

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

  it("adds a pen stroke through an agent's points, framed by them, read back without them", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const points = [
      { x: 10, y: 20 },
      { x: 60, y: 45 },
      { x: 110, y: 70 },
      { x: 110, y: 20 },
    ];
    const stroke = { type: "stroke", points, colour: "red" };
    const { added } = (await write("add", { elements: [stroke] }, writing, later())) as {
      added: { id: string }[];
    };
    const id = added[0]!.id;
    // The second point lies on the line from the first to the third.
    expect(opened.board.elements[id]?.kind).toEqual({
      type: "stroke",
      frame: { x: 10, y: 20, width: 100, height: 50 },
      points: [0, 0, 1, 1, 1, 0],
      colour: "red",
    });
    const reading = { ...writing, unsaved: () => false } as unknown as Reading & Writing;
    const read = (await reply(
      { id: 1, tool: "elements", args: { ids: [id] }, deadline: later() },
      reading,
    )) as {
      elements: Record<string, { kind: Record<string, unknown> }>;
    };
    expect(read.elements[id]?.kind).toMatchObject({ type: "stroke", point_count: 3 });
    expect(read.elements[id]?.kind).not.toHaveProperty("points");
  });

  it("adds a highlighter stroke as an agent asks for one", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const stroke = { type: "stroke", tip: "highlighter", points: [{ x: 10, y: 20 }] };
    const { added } = (await write("add", { elements: [stroke] }, writing, later())) as {
      added: { id: string }[];
    };
    expect(opened.board.elements[added[0]!.id]?.kind).toMatchObject({ tip: "highlighter" });
  });

  it("sticks a stroke drawn whole on a filled shape to it, unless the agent says not to", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: measure,
    } as unknown as CanvasRenderingContext2D);
    const opened = untitled();
    const { writing } = page(opened);
    const shape = { type: "shape", x: 0, y: 0, width: 100, height: 100, fill: "solid" };
    const stroke = {
      type: "stroke",
      points: [
        { x: 20, y: 20 },
        { x: 80, y: 60 },
      ],
    };
    const add = async (stick: boolean) => {
      const { added } = (await write(
        "add",
        { elements: [shape, stroke], stick },
        writing,
        later(),
      )) as { added: { id: string }[] };
      return added.map(({ id }) => id);
    };
    const [filled, stuck] = await add(true);
    expect(opened.board.elements[stuck!]?.kind).toMatchObject({ target: filled });
    const [, free] = await add(false);
    expect(opened.board.elements[free!]?.kind).not.toHaveProperty("target");
  });

  it("refuses a pen stroke with no point plainly, and changes nothing", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const adding = write("add", { elements: [{ type: "stroke", points: [] }] }, writing, later());
    await expect(adding).rejects.toThrow("A stroke needs a point");
    expect(opened.board.elements).toEqual({});
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

  it("locks what an agent names, whose edits it then refuses, and unlocks it", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const { added } = (await write("add", { elements: [arrow] }, writing, later())) as {
      added: { id: string }[];
    };
    const ids = added.map(({ id }) => id);
    await write("lock", { ids, locked: true }, writing, later());
    const reading = {
      ...writing,
      unsaved: () => false,
      shown: () => undefined,
    } as unknown as Reading & Writing;
    const read = (await reply({ id: 1, tool: "board", args: {}, deadline: later() }, reading)) as {
      elements: { locked_by?: string }[];
    };
    expect(read.elements[0]?.locked_by).toBe(ids[0]);
    const before = opened.editor.json();
    await expect(write("remove", { ids }, writing, later())).rejects.toThrow("is locked");
    expect(opened.editor.json()).toBe(before);
    await write("lock", { ids, locked: false }, writing, later());
    await write("remove", { ids }, writing, later());
    expect(opened.board.elements).toEqual({});
  });

  it("names the locked group to unlock of what it holds, and adds no image into it", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const keep = vi.spyOn(writing, "keep");
    const { added } = (await write("add", { elements: [arrow, arrow] }, writing, later())) as {
      added: { id: string }[];
    };
    const ids = added.map(({ id }) => id);
    const { group } = (await write("group", { ids }, writing, later())) as { group: string };
    await write("lock", { ids: [group], locked: true }, writing, later());
    const reading = {
      ...writing,
      unsaved: () => false,
      shown: () => undefined,
    } as unknown as Reading & Writing;
    const read = (await reply({ id: 1, tool: "board", args: {}, deadline: later() }, reading)) as {
      elements: { id: string; locked_by?: string }[];
    };
    expect(read.elements.find(({ id }) => id === ids[0])?.locked_by).toBe(group);
    const before = opened.editor.json();
    await expect(
      write("add_images", { images: [{ data: "", group }] }, writing, later()),
    ).rejects.toThrow("is locked");
    expect(opened.editor.json()).toBe(before);
    expect(keep).not.toHaveBeenCalled();
  });

  it("flips no group whose only images are locked, and says so", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const image = newId();
    const size = { width: 10, height: 10 };
    const kind = imageKind("a".repeat(64), size, { x: 0, y: 0, ...size });
    opened.editor.add(image, undefined, JSON.stringify(kind));
    opened.board = core.board(opened.editor);
    const { added } = (await write("add", { elements: [arrow] }, writing, later())) as {
      added: { id: string }[];
    };
    const ids = [image, ...added.map(({ id }) => id)];
    const { group } = (await write("group", { ids }, writing, later())) as { group: string };
    await write("lock", { ids: [image], locked: true }, writing, later());
    const before = opened.editor.json();
    await expect(
      write("transform", { ids: [group], flip: "horizontal" }, writing, later()),
    ).rejects.toThrow("locked");
    expect(opened.editor.json()).toBe(before);
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

  it("draws the stars and polygons an agent counts the corners of, and refuses the others", async () => {
    const opened = untitled();
    const { writing } = page(opened);
    const star = { type: "shape", x: 0, y: 0, shape: "star", corners: 7 };
    const pentagon = { type: "shape", x: 200, y: 0, shape: "polygon", corners: 5 };
    const { added } = (await write("add", { elements: [star, pentagon] }, writing, later())) as {
      added: { id: string }[];
    };
    const [pointed, sided] = added.map(({ id }) => id);
    const kindOf = (id: string) => opened.board.elements[id]!.kind;
    expect(kindOf(pointed!)).toMatchObject({ shape: "star", corners: 7 });
    // Five, as it comes, writes nothing.
    expect(kindOf(sided!)).not.toHaveProperty("corners");
    await write("update", { updates: [{ id: sided, corners: 12 }] }, writing, later());
    expect(kindOf(sided!)).toMatchObject({ corners: 12 });
    // Turned into a triangle, it counts its own three.
    await write("update", { updates: [{ id: pointed, shape: "triangle" }] }, writing, later());
    expect(kindOf(pointed!)).toMatchObject({ shape: "triangle" });
    expect(kindOf(pointed!)).not.toHaveProperty("corners");
    const before = opened.editor.json();
    await expect(
      write("update", { updates: [{ id: pointed, corners: 6 }] }, writing, later()),
    ).rejects.toThrow("is a triangle, which takes no corners");
    await expect(
      write("update", { updates: [{ id: sided, corners: 13 }] }, writing, later()),
    ).rejects.toThrow("`corners` is a whole number from 3 to 12, not 13");
    const ellipse = { type: "shape", x: 0, y: 200, shape: "ellipse", corners: 6 };
    await expect(write("add", { elements: [ellipse] }, writing, later())).rejects.toThrow(
      "A new ellipse takes no corners",
    );
    expect(opened.editor.json()).toBe(before);
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
