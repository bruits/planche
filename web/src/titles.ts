// Groups' titles, as labels over the top-left of what each group draws, at one size on screen
// whatever the zoom, so that they read from afar. They lie above whatever the board draws, so the
// renderer and pictures of the board leave them out. A press on one reaches the board as a press
// on its group, and a double-click writes it where it shows.

import type { Camera, Viewport } from "./camera.js";
import { composing } from "./commands.js";
import type { Board, Rect } from "./core.js";

export interface Titles {
  /**
   * The titles of `board`'s groups, each over the area `over` gives it, marked when its group is
   * `selected`, and one to add over `offered`, a group selected alone with none.
   */
  show(
    board: Board,
    over: (id: string) => Rect | undefined,
    selected: string[],
    offered?: string,
  ): void;
  /** Mirrored left to right across the viewport `mirrored` when given, as the board shows. */
  frame(camera: Camera, mirrored?: Viewport): void;
  /** Writes the title of group `id` where it shows, until Enter, Esc, or a press elsewhere. */
  write(id: string): void;
  /** Until the next board shows. */
  clear(): void;
}

/** The group whose title `target` is, or lies in, unless it is locked, as presses go through it then. */
export function titledGroup(target: EventTarget | null): string | undefined {
  const label = target instanceof Element ? target.closest<HTMLElement>(".group-title") : null;
  return label && !label.classList.contains("locked") && !label.classList.contains("offered")
    ? label.dataset.group
    : undefined;
}

/** Whether `target` is a group's title, or one offered, or lies in one. */
export function onTitle(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".group-title") !== null;
}

const OFFER = "Add title";
/** The least a title shows of itself, in CSS pixels, however small its group shows. */
const NARROWEST = 48;

/** `rename` gives group `id` the title written, blank for none. */
export function titles(host: HTMLElement, rename: (id: string, title: string) => void): Titles {
  const layer = document.createElement("div");
  layer.className = "titles";
  host.append(layer);
  const shown = new Map<string, { label: HTMLElement; over: Rect; title: string }>();
  let camera: Camera | undefined;
  let mirrored: Viewport | undefined;
  let writing: { id: string; field: HTMLInputElement } | undefined;
  const place = ({ label, over }: { label: HTMLElement; over: Rect }) => {
    if (!camera) {
      return;
    }
    // Over the corner that shows on the left, which mirroring swaps.
    const edge = mirrored ? over.x + over.width : over.x;
    const left = (edge - camera.x) * camera.zoom;
    const x = mirrored ? mirrored.width - left : left;
    const y = (over.y - camera.y) * camera.zoom;
    label.style.setProperty("transform", `translate(${x}px, ${y}px)`);
    label.style.setProperty("max-width", `${Math.max(over.width * camera.zoom, NARROWEST)}px`);
  };
  const create = (id: string) => {
    const label = document.createElement("div");
    label.className = "group-title";
    label.dataset.group = id;
    // An offer takes its own press, which the board would take as one on nothing.
    label.addEventListener("pointerdown", (event) => {
      if (label.classList.contains("offered") || label.classList.contains("writing")) {
        event.stopPropagation();
      }
    });
    label.addEventListener("click", () => {
      if (label.classList.contains("offered")) {
        write(id);
      }
    });
    // The board would go inside the group.
    label.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      write(id);
    });
    layer.append(label);
    return { label, over: { x: 0, y: 0, width: 0, height: 0 }, title: "" };
  };
  const finish = () => {
    const ended = writing;
    if (!ended) {
      return;
    }
    writing = undefined;
    const entry = shown.get(ended.id);
    if (entry) {
      entry.label.classList.remove("writing");
      entry.label.textContent = entry.title || OFFER;
    }
    if (entry && ended.field.value !== entry.title) {
      rename(ended.id, ended.field.value);
    }
  };
  const write = (id: string) => {
    const entry = shown.get(id);
    if (!entry || writing?.id === id) {
      return;
    }
    finish();
    const field = document.createElement("input");
    field.type = "text";
    field.placeholder = "Title";
    field.setAttribute("aria-label", "Group title");
    field.value = entry.title;
    const fit = () =>
      field.style.setProperty("width", `${Math.max(field.value.length, OFFER.length) + 1}ch`);
    fit();
    field.addEventListener("input", fit);
    // Esc ends it too, as it ends writing a note.
    field.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === "Escape") && !composing(event)) {
        event.preventDefault();
        field.blur();
      }
    });
    field.addEventListener("blur", finish);
    writing = { id, field };
    entry.label.classList.add("writing");
    entry.label.replaceChildren(field);
    field.focus({ preventScroll: true });
    field.select();
  };
  // Before the board hears of a press elsewhere, which would refuse the title's edit as its own began.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (writing && event.target !== writing.field) {
        writing.field.blur();
      }
    },
    { capture: true },
  );
  return {
    show(board, over, selected, offered) {
      const chosen = new Set(selected);
      const groups = board.draw_order.flatMap((id) => {
        const { kind } = board.elements[id]!;
        return kind.type === "group" && (kind.title !== undefined || id === offered)
          ? [{ id, title: kind.title ?? "" }]
          : [];
      });
      const present = new Set(groups.map(({ id }) => id));
      if (writing && !present.has(writing.id)) {
        writing.field.blur();
      }
      for (const [id, { label }] of shown) {
        if (!present.has(id)) {
          label.remove();
          shown.delete(id);
        }
      }
      for (const { id, title } of groups) {
        const entry = shown.get(id) ?? create(id);
        shown.set(id, entry);
        const area = over(id);
        entry.label.hidden = area === undefined;
        if (area === undefined) {
          continue;
        }
        entry.over = area;
        entry.title = title;
        if (writing?.id !== id) {
          entry.label.textContent = title || OFFER;
        }
        entry.label.classList.toggle("offered", title === "");
        entry.label.classList.toggle("selected", chosen.has(id));
        entry.label.classList.toggle("locked", lockedUp(board, id));
        place(entry);
      }
    },
    frame(next, across) {
      camera = next;
      mirrored = across;
      layer.hidden = false;
      shown.forEach(place);
    },
    write,
    clear() {
      writing = undefined;
      camera = undefined;
      layer.hidden = true;
      layer.replaceChildren();
      shown.clear();
    },
  };
}

/** Whether the group `id`, or one holding it, is locked. */
function lockedUp(board: Board, id: string): boolean {
  // Boards are repaired on read, but a cycle would loop forever.
  const seen = new Set<string>();
  for (let at: string | undefined = id; at !== undefined && !seen.has(at);) {
    if (board.elements[at]?.locked === true) {
      return true;
    }
    seen.add(at);
    at = board.elements[at]?.group;
  }
  return false;
}
