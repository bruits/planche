// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { refresh, untitled } from "./board.js";
import * as core from "./core.js";
import type { Kind } from "./core.js";
import { edits, type Edits, type Hooks } from "./edit.js";
import { closeMenu, openMenu } from "./menu.js";
import { overlay } from "./overlay.js";
import type { Renderer } from "./renderer.js";
import { view } from "./view.js";

const STICKY = "a".repeat(32);
const sticky: Kind = {
  type: "sticky",
  frame: { x: 0, y: 0, width: 100, height: 100 },
  rotation: 0,
  text: { content: "", font_size: 20 },
};

/** How each page's board goes once its test ends, so that what it listens to on the window stays still. */
const leaving: (() => void)[] = [];
afterEach(() => leaving.splice(0).forEach((leave) => leave()));

/** A board holding a sticky note, and `more`, shown at `zoom` from the origin. */
function page(
  more: [string, Kind][] = [],
  {
    drawing,
    snapping,
    zoom = 1,
  }: Partial<Pick<Hooks, "drawing" | "snapping">> & { zoom?: number } = {},
) {
  const opened = untitled();
  for (const [id, kind] of [[STICKY, sticky] as const, ...more]) {
    opened.editor.add(id, undefined, JSON.stringify(kind));
  }
  opened.board = core.board(opened.editor);
  const host = document.body.appendChild(document.createElement("div"));
  let editing: Edits | undefined;
  const viewport = view(host, {
    advance: () => editing?.catchUp(),
    frame() {},
    painted() {},
    failed(error) {
      throw error;
    },
  });
  // Draws nothing, as only where things are matters here.
  const renderer = {
    canvas: document.createElement("canvas"),
    resize() {},
    draw() {},
    destroy() {},
  };
  viewport.show(renderer as unknown as Renderer, { x: 0, y: 0, zoom });
  const hooks: Hooks = {
    changed: vi.fn<Hooks["changed"]>((touched) => refresh(opened, touched)),
    selectionChanged() {},
    settled() {},
    snapping: snapping ?? (() => false),
    drawing: drawing ?? (() => undefined),
    erasing: () => false,
    sampling: () => false,
    drawn() {},
    styled: (kind) => kind,
    selecting: () => true,
    hovered() {},
    pointed() {},
    stepped() {},
    inked: vi.fn<Hooks["inked"]>(),
  };
  let gone = false;
  leaving.push(() => (gone = true));
  editing = edits(viewport, overlay(host), () => (gone ? undefined : opened), hooks);
  const pointer = (
    type: string,
    clientX: number,
    clientY: number,
    { shiftKey = false, altKey = false } = {},
  ) =>
    host.dispatchEvent(
      new PointerEvent(type, {
        clientX,
        clientY,
        shiftKey,
        altKey,
        button: 0,
        pointerId: 1,
        bubbles: true,
      }),
    );
  const at = () => {
    const kind = core.element(opened.editor, STICKY)?.kind;
    return kind?.type === "sticky" ? { x: kind.frame.x, y: kind.frame.y } : undefined;
  };
  return { opened, editing, hooks, host, pointer, at };
}

/** Pressed on the page, `type` "keydown" or "keyup", and whether something took it. */
function key(type: string, init: KeyboardEventInit, target: EventTarget = document.body): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const IMAGE = "c".repeat(32);
/** Of samples/demo. */
const image: Kind = {
  type: "image",
  asset: "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f",
  natural_size: { width: 300, height: 200 },
  frame: { x: 200, y: 0, width: 300, height: 200 },
  rotation: 0,
  edits: { crop: null, flip_horizontal: false, flip_vertical: false, greyscale: false },
};

function cropOf(opened: ReturnType<typeof page>["opened"]) {
  const kind = core.element(opened.editor, IMAGE)?.kind;
  return kind?.type === "image" ? kind.edits : undefined;
}

function lower(editing: Edits, y: number) {
  editing.adjust((editor, touched) =>
    touched.push(
      ...editor.update(
        STICKY,
        JSON.stringify({ ...sticky, frame: { x: 0, y, width: 100, height: 100 } }),
      ),
    ),
  );
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

describe("edits", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("moves the selection once per frame, to where the pointer last went", async () => {
    const { hooks, pointer, at } = page();
    pointer("pointerdown", 50, 50);
    for (const x of [60, 70, 80, 90, 100]) {
      pointer("pointermove", x, 50);
    }
    expect(at()).toEqual({ x: 0, y: 0 });
    vi.mocked(hooks.changed).mockClear();
    await nextFrame();
    expect(at()).toEqual({ x: 50, y: 0 });
    expect(hooks.changed).toHaveBeenCalledOnce();
    pointer("pointerup", 100, 50);
  });

  it("undoes a drag in one step", async () => {
    const { editing, pointer, at } = page();
    pointer("pointerdown", 50, 50);
    for (const x of [60, 70, 80]) {
      pointer("pointermove", x, 50);
      await nextFrame();
    }
    pointer("pointerup", 80, 50);
    expect(at()).toEqual({ x: 30, y: 0 });
    editing.undo();
    expect(at()).toEqual({ x: 0, y: 0 });
  });

  it("keeps a move made before the frame when the pointer lets go", () => {
    const { pointer, at } = page();
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 90, 70);
    pointer("pointerup", 90, 70);
    expect(at()).toEqual({ x: 40, y: 20 });
  });

  it("moves a copy instead when the drag begins with Alt held, and undoes it in one step", async () => {
    const { opened, editing, pointer, at } = page();
    pointer("pointerdown", 50, 50, { altKey: true });
    for (const x of [60, 70, 80]) {
      pointer("pointermove", x, 50, { altKey: true });
      await nextFrame();
    }
    pointer("pointerup", 80, 50);
    expect(at()).toEqual({ x: 0, y: 0 });
    const [copy] = editing.selection();
    expect(new Set(Object.keys(opened.board.elements))).toEqual(new Set([STICKY, copy]));
    expect(core.element(opened.editor, copy!)?.kind).toMatchObject({
      type: "sticky",
      frame: { x: 30, y: 0 },
    });
    editing.undo();
    expect(Object.keys(opened.board.elements)).toEqual([STICKY]);
  });

  it("aligns the selection, and undoes it in one step", () => {
    const other = "b".repeat(32);
    const { opened, editing } = page([
      [other, { ...sticky, frame: { x: 300, y: 40, width: 100, height: 100 } }],
    ]);
    editing.select([STICKY, other]);
    editing.align("top");
    expect(core.element(opened.editor, other)?.kind).toMatchObject({ frame: { x: 300, y: 0 } });
    editing.undo();
    expect(core.element(opened.editor, other)?.kind).toMatchObject({ frame: { x: 300, y: 40 } });
  });

  it("keeps the selection through undo and redo of what moved part of it, and what stuck to that", () => {
    const other = "b".repeat(32);
    const pin = "d".repeat(32);
    const { opened, editing } = page([
      [other, { ...sticky, frame: { x: 300, y: 40, width: 100, height: 100 } }],
      [pin, { type: "comment", at: { x: 350, y: 90 }, text: "Here", target: other }],
    ]);
    editing.select([STICKY, other]);
    editing.align("top");
    expect(core.element(opened.editor, pin)?.kind).toMatchObject({ at: { x: 350, y: 50 } });
    editing.undo();
    expect(editing.selection()).toEqual([STICKY, other]);
    editing.redo();
    expect(editing.selection()).toEqual([STICKY, other]);
  });

  it("keeps the selection inside the group gone into through an undo", () => {
    const other = "b".repeat(32);
    const group = "c".repeat(32);
    const { editing } = page([
      [other, { ...sticky, frame: { x: 300, y: 40, width: 100, height: 100 } }],
    ]);
    editing.select([STICKY, other]);
    editing.group(group);
    editing.goInside();
    editing.select([STICKY, other]);
    editing.align("top");
    editing.undo();
    expect(editing.entered()).toBe(group);
    expect(editing.selection()).toEqual([STICKY, other]);
  });

  it("keeps the selection when an undo takes away all it touched", () => {
    const other = "b".repeat(32);
    const { editing } = page();
    editing.select([STICKY]);
    editing.apply((editor, touched) => {
      editor.add(other, undefined, JSON.stringify(sticky));
      touched.push(other);
    });
    editing.select([STICKY]);
    editing.undo();
    expect(editing.selection()).toEqual([STICKY]);
  });

  it("selects what an undo brings back, though it sticks to what is selected", () => {
    const pin = "d".repeat(32);
    const { editing } = page([
      [pin, { type: "comment", at: { x: 50, y: 50 }, text: "Here", target: STICKY }],
    ]);
    editing.select([pin]);
    editing.remove();
    editing.select([STICKY]);
    editing.undo();
    expect(editing.selection()).toEqual([pin]);
  });

  it("selects what an undo brings back", () => {
    const other = "b".repeat(32);
    const { editing } = page([
      [other, { ...sticky, frame: { x: 300, y: 40, width: 100, height: 100 } }],
    ]);
    editing.select([STICKY]);
    editing.remove();
    editing.select([other]);
    editing.undo();
    expect(editing.selection()).toEqual([STICKY]);
  });

  it("undoes in one step an edit applied from outside, as an agent's", () => {
    const { editing, at } = page();
    editing.apply((editor, touched) => {
      touched.push(...editor.translate([STICKY], 10, 0));
      touched.push(...editor.translate([STICKY], 0, 20));
    });
    expect(at()).toEqual({ x: 10, y: 20 });
    editing.undo();
    expect(at()).toEqual({ x: 0, y: 0 });
  });

  it("refuses an edit from outside while the user drags", () => {
    const { editing, pointer, at } = page();
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 90, 50);
    expect(() =>
      editing.apply((editor, touched) => touched.push(...editor.translate([STICKY], 0, 20))),
    ).toThrow("Someone is editing in Planche");
    pointer("pointerup", 90, 50);
    expect(at()).toEqual({ x: 40, y: 0 });
  });

  it("holds what is adjusted open, keeping others out, and undoes it in one step", async () => {
    const { editing, pointer, at } = page();
    lower(editing, 10);
    lower(editing, 30);
    expect(at()).toEqual({ x: 0, y: 30 });
    expect(() =>
      editing.apply((editor, touched) => touched.push(...editor.translate([STICKY], 0, 20))),
    ).toThrow("Someone is editing in Planche");
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 90, 50);
    await nextFrame();
    pointer("pointerup", 90, 50);
    editing.undo();
    expect(at()).toEqual({ x: 0, y: 30 });
    const idle = vi.fn<() => void>();
    const waited = editing.idle().then(idle);
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
    editing.finishAdjusting();
    await waited;
    editing.undo();
    expect(at()).toEqual({ x: 0, y: 0 });
  });

  it("takes back all it adjusted once a step throws, and lets others in", async () => {
    const { editing, at } = page();
    lower(editing, 10);
    expect(() =>
      editing.adjust(() => {
        throw new Error("Not there");
      }),
    ).toThrow("Not there");
    expect(at()).toEqual({ x: 0, y: 0 });
    await editing.idle();
    expect(editing.adjusting()).toBe(false);
  });

  it("lets go of what is adjusted once its board goes, waking who waits", async () => {
    const { opened, editing, at } = page();
    lower(editing, 10);
    const waited = editing.idle();
    // As the app does once another board opens.
    const next = untitled();
    next.editor.add(STICKY, undefined, JSON.stringify(sticky));
    opened.editor = next.editor;
    opened.board = core.board(next.editor);
    editing.reset();
    await waited;
    editing.apply((editor, touched) => touched.push(...editor.translate([STICKY], 0, 20)));
    expect(at()).toEqual({ x: 0, y: 20 });
  });

  it("selects the comments pinned within a marquee", async () => {
    const pinned: Kind = { type: "comment", at: { x: 150, y: 150 }, text: "Why here?" };
    const COMMENT = "b".repeat(32);
    const { editing, pointer } = page([[COMMENT, pinned]]);
    pointer("pointerdown", 130, 130);
    pointer("pointermove", 170, 170);
    await nextFrame();
    pointer("pointerup", 170, 170);
    expect(editing.selection()).toEqual([COMMENT]);
  });

  it("keeps an arrow drawn with Shift held at a multiple of 45°", async () => {
    const { opened, pointer } = page([], { drawing: () => "arrow" });
    pointer("pointerdown", 200, 0);
    pointer("pointermove", 300, 90, { shiftKey: true });
    await nextFrame();
    pointer("pointerup", 300, 90, { shiftKey: true });
    const [from, to] = Object.values(opened.board.elements).flatMap(({ kind }) =>
      kind.type === "arrow" ? [kind.from, kind.to] : [],
    );
    expect(from).toEqual({ x: 200, y: 0 });
    expect(to!.x - from!.x).toBeCloseTo(to!.y - from!.y, 9);
    expect(to!.x - from!.x).toBeCloseTo(Math.hypot(100, 90) * Math.SQRT1_2, 9);
  });
});

/** A board whose image is being cropped, from its whole. */
function cropping() {
  const shown = page([[IMAGE, image]]);
  shown.editing.select([IMAGE]);
  shown.editing.crop();
  return shown;
}

describe("cropping", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps the crop's proportions while Shift drags a corner, to a pixel", () => {
    const { opened, pointer } = cropping();
    pointer("pointerdown", 500, 200);
    pointer("pointermove", 400, 180, { shiftKey: true });
    pointer("pointerup", 400, 180, { shiftKey: true });
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 0, y: 0, width: 222, height: 148 });
  });

  it("keeps the proportions within the image, growing as far as it lets", () => {
    const kept = { x: 100, y: 0, width: 150, height: 100 };
    const { opened, editing, pointer } = page([
      [IMAGE, { ...image, edits: { ...image.edits, crop: kept } }],
    ]);
    editing.select([IMAGE]);
    editing.crop();
    const corner = core.pointOfPixel(opened.editor, IMAGE, { x: 250, y: 100 })!;
    pointer("pointerdown", corner.x, corner.y);
    pointer("pointermove", corner.x + 400, corner.y + 400, { shiftKey: true });
    pointer("pointerup", corner.x + 400, corner.y + 400, { shiftKey: true });
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 100, y: 0, width: 200, height: 133 });
  });

  it("drags a corner freely without Shift", () => {
    const { opened, pointer } = cropping();
    pointer("pointerdown", 500, 200);
    pointer("pointermove", 400, 180);
    pointer("pointerup", 400, 180);
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 0, y: 0, width: 200, height: 180 });
  });

  it("grows a side dragged with Shift around the crop's centre line, within the image", () => {
    const { opened, pointer } = cropping();
    pointer("pointerdown", 500, 100);
    pointer("pointermove", 350, 100, { shiftKey: true });
    pointer("pointerup", 350, 100, { shiftKey: true });
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 0, y: 50, width: 150, height: 100 });
  });

  it("keeps the proportions once Shift goes down mid-drag", async () => {
    const { opened, pointer } = cropping();
    pointer("pointerdown", 500, 200);
    pointer("pointermove", 400, 180);
    await nextFrame();
    key("keydown", { key: "Shift", shiftKey: true });
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 0, y: 0, width: 222, height: 148 });
    pointer("pointerup", 400, 180);
  });

  it("lets go of the proportions once Shift comes up mid-drag", async () => {
    const { opened, pointer } = cropping();
    pointer("pointerdown", 500, 200);
    pointer("pointermove", 400, 180, { shiftKey: true });
    await nextFrame();
    key("keyup", { key: "Shift" });
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 0, y: 0, width: 200, height: 180 });
    pointer("pointerup", 400, 180);
  });

  it("turns the crop between portrait and landscape with X, as large as the image lets it", () => {
    const { opened, editing } = cropping();
    expect(key("keydown", { key: "x" })).toBe(true);
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 84, y: 0, width: 133, height: 200 });
    editing.undo();
    expect(cropOf(opened)?.crop).toBeFalsy();
  });

  it("shows the guides of each composition over the crop in turn with O", () => {
    const { host } = cropping();
    const segments = () =>
      (host.querySelector(".crop-guides.line")?.getAttribute("d") ?? "").split("M").length - 1;
    expect(segments()).toBe(0);
    const shown = [1, 2, 3, 4].map(() => {
      expect(key("keydown", { key: "o" })).toBe(true);
      return segments();
    });
    expect(shown).toEqual([4, 4, 2, 0]);
  });

  it("leaves X and O to the tools when nothing is being cropped, or with a modifier", () => {
    cropping();
    expect(key("keydown", { key: "x", metaKey: true })).toBe(false);
    key("keydown", { key: "Escape" });
    expect(key("keydown", { key: "x" })).toBe(false);
    expect(key("keydown", { key: "o" })).toBe(false);
  });

  it("changes the shape of the crop under way", () => {
    const { opened, editing } = cropping();
    editing.cropShape("ellipse");
    expect(editing.croppedAs()).toBe("ellipse");
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop_shape).toBe("ellipse");
  });
});

describe("nudging", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("moves the selection a CSS pixel with an arrow key, or ten with Shift", () => {
    const { editing, at } = page([], { zoom: 2 });
    editing.select([STICKY]);
    expect(key("keydown", { key: "ArrowRight" })).toBe(true);
    key("keyup", { key: "ArrowRight" });
    expect(at()).toEqual({ x: 0.5, y: 0 });
    key("keydown", { key: "ArrowUp", shiftKey: true });
    key("keyup", { key: "ArrowUp" });
    expect(at()).toEqual({ x: 0.5, y: -5 });
  });

  it("moves by the grid's step while snapping to the grid shown", () => {
    const { opened, editing, at } = page([], { snapping: () => true });
    core.setBackground(opened.editor, "grid");
    opened.board = core.board(opened.editor);
    editing.select([STICKY]);
    key("keydown", { key: "ArrowDown" });
    key("keyup", { key: "ArrowDown" });
    expect(at()).toEqual({ x: 0, y: 20 });
  });

  it("holds a held key's moves as one edit, keeping others out until it comes up", async () => {
    const { editing, at } = page();
    editing.select([STICKY]);
    key("keydown", { key: "ArrowLeft" });
    key("keydown", { key: "ArrowLeft", repeat: true });
    key("keydown", { key: "ArrowLeft", repeat: true });
    expect(at()).toEqual({ x: -3, y: 0 });
    expect(() => editing.apply(() => {})).toThrow("Someone is editing in Planche");
    key("keyup", { key: "ArrowLeft" });
    await editing.idle();
    editing.undo();
    expect(at()).toEqual({ x: 0, y: 0 });
  });

  it("ends a move once ⌘ goes down, as macOS then sends no keyup", async () => {
    const { editing, at } = page();
    editing.select([STICKY]);
    key("keydown", { key: "ArrowRight" });
    key("keydown", { key: "Meta", metaKey: true });
    await editing.idle();
    editing.undo();
    expect(at()).toEqual({ x: 0, y: 0 });
  });

  it("leaves the keys alone with nothing selected, a modifier held, or a field focused", () => {
    const { editing, at } = page();
    expect(key("keydown", { key: "ArrowRight" })).toBe(false);
    editing.select([STICKY]);
    expect(key("keydown", { key: "ArrowRight", altKey: true })).toBe(false);
    const field = document.body.appendChild(document.createElement("textarea"));
    expect(key("keydown", { key: "ArrowRight" }, field)).toBe(false);
    const slider = document.body.appendChild(document.createElement("input"));
    slider.type = "range";
    expect(key("keydown", { key: "ArrowRight" }, slider)).toBe(false);
    expect(at()).toEqual({ x: 0, y: 0 });
  });

  it("leaves the selection still as the arrow keys move within a menu", () => {
    const { editing, at } = page();
    editing.select([STICKY]);
    openMenu([{ label: "Copy", run() {} }], { label: "Selection", place: { x: 10, y: 10 } });
    const item = document.activeElement!;
    key("keydown", { key: "ArrowRight" }, item);
    key("keydown", { key: "ArrowLeft" }, item);
    closeMenu();
    expect(at()).toEqual({ x: 0, y: 0 });
  });

  it("sets down what it moves, as a drag does", () => {
    const { opened, editing } = page([[IMAGE, image]]);
    const note = "d".repeat(32);
    opened.editor.add(
      note,
      undefined,
      JSON.stringify({ ...sticky, frame: { x: 300, y: 50, width: 50, height: 50 } }),
    );
    opened.board = core.board(opened.editor);
    editing.select([note]);
    key("keydown", { key: "ArrowRight" });
    key("keyup", { key: "ArrowRight" });
    expect(core.element(opened.editor, note)?.kind).toMatchObject({ target: IMAGE });
  });
});

function strokes(opened: ReturnType<typeof page>["opened"]) {
  return Object.values(opened.board.elements).flatMap(({ kind }) =>
    kind.type === "stroke" ? [kind] : [],
  );
}

describe("the pen", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("draws each position the pointer passed, smoothed, as one edit that leaves it to draw again", async () => {
    const { opened, editing, hooks, host, pointer } = page([], { drawing: () => "stroke" });
    pointer("pointerdown", 200, 200);
    // Merged into one move, as engines may send them.
    const passed = [
      new PointerEvent("pointermove", { clientX: 100, clientY: 300, pointerId: 1 }),
      new PointerEvent("pointermove", { clientX: 300, clientY: 300, pointerId: 1 }),
    ];
    host.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 300,
        clientY: 300,
        pointerId: 1,
        bubbles: true,
        coalescedEvents: passed,
      }),
    );
    await nextFrame();
    expect(hooks.inked).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "stroke" }));
    pointer("pointerup", 300, 300);
    expect(hooks.inked).toHaveBeenLastCalledWith(undefined);
    // Halfway to each position from the last point, (150, 250), then (225, 275), which lies on
    // the line from there to (300, 300), where it was let go.
    const [stroke] = strokes(opened);
    expect(stroke?.frame).toEqual({ x: 150, y: 200, width: 150, height: 100 });
    expect(stroke?.points).toEqual([0.33333, 0, 0, 0.5, 1, 1]);
    expect(editing.selection()).toEqual([]);
    editing.undo();
    expect(strokes(opened)).toEqual([]);
  });

  it("leaves a dot for a click", () => {
    const { opened, pointer } = page([], { drawing: () => "stroke" });
    pointer("pointerdown", 200, 200);
    pointer("pointerup", 200, 200);
    expect(strokes(opened)).toMatchObject([
      { frame: { x: 200, y: 200, width: 0, height: 0 }, points: [0, 0] },
    ]);
  });

  it("draws straight from where it was pressed, by steps of 45°, while ⇧ is held", async () => {
    const { opened, pointer } = page([], { drawing: () => "stroke" });
    pointer("pointerdown", 200, 200);
    pointer("pointermove", 260, 300, { shiftKey: true });
    await nextFrame();
    pointer("pointerup", 300, 290, { shiftKey: true });
    const [stroke] = strokes(opened);
    expect(stroke?.points).toHaveLength(4);
    expect(stroke?.frame.width).toBeCloseTo(stroke?.frame.height ?? 0);
  });

  it("draws nothing once the press is lost", async () => {
    const { opened, hooks, pointer } = page([], { drawing: () => "stroke" });
    pointer("pointerdown", 200, 200);
    pointer("pointermove", 300, 300);
    await nextFrame();
    pointer("pointercancel", 300, 300);
    expect(strokes(opened)).toEqual([]);
    expect(hooks.inked).toHaveBeenLastCalledWith(undefined);
  });

  it("puts what it draws in the group gone into", async () => {
    const other = "b".repeat(32);
    const group = "c".repeat(32);
    const { opened, editing, pointer } = page(
      [[other, { ...sticky, frame: { x: 300, y: 40, width: 100, height: 100 } }]],
      { drawing: () => "stroke" },
    );
    editing.select([STICKY, other]);
    editing.group(group);
    editing.goInside();
    pointer("pointerdown", 200, 300);
    pointer("pointermove", 260, 360);
    await nextFrame();
    pointer("pointerup", 260, 360);
    const drawn = Object.values(opened.board.elements).filter(({ kind }) => kind.type === "stroke");
    expect(drawn).toMatchObject([{ group }]);
    expect(editing.entered()).toBe(group);
  });

  it("lets go of the selection once pressed", () => {
    const { editing, pointer } = page([], { drawing: () => "stroke" });
    editing.select([STICKY]);
    pointer("pointerdown", 200, 200);
    expect(editing.selection()).toEqual([]);
    pointer("pointerup", 200, 200);
  });

  it("turns straight, or back, as ⇧ is pressed or let go while the pointer stays still", async () => {
    const { opened, hooks, pointer } = page([], { drawing: () => "stroke" });
    const shown = () => vi.mocked(hooks.inked).mock.lastCall?.[0]?.points.length;
    pointer("pointerdown", 200, 200);
    pointer("pointermove", 260, 300);
    await nextFrame();
    expect(shown()).toBe(3);
    key("keydown", { key: "Shift", shiftKey: true });
    expect(shown()).toBe(2);
    key("keyup", { key: "Shift" });
    expect(shown()).toBe(3);
    key("keydown", { key: "Shift", shiftKey: true });
    pointer("pointerup", 260, 300);
    const [stroke] = strokes(opened);
    expect(stroke?.points).toHaveLength(4);
  });

  it("forgets what it was drawing once its board goes", () => {
    const { opened, editing, hooks, pointer } = page([], { drawing: () => "stroke" });
    pointer("pointerdown", 200, 200);
    expect(hooks.inked).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "stroke" }));
    editing.reset();
    expect(hooks.inked).toHaveBeenLastCalledWith(undefined);
    pointer("pointerup", 200, 200);
    expect(strokes(opened)).toEqual([]);
  });
});
