// Menus of commands: the toolbar's, and the one a right-click opens. They follow the ARIA
// menu pattern, so that the keyboard reaches every item, and only one is open at a time.

import { ariaKeys, describe, named, type Command } from "./commands.js";
import { icon, type Icon } from "./icons.js";

/** `checked` marks, among tools that share a button, the one in use. */
export type Entry = (Command & { icon?: Icon; checked?: boolean }) | "separator";

/** Its top-left corner at a point, or above an element, lined up with its right end or `left`. */
export type Place = { x: number; y: number } | { above: HTMLElement; left?: boolean };

/** From the window's edges, in CSS pixels. */
const MARGIN = 8;

let open: { menu: HTMLElement; close: () => void } | undefined;

export function menuOpen(): boolean {
  return open !== undefined;
}

export function closeMenu(): void {
  open?.close();
}

export interface Opening {
  /** What assistive technologies call it. */
  label: string;
  place: Place;
  /** The button that opens it, and closes it again when pressed. */
  owner?: HTMLElement;
  /** Whether its last item takes the focus first, as when the Up arrow opens it. */
  fromEnd?: boolean;
  /** Once it closes, whichever way. */
  closed?(): void;
}

/** Focus goes back where it was once it closes. */
export function openMenu(entries: Entry[], { label, place, owner, fromEnd = false, closed }: Opening): void {
  closeMenu();
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  const items = entries.flatMap((entry) => {
    if (entry === "separator") {
      const line = document.createElement("div");
      line.setAttribute("role", "separator");
      menu.append(line);
      return [];
    }
    const item = menuItem(entry, () => {
      close();
      entry.run();
    });
    menu.append(item);
    return [item];
  });

  const focus = (at: number) => items[(at + items.length) % items.length]?.focus();
  menu.addEventListener("keydown", (event) => {
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      focus(at + 1);
    } else if (event.key === "ArrowUp") {
      focus(at < 0 ? -1 : at - 1);
    } else if (event.key === "Home") {
      focus(0);
    } else if (event.key === "End") {
      focus(-1);
    } else if (event.key === "Escape" || event.key === "Tab") {
      close();
    } else {
      // Enter and Space click the focused item, as buttons do.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  // A press inside, even between items, would move the focus to the page and leave its keys there.
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  const outside = (event: Event) => {
    const target = event.target as Node;
    if (!menu.contains(target) && !owner?.contains(target)) {
      close();
    }
  };
  // The page moving under it, or losing the window, would leave it pointing at nothing.
  const listeners: [EventTarget, string, EventListener][] = [
    [window, "pointerdown", outside],
    [window, "wheel", outside],
    // Captured, an element's blur would come here too, such as the opener's as the menu takes the focus.
    [window, "blur", (event) => event.target === window && close()],
    [window, "resize", () => close()],
  ];
  const close = () => {
    if (open?.menu !== menu) {
      return;
    }
    open = undefined;
    listeners.forEach(([target, type, listener]) => target.removeEventListener(type, listener, true));
    menu.remove();
    back?.focus();
    closed?.();
  };

  document.body.append(menu);
  position(menu, place);
  open = { menu, close };
  listeners.forEach(([target, type, listener]) => target.addEventListener(type, listener, true));
  focus(fromEnd ? -1 : 0);
}

function menuItem(command: Exclude<Entry, "separator">, activate: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.tabIndex = -1;
  item.setAttribute("role", command.checked === undefined ? "menuitem" : "menuitemradio");
  if (command.checked !== undefined) {
    item.setAttribute("aria-checked", String(command.checked));
  }
  const label = document.createElement("span");
  label.className = "name";
  if (command.icon) {
    label.append(icon(command.icon));
  }
  label.append(named(command));
  item.append(label);
  // Named apart from its label, as its glyphs would otherwise be read out as part of it.
  const shortcut = command.keys?.[0];
  if (shortcut) {
    item.setAttribute("aria-keyshortcuts", ariaKeys(shortcut));
    const keys = document.createElement("kbd");
    keys.setAttribute("aria-hidden", "true");
    keys.textContent = describe(shortcut);
    item.append(keys);
  }
  // Still focusable, as the pattern wants, so that its reason can be read.
  const reason = command.unavailable?.();
  if (reason !== undefined) {
    item.setAttribute("aria-disabled", "true");
    item.title = reason;
  }
  // Asked again, as things may have changed since it opened.
  item.addEventListener("click", () => {
    if (command.unavailable?.() === undefined) {
      activate();
    }
  });
  // Hovering moves the focus, so that the keyboard carries on from there.
  item.addEventListener("pointermove", () => item.focus());
  return item;
}

function position(menu: HTMLElement, place: Place): void {
  const { width, height } = menu.getBoundingClientRect();
  let [x, y] = "above" in place ? [0, 0] : [place.x, place.y];
  if ("above" in place) {
    const anchor = place.above.getBoundingClientRect();
    [x, y] = [place.left ? anchor.left : anchor.right - width, anchor.top - height - MARGIN];
  }
  // Opened near the right or bottom edge, it opens the other way.
  if (x + width > innerWidth - MARGIN && "x" in place) {
    x -= width;
  }
  if (y + height > innerHeight - MARGIN && "y" in place) {
    y -= height;
  }
  menu.style.left = `${clamp(x, MARGIN, innerWidth - width - MARGIN)}px`;
  menu.style.top = `${clamp(y, MARGIN, innerHeight - height - MARGIN)}px`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}
