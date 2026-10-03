// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { refresh, untitled } from "./board.js";
import * as core from "./core.js";
import type { Kind } from "./core.js";
import { edits, type Edits, type Hooks } from "./edit.js";
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

/** A board holding a sticky note, and `more`, shown at 1:1 from the origin. */
function page(more: [string, Kind][] = [], { drawing }: Partial<Pick<Hooks, "drawing">> = {}) {
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
  viewport.show(renderer as unknown as Renderer, { x: 0, y: 0, zoom: 1 });
  const hooks: Hooks = {
    changed: vi.fn<Hooks["changed"]>((touched) => refresh(opened, touched)),
    selectionChanged() {},
    settled() {},
    snapping: () => false,
    drawing: drawing ?? (() => undefined),
    erasing: () => false,
    sampling: () => false,
    drawn() {},
    styled: (kind) => kind,
    selecting: () => true,
    hovered() {},
    pointed() {},
    stepped() {},
  };
  editing = edits(viewport, overlay(host), () => opened, hooks);
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
  return { opened, editing, hooks, pointer, at };
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
