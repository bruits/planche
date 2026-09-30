// Edits by pointer and keyboard: select, move, delete, undo, and redo. A click selects the
// element under it, or the outermost group holding it, and a drag from where nothing is
// draws a rectangle that selects what it touches.

import type { Board, Editor, Point, Rect } from "./core.js";
import type { Overlay } from "./overlay.js";
import type { View } from "./view.js";

/** How near the pointer counts as on an element, in CSS pixels. */
const TOLERANCE = 4;
/** How far a press moves before it drags, in CSS pixels. */
const DRAG = 3;

export interface Editing {
  editor: Editor;
  board: Board;
}

export interface Edits {
  /** Forgets the selection and any drag, as when another board opens. */
  reset(): void;
}

/**
 * `changed` receives the elements every edit, undo, and redo touches, once `current` would
 * have them up to date, as it must.
 */
export function edits(
  view: View,
  overlay: Overlay,
  current: () => Editing | undefined,
  changed: (touched: string[]) => void,
): Edits {
  let selected = new Set<string>();
  let press:
    | { pointer: number; start: Point; last: Point; dragging: boolean; clicked: string | undefined }
    | { pointer: number; start: Point; marquee: Set<string> }
    | undefined;

  const show = () => {
    const editing = current();
    overlay.outline(editing ? [...selected].map((id) => editing.editor.outline(id)) : []);
  };
  /** Undoing and redoing select what they touch, and nothing touched keeps the selection. */
  const edit = (editing: Editing, touched: string[], reselect = false) => {
    changed(touched);
    if (reselect && touched.length > 0) {
      selected = new Set(touched.flatMap((id) => editing.editor.topLevel(id) ?? []));
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
    if (press || !editing || !at || !zoom || event.button !== 0 || event.altKey) {
      return;
    }
    const { editor } = editing;
    const hit = editor.hit(at.x, at.y, TOLERANCE / zoom);
    const top = hit === undefined ? undefined : editor.topLevel(hit);
    const toggling = event.shiftKey || event.metaKey || event.ctrlKey;
    if (top !== undefined && toggling) {
      if (!selected.delete(top)) {
        selected.add(top);
      }
    } else if (top !== undefined) {
      // Pressing one of several selected elements drags them all, and clicking it selects it alone.
      const clicked = selected.has(top) ? top : undefined;
      if (!clicked) {
        selected = new Set([top]);
      }
      press = { pointer: event.pointerId, start: at, last: at, dragging: false, clicked };
    } else {
      press = { pointer: event.pointerId, start: at, marquee: toggling ? new Set(selected) : new Set() };
      selected = new Set(press.marquee);
    }
    if (press) {
      view.host.setPointerCapture(event.pointerId);
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
    if ("marquee" in press) {
      const area = rect(press.start, at);
      const touched = editor.touching(area.x, area.y, area.width, area.height);
      selected = new Set([...press.marquee, ...touched.flatMap((id) => editor.topLevel(id) ?? [])]);
      overlay.marquee(area);
      show();
      return;
    }
    if (!press.dragging) {
      if (Math.hypot(at.x - press.start.x, at.y - press.start.y) * zoom < DRAG) {
        return;
      }
      press.dragging = true;
      editor.beginGesture();
    }
    const moved = editor.translate([...selected], at.x - press.last.x, at.y - press.last.y);
    press.last = at;
    edit(editing, moved);
  });

  const release = () => {
    if (!press) {
      return;
    }
    if ("marquee" in press) {
      overlay.marquee(undefined);
    } else if (press.dragging) {
      current()?.editor.endGesture();
    } else if (press.clicked !== undefined) {
      selected = new Set([press.clicked]);
      show();
    }
    press = undefined;
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

  window.addEventListener("keydown", (event) => {
    const editing = current();
    if (!editing || press) {
      return;
    }
    const { editor } = editing;
    const key = event.key.toLowerCase();
    const command = event.metaKey || event.ctrlKey;
    if ((key === "delete" || key === "backspace") && selected.size > 0) {
      edit(editing, editor.remove([...selected]));
    } else if (command && key === "z" && !event.shiftKey) {
      edit(editing, editor.undo(), true);
    } else if (command && ((key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey))) {
      edit(editing, editor.redo(), true);
    } else {
      return;
    }
    event.preventDefault();
  });

  return {
    reset() {
      selected = new Set();
      press = undefined;
      overlay.outline([]);
      overlay.marquee(undefined);
    },
  };
}

function rect(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}
