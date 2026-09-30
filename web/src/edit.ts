// Edits: select, move, scale, and rotate by pointer, and flip, restack, delete, undo, and redo
// for the commands to run. A click selects the element under it, or the outermost group holding
// it, and a drag from where nothing is draws a rectangle that selects what it touches. The
// selection's corners scale it around the opposite one, and the handle above it rotates it
// around its centre.

import { mac, opensMenu } from "./commands.js";
import * as core from "./core.js";
import type { Board, Editor, Point, Rect } from "./core.js";
import { handles, type Overlay } from "./overlay.js";
import type { View } from "./view.js";

/** How near the pointer counts as on an element, in CSS pixels. */
const TOLERANCE = 4;
/** How near the pointer counts as on a handle, in CSS pixels. */
const REACH = 6;
/** How far a press moves before it drags, in CSS pixels. */
const DRAG = 3;
/** Scaling down further would turn the selection over. */
const SMALLEST_SCALE = 0.01;

export interface Editing {
  editor: Editor;
  board: Board;
}

export type Restack = "forward" | "backward" | "front" | "back";

export interface Edits {
  /** Whether a gesture is under way, which edits from elsewhere would break. */
  busy(): boolean;
  /** Once no gesture is under way. */
  idle(): Promise<void>;
  /** Top-level elements only. */
  selection(): string[];
  /** Selects the elements, or their outermost groups. */
  select(ids: string[]): void;
  /**
   * Selects what a right-click at `at` is about, the element there unless it is selected
   * already, or nothing unless `at` is within the selection. Whether anything is.
   */
  aim(at: Point): boolean;
  /** The selection's centre, `undefined` when nothing is selected. */
  centre(): Point | undefined;
  remove(): void;
  flip(horizontally: boolean): void;
  restack(to: Restack): void;
  undo(): void;
  redo(): void;
  /** Forgets the selection and any drag, as when another board opens. */
  reset(): void;
}

type Press =
  | { kind: "move"; pointer: number; start: Point; dragging: boolean; clicked?: string }
  | { kind: "marquee"; pointer: number; start: Point; kept: Set<string> }
  | { kind: "scale"; pointer: number; origin: Point; handle: Point }
  | { kind: "rotate"; pointer: number; pivot: Point; from: number };

/**
 * `changed` receives the elements every edit, undo, and redo touches, once `current` would
 * have them up to date, as it must. `selectionChanged` hears whenever the selection may have.
 */
export function edits(
  view: View,
  overlay: Overlay,
  current: () => Editing | undefined,
  changed: (touched: string[]) => void,
  selectionChanged: () => void,
): Edits {
  let selected = new Set<string>();
  let press: Press | undefined;
  let waiting: (() => void)[] = [];
  const settle = () => {
    press = undefined;
    const ready = waiting;
    waiting = [];
    ready.forEach((resolve) => resolve());
  };

  const show = () => {
    const editing = current();
    const ids = [...selected];
    overlay.outline(editing ? ids.map((id) => editing.editor.outline(id)) : []);
    overlay.box(editing && ids.length > 0 ? box(editing.editor, ids) : undefined);
    selectionChanged();
  };
  const select = (editing: Editing, ids: string[]) => {
    selected = new Set(ids.flatMap((id) => editing.editor.topLevel(id) ?? []));
  };
  /** Undoing and redoing select what they touch, and nothing touched keeps the selection. */
  const edit = (editing: Editing, touched: string[], reselect = false) => {
    changed(touched);
    if (reselect && touched.length > 0) {
      select(editing, touched);
    }
    for (const id of selected) {
      if (!(id in editing.board.elements)) {
        selected.delete(id);
      }
    }
    show();
  };

  view.host.addEventListener("pointerdown", (event) => {
    const editing = current();
    const at = view.at(event);
    const zoom = view.zoom();
    if (press || !editing || !at || !zoom || event.button !== 0 || view.pans(event) || opensMenu(event)) {
      return;
    }
    const { editor } = editing;
    const pointer = event.pointerId;
    const corners = selected.size > 0 ? box(editor, [...selected]) : undefined;
    const far = corners ? handles(corners, zoom).map((handle) => distance(at, handle) * zoom) : [];
    const nearest = far.indexOf(Math.min(...far));
    const grabbed = far[nearest]! <= REACH ? nearest : -1;
    const hit = editor.hit(at.x, at.y, TOLERANCE / zoom);
    const top = hit === undefined ? undefined : editor.topLevel(hit);
    // Ctrl on macOS opens the context menu instead.
    const toggling = event.shiftKey || event.metaKey || (event.ctrlKey && !mac);
    if (corners && grabbed >= 0) {
      // The rotation handle comes last, after the corners if the box is large enough for them.
      if (grabbed < far.length - 1) {
        // From where it is pressed, so that it starts at 1.
        press = { kind: "scale", pointer, origin: corners[(grabbed + 2) % 4]!, handle: at };
      } else {
        const pivot = { x: (corners[0]!.x + corners[2]!.x) / 2, y: (corners[0]!.y + corners[2]!.y) / 2 };
        press = { kind: "rotate", pointer, pivot, from: Math.atan2(at.y - pivot.y, at.x - pivot.x) };
      }
      editor.beginGesture();
    } else if (top !== undefined && toggling) {
      if (!selected.delete(top)) {
        selected.add(top);
      }
    } else if (top !== undefined) {
      // Pressing one of several selected elements drags them all, and clicking it selects it alone.
      const clicked = selected.has(top) ? top : undefined;
      if (!clicked) {
        selected = new Set([top]);
      }
      press = { kind: "move", pointer, start: at, dragging: false, clicked };
    } else {
      press = { kind: "marquee", pointer, start: at, kept: toggling ? new Set(selected) : new Set() };
      selected = new Set(press.kept);
    }
    if (press) {
      view.host.setPointerCapture(pointer);
    }
    show();
  });

  view.host.addEventListener("pointermove", (event) => {
    const editing = current();
    const at = view.at(event);
    const zoom = view.zoom();
    if (!press || event.pointerId !== press.pointer || !editing || !at || !zoom) {
      return;
    }
    const { editor } = editing;
    const ids = [...selected];
    // From where the gesture began, so that coming back there changes nothing.
    const again = (edited: () => string[]) => edit(editing, [...editor.rewindGesture(), ...edited()]);
    switch (press.kind) {
      case "marquee": {
        const area = rect(press.start, at);
        const touched = editor.touching(area.x, area.y, area.width, area.height);
        selected = new Set([...press.kept, ...touched.flatMap((id) => editor.topLevel(id) ?? [])]);
        overlay.marquee(area);
        show();
        return;
      }
      case "move": {
        if (!press.dragging) {
          if (distance(at, press.start) * zoom < DRAG) {
            return;
          }
          press.dragging = true;
          editor.beginGesture();
        }
        const { start } = press;
        again(() => editor.translate(ids, at.x - start.x, at.y - start.y));
        return;
      }
      case "scale": {
        const { origin, handle } = press;
        const [dx, dy] = [handle.x - origin.x, handle.y - origin.y];
        const length = dx * dx + dy * dy;
        if (length === 0) {
          return;
        }
        // Along the diagonal, so that the scale is the same both ways.
        const along = ((at.x - origin.x) * dx + (at.y - origin.y) * dy) / length;
        again(() => editor.scale(ids, origin.x, origin.y, Math.max(along, SMALLEST_SCALE)));
        return;
      }
      case "rotate": {
        const { pivot, from } = press;
        const turned = ((Math.atan2(at.y - pivot.y, at.x - pivot.x) - from) * 180) / Math.PI;
        again(() => editor.rotate(ids, pivot.x, pivot.y, turned));
        return;
      }
    }
  });

  const release = () => {
    if (!press) {
      return;
    }
    if (press.kind === "marquee") {
      overlay.marquee(undefined);
    } else if (press.kind !== "move" || press.dragging) {
      current()?.editor.endGesture();
    } else if (press.clicked !== undefined) {
      selected = new Set([press.clicked]);
      show();
    }
    settle();
  };
  // A gesture left open would keep undo from ever working again.
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    view.host.addEventListener(type, (event) => {
      if (event.pointerId === press?.pointer) {
        release();
      }
    });
  }
  addEventListener("blur", release);

  /** Unless a gesture is under way, since it would carry on over the edit. */
  const run = (edited: (editing: Editing, ids: string[]) => void) => {
    const editing = current();
    if (editing && !press) {
      edited(editing, [...selected]);
    }
  };

  return {
    busy: () => press !== undefined,
    idle: () => (press ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve()),
    selection: () => [...selected],
    select(ids) {
      const editing = current();
      if (editing) {
        select(editing, ids);
        show();
      }
    },
    aim(at) {
      const editing = current();
      const zoom = view.zoom();
      if (!editing || !zoom || press) {
        return selected.size > 0;
      }
      const { editor } = editing;
      const hit = editor.hit(at.x, at.y, TOLERANCE / zoom);
      const top = hit === undefined ? undefined : editor.topLevel(hit);
      if (top !== undefined && !selected.has(top)) {
        selected = new Set([top]);
      } else if (top === undefined && !within(at, box(editor, [...selected]))) {
        selected = new Set();
      }
      show();
      return selected.size > 0;
    },
    centre() {
      const editing = current();
      const corners = editing && selected.size > 0 ? box(editing.editor, [...selected]) : undefined;
      return corners && { x: (corners[0]!.x + corners[2]!.x) / 2, y: (corners[0]!.y + corners[2]!.y) / 2 };
    },
    remove: () => run((editing, ids) => edit(editing, editing.editor.remove(ids))),
    flip: (horizontally) => run((editing, ids) => edit(editing, editing.editor.flip(ids, horizontally))),
    restack: (to) => run((editing, ids) => edit(editing, editing.editor.restack(ids, to))),
    undo: () => run((editing) => edit(editing, editing.editor.undo(), true)),
    redo: () => run((editing) => edit(editing, editing.editor.redo(), true)),
    reset() {
      selected = new Set();
      settle();
      overlay.outline([]);
      overlay.box(undefined);
      overlay.marquee(undefined);
      selectionChanged();
    },
  };
}

/** Whether `point` is inside the box, whichever way it is turned. */
function within(point: Point, corners: Point[] | undefined): boolean {
  if (!corners) {
    return false;
  }
  // On the same side of every edge, as the box is convex.
  const sides = corners.map((from, at) => {
    const to = corners[(at + 1) % corners.length]!;
    return Math.sign((to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x));
  });
  return sides.every((side) => side >= 0) || sides.every((side) => side <= 0);
}

/** Clockwise from its top-left: a lone element's own, turned with it, or the upright bounds of all. */
function box(editor: Editor, ids: string[]): Point[] | undefined {
  const outline = ids.length === 1 ? editor.outline(ids[0]!) : undefined;
  if (outline?.length === 8) {
    return [0, 2, 4, 6].map((at) => ({ x: outline[at]!, y: outline[at + 1]! }));
  }
  const bounds = core.bounds(editor, ids);
  if (!bounds) {
    return undefined;
  }
  const { x, y, width, height } = bounds;
  const [right, bottom] = [x + width, y + height];
  return [
    { x, y },
    { x: right, y },
    { x: right, y: bottom },
    { x, y: bottom },
  ];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function rect(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}
