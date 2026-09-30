// Edits: draw, select, move, scale, and rotate by pointer, and flip, restack, group, delete,
// undo, and redo for the commands to run. A click selects the element under it, or the
// outermost group holding it, and a drag from where nothing is draws a rectangle that selects
// what it touches. Double-clicking a group goes into it, where clicks select its own elements
// instead. The selection's corners scale it around the opposite one, the handle above it rotates
// it around its centre, and a lone arrow's ends move on their own.

import { mac, opensMenu } from "./commands.js";
import * as core from "./core.js";
import type { Board, Editor, Kind, Point, Rect } from "./core.js";
import { newId } from "./board.js";
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
/** A shape placed by a click, in CSS pixels. */
const PLACED_SIZE = 100;

export interface Editing {
  editor: Editor;
  board: Board;
}

export type Restack = "forward" | "backward" | "front" | "back";

/** What a press draws, while a tool to draw is in use. */
export type Draw = "arrow" | "rectangle" | "ellipse";

export interface Hooks {
  /**
   * The elements every edit, undo, and redo touches, once `current` would have them up to date,
   * as it must.
   */
  changed(touched: string[]): void;
  selectionChanged(): void;
  /** What a press draws, `undefined` when it selects. */
  drawing(): Draw | undefined;
  /** Once a press drew something, which it selects. */
  drawn(): void;
}

type Arrow = Extract<Kind, { type: "arrow" }>;

export interface Edits {
  /** Whether a gesture is under way, which edits from elsewhere would break. */
  busy(): boolean;
  /** Once no gesture is under way. */
  idle(): Promise<void>;
  /** Elements of the group gone into, or of the top level. */
  selection(): string[];
  /** The group gone into, `undefined` at the top level. */
  entered(): string | undefined;
  /** Selects the elements, or the groups holding them at the level of the selection. */
  select(ids: string[]): void;
  /** Everything in the group gone into, or on the board. */
  selectAll(): void;
  /** Selects the group gone into, which leaves it. Whether there was one. */
  up(): boolean;
  /** Into the one group selected, selecting its elements. */
  goInside(): void;
  loneArrow(): boolean;
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
  /** Into a new group named `id`, which it selects. */
  group(id: string): void;
  /** Selects the elements of the groups it ungroups. */
  ungroup(): void;
  undo(): void;
  redo(): void;
  /** Forgets the selection and any drag, as when another board opens. */
  reset(): void;
}

type Press =
  /** `through` a press on nothing but the selection's box, which a click lets go of. */
  | { kind: "move"; pointer: number; start: Point; dragging: boolean; clicked?: string; through?: true }
  | { kind: "marquee"; pointer: number; start: Point; kept: Set<string> }
  | { kind: "scale"; pointer: number; origin: Point; handle: Point }
  | { kind: "rotate"; pointer: number; pivot: Point; from: number }
  | { kind: "draw"; pointer: number; start: Point; last: Point; shape: Draw; id: string; dragging: boolean }
  | { kind: "end"; pointer: number; start: Point; dragging: boolean; id: string; arrow: Arrow; end: "from" | "to" };

export function edits(
  view: View,
  overlay: Overlay,
  current: () => Editing | undefined,
  { changed, selectionChanged, drawing, drawn }: Hooks,
): Edits {
  let selected = new Set<string>();
  let entered: string | undefined;
  let press: Press | undefined;
  /** Whether the last press was a click, as browsers still send a double-click when it dragged. */
  let wasClick = false;
  let waiting: (() => void)[] = [];
  const settle = () => {
    press = undefined;
    const ready = waiting;
    waiting = [];
    ready.forEach((resolve) => resolve());
  };

  const lone = (editing: Editing): { id: string; arrow: Arrow } | undefined => {
    const [id] = selected;
    const kind = selected.size === 1 ? editing.board.elements[id!]?.kind : undefined;
    return kind?.type === "arrow" ? { id: id!, arrow: kind } : undefined;
  };
  const show = () => {
    const editing = current();
    const ids = [...selected];
    const arrow = editing && lone(editing)?.arrow;
    overlay.outline(editing ? ids.map((id) => editing.editor.outline(id)) : []);
    overlay.box(editing && ids.length > 0 && !arrow ? box(editing.editor, ids) : undefined);
    overlay.ends(arrow ? [arrow.from, arrow.to] : undefined);
    overlay.entered(editing && entered !== undefined ? box(editing.editor, [entered]) : undefined);
    selectionChanged();
  };
  /** The element, or its group, at the level of the selection, `undefined` outside the group gone into. */
  const level = (editor: Editor, id: string) =>
    entered === undefined ? editor.topLevel(id) : editor.memberOf(entered, id);
  /**
   * Up to the group `to`, or the top level. A selection never mixes levels, as moving a group
   * and one of its elements would move it twice.
   */
  const leave = (editor: Editor, to?: string) => {
    entered = to;
    selected = new Set([...selected].flatMap((id) => level(editor, id) ?? []));
  };
  /** What a press on `hit` is about. Pressing anything but the group's elements leaves it, unless `stays`. */
  const aimed = (editor: Editor, hit: string | undefined, stays: boolean) => {
    if (entered !== undefined && !stays && (hit === undefined || level(editor, hit) === undefined)) {
      leave(editor);
    }
    return hit === undefined ? undefined : level(editor, hit);
  };
  const select = (editing: Editing, ids: string[]) => {
    const { editor, board } = editing;
    const present = ids.filter((id) => id in board.elements);
    if (present.some((id) => level(editor, id) === undefined)) {
      leave(editor);
    }
    selected = new Set(present.flatMap((id) => level(editor, id) ?? []));
  };
  /** Undoing and redoing select what they touch, and nothing touched keeps the selection. */
  const edit = (editing: Editing, touched: string[], reselect = false) => {
    const { board } = editing;
    // Read before the edit, which may remove the group gone into, and its emptied groups too.
    const around: string[] = [];
    for (let at = entered; at !== undefined && !around.includes(at); at = board.elements[at]?.group) {
      around.push(at);
    }
    changed(touched);
    if (entered !== undefined && !(entered in board.elements)) {
      leave(editing.editor, around.find((id) => id in board.elements));
    }
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
    wasClick = false;
    const editing = current();
    const at = view.at(event);
    const zoom = view.zoom();
    if (press || !editing || !at || !zoom || event.button !== 0 || view.pans(event) || opensMenu(event)) {
      return;
    }
    const { editor } = editing;
    const pointer = event.pointerId;
    const shape = drawing();
    if (shape) {
      press = { kind: "draw", pointer, start: at, last: at, shape, id: newId(), dragging: false };
      view.host.setPointerCapture(pointer);
      return;
    }
    const single = lone(editing);
    if (single) {
      const ends = (["from", "to"] as const).filter((end) => distance(at, single.arrow[end]) * zoom <= REACH);
      // The nearest, as they may overlap on a short arrow.
      const end = ends.sort((a, b) => distance(at, single.arrow[a]) - distance(at, single.arrow[b]))[0];
      if (end) {
        press = { kind: "end", pointer, start: at, dragging: false, ...single, end };
        editor.beginGesture();
        view.host.setPointerCapture(pointer);
        return;
      }
    }
    const corners = selected.size > 0 && !single ? box(editor, [...selected]) : undefined;
    const far = corners ? handles(corners, zoom).map((handle) => distance(at, handle) * zoom) : [];
    const nearest = far.indexOf(Math.min(...far));
    const grabbed = far[nearest]! <= REACH ? nearest : -1;
    const hit = editor.hit(at.x, at.y, TOLERANCE / zoom);
    // Ctrl on macOS opens the context menu instead.
    const toggling = event.shiftKey || event.metaKey || (event.ctrlKey && !mac);
    // Within the selection's box, which its hollow shapes mostly let through, a press drags it.
    const onSelection = hit === undefined && !toggling && within(at, corners);
    const top = aimed(editor, hit, grabbed >= 0 || onSelection);
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
    } else if (onSelection) {
      press = { kind: "move", pointer, start: at, dragging: false, through: true };
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
      case "draw": {
        press.last = at;
        if (!press.dragging) {
          if (distance(at, press.start) * zoom < DRAG) {
            return;
          }
          press.dragging = true;
          selected = new Set();
          editor.beginGesture();
        }
        const { id, shape, start } = press;
        again(() => editor.add(id, entered, JSON.stringify(shaped(shape, start, at))));
        return;
      }
      case "end": {
        const { id, arrow, end, start } = press;
        // By as much as the pointer moved, so that the end never jumps to it.
        if (!press.dragging && distance(at, start) * zoom < DRAG) {
          return;
        }
        press.dragging = true;
        const moved = { x: arrow[end].x + at.x - start.x, y: arrow[end].y + at.y - start.y };
        again(() => editor.update(id, JSON.stringify({ ...arrow, [end]: moved })));
        return;
      }
    }
  });

  /** `completed` unless the press was lost, as to a blur. */
  const release = (completed: boolean) => {
    if (!press) {
      return;
    }
    wasClick = press.kind === "move" && !press.dragging;
    if (press.kind === "marquee") {
      overlay.marquee(undefined);
    } else if (press.kind === "draw") {
      finishDrawing(press, completed);
    } else if (press.kind !== "move" || press.dragging) {
      current()?.editor.endGesture();
    } else if (press.clicked !== undefined) {
      selected = new Set([press.clicked]);
      show();
    } else if (press.through && completed) {
      // As a click on nothing does.
      entered = undefined;
      selected = new Set();
      show();
    }
    settle();
  };
  /**
   * A click places a shape at a size of its own, but draws no arrow, which has no such size. A
   * drag brought back to where it started counts as a click.
   */
  const finishDrawing = (press: Extract<Press, { kind: "draw" }>, completed: boolean) => {
    const editing = current();
    const zoom = view.zoom();
    if (!editing) {
      return;
    }
    const { editor } = editing;
    const { id, shape, start, last, dragging } = press;
    if (dragging && zoom !== undefined && distance(last, start) * zoom >= DRAG) {
      editor.endGesture();
    } else {
      const touched = dragging ? editor.rewindGesture() : [];
      const placing = shape !== "arrow" && completed && zoom !== undefined;
      if (placing) {
        const half = PLACED_SIZE / zoom / 2;
        const corner = (sign: number) => ({ x: start.x + sign * half, y: start.y + sign * half });
        touched.push(...editor.add(id, entered, JSON.stringify(shaped(shape, corner(-1), corner(1)))));
      }
      editor.endGesture();
      edit(editing, touched);
      if (!placing) {
        return;
      }
    }
    selected = new Set([id]);
    show();
    drawn();
  };
  // A gesture left open would keep undo from ever working again.
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    view.host.addEventListener(type, (event) => {
      if (event.pointerId === press?.pointer) {
        release(type === "pointerup");
      }
    });
  }
  addEventListener("blur", () => release(false));

  view.host.addEventListener("dblclick", (event) => {
    const editing = current();
    const at = view.at(event);
    const zoom = view.zoom();
    if (!wasClick || press || !editing || !at || !zoom || event.button !== 0 || view.pans(event)) {
      return;
    }
    const { editor, board } = editing;
    const hit = editor.hit(at.x, at.y, TOLERANCE / zoom);
    const group = hit === undefined ? undefined : level(editor, hit);
    if (hit === undefined || group === undefined || board.elements[group]?.kind.type !== "group") {
      return;
    }
    const member = editor.memberOf(group, hit);
    entered = group;
    selected = new Set(member === undefined ? [] : [member]);
    show();
  });

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
    entered: () => entered,
    loneArrow() {
      const editing = current();
      return editing !== undefined && lone(editing) !== undefined;
    },
    select(ids) {
      const editing = current();
      if (editing) {
        select(editing, ids);
        show();
      }
    },
    selectAll() {
      const editing = current();
      if (editing) {
        const { editor, board } = editing;
        selected = new Set(board.draw_order.flatMap((id) => level(editor, id) ?? []));
        show();
      }
    },
    up() {
      const editing = current();
      if (!editing || entered === undefined || press) {
        return false;
      }
      selected = new Set([entered]);
      entered = editing.board.elements[entered]?.group;
      show();
      return true;
    },
    goInside: () =>
      run(({ board }, ids) => {
        const group = ids[0];
        if (ids.length !== 1 || board.elements[group!]?.kind.type !== "group") {
          return;
        }
        entered = group;
        selected = new Set(Object.keys(board.elements).filter((id) => board.elements[id]!.group === group));
        show();
      }),
    aim(at) {
      const editing = current();
      const zoom = view.zoom();
      if (!editing || !zoom || press) {
        return selected.size > 0;
      }
      const { editor } = editing;
      const hit = editor.hit(at.x, at.y, TOLERANCE / zoom);
      // As a left press would, with no box around a lone arrow.
      const onSelection = hit === undefined && !lone(editing) && within(at, box(editor, [...selected]));
      const top = aimed(editor, hit, onSelection);
      if (top !== undefined && !selected.has(top)) {
        selected = new Set([top]);
      } else if (top === undefined && !onSelection) {
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
    group: (id) =>
      run((editing, ids) => {
        const touched = editing.editor.group(id, ids);
        selected = new Set([id]);
        edit(editing, touched);
      }),
    ungroup: () =>
      run((editing, ids) => {
        const { editor, board } = editing;
        const groups = new Set(ids.filter((id) => board.elements[id]?.kind.type === "group"));
        const members = Object.keys(board.elements).filter((id) => groups.has(board.elements[id]!.group ?? ""));
        const touched: string[] = [];
        editor.beginGesture();
        try {
          groups.forEach((group) => touched.push(...editor.ungroup(group)));
        } finally {
          editor.endGesture();
          // Even halfway, so that the board the app keeps matches the core's.
          selected = new Set([...ids.filter((id) => !groups.has(id)), ...members]);
          edit(editing, touched);
        }
      }),
    undo: () => run((editing) => edit(editing, editing.editor.undo(), true)),
    redo: () => run((editing) => edit(editing, editing.editor.redo(), true)),
    reset() {
      selected = new Set();
      entered = undefined;
      settle();
      overlay.outline([]);
      overlay.box(undefined);
      overlay.ends(undefined);
      overlay.marquee(undefined);
      overlay.entered(undefined);
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

/** Between two corners of its frame, or from one end to the other. */
function shaped(shape: Draw, from: Point, to: Point): Kind {
  return shape === "arrow" ? { type: "arrow", from, to } : { type: "shape", frame: rect(from, to), rotation: 0, shape };
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
