// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { refresh, untitled } from "./board.js";
import * as core from "./core.js";
import type { Board, Kind, Point } from "./core.js";
import { fit } from "./camera.js";
import { edits, type Edits, type Hooks } from "./edit.js";
import { closeMenu, openMenu } from "./menu.js";
import { overlay } from "./overlay.js";
import type { Renderer } from "./renderer.js";
import { titles } from "./titles.js";
import { view } from "./view.js";

const STICKY = "a".repeat(32);
const sticky: Extract<Kind, { type: "sticky" }> = {
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
    erasing,
    snapping,
    aligning,
    showsAnnotations,
    reveal,
    zoom = 1,
  }: Partial<
    Pick<Hooks, "drawing" | "erasing" | "snapping" | "aligning" | "showsAnnotations" | "reveal">
  > & {
    zoom?: number;
  } = {},
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
    panned() {},
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
    aligning: aligning ?? (() => false),
    showsAnnotations: showsAnnotations ?? (() => true),
    reveal: reveal ?? (() => {}),
    drawing: drawing ?? (() => undefined),
    erasing: erasing ?? (() => false),
    sampling: () => false,
    drawn() {},
    styled: (kind) => kind,
    selecting: () => true,
    hovered() {},
    pointed() {},
    stepped() {},
    retitle: vi.fn<Hooks["retitle"]>(),
    inked: vi.fn<Hooks["inked"]>(),
  };
  let gone = false;
  leaving.push(() => (gone = true));
  editing = edits(viewport, overlay(host), () => (gone ? undefined : opened), hooks);
  const pointer = (
    type: string,
    clientX: number,
    clientY: number,
    {
      shiftKey = false,
      altKey = false,
      free = false,
      finger,
    }: { shiftKey?: boolean; altKey?: boolean; free?: boolean; finger?: number } = {},
  ) =>
    host.dispatchEvent(
      new PointerEvent(type, {
        clientX,
        clientY,
        shiftKey,
        altKey,
        // ⌘ on macOS, Ctrl elsewhere.
        metaKey: free,
        ctrlKey: free,
        button: 0,
        pointerId: finger ?? 1,
        pointerType: finger === undefined ? "mouse" : "touch",
        bubbles: true,
      }),
    );
  const at = () => {
    const kind = core.element(opened.editor, STICKY)?.kind;
    return kind?.type === "sticky" ? { x: kind.frame.x, y: kind.frame.y } : undefined;
  };
  return { opened, editing, hooks, host, viewport, pointer, at };
}

/** As the page shows a board mirrored across a viewport 400 CSS pixels wide. */
function mirrored(host: HTMLElement, viewport: ReturnType<typeof view>) {
  host.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  viewport.mirror(true);
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
  asset: "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png",
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

/**
 * `beneath`, and above it a sticky note at (300, 0), 100 wide and tall, turned by `rotation` degrees,
 * selected and pressed at `x` and `y`.
 */
function turning(beneath: Kind, x: number, y: number, zoom = 1, rotation = 0) {
  const [below, top] = ["b".repeat(32), "d".repeat(32)];
  const { editing, pointer } = page(
    [
      [below, beneath],
      [top, { ...sticky, rotation, frame: { x: 300, y: 0, width: 100, height: 100 } }],
    ],
    { zoom },
  );
  editing.select([top]);
  pointer("pointerdown", x, y);
  const grab = editing.grab();
  pointer("pointerup", x, y);
  return { grab, selection: editing.selection(), below };
}

describe("edits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("moves the selection as the pointer goes over a mirrored board", () => {
    const { host, viewport, pointer, at } = page();
    mirrored(host, viewport);
    pointer("pointerdown", 350, 50);
    pointer("pointermove", 330, 60);
    pointer("pointerup", 330, 60);
    expect(at()).toEqual({ x: 20, y: 10 });
  });

  it("writes in a mirrored board's note where it shows, mirrored as it draws", () => {
    // As happy-dom measures no text.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: () => ({ width: 0, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 }),
    } as unknown as CanvasRenderingContext2D);
    const { editing, host, viewport } = page();
    mirrored(host, viewport);
    editing.write(STICKY);
    const field = document.querySelector<HTMLTextAreaElement>("textarea.writer")!;
    // From 0 to 100 on the board, so from 300 to 400 on the page.
    expect(field.style.left).toBe("300px");
    expect(field.style.transform).toBe("scaleX(-1) rotate(0deg)");
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

  it("shows an image at its actual size, and undoes it in one step", () => {
    const { opened, editing } = page([
      [IMAGE, { ...image, frame: { x: 200, y: 0, width: 600, height: 400 }, rotation: 30 }],
    ]);
    editing.select([IMAGE]);
    editing.actualSize();
    const shown = core.element(opened.editor, IMAGE)!.kind;
    expect(shown).toMatchObject({ frame: { x: 350, y: 100, width: 300, height: 200 } });
    expect(core.rotationOf(shown)).toBe(0);
    editing.undo();
    expect(core.element(opened.editor, IMAGE)?.kind).toMatchObject({
      frame: { x: 200, y: 0, width: 600, height: 400 },
      rotation: 30,
    });
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

  it("turns from just outside a corner, over what lies beneath it", async () => {
    const other = "b".repeat(32);
    const { opened, editing, pointer } = page([
      [other, { ...sticky, frame: { x: 20, y: 20, width: 50, height: 50 } }],
    ]);
    editing.select([other]);
    // Over the sticky note beneath, 11 pixels out from the top-right corner, at (70, 20).
    pointer("pointerdown", 78, 12);
    expect(editing.grab()).toBe("turn");
    pointer("pointermove", 90, 60);
    await nextFrame();
    pointer("pointerup", 90, 60);
    const turned = (id: string) => core.rotationOf(core.element(opened.editor, id)!.kind);
    expect(editing.selection()).toEqual([other]);
    expect(turned(other)).not.toBe(0);
    expect(turned(STICKY)).toBe(0);
    expect(core.element(opened.editor, STICKY)?.kind).toMatchObject({ frame: sticky.frame });
  });

  it("shows the turn grip from just outside a corner, over what lies beneath it", async () => {
    const other = "b".repeat(32);
    const { editing, pointer } = page([
      [other, { ...sticky, frame: { x: 20, y: 20, width: 50, height: 50 } }],
    ]);
    editing.select([other]);
    pointer("pointermove", 78, 12);
    await nextFrame();
    expect(editing.grab()).toBe("turn");
  });

  it("leaves a press just outside a corner to what lies above the selection", () => {
    const above = "b".repeat(32);
    const { editing, pointer } = page([
      [above, { ...sticky, frame: { x: 80, y: -40, width: 60, height: 60 } }],
    ]);
    editing.select([STICKY]);
    // On the sticky note poking out, 11 pixels out from the top-right corner, at (100, 0).
    pointer("pointerdown", 108, -8);
    expect(editing.grab()).toBeUndefined();
    pointer("pointerup", 108, -8);
    expect(editing.selection()).toEqual([above]);
  });

  it("leaves a press just outside a corner to what lies beneath but beside the selection", () => {
    const around: Kind = {
      type: "shape",
      frame: { x: 290, y: -10, width: 120, height: 120 },
      shape: "rectangle",
      text: { content: "", font_size: 20 },
    };
    const besides: [Kind, number, number][] = [
      [{ ...sticky, frame: { x: 400, y: 0, width: 100, height: 100 } }, 411, 5],
      // As floats land a hair over the side shared.
      [{ ...sticky, frame: { x: 399.99, y: 0, width: 100, height: 100 } }, 411, 5],
      // The same on the other sides.
      [{ ...sticky, frame: { x: 200.01, y: 0, width: 100, height: 100 } }, 289, 5],
      [{ ...sticky, frame: { x: 300, y: -99.99, width: 100, height: 100 } }, 312, -10],
      [{ ...sticky, frame: { x: 300, y: 99.99, width: 100, height: 100 } }, 312, 110],
      // Past the corner, though its frame is over the selection.
      [
        core.strokeKind(
          [
            { x: 380, y: -30 },
            { x: 430, y: 20 },
          ],
          0,
        ),
        410,
        0,
      ],
      // Around it, which its inside lets through.
      [around, 405, -10],
    ];
    for (const [kind, x, y] of besides) {
      const { grab, selection, below } = turning(kind, x, y);
      expect(grab).toBeUndefined();
      expect(selection).toEqual([below]);
    }
  });

  it("leaves a press just outside a corner to what lies beside the selection, zoomed out", () => {
    // A screen pixel spans two board units, so overlapping by one and a half is still beside.
    for (const x of [420, 398.5]) {
      const { grab, selection, below } = turning(
        { ...sticky, frame: { x, y: 0, width: 100, height: 100 } },
        211,
        1,
        0.5,
      );
      expect(grab).toBeUndefined();
      expect(selection).toEqual([below]);
    }
  });

  it("turns over what lies beneath once it overlaps the selection by a screen pixel, zoomed out", () => {
    const { grab } = turning(
      { ...sticky, frame: { x: 397.5, y: 0, width: 100, height: 100 } },
      211,
      1,
      0.5,
    );
    expect(grab).toBe("turn");
  });

  it("goes by the sides of a turned selection, not by its upright bounds", () => {
    // The neighbour's bottom-left corner lies 0.5 and 2.3 units inside the top-right side.
    const shallow = turning(
      { ...sticky, frame: { x: 415, y: -55, width: 100, height: 100 } },
      428,
      38,
      1,
      45,
    );
    expect(shallow.grab).toBeUndefined();
    expect(shallow.selection).toEqual([shallow.below]);
    const deep = turning(
      { ...sticky, frame: { x: 415, y: -52.5, width: 100, height: 100 } },
      428,
      38,
      1,
      45,
    );
    expect(deep.grab).toBe("turn");
  });

  it("goes by the draw order of the whole board, not by siblings, once inside a group", () => {
    const [group, far, above] = ["b", "d", "e"].map((letter) => letter.repeat(32)) as [
      string,
      string,
      string,
    ];
    const { opened, editing, pointer } = page([
      [far, { ...sticky, frame: { x: 300, y: 300, width: 60, height: 60 } }],
    ]);
    opened.editor.group(group, [STICKY, far]);
    opened.editor.add(
      above,
      undefined,
      JSON.stringify({ ...sticky, frame: { x: 80, y: -40, width: 60, height: 60 } }),
    );
    opened.board = core.board(opened.editor);
    editing.select([group]);
    editing.goInside();
    editing.select([STICKY]);
    pointer("pointerdown", 108, -8);
    expect(editing.grab()).toBeUndefined();
    pointer("pointerup", 108, -8);
    expect(editing.selection()).toEqual([above]);
  });

  it("leaves what lies beyond the turn's reach of a corner to a press", () => {
    const other = "b".repeat(32);
    const { editing, pointer } = page([
      [other, { ...sticky, frame: { x: 20, y: 20, width: 50, height: 50 } }],
    ]);
    editing.select([other]);
    pointer("pointerdown", 85, 5);
    expect(editing.grab()).toBeUndefined();
    pointer("pointerup", 85, 5);
    expect(editing.selection()).toEqual([STICKY]);
  });
});

/** The sticky note and `more`, in a viewport 600 by 400 CSS pixels. */
function viewed(more: [string, Kind][]) {
  const shown = page(more);
  Object.defineProperties(shown.host, {
    clientWidth: { value: 600 },
    clientHeight: { value: 400 },
  });
  const twice = (clientX: number, clientY: number) => {
    for (const type of ["pointerdown", "pointerup", "pointerdown", "pointerup"]) {
      shown.pointer(type, clientX, clientY);
    }
    shown.host.dispatchEvent(
      new MouseEvent("dblclick", { clientX, clientY, button: 0, bubbles: true }),
    );
  };
  return { ...shown, twice };
}

describe("a double-click", () => {
  const BESIDE = "d".repeat(32);
  const next: Kind = { ...image, frame: { x: 500, y: 0, width: 300, height: 200 } };
  /** The image, and another just right of it. */
  const images = () =>
    viewed([
      [IMAGE, image],
      [BESIDE, next],
    ]);
  const size = { width: 600, height: 400 };
  const start = { x: 0, y: 0, zoom: 1 };

  it("zooms to an image, and back to the view it left once on it again", () => {
    const { editing, viewport, twice } = images();
    twice(350, 100);
    expect(viewport.camera()).toEqual(fit({ x: 200, y: 0, width: 300, height: 200 }, size));
    expect(editing.cropping()).toBeUndefined();
    // The image's centre, now in the viewport's.
    twice(300, 200);
    expect(viewport.camera()).toEqual(start);
  });

  it("zooms from one image to another, then back to the view the first left", () => {
    const { viewport, twice } = images();
    twice(350, 100);
    // The other image, at the right edge.
    twice(590, 200);
    expect(viewport.camera()).toEqual(fit({ x: 500, y: 0, width: 300, height: 200 }, size));
    twice(300, 200);
    expect(viewport.camera()).toEqual(start);
  });

  it("zooms to an image again once the view moved away from it", () => {
    const { viewport, twice } = images();
    twice(350, 100);
    const zoomed = viewport.camera()!;
    viewport.look({ ...zoomed, x: zoomed.x + 10 });
    twice(300, 200);
    expect(viewport.camera()).toEqual(zoomed);
  });

  it("writes in a sticky note rather than zoom to it", () => {
    const { editing, viewport, twice } = images();
    twice(50, 50);
    expect(viewport.camera()).toEqual(start);
    expect(editing.writing()).toBe(STICKY);
  });

  it("zooms to a stroke, an arrow, or a line", () => {
    const LINED = "e".repeat(32);
    const from = { x: 100, y: 250 };
    const to = { x: 400, y: 350 };
    const kinds: Kind[] = [
      core.strokeKind([from, to], 0),
      { type: "arrow", from, to },
      { type: "line", from, to },
    ];
    for (const kind of kinds) {
      const { opened, viewport, twice } = images();
      opened.editor.add(LINED, undefined, JSON.stringify(kind));
      opened.board = core.board(opened.editor);
      // Halfway along it.
      twice(250, 300);
      const area = core.extent(opened.editor, [LINED])!;
      expect(viewport.camera()).toEqual(fit(area, size));
    }
  });

  it("goes back from a double-click on nothing, where what it zoomed to was", () => {
    const area = { x: 150, y: 0, width: 100, height: 300 };
    const { viewport, twice } = viewed([[IMAGE, { ...image, frame: area }]]);
    twice(160, 200);
    const zoomed = viewport.camera()!;
    expect(zoomed).toEqual(fit(area, size));
    // Centred, it now starts right of the pointer.
    expect((area.x - zoomed.x) * zoomed.zoom).toBeGreaterThan(160);
    twice(160, 200);
    expect(viewport.camera()).toEqual(start);
  });

  it("does nothing on nothing once the view moved away from what it zoomed to", () => {
    const { viewport, twice } = images();
    twice(350, 100);
    const moved = { ...viewport.camera()!, y: 300 };
    viewport.look(moved);
    twice(300, 20);
    expect(viewport.camera()).toEqual(moved);
  });
});

/** A board whose image is being cropped, from its whole. */
function cropping() {
  const shown = page([[IMAGE, image]]);
  shown.editing.select([IMAGE]);
  shown.editing.crop();
  return shown;
}

/**
 * Sticky notes beside the one that moves, each at its own top-left, 100 wide and tall unless
 * told, in a window that shows them.
 */
function beside(
  corners: (Point & { width?: number; height?: number })[],
  options: Partial<Pick<Hooks, "snapping" | "aligning" | "drawing">> = {},
) {
  // As happy-dom measures no text, which a sticky note fits as it stretches.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: () => ({ width: 0, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 }),
  } as unknown as CanvasRenderingContext2D);
  const others = corners.map((corner, at): [string, Kind] => [
    String(at).repeat(32),
    { ...sticky, frame: { width: 100, height: 100, ...corner } },
  ]);
  const shown = page(others, { aligning: () => true, ...options });
  Object.defineProperties(shown.host, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
  });
  const frame = () => {
    const kind = core.element(shown.opened.editor, STICKY)?.kind;
    return kind?.type === "sticky" ? kind.frame : undefined;
  };
  return { ...shown, frame };
}

function linedUp(host: HTMLElement, part: string): string | null | undefined {
  return host.querySelector(`.lineup .${part}`)?.getAttribute("d");
}

const NOTE = "f".repeat(32);

/** In a face no other test measures, as measures stay with each face. */
function written(opened: ReturnType<typeof page>["opened"]) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text: string) => ({
      width: text.length * 50,
      fontBoundingBoxAscent: 80,
      fontBoundingBoxDescent: 20,
      actualBoundingBoxAscent: 70,
    }),
  } as unknown as CanvasRenderingContext2D);
  const note = {
    type: "note",
    frame: { x: 0, y: 150, width: 40, height: 150 },
    rotation: 0,
    text: { content: "aa bb cc dd ee ff", font_size: 20, bold: true, italic: true },
  } as const;
  opened.editor.add(NOTE, undefined, JSON.stringify(note));
  opened.board = core.board(opened.editor);
  return note;
}

describe("lining up", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("lines a move up with a side of what is beside it, showing how until let go", async () => {
    const { host, pointer, at } = beside([{ x: 300, y: 200 }]);
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 246, 50);
    await nextFrame();
    expect(at()).toEqual({ x: 200, y: 0 });
    expect(linedUp(host, "bridges")).toBe("M300 200L300 100");
    pointer("pointerup", 246, 50);
    expect(linedUp(host, "bridges")).toBe("");
  });

  it("keeps as far from the next one as others stand apart, showing each gap alike", async () => {
    const { host, pointer, at } = beside([
      { x: 140, y: 0 },
      { x: 280, y: 0 },
    ]);
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 473, 50);
    await nextFrame();
    expect(at()).toEqual({ x: 420, y: 0 });
    expect(linedUp(host, "gaps")).toContain("M240 50L280 50");
    expect(linedUp(host, "gaps")).toContain("M380 50L420 50");
    pointer("pointerup", 473, 50);
    expect(linedUp(host, "gaps")).toBe("");
  });

  it("scales a side onto what is beside it, from the dot on a corner", async () => {
    const { opened, editing, host, pointer } = beside([{ x: 250, y: 300 }]);
    editing.select([STICKY]);
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 247, 247);
    await nextFrame();
    expect(core.element(opened.editor, STICKY)?.kind).toMatchObject({
      frame: { x: 0, y: 0, width: 250, height: 250 },
    });
    expect(linedUp(host, "bridges")).toBe("M250 300L250 250");
    pointer("pointerup", 247, 247);
    expect(linedUp(host, "bridges")).toBe("");
  });

  it("stretches a side onto what is beside it", async () => {
    const { opened, editing, host, pointer } = beside([{ x: 250, y: 300 }]);
    editing.select([STICKY]);
    pointer("pointerdown", 100, 50);
    pointer("pointermove", 247, 50);
    await nextFrame();
    expect(core.element(opened.editor, STICKY)?.kind).toMatchObject({
      frame: { x: 0, y: 0, width: 250, height: 100 },
    });
    expect(linedUp(host, "bridges")).toBe("M250 300L250 100");
    pointer("pointerup", 247, 50);
  });

  it("frees a scale once ⌘ goes down, and lines it up again once it comes up", async () => {
    const { editing, host, pointer, frame } = beside([{ x: 250, y: 300 }]);
    editing.select([STICKY]);
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 247, 247);
    await nextFrame();
    key("keydown", { key: "Meta", metaKey: true, ctrlKey: true });
    expect(frame()?.width).toBeCloseTo(247);
    expect(linedUp(host, "bridges")).toBe("");
    key("keyup", { key: "Meta" });
    expect(frame()?.width).toBe(250);
    pointer("pointerup", 247, 247);
  });

  it("stretches a quarter-turned sticky note down onto what is beside it", async () => {
    const { opened, editing, host, pointer } = beside([{ x: 300, y: 250 }]);
    opened.editor.update(STICKY, JSON.stringify({ ...sticky, rotation: 90 }));
    opened.board = core.board(opened.editor);
    editing.select([STICKY]);
    pointer("pointerdown", 50, 100);
    pointer("pointermove", 50, 247);
    await nextFrame();
    expect(core.bounds(opened.editor, [STICKY])?.height).toBeCloseTo(250);
    const bridge = linedUp(host, "bridges")
      ?.match(/-?[\d.]+/g)
      ?.map(Number);
    expect(bridge?.map(Math.round)).toEqual([300, 250, 100, 250]);
    pointer("pointerup", 50, 247);
  });

  it("stretches no shorter than its text lets it, onto what is beside it further", async () => {
    // Its font is 20 high, between the right side of the first at 17 and the left of the second.
    const { editing, pointer, frame } = beside([
      { x: 10, y: 300, width: 7, height: 7 },
      { x: 24, y: 300, width: 6, height: 6 },
    ]);
    editing.select([STICKY]);
    pointer("pointerdown", 100, 50);
    pointer("pointermove", 19, 50);
    await nextFrame();
    expect(frame()?.width).toBe(24);
    pointer("pointerup", 19, 50);
  });

  it("draws a stretched note's guides to where it fits its text again", async () => {
    const { opened, editing, host, pointer } = beside([{ x: 250, y: 400 }]);
    const note = written(opened);
    editing.select([NOTE]);
    pointer("pointerdown", 40, 225);
    pointer("pointermove", 247, 225);
    await nextFrame();
    const fits = core.bounds(opened.editor, [NOTE])!;
    expect(fits.width).toBe(250);
    expect(fits.height).toBeLessThan(note.frame.height);
    expect(linedUp(host, "bridges")).toBe(`M250 400L250 ${fits.y + fits.height}`);
    pointer("pointerup", 247, 225);
  });

  it("lets go of a stretch once fitting its text leaves the gap it kept behind", async () => {
    // 40 apart, facing the note as it is, but not once it is wide enough for one line.
    const { opened, editing, host, pointer } = beside([
      { x: 300, y: 250, width: 50, height: 40 },
      { x: 390, y: 250, width: 50, height: 40 },
    ]);
    written(opened);
    editing.select([NOTE]);
    pointer("pointerdown", 40, 225);
    pointer("pointermove", 257, 225);
    await nextFrame();
    expect(core.bounds(opened.editor, [NOTE])?.width).toBe(257);
    expect(linedUp(host, "gaps")).toBe("");
    pointer("pointerup", 257, 225);
  });

  it("draws a shape's corners onto what is beside it", async () => {
    const { opened, host, pointer } = beside([{ x: 300, y: 200 }], {
      drawing: () => "rectangle",
    });
    pointer("pointerdown", 297, 20);
    pointer("pointermove", 397, 120);
    await nextFrame();
    expect(linedUp(host, "bridges")).toBe("M300 200L300 120M400 200L400 120");
    pointer("pointerup", 397, 120);
    expect(linedUp(host, "bridges")).toBe("");
    const shapes = Object.values(opened.board.elements).filter(({ kind }) => kind.type === "shape");
    expect(shapes.map(({ kind }) => kind)).toMatchObject([
      { frame: { x: 300, y: 20, width: 100, height: 100 } },
    ]);
  });

  it("lines up what is drawn once ⌘ comes up, though not with itself", async () => {
    const { opened, pointer } = beside([{ x: 300, y: 200 }], { drawing: () => "rectangle" });
    pointer("pointerdown", 297, 20);
    pointer("pointermove", 397, 120, { free: true });
    await nextFrame();
    // 4 below where it ended a step before.
    pointer("pointermove", 430, 124);
    await nextFrame();
    pointer("pointerup", 430, 124);
    const shapes = Object.values(opened.board.elements).filter(({ kind }) => kind.type === "shape");
    expect(shapes.map(({ kind }) => kind)).toMatchObject([
      { frame: { x: 300, y: 20, width: 130, height: 104 } },
    ]);
  });

  it("draws a thin shape away from anything as thin as drawn", async () => {
    const { opened, pointer } = beside([], { drawing: () => "rectangle" });
    pointer("pointerdown", 300, 400);
    pointer("pointermove", 500, 404);
    await nextFrame();
    pointer("pointerup", 500, 404);
    const shapes = Object.values(opened.board.elements).filter(({ kind }) => kind.type === "shape");
    expect(shapes.map(({ kind }) => kind)).toMatchObject([
      { frame: { x: 300, y: 400, width: 200, height: 4 } },
    ]);
  });

  it("frees what is drawn once ⌘ goes down mid-drag", async () => {
    const { opened, host, pointer } = beside([{ x: 300, y: 200 }], { drawing: () => "rectangle" });
    pointer("pointerdown", 297, 20);
    pointer("pointermove", 397, 120);
    await nextFrame();
    key("keydown", { key: "Meta", metaKey: true, ctrlKey: true });
    expect(linedUp(host, "bridges")).toBe("");
    pointer("pointerup", 397, 120, { free: true });
    const shapes = Object.values(opened.board.elements).filter(({ kind }) => kind.type === "shape");
    expect(shapes.map(({ kind }) => kind)).toMatchObject([
      { frame: { x: 297, y: 20, width: 100, height: 100 } },
    ]);
  });

  it("draws onto the grid alone once switched off", async () => {
    const { opened, host, pointer } = beside([{ x: 300, y: 200 }], {
      drawing: () => "rectangle",
      snapping: () => true,
      aligning: () => false,
    });
    pointer("pointerdown", 277, 37);
    pointer("pointermove", 397, 158);
    await nextFrame();
    expect(linedUp(host, "bridges")).toBe("");
    pointer("pointerup", 397, 158);
    const shapes = Object.values(opened.board.elements).filter(({ kind }) => kind.type === "shape");
    expect(shapes.map(({ kind }) => kind)).toMatchObject([
      { frame: { x: 280, y: 40, width: 120, height: 120 } },
    ]);
  });

  it("places a shape with a click lined up with what is beside it", () => {
    const { opened, pointer } = beside([{ x: 300, y: 200 }], { drawing: () => "rectangle" });
    // Centred on the click, 120 wide, its left side 3 from the sticky note's.
    pointer("pointerdown", 357, 450);
    pointer("pointerup", 357, 450);
    const shapes = Object.values(opened.board.elements).filter(({ kind }) => kind.type === "shape");
    expect(shapes.map(({ kind }) => kind)).toMatchObject([
      { frame: { x: 300, y: 390, width: 120, height: 120 } },
    ]);
  });

  it("lets a move with ⌘ held go freely", async () => {
    const { host, pointer, at } = beside([{ x: 300, y: 200 }]);
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 246, 50, { free: true });
    await nextFrame();
    expect(at()).toEqual({ x: 196, y: 0 });
    expect(linedUp(host, "bridges")).toBe("");
    pointer("pointerup", 246, 50, { free: true });
    expect(at()).toEqual({ x: 196, y: 0 });
  });

  it("lets go once ⌘ goes down mid-move, and lines up again once it comes up", async () => {
    const { host, pointer, at } = beside([{ x: 300, y: 200 }]);
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 246, 50);
    await nextFrame();
    key("keydown", { key: "Meta", metaKey: true, ctrlKey: true });
    expect(at()).toEqual({ x: 196, y: 0 });
    expect(linedUp(host, "bridges")).toBe("");
    key("keyup", { key: "Meta" });
    expect(at()).toEqual({ x: 200, y: 0 });
    expect(linedUp(host, "bridges")).toBe("M300 200L300 100");
    pointer("pointerup", 246, 50);
  });

  it("frees a move from the grid too once ⌘ goes down mid-move", async () => {
    const { pointer, at } = beside([], { snapping: () => true });
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 53, 50);
    await nextFrame();
    expect(at()).toEqual({ x: 0, y: 0 });
    key("keydown", { key: "Meta", metaKey: true, ctrlKey: true });
    expect(at()).toEqual({ x: 3, y: 0 });
    pointer("pointerup", 53, 50, { free: true });
  });

  it("lines up before the grid pulls, which takes the way nothing beside it pulls", async () => {
    const { host, pointer, at } = beside([{ x: 303, y: 200 }], { snapping: () => true });
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 246, 53);
    await nextFrame();
    expect(at()).toEqual({ x: 203, y: 0 });
    // From where it lands, the grid's pull included.
    expect(linedUp(host, "bridges")).toBe("M303 200L303 100");
    pointer("pointerup", 246, 53);
  });

  it("leaves what is beside a move alone once switched off", () => {
    const { pointer, at } = beside([{ x: 300, y: 200 }], { aligning: () => false });
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 246, 50);
    pointer("pointerup", 246, 50);
    expect(at()).toEqual({ x: 196, y: 0 });
  });

  it("lines a copy up with its original, which stays put", () => {
    const { opened, editing, pointer, at } = beside([]);
    pointer("pointerdown", 50, 50, { altKey: true });
    pointer("pointermove", 55, 200, { altKey: true });
    pointer("pointerup", 55, 200);
    const [copy] = editing.selection();
    expect(core.element(opened.editor, copy!)?.kind).toMatchObject({ frame: { x: 0, y: 150 } });
    expect(at()).toEqual({ x: 0, y: 0 });
  });
});

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
      [IMAGE, { ...image, edits: { ...core.editsOf(image), crop: kept } }],
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

  it("moves the selection along the arrow as a mirrored board shows", () => {
    const { editing, host, viewport, at } = page();
    mirrored(host, viewport);
    editing.select([STICKY]);
    key("keydown", { key: "ArrowRight" });
    key("keyup", { key: "ArrowRight" });
    expect(at()).toEqual({ x: -1, y: 0 });
  });

  it("moves by the grid's step while snapping to the grid shown", () => {
    const { opened, editing, at } = page([], { snapping: () => true });
    core.setBackground(opened.editor, "grid");
    opened.board = core.board(opened.editor);
    editing.select([STICKY]);
    key("keydown", { key: "ArrowDown" });
    key("keyup", { key: "ArrowDown" });
    expect(at()).toEqual({ x: 0, y: 40 });
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
    const { opened, editing, hooks, host, pointer } = page([], { drawing: () => "pen" });
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
    const { opened, pointer } = page([], { drawing: () => "pen" });
    pointer("pointerdown", 200, 200);
    pointer("pointerup", 200, 200);
    expect(strokes(opened)).toMatchObject([
      { frame: { x: 200, y: 200, width: 0, height: 0 }, points: [0, 0] },
    ]);
  });

  it("draws straight from where it was pressed, by steps of 45°, while ⇧ is held", async () => {
    const { opened, pointer } = page([], { drawing: () => "pen" });
    pointer("pointerdown", 200, 200);
    pointer("pointermove", 260, 300, { shiftKey: true });
    await nextFrame();
    pointer("pointerup", 300, 290, { shiftKey: true });
    const [stroke] = strokes(opened);
    expect(stroke?.points).toHaveLength(4);
    expect(stroke?.frame.width).toBeCloseTo(stroke?.frame.height ?? 0);
  });

  it("draws nothing once the press is lost", async () => {
    const { opened, hooks, pointer } = page([], { drawing: () => "pen" });
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
      { drawing: () => "pen" },
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
    const { editing, pointer } = page([], { drawing: () => "pen" });
    editing.select([STICKY]);
    pointer("pointerdown", 200, 200);
    expect(editing.selection()).toEqual([]);
    pointer("pointerup", 200, 200);
  });

  it("turns straight, or back, as ⇧ is pressed or let go while the pointer stays still", async () => {
    const { opened, hooks, pointer } = page([], { drawing: () => "pen" });
    const shown = () => vi.mocked(hooks.inked).mock.lastCall?.[0]?.points.length;
    pointer("pointerdown", 200, 200);
    pointer("pointermove", 300, 200);
    pointer("pointermove", 300, 300);
    await nextFrame();
    expect(shown()).toBeGreaterThan(2);
    key("keydown", { key: "Shift", shiftKey: true });
    expect(shown()).toBe(2);
    key("keyup", { key: "Shift" });
    expect(shown()).toBeGreaterThan(2);
    key("keydown", { key: "Shift", shiftKey: true });
    pointer("pointerup", 300, 300);
    const [stroke] = strokes(opened);
    expect(stroke?.points).toHaveLength(4);
  });

  it("draws as a highlighter wide and see-through, in its yellow, while pressed and once let go", () => {
    const { opened, hooks, pointer } = page([], { drawing: () => "highlighter" });
    pointer("pointerdown", 200, 200);
    expect(hooks.inked).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 16, paint: "highlight-yellow", opacity: 0.4 }),
    );
    pointer("pointerup", 200, 200);
    expect(strokes(opened)).toMatchObject([{ tip: "highlighter" }]);
  });

  it("sticks what it draws whole on the sticky note to it, as one edit, unless ⌘ is held", async () => {
    const { opened, editing, pointer } = page([], { drawing: () => "pen" });
    const draw = async (from: Point, to: Point, free = false) => {
      pointer("pointerdown", from.x, from.y, { free });
      pointer("pointermove", to.x, to.y, { free });
      await nextFrame();
      pointer("pointerup", to.x, to.y, { free });
    };
    await draw({ x: 20, y: 20 }, { x: 80, y: 80 });
    await draw({ x: 50, y: 50 }, { x: 150, y: 50 });
    await draw({ x: 20, y: 80 }, { x: 80, y: 20 }, true);
    expect(strokes(opened).map(({ target }) => target)).toEqual([STICKY, undefined, undefined]);
    editing.undo();
    editing.undo();
    editing.undo();
    expect(strokes(opened)).toEqual([]);
  });

  it("shows while pressed the curve it draws once let go", async () => {
    const { opened, hooks, pointer } = page([], { drawing: () => "pen" });
    pointer("pointerdown", 200, 200);
    for (const [x, y] of [
      [260, 210],
      [300, 250],
      [310, 310],
      [280, 360],
    ]) {
      pointer("pointermove", x!, y!);
    }
    await nextFrame();
    const shown = vi.mocked(hooks.inked).mock.lastCall?.[0];
    pointer("pointerup", 280, 360);
    const [id] = Object.entries(opened.board.elements).flatMap(([each, { kind }]) =>
      kind.type === "stroke" ? [each] : [],
    );
    expect(core.drawn(opened.editor, [id!], new Set())[0]).toEqual([shown]);
    // Round between the points it keeps.
    expect(shown?.points.length).toBeGreaterThan(strokes(opened)[0]!.points.length / 2);
  });

  it("forgets what it was drawing once its board goes", () => {
    const { opened, editing, hooks, pointer } = page([], { drawing: () => "pen" });
    pointer("pointerdown", 200, 200);
    expect(hooks.inked).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "stroke" }));
    editing.reset();
    expect(hooks.inked).toHaveBeenLastCalledWith(undefined);
    pointer("pointerup", 200, 200);
    expect(strokes(opened)).toEqual([]);
  });
});

/** As some engines let the capture go, a moment before the release, or while still pressed. */
function captureLost(host: HTMLElement, x: number, y: number, buttons: number) {
  host.dispatchEvent(
    new PointerEvent("lostpointercapture", { clientX: x, clientY: y, buttons, pointerId: 1 }),
  );
}

describe("the end of a press", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps what the pen drew when the capture goes just before the button is released", async () => {
    const { opened, host, pointer } = page([], { drawing: () => "pen" });
    pointer("pointerdown", 200, 200);
    pointer("pointermove", 300, 250);
    await nextFrame();
    captureLost(host, 300, 250, 0);
    pointer("pointerup", 300, 250);
    expect(strokes(opened)).toHaveLength(1);
  });

  it("keeps what the eraser took when the capture goes just before the button is released", async () => {
    const { opened, host, pointer } = page([], { erasing: () => true });
    pointer("pointerdown", 150, 50);
    pointer("pointermove", 50, 50);
    await nextFrame();
    captureLost(host, 50, 50, 0);
    pointer("pointerup", 50, 50);
    expect(opened.board.elements).toEqual({});
  });

  it("gives back what the eraser took, and the selection, when the capture goes while the button is held", async () => {
    const { opened, editing, host, pointer } = page([], { erasing: () => true });
    editing.selectAll();
    pointer("pointerdown", 150, 50);
    pointer("pointermove", 50, 50);
    await nextFrame();
    captureLost(host, 50, 50, 1);
    pointer("pointerup", 50, 50);
    expect(Object.keys(opened.board.elements)).toEqual([STICKY]);
    expect(editing.selection()).toEqual([STICKY]);
  });

  it("gives up what it drew when the capture goes while the button is held", async () => {
    const { opened, host, pointer } = page([], { drawing: () => "pen" });
    pointer("pointerdown", 200, 200);
    pointer("pointermove", 300, 250);
    await nextFrame();
    captureLost(host, 300, 250, 1);
    pointer("pointerup", 300, 250);
    expect(strokes(opened)).toEqual([]);
  });
});

describe("a second finger", () => {
  afterEach(() => document.body.replaceChildren());

  it("takes back what the first one moved", async () => {
    const { editing, pointer, at } = page();
    pointer("pointerdown", 50, 50, { finger: 1 });
    pointer("pointermove", 90, 70, { finger: 1 });
    await nextFrame();
    expect(at()).toEqual({ x: 40, y: 20 });
    pointer("pointerdown", 300, 200, { finger: 2 });
    expect(at()).toEqual({ x: 0, y: 0 });
    expect(editing.selection()).toEqual([]);
    expect(editing.busy()).toBe(false);
    pointer("pointermove", 100, 80, { finger: 1 });
    await nextFrame();
    pointer("pointerup", 100, 80, { finger: 1 });
    pointer("pointerup", 300, 200, { finger: 2 });
    expect(at()).toEqual({ x: 0, y: 0 });
    // What undoes next is the note's adding, as the page made it.
    editing.undo();
    expect(at()).toBeUndefined();
  });

  it("takes back what the first one moved, though the second lands on a group's title", async () => {
    const { host, pointer, at } = page();
    const group = "f".repeat(32);
    const board: Board = {
      elements: { [group]: { z: "a0", kind: { type: "group" }, locked: false } },
      draw_order: [group],
      background: "plain",
    };
    const labels = titles(host, () => {});
    labels.frame({ x: 0, y: 0, zoom: 1 });
    // Selected alone and untitled, the group offers a title, whose label keeps a press to itself.
    labels.show(board, () => ({ x: 300, y: 300, width: 100, height: 100 }), [group], group);
    pointer("pointerdown", 50, 50, { finger: 1 });
    pointer("pointermove", 90, 70, { finger: 1 });
    await nextFrame();
    host.querySelector(".group-title.offered")!.dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: 310,
        clientY: 290,
        button: 0,
        pointerId: 2,
        pointerType: "touch",
        bubbles: true,
      }),
    );
    expect(at()).toEqual({ x: 0, y: 0 });
  });

  it("takes back the marquee, and leaves the selection as it was", async () => {
    const { editing, host, pointer } = page();
    editing.selectAll();
    pointer("pointerdown", 300, 300, { finger: 1 });
    pointer("pointermove", 350, 350, { finger: 1 });
    await nextFrame();
    expect(editing.selection()).toEqual([]);
    pointer("pointerdown", 400, 300, { finger: 2 });
    expect(editing.selection()).toEqual([STICKY]);
    expect(host.querySelector(".marquee")?.getAttribute("display")).toBe("none");
  });

  it("takes back what the pen drew", async () => {
    const { opened, hooks, pointer } = page([], { drawing: () => "pen" });
    pointer("pointerdown", 200, 200, { finger: 1 });
    pointer("pointermove", 300, 300, { finger: 1 });
    await nextFrame();
    pointer("pointerdown", 400, 300, { finger: 2 });
    expect(hooks.inked).toHaveBeenLastCalledWith(undefined);
    pointer("pointerup", 300, 300, { finger: 1 });
    expect(strokes(opened)).toEqual([]);
  });

  it("takes back what the eraser took", async () => {
    const { opened, pointer } = page([], { erasing: () => true });
    pointer("pointerdown", 150, 50, { finger: 1 });
    pointer("pointermove", 50, 50, { finger: 1 });
    await nextFrame();
    pointer("pointerdown", 300, 200, { finger: 2 });
    pointer("pointerup", 50, 50, { finger: 1 });
    expect(Object.keys(opened.board.elements)).toEqual([STICKY]);
  });

  it("presses nothing more until a finger lifts", async () => {
    const { editing, pointer } = page();
    pointer("pointerdown", 300, 300, { finger: 1 });
    pointer("pointerdown", 400, 300, { finger: 2 });
    pointer("pointerdown", 50, 50, { finger: 3 });
    pointer("pointerup", 50, 50, { finger: 3 });
    expect(editing.selection()).toEqual([]);
    pointer("pointerup", 400, 300, { finger: 2 });
    pointer("pointerdown", 50, 50, { finger: 2 });
    pointer("pointerup", 50, 50, { finger: 2 });
    expect(editing.selection()).toEqual([]);
  });

  it("leaves a stylus its stroke when two fingers land beside it", async () => {
    const { opened, host, pointer } = page([], { drawing: () => "pen" });
    const stylus = (type: string, clientX: number, clientY: number) =>
      host.dispatchEvent(
        new PointerEvent(type, {
          clientX,
          clientY,
          button: 0,
          pointerId: 9,
          pointerType: "pen",
          bubbles: true,
        }),
      );
    stylus("pointerdown", 200, 200);
    pointer("pointerdown", 400, 300, { finger: 1 });
    pointer("pointerdown", 420, 320, { finger: 2 });
    stylus("pointermove", 300, 300);
    await nextFrame();
    stylus("pointerup", 300, 300);
    expect(strokes(opened)).toHaveLength(1);
  });

  it("puts a crop back to where the press found it, and goes on cropping", async () => {
    const { opened, editing, pointer } = cropping();
    // A first drag, from the whole image to 200 by 180 pixels, which is where the next one starts.
    pointer("pointerdown", 500, 200);
    pointer("pointermove", 400, 180);
    pointer("pointerup", 400, 180);
    pointer("pointerdown", 400, 180, { finger: 1 });
    pointer("pointermove", 350, 150, { finger: 1 });
    await nextFrame();
    pointer("pointerdown", 100, 300, { finger: 2 });
    expect(editing.cropping()).toBe(IMAGE);
    expect(editing.busy()).toBe(true);
    pointer("pointerup", 350, 150, { finger: 1 });
    pointer("pointerup", 100, 300, { finger: 2 });
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 0, y: 0, width: 200, height: 180 });
  });

  it("leaves the crop's edit open, to be cropped afresh and undone as one", async () => {
    const kept = { x: 100, y: 0, width: 150, height: 100 };
    const { opened, editing, pointer } = page([
      [IMAGE, { ...image, edits: { ...core.editsOf(image), crop: kept } }],
    ]);
    editing.select([IMAGE]);
    editing.crop();
    const corner = core.pointOfPixel(opened.editor, IMAGE, { x: 250, y: 100 })!;
    pointer("pointerdown", corner.x, corner.y, { finger: 1 });
    pointer("pointermove", corner.x + 40, corner.y + 40, { finger: 1 });
    await nextFrame();
    pointer("pointerdown", 100, 300, { finger: 2 });
    // The image still shows whole, as the open edit left it.
    expect(cropOf(opened)?.crop).toBeFalsy();
    pointer("pointerup", corner.x + 40, corner.y + 40, { finger: 1 });
    pointer("pointerup", 100, 300, { finger: 2 });
    // The whole image shows twice as large as it was cropped, so 40 CSS pixels are 20 of its own.
    pointer("pointerdown", corner.x, corner.y);
    pointer("pointermove", corner.x - 40, corner.y - 40);
    pointer("pointerup", corner.x - 40, corner.y - 40);
    key("keydown", { key: "Enter" });
    expect(cropOf(opened)?.crop).toEqual({ x: 100, y: 0, width: 130, height: 80 });
    editing.undo();
    expect(cropOf(opened)?.crop).toEqual(kept);
  });

  describe("pressing outside the group gone into", () => {
    const OTHER = "b".repeat(32);
    const OUTSIDE = "d".repeat(32);
    const GROUP = "e".repeat(32);

    function inside() {
      const shown = page([
        [OTHER, { ...sticky, frame: { x: 300, y: 0, width: 100, height: 100 } }],
        [OUTSIDE, { ...sticky, frame: { x: 0, y: 300, width: 100, height: 100 } }],
      ]);
      shown.editing.select([STICKY, OTHER]);
      shown.editing.group(GROUP);
      shown.editing.goInside();
      shown.editing.select([STICKY]);
      return shown;
    }

    it("goes back inside the group, with what was selected there, when a second finger takes the press", () => {
      const { editing, pointer } = inside();
      pointer("pointerdown", 50, 350, { finger: 1 });
      expect(editing.entered()).toBeUndefined();
      expect(editing.selection()).toEqual([OUTSIDE]);
      pointer("pointerdown", 600, 500, { finger: 2 });
      expect(editing.entered()).toBe(GROUP);
      expect(editing.selection()).toEqual([STICKY]);
      pointer("pointerup", 50, 350, { finger: 1 });
      pointer("pointerup", 600, 500, { finger: 2 });
      expect(editing.entered()).toBe(GROUP);
      expect(editing.selection()).toEqual([STICKY]);
    });

    it("goes back inside the group too when the press was on nothing", async () => {
      const { editing, pointer } = inside();
      pointer("pointerdown", 600, 500, { finger: 1 });
      pointer("pointermove", 650, 550, { finger: 1 });
      await nextFrame();
      expect(editing.entered()).toBeUndefined();
      expect(editing.selection()).toEqual([]);
      pointer("pointerdown", 700, 500, { finger: 2 });
      expect(editing.entered()).toBe(GROUP);
      expect(editing.selection()).toEqual([STICKY]);
    });
  });
});

describe("a group's panel", () => {
  afterEach(() => document.body.replaceChildren());

  const OTHER = "b".repeat(32);
  const GROUP = "e".repeat(32);

  /** The sticky note and another a hundred to its right, grouped on a panel. */
  function framed(hooks: Parameters<typeof page>[1] = {}) {
    const next: Kind = {
      type: "sticky",
      frame: { x: 200, y: 0, width: 100, height: 100 },
      rotation: 0,
      text: { content: "", font_size: 20 },
    };
    const shown = page([[OTHER, next]], hooks);
    const { opened } = shown;
    opened.editor.group(GROUP, [STICKY, OTHER]);
    const kind = core.element(opened.editor, GROUP)!.kind;
    opened.editor.update(GROUP, JSON.stringify({ ...kind, colour: "blue", fill: "tint" }));
    opened.board = core.board(opened.editor);
    return shown;
  }

  it("selects its group when clicked between its elements", () => {
    const { editing, pointer } = framed();
    pointer("pointerdown", 150, 50);
    pointer("pointerup", 150, 50);
    expect(editing.selection()).toEqual([GROUP]);
  });

  it("is left whole by the eraser", () => {
    const { opened, pointer } = framed({ erasing: () => true });
    pointer("pointerdown", 150, 50);
    pointer("pointerup", 150, 50);
    expect(Object.keys(opened.board.elements)).toHaveLength(3);
  });

  it("lets a double-click on its group's title write it, rather than go inside the group", () => {
    const { editing, hooks, host } = framed();
    const title = host.appendChild(document.createElement("div"));
    title.className = "group-title";
    title.dataset.group = GROUP;
    const at = { clientX: 50, clientY: -30, button: 0, pointerId: 1, bubbles: true };
    for (const type of ["pointerdown", "pointerup"]) {
      title.dispatchEvent(new PointerEvent(type, at));
    }
    expect(editing.selection()).toEqual([GROUP]);
    title.dispatchEvent(new PointerEvent("pointerdown", at));
    host.dispatchEvent(new PointerEvent("pointerup", at));
    host.dispatchEvent(new MouseEvent("dblclick", at));
    expect(hooks.retitle).toHaveBeenCalledExactlyOnceWith(GROUP);
    expect(editing.entered()).toBeUndefined();
  });

  it("goes inside on a double-click on one of its elements, rather than zoom to it", () => {
    const { editing, host, viewport, pointer } = framed();
    Object.defineProperties(host, {
      clientWidth: { value: 600 },
      clientHeight: { value: 400 },
    });
    for (const type of ["pointerdown", "pointerup", "pointerdown", "pointerup"]) {
      pointer(type, 50, 50);
    }
    host.dispatchEvent(
      new MouseEvent("dblclick", { clientX: 50, clientY: 50, button: 0, bubbles: true }),
    );
    expect(editing.entered()).toBe(GROUP);
    expect(editing.selection()).toEqual([STICKY]);
    expect(viewport.camera()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("moves its group from its title, even over the corner's grip it covers", async () => {
    const { editing, host, at } = framed();
    editing.select([GROUP]);
    const title = host.appendChild(document.createElement("div"));
    title.className = "group-title";
    title.dataset.group = GROUP;
    // Within the turn grip's reach of the panel's top-left corner, at (-10, -10).
    const press = { clientX: -5, clientY: -16, button: 0, pointerId: 1, bubbles: true };
    const to = { ...press, clientX: 15, clientY: 4 };
    title.dispatchEvent(new PointerEvent("pointerdown", press));
    host.dispatchEvent(new PointerEvent("pointermove", to));
    await nextFrame();
    host.dispatchEvent(new PointerEvent("pointerup", to));
    expect(at()).toEqual({ x: 20, y: 20 });
  });

  it("stands behind the elements of its group once gone into, which a press between drags", async () => {
    const { editing, pointer, at } = framed();
    editing.select([GROUP]);
    editing.goInside();
    pointer("pointerdown", 150, 50);
    pointer("pointermove", 150, 80);
    await nextFrame();
    pointer("pointerup", 150, 80);
    expect(at()).toEqual({ x: 0, y: 30 });
    expect(editing.selection()).toEqual([STICKY, OTHER]);
  });
});

function locked(opened: ReturnType<typeof page>["opened"], id: string) {
  return opened.board.elements[id]?.locked === true;
}

describe("locking", () => {
  afterEach(() => document.body.replaceChildren());

  const OTHER = "b".repeat(32);
  const GROUP = "e".repeat(32);
  const BACKDROP = "f".repeat(32);
  const apart: Kind = { ...sticky, frame: { x: 300, y: 0, width: 100, height: 100 } };

  it("lets go of what it locks, which a click then goes through to what lies under it", () => {
    const { opened, editing, pointer } = page([[OTHER, sticky]]);
    editing.select([OTHER]);
    editing.lock();
    expect(locked(opened, OTHER)).toBe(true);
    expect(editing.selection()).toEqual([]);
    pointer("pointerdown", 50, 50);
    pointer("pointerup", 50, 50);
    expect(editing.selection()).toEqual([STICKY]);
  });

  it("leaves what is locked out of a selection rectangle and of Select all", async () => {
    const { editing, pointer } = page([[OTHER, apart]]);
    editing.select([STICKY]);
    editing.lock();
    pointer("pointerdown", 50, 150);
    pointer("pointermove", 350, 50);
    await nextFrame();
    pointer("pointerup", 350, 50);
    expect(editing.selection()).toEqual([OTHER]);
    editing.select([]);
    editing.selectAll();
    expect(editing.selection()).toEqual([OTHER]);
  });

  it("selects what an undo unlocks, and nothing a redo locks again", () => {
    const { editing } = page();
    editing.select([STICKY]);
    editing.lock();
    editing.undo();
    expect(editing.selection()).toEqual([STICKY]);
    editing.redo();
    expect(editing.selection()).toEqual([]);
    editing.select([STICKY]);
    expect(editing.selection()).toEqual([]);
  });

  it("offers to unlock what a right-click lands on, selecting nothing under it, and selects what it unlocks", () => {
    const { opened, editing } = page([[OTHER, sticky]]);
    editing.select([OTHER]);
    editing.lock();
    expect(editing.aim({ x: 50, y: 50 })).toBe(false);
    expect(editing.lockedAt({ x: 50, y: 50 })).toBe(OTHER);
    expect(editing.lockedAt({ x: 250, y: 50 })).toBeUndefined();
    editing.unlock([OTHER]);
    expect(locked(opened, OTHER)).toBe(false);
    expect(editing.selection()).toEqual([OTHER]);
  });

  it("keeps the selection on a right-click within its box, though what it lands on is locked", () => {
    const backdrop: Kind = { ...sticky, frame: { x: -100, y: -100, width: 600, height: 300 } };
    const { editing } = page([
      [BACKDROP, backdrop],
      [OTHER, apart],
    ]);
    editing.select([BACKDROP]);
    editing.lock();
    editing.select([STICKY, OTHER]);
    expect(editing.lockedAt({ x: 200, y: 50 })).toBe(BACKDROP);
    expect(editing.aim({ x: 200, y: 50 })).toBe(true);
    expect(editing.selection()).toEqual([STICKY, OTHER]);
  });

  it("tells what the pointer rests on is locked, outlined dashed where a click selects nothing", async () => {
    const { host, editing, pointer } = page([[OTHER, apart]]);
    editing.select([STICKY]);
    editing.lock();
    const outlined = () => host.querySelector(".preview")!;
    pointer("pointermove", 50, 50);
    await nextFrame();
    expect(editing.lockedUnder()).toBe(STICKY);
    expect(outlined().classList.contains("locked")).toBe(true);
    expect(outlined().childElementCount).toBe(1);
    pointer("pointermove", 350, 50);
    await nextFrame();
    expect(editing.lockedUnder()).toBeUndefined();
    expect(outlined().classList.contains("locked")).toBe(false);
  });

  it("leaves the group gone into once an agent locks it", () => {
    const { editing } = page([[OTHER, apart]]);
    editing.select([STICKY, OTHER]);
    editing.group(GROUP);
    editing.goInside();
    editing.apply((editor, touched) => touched.push(...editor.setLocked([GROUP], true)));
    expect(editing.entered()).toBeUndefined();
    expect(editing.selection()).toEqual([]);
  });

  it("goes inside a group with none of its locked elements selected", () => {
    const { editing } = page([[OTHER, apart]]);
    editing.select([STICKY, OTHER]);
    editing.group(GROUP);
    editing.apply((editor, touched) => touched.push(...editor.setLocked([OTHER], true)));
    expect(editing.selection()).toEqual([GROUP]);
    editing.goInside();
    expect(editing.selection()).toEqual([STICKY]);
  });
});

describe("hiding annotations", () => {
  afterEach(() => document.body.replaceChildren());

  const OTHER = "b".repeat(32);
  const GROUP = "e".repeat(32);
  /** Under the sticky notes, which cover its top-left corner. */
  const under: Kind = { ...image, frame: { x: 0, y: 0, width: 300, height: 200 } };

  it("lets a click go through them to what lies under them", () => {
    const { editing, pointer } = page(
      [
        [IMAGE, under],
        [OTHER, sticky],
      ],
      { showsAnnotations: () => false },
    );
    pointer("pointerdown", 50, 50);
    pointer("pointerup", 50, 50);
    expect(editing.selection()).toEqual([IMAGE]);
  });

  it("leaves them out of a selection rectangle and of Select all", async () => {
    const { editing, pointer } = page([[IMAGE, under]], { showsAnnotations: () => false });
    pointer("pointerdown", 350, 250);
    pointer("pointermove", -10, -10);
    await nextFrame();
    pointer("pointerup", -10, -10);
    expect(editing.selection()).toEqual([IMAGE]);
    editing.select([]);
    editing.selectAll();
    expect(editing.selection()).toEqual([IMAGE]);
  });

  it("goes inside a group with only its images selected", () => {
    const { editing, hide } = hiding();
    editing.select([STICKY, IMAGE]);
    editing.group(GROUP);
    hide();
    editing.goInside();
    expect(editing.selection()).toEqual([IMAGE]);
  });

  it("shows them again for a note an undo brings back, or moves back, and selects it", () => {
    const { editing, hide, shown } = hiding();
    editing.select([STICKY]);
    editing.remove();
    hide();
    editing.select([IMAGE]);
    editing.undo();
    expect(shown()).toBe(true);
    expect(editing.selection()).toEqual([STICKY]);
    editing.apply((editor, touched) => touched.push(...editor.translate([STICKY], 10, 0)));
    hide();
    editing.select([IMAGE]);
    editing.undo();
    expect(shown()).toBe(true);
    expect(editing.selection()).toEqual([STICKY]);
  });

  it("stays hidden through an undo of an image's move, which carries the comment pinned to it", () => {
    const pinned: Kind = { type: "comment", at: { x: 250, y: 150 }, text: "", target: IMAGE };
    const { editing, hide, shown } = hiding([[OTHER, pinned]]);
    editing.apply((editor, touched) => touched.push(...editor.translate([IMAGE], 10, 0)));
    hide();
    editing.select([]);
    editing.undo();
    expect(shown()).toBe(false);
    expect(editing.selection()).toEqual([IMAGE]);
  });

  it("shows them again for notes an undo ungroups, and selects them", () => {
    const apart: Kind = { ...sticky, frame: { x: 0, y: 300, width: 100, height: 100 } };
    const { editing, hide, shown } = hiding([[OTHER, apart]]);
    editing.select([STICKY, OTHER]);
    editing.group(GROUP);
    hide();
    editing.undo();
    expect(shown()).toBe(true);
    expect(editing.selection().toSorted()).toEqual([OTHER, STICKY].toSorted());
  });

  it("stays hidden through a redo that deletes the image a comment is pinned to", () => {
    const pinned: Kind = { type: "comment", at: { x: 250, y: 150 }, text: "", target: IMAGE };
    const { editing, hide, shown } = hiding([[OTHER, pinned]]);
    hide();
    editing.select([IMAGE]);
    editing.remove();
    editing.undo();
    editing.redo();
    expect(shown()).toBe(false);
    expect(editing.selection()).toEqual([]);
  });

  it("stays hidden through a redo that locks them again with what they lie on", () => {
    const { editing, hide, shown } = hiding();
    editing.select([STICKY, IMAGE]);
    editing.lock();
    hide();
    editing.undo();
    expect(editing.selection()).toEqual([IMAGE]);
    editing.redo();
    expect(shown()).toBe(false);
    expect(editing.selection()).toEqual([]);
  });

  it("shows them again once an edit adds one, but for those a group brings along", () => {
    const { editing, hide, shown } = hiding();
    editing.select([STICKY, IMAGE]);
    editing.group(GROUP);
    hide();
    const ids = { [GROUP]: "1".repeat(32), [IMAGE]: "2".repeat(32), [STICKY]: "3".repeat(32) };
    editing.apply((editor, touched) =>
      touched.push(...editor.paste(editor.copy([GROUP]), JSON.stringify(ids), undefined)),
    );
    expect(shown()).toBe(false);
    editing.apply((editor, touched) =>
      touched.push(...editor.add(OTHER, undefined, JSON.stringify(sticky))),
    );
    expect(shown()).toBe(true);
  });

  it("shows them again once asked to select one, as an agent pointing to it does", () => {
    const { editing, hide, shown } = hiding();
    hide();
    editing.select([IMAGE]);
    expect(shown()).toBe(false);
    editing.select([STICKY]);
    expect(shown()).toBe(true);
    expect(editing.selection()).toEqual([STICKY]);
  });

  /** The sticky note over an image, and `more`. */
  function hiding(more: [string, Kind][] = []) {
    let annotated = true;
    const made = page([[IMAGE, under], ...more], {
      showsAnnotations: () => annotated,
      reveal: () => {
        annotated = true;
      },
    });
    const hide = () => {
      annotated = false;
    };
    return { ...made, hide, shown: () => annotated };
  }
});

function shaped(shape: "rectangle" | "ellipse", y: number): Kind {
  return {
    type: "shape",
    frame: { x: 0, y, width: 50, height: 50 },
    shape,
    text: { content: "", font_size: 20 },
  };
}

describe("inverting and matching the selection", () => {
  afterEach(() => document.body.replaceChildren());

  const OTHER = "b".repeat(32);
  const GROUP = "e".repeat(32);
  const apart: Kind = { ...sticky, frame: { x: 0, y: 300, width: 100, height: 100 } };
  const note: Kind = {
    type: "note",
    frame: { x: 0, y: 500, width: 100, height: 40 },
    rotation: 0,
    text: { content: "", font_size: 20 },
  };

  it("selects what is not selected, and back again", () => {
    const { editing } = page([
      [IMAGE, image],
      [OTHER, apart],
    ]);
    editing.select([IMAGE]);
    editing.invertSelection();
    expect(editing.selection()).toEqual([STICKY, OTHER]);
    editing.invertSelection();
    expect(editing.selection()).toEqual([IMAGE]);
    editing.select([]);
    editing.invertSelection();
    expect(editing.selection()).toEqual([STICKY, IMAGE, OTHER]);
  });

  it("takes a group whole at the top level, and only its own elements once gone into", () => {
    const { editing } = page([
      [IMAGE, image],
      [OTHER, apart],
    ]);
    editing.select([STICKY, OTHER]);
    editing.group(GROUP);
    editing.select([IMAGE]);
    editing.invertSelection();
    expect(editing.selection()).toEqual([GROUP]);
    editing.goInside();
    editing.select([STICKY]);
    editing.invertSelection();
    expect(editing.selection()).toEqual([OTHER]);
    expect(editing.entered()).toBe(GROUP);
  });

  it("selects every element of the types selected", () => {
    const { editing } = page([
      [IMAGE, image],
      [OTHER, apart],
      [NOTE, note],
    ]);
    editing.select([STICKY]);
    editing.selectSameType();
    expect(editing.selection()).toEqual([STICKY, OTHER]);
    editing.select([STICKY, IMAGE]);
    editing.selectSameType();
    expect(editing.selection()).toEqual([STICKY, IMAGE, OTHER]);
    editing.select([]);
    editing.selectSameType();
    expect(editing.selection()).toEqual([]);
  });

  it("tells shapes by their outline and strokes by their tip, and stays at its level", () => {
    const line = [
      { x: 0, y: 600 },
      { x: 50, y: 650 },
    ];
    const RECTANGLE = "1".repeat(32);
    const ELLIPSE = "2".repeat(32);
    const INNER = "3".repeat(32);
    const PEN = "4".repeat(32);
    const HIGHLIGHT = "5".repeat(32);
    const { editing } = page([
      [RECTANGLE, shaped("rectangle", 300)],
      [ELLIPSE, shaped("ellipse", 400)],
      [INNER, shaped("rectangle", 500)],
      [OTHER, apart],
      [PEN, core.strokeKind(line, 0, "pen")],
      [HIGHLIGHT, core.strokeKind(line, 0, "highlighter")],
    ]);
    editing.select([INNER, OTHER]);
    editing.group(GROUP);
    editing.select([RECTANGLE]);
    editing.selectSameType();
    expect(editing.selection()).toEqual([RECTANGLE]);
    editing.select([HIGHLIGHT]);
    editing.selectSameType();
    expect(editing.selection()).toEqual([HIGHLIGHT]);
    editing.select([GROUP]);
    editing.goInside();
    editing.select([INNER]);
    editing.selectSameType();
    expect(editing.selection()).toEqual([INNER]);
  });

  it("leaves out what is locked and the annotations hidden", () => {
    let shown = true;
    const { editing } = page(
      [
        [IMAGE, image],
        [OTHER, apart],
      ],
      { showsAnnotations: () => shown },
    );
    editing.select([OTHER]);
    editing.lock();
    editing.select([STICKY]);
    editing.selectSameType();
    expect(editing.selection()).toEqual([STICKY]);
    editing.invertSelection();
    expect(editing.selection()).toEqual([IMAGE]);
    shown = false;
    editing.select([]);
    editing.invertSelection();
    expect(editing.selection()).toEqual([IMAGE]);
  });
});
