// Comments, as pins over the board at one size on screen whatever the zoom, each growing into
// its text while hovered or focused. They lie above whatever the board draws, so the
// renderer leaves them out. A press on a pin reaches the board as a press on its comment, and
// keys pressed on a focused one write in it.

import type { Camera } from "./camera.js";
import type { Board, Point } from "./core.js";

export interface Pins {
  /**
   * Those of `board`, marked when they or their groups are `selected`, and the pin of `hidden`
   * left to the field that writes it.
   */
  show(board: Board, selected: string[], hidden?: string): void;
  frame(camera: Camera): void;
  /** Until the next board shows. */
  clear(): void;
}

/** The comment whose pin `target` is, or lies in. */
export function pinned(target: EventTarget | null): string | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>(".comment")?.dataset.comment
    : undefined;
}

/** How much of a comment names its pin, in characters. */
const NAMED = 40;

export interface Keys {
  /** The comment whose pin Space presses. */
  choose(id: string): void;
  /** The comment whose pin Enter presses, which takes the focus back once written. */
  write(id: string): void;
}

/** One stop for Tab, and the arrow keys between pins, in the order the board stacks them. */
export function pins(host: HTMLElement, { choose, write }: Keys): Pins {
  const layer = document.createElement("div");
  layer.className = "pins";
  layer.setAttribute("role", "toolbar");
  layer.setAttribute("aria-label", "Comments");
  host.append(layer);
  const stops = () => [...layer.querySelectorAll<HTMLButtonElement>(".pin")];
  const stop = (next: HTMLButtonElement | undefined) =>
    stops().forEach(
      (pin, at) => (pin.tabIndex = pin === next || (next === undefined && at === 0) ? 0 : -1),
    );
  layer.addEventListener("focusin", (event) => {
    layer.classList.remove("quiet");
    stop(event.target as HTMLButtonElement);
  });
  layer.addEventListener("keydown", (event) => {
    const shown = stops();
    const at = shown.indexOf(document.activeElement as HTMLButtonElement);
    const moves: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowDown: at + 1,
      ArrowLeft: at - 1,
      ArrowUp: at - 1,
    };
    const to = moves[event.key];
    if (at >= 0 && to !== undefined) {
      event.preventDefault();
      shown[(to + shown.length) % shown.length]!.focus({ preventScroll: true });
    }
  });
  // Esc shrinks a pin back until the pointer comes to another, as it may hide what it wants.
  addEventListener("keydown", (event) => event.key === "Escape" && layer.classList.add("quiet"));
  const shown = new Map<
    string,
    { comment: HTMLElement; pin: HTMLElement; text: HTMLElement; at: Point }
  >();
  let camera: Camera | undefined;
  /** The comment whose pin keys pressed, while it is written in. */
  let returning: string | undefined;
  const place = ({ comment, at }: { comment: HTMLElement; at: Point }) => {
    if (camera) {
      const [x, y] = [(at.x - camera.x) * camera.zoom, (at.y - camera.y) * camera.zoom];
      comment.style.setProperty("transform", `translate(${x}px, ${y}px)`);
    }
  };
  const create = (id: string) => {
    const comment = document.createElement("div");
    comment.className = "comment";
    comment.dataset.comment = id;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin";
    pin.tabIndex = -1;
    const text = document.createElement("span");
    text.className = "text";
    text.id = `comment-${id}`;
    pin.setAttribute("aria-describedby", text.id);
    pin.append(text);
    // The board takes the press, and a pin focused before would stay grown.
    comment.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement && layer.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    });
    comment.addEventListener("pointerenter", () => layer.classList.remove("quiet"));
    pin.addEventListener("keydown", (event) => {
      if (event.key === " ") {
        event.preventDefault();
        choose(id);
      }
    });
    // Firefox clicks on Space's release unless it is cancelled too.
    pin.addEventListener("keyup", (event) => event.key === " " && event.preventDefault());
    pin.addEventListener("click", (event) => {
      if (event.detail === 0) {
        returning = id;
        write(id);
      }
    });
    comment.append(pin);
    layer.append(comment);
    return { comment, pin, text, at: { x: 0, y: 0 } };
  };
  return {
    show(board, selected, hidden) {
      const chosen = new Set(selected);
      const marked = (id: string) => {
        // Boards are repaired on read, but a cycle would loop forever.
        const seen = new Set<string>();
        for (
          let at: string | undefined = id;
          at !== undefined && !seen.has(at);
          at = board.elements[at]?.group
        ) {
          if (chosen.has(at)) {
            return true;
          }
          seen.add(at);
        }
        return false;
      };
      const comments = board.draw_order.flatMap((id) => {
        const { kind } = board.elements[id]!;
        return kind.type === "comment" ? [{ id, kind }] : [];
      });
      const present = new Set(comments.map(({ id }) => id));
      const focused = document.activeElement;
      const focusedAt = stops().findIndex((pin) => pin === focused);
      for (const [id, { comment }] of shown) {
        if (!present.has(id)) {
          comment.remove();
          shown.delete(id);
        }
      }
      comments.forEach(({ id, kind }, index) => {
        const entry = shown.get(id) ?? create(id);
        shown.set(id, entry);
        if (entry.text.textContent !== kind.text || !entry.pin.hasAttribute("aria-label")) {
          entry.text.textContent = kind.text;
          const name = kind.text.trim().split("\n")[0]!;
          entry.pin.setAttribute(
            "aria-label",
            `Comment: ${name.length > NAMED ? `${name.slice(0, NAMED)}…` : name}`,
          );
        }
        entry.comment.classList.toggle("selected", marked(id));
        entry.comment.classList.toggle("writing", id === hidden);
        entry.comment.classList.toggle("blank", kind.text.trim() === "");
        // Later ones on top, as the board stacks them. Moved only when out of place, which
        // would lose the pointer's hover, and the focus.
        if (layer.children[index] !== entry.comment) {
          layer.insertBefore(entry.comment, layer.children[index] ?? null);
        }
        entry.at = kind.at;
        place(entry);
      });
      // Refocused where it was, or on the next pin once its own went.
      if (focusedAt >= 0 && focused !== document.activeElement) {
        const remaining = stops();
        const kept = focused instanceof HTMLElement && layer.contains(focused);
        (kept ? focused : remaining[Math.min(focusedAt, remaining.length - 1)])?.focus({
          preventScroll: true,
        });
      }
      if (returning !== undefined && returning !== hidden) {
        shown.get(returning)?.pin.focus({ preventScroll: true });
        returning = undefined;
      }
      if (!stops().some((pin) => pin.tabIndex === 0)) {
        stop(undefined);
      }
    },
    frame(next) {
      camera = next;
      layer.hidden = false;
      shown.forEach(place);
    },
    clear() {
      camera = undefined;
      returning = undefined;
      layer.hidden = true;
      layer.replaceChildren();
      shown.clear();
    },
  };
}
