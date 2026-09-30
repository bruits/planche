// Menus of commands: the toolbar's, and the one a right-click opens. They follow the ARIA
// menu pattern, so that the keyboard reaches every item, and only one is open at a time, with
// at most one submenu.

import { ariaKeys, describe, named, type Command } from "./commands.js";
import { icon, type Icon } from "./icons.js";

/**
 * `checked` ticks, among entries that exclude each other, such as tools that share a button or
 * a submenu's options, the one in use. With `options`, it opens a submenu of them and does not
 * run, and theirs open none.
 */
export type Entry = Item | "separator";

export type Item = Command & { icon?: Icon; checked?: boolean; options?: Entry[] };

/** Its top-left corner at a point, or above an element, lined up with its right end or `left`. */
export type Place = { x: number; y: number } | { above: HTMLElement; left?: boolean };

/** From the window's edges, in CSS pixels. */
const MARGIN = 8;
/**
 * How long a submenu stays once the pointer moves on to another item, in milliseconds, so that
 * it may cross the items below on its way to the submenu's.
 */
const LINGER = 300;

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
  let submenu: { menu: HTMLElement; owner: HTMLButtonElement } | undefined;
  let leaving: ReturnType<typeof setTimeout> | undefined;
  /** Whether the pointer moved the focus last. */
  let pointing = false;
  const stay = () => {
    clearTimeout(leaving);
    leaving = undefined;
  };
  const closeSubmenu = () => {
    stay();
    submenu?.owner.setAttribute("aria-expanded", "false");
    submenu?.menu.remove();
    submenu = undefined;
  };
  const activate = (entry: Item, item: HTMLButtonElement) => {
    if (entry.options) {
      openSubmenu(entry, item, true);
    } else {
      close();
      entry.run();
    }
  };
  /** Beside its item, which keeps the focus unless `entering`, as when hovered. */
  const openSubmenu = (entry: Item, opener: HTMLButtonElement, entering: boolean) => {
    stay();
    if (submenu?.owner !== opener) {
      closeSubmenu();
      const { menu: inner, items } = list(entry.options ?? [], named(entry), activate);
      // Inside the menu, so that pressing in it counts as pressing in the menu.
      inner.id = "submenu";
      opener.setAttribute("aria-controls", inner.id);
      navigate(inner, items, (key) => {
        if (key === "ArrowLeft" || key === "Escape") {
          closeSubmenu();
          opener.focus();
          return true;
        }
        return false;
      });
      menu.append(inner);
      opener.setAttribute("aria-expanded", "true");
      beside(inner, opener, menu);
      submenu = { menu: inner, owner: opener };
    }
    if (entering) {
      const items = [...submenu!.menu.querySelectorAll("button")];
      (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    }
  };
  const { menu, items, shown } = list(entries, label, activate);
  shown.forEach((entry, at) => {
    const item = items[at]!;
    if (entry.options) {
      item.addEventListener("pointerenter", () => entry.unavailable?.() === undefined && openSubmenu(entry, item, false));
    }
  });
  menu.addEventListener("pointermove", () => (pointing = true));
  menu.addEventListener("keydown", () => (pointing = false), true);
  // Moving on to another item lets go of the submenu, a moment later when the pointer did.
  menu.addEventListener("focusin", (event) => {
    const target = event.target as Node;
    if (!submenu || target === submenu.owner || submenu.menu.contains(target)) {
      stay();
    } else if (pointing) {
      leaving ??= setTimeout(closeSubmenu, LINGER);
    } else {
      closeSubmenu();
    }
  });
  navigate(menu, items, (key) => {
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const entry = shown[at];
    if (key === "ArrowRight" && entry?.options && entry.unavailable?.() === undefined) {
      openSubmenu(entry, items[at]!, true);
      return true;
    }
    if (key === "Escape") {
      close();
      return true;
    }
    return false;
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
  items.at(fromEnd ? -1 : 0)?.focus();
}

/** Its items, with the entries they show, which `activate` runs. */
function list(
  entries: Entry[],
  label: string,
  activate: (entry: Item, item: HTMLButtonElement) => void,
): { menu: HTMLElement; items: HTMLButtonElement[]; shown: Item[] } {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  const shown = entries.filter((entry) => entry !== "separator");
  const items = entries.map((entry) => {
    if (entry !== "separator") {
      return menuItem(entry, (item) => activate(entry, item));
    }
    const line = document.createElement("div");
    line.setAttribute("role", "separator");
    return line;
  });
  menu.append(...items);
  return { menu, items: items.filter((item) => item instanceof HTMLButtonElement), shown };
}

/**
 * Up and down its items, round from one end to the other, and Tab closes every menu. `other`
 * takes any other key first, and says whether it did.
 */
function navigate(menu: HTMLElement, items: HTMLButtonElement[], other: (key: string) => boolean): void {
  const focus = (at: number) => items[(at + items.length) % items.length]?.focus();
  menu.addEventListener("keydown", (event) => {
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 && event.target !== menu) {
      // A submenu's own.
      return;
    }
    if (event.key === "ArrowDown") {
      focus(at + 1);
    } else if (event.key === "ArrowUp") {
      focus(at < 0 ? -1 : at - 1);
    } else if (event.key === "Home") {
      focus(0);
    } else if (event.key === "End") {
      focus(-1);
    } else if (event.key === "Tab") {
      closeMenu();
    } else if (!other(event.key)) {
      // Enter and Space click the focused item, as buttons do.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
}

function menuItem(command: Item, activate: (item: HTMLButtonElement) => void): HTMLButtonElement {
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
  const end = document.createElement("span");
  end.className = "end";
  item.append(label, end);
  // Named apart from its label, as its glyphs would otherwise be read out as part of it.
  const shortcut = command.keys?.[0];
  if (shortcut) {
    item.setAttribute("aria-keyshortcuts", ariaKeys(shortcut));
    const keys = document.createElement("kbd");
    keys.setAttribute("aria-hidden", "true");
    keys.textContent = describe(shortcut);
    end.append(keys);
  }
  if (command.options) {
    item.setAttribute("aria-haspopup", "menu");
    item.setAttribute("aria-expanded", "false");
    const opens = icon("chevron");
    opens.classList.add("opens");
    end.append(opens);
  }
  // Hidden from assistive technologies, which `aria-checked` tells already.
  if (command.checked !== undefined) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.setAttribute("aria-hidden", "true");
    tick.textContent = "✓";
    end.append(tick);
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
      activate(item);
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

/** To the right of `parent`, or its left where there is no room, its first item level with `owner`. */
function beside(menu: HTMLElement, owner: HTMLElement, parent: HTMLElement): void {
  const { width, height } = menu.getBoundingClientRect();
  const around = parent.getBoundingClientRect();
  const first = menu.querySelector("button")?.offsetTop ?? 0;
  const right = around.right + width + MARGIN <= innerWidth;
  const x = right ? around.right : around.left - width;
  const y = owner.getBoundingClientRect().top - first;
  menu.style.left = `${clamp(x, MARGIN, innerWidth - width - MARGIN)}px`;
  menu.style.top = `${clamp(y, MARGIN, innerHeight - height - MARGIN)}px`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}
