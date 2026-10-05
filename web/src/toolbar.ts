// The bar at the bottom of the window: the tools, some of which share a button, the commands
// that act at once, the zoom, and a menu of the rest. Above it sit a line of hints, and the
// app's messages.

import { ariaKeys, describe, named, type Command } from "./commands.js";
import { icon, type Icon } from "./icons.js";
import { closeMenu, openMenu, type Entry, type Place } from "./menu.js";
import { scrolled } from "./view.js";

export interface Button {
  command: Command;
  icon: Icon;
  /** For a tool, whether it is the one in use. */
  pressed?(): boolean;
}

/** Tools that share a button, which stands for the last one used, and a menu of them all. */
export interface Family {
  label: string;
  tools: Button[];
}

/** A button that shows the zoom, and opens a menu of `entries`. */
export interface Zoom {
  /** As the button shows it, `undefined` when nothing is shown. */
  zoom(): string | undefined;
  unavailable(): string | undefined;
  entries(): Entry[];
}

export interface Toolbar {
  /** Shows which tool is in use, and `hint` unless a button's own is showing. */
  refresh(hint: string): void;
  /** Stays until the next message when `busy`, and fades after a while otherwise. */
  say(message: string, busy?: boolean): void;
  /** Marks the menu's button while the board has changes to lose. */
  unsaved(unsaved: boolean): void;
  /** Shows the zoom as it is, cheaply enough for every frame. */
  zoomed(): void;
  /** Shows `shown` as the hint while `element`, outside the bar, is hovered or focused. */
  explain(element: HTMLElement, shown: () => string): void;
  /** Its top edge, with the hint and the message, in CSS pixels from the window's. */
  top(): number;
}

/** How long a message shows, in milliseconds, plus a little per character to read. */
const MESSAGE_TIME = 4000;
const READING_TIME = 40;

/**
 * `groups` of buttons, apart from each other, the last one ending with the button of the menu
 * that `entries` fills.
 */
export function toolbar(
  host: HTMLElement,
  groups: (Button | Family | Zoom)[][],
  entries: () => Entry[],
): Toolbar {
  // Always there, even empty, as screen readers only follow a live region that already shows.
  const message = document.createElement("p");
  message.id = "message";
  message.setAttribute("role", "status");
  const hint = document.createElement("p");
  hint.className = "hint";
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Tools");
  // Inside the bar, whose edges stay put as its buttons scroll.
  const row = document.createElement("div");
  row.className = "row";
  bar.append(row);
  scrolls(bar, row);
  host.append(message, hint, bar);

  let base = "";
  // Apart, since a click takes the focus away from the button still under the pointer.
  let hovered: (() => string) | undefined;
  let focused: (() => string) | undefined;
  // Refreshed at every pointer move of a drag, when it seldom changes.
  const showHint = () => {
    const text = hovered?.() ?? focused?.() ?? base;
    if (hint.textContent !== text) {
      hint.textContent = text;
    }
  };

  /** Each button for a tool or a command, with the one it stands for, and the one it shows. */
  const buttons: { button: HTMLButtonElement; current: () => Button; shown: Button }[] = [];
  const chevrons: { chevron: HTMLButtonElement; tools: Button[] }[] = [];
  const zooms: { button: HTMLButtonElement; value: HTMLElement; item: Zoom }[] = [];
  const stops: HTMLButtonElement[] = [];
  const add = (current: () => Button) => {
    const shown = current();
    const button = document.createElement("button");
    button.type = "button";
    dress(button, shown);
    button.addEventListener("click", (event) => {
      const { command } = current();
      if (command.unavailable?.() === undefined) {
        command.run();
      }
      // A click leaves the focus to the page, where keys and Space act on the board.
      if (event.detail > 0) {
        button.blur();
      }
    });
    explain(button, () => explanation(current().command));
    row.append(button);
    buttons.push({ button, current, shown });
    stops.push(button);
    return button;
  };
  groups.forEach((group, at) => {
    if (at > 0) {
      row.append(separator());
    }
    for (const item of group) {
      if ("zoom" in item) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "zoom";
        const value = document.createElement("span");
        button.append(value, icon("chevron"));
        opens(button, "Zoom", item.entries, { above: button, left: true });
        explain(button, () => "Zoom");
        row.append(button);
        stops.push(button);
        zooms.push({ button, value, item });
        continue;
      }
      if (!("tools" in item)) {
        add(() => item);
        continue;
      }
      let last = item.tools[0]!;
      const button = add(() => (last = item.tools.find((tool) => tool.pressed?.()) ?? last));
      const chevron = document.createElement("button");
      chevron.type = "button";
      chevron.className = "chevron";
      chevron.setAttribute("aria-label", item.label);
      chevron.append(icon("chevron"));
      const tools = () =>
        item.tools.map(({ command, icon: name, pressed }) => ({
          ...command,
          icon: name,
          checked: pressed?.() ?? false,
        }));
      opens(chevron, item.label, tools, { above: button, left: true });
      explain(chevron, () => item.label);
      row.append(chevron);
      stops.push(chevron);
      chevrons.push({ chevron, tools: item.tools });
    }
  });

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "menu-button";
  menuButton.setAttribute("aria-label", "Menu");
  menuButton.append(icon("menu"));
  opens(menuButton, "Menu", entries, { above: menuButton });
  explain(menuButton, () => "Menu");
  row.append(menuButton);
  stops.push(menuButton);

  // One stop for Tab, and the arrow keys between buttons, as the toolbar pattern wants.
  const stop = (next: HTMLButtonElement) =>
    stops.forEach((button) => (button.tabIndex = button === next ? 0 : -1));
  stop(stops[0]!);
  bar.addEventListener("focusin", (event) => stop(event.target as HTMLButtonElement));
  bar.addEventListener("keydown", (event) => {
    const at = stops.indexOf(document.activeElement as HTMLButtonElement);
    const moves: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: -1,
    };
    const to = moves[event.key];
    // Up and Down are its own too, though they open no menu here, so that they never move the
    // selection.
    if (at >= 0 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      return;
    }
    if (at < 0 || to === undefined) {
      return;
    }
    event.preventDefault();
    stops[(to + stops.length) % stops.length]!.focus();
  });

  const zoomed = () => {
    for (const { button, value, item } of zooms) {
      const zoom = item.zoom();
      const text = zoom ?? "–";
      if (value.textContent !== text) {
        value.textContent = text;
        button.setAttribute("aria-label", zoom === undefined ? "Zoom" : `Zoom ${zoom}`);
      }
    }
  };
  zoomed();

  function explain(button: HTMLElement, shown: () => string): void {
    const listen = (type: string, change: () => void) =>
      button.addEventListener(type, () => {
        change();
        showHint();
      });
    listen("pointerenter", () => (hovered = shown));
    listen("pointerleave", () => (hovered = undefined));
    listen("focus", () => (focused = shown));
    listen("blur", () => (focused = undefined));
  }

  let fading: ReturnType<typeof setTimeout> | undefined;
  return {
    refresh(next) {
      for (const entry of buttons) {
        const { button, current } = entry;
        const now = current();
        if (now !== entry.shown) {
          entry.shown = now;
          dress(button, now);
        }
        const reason = now.command.unavailable?.();
        mark(button, {
          "aria-pressed": now.pressed && String(now.pressed()),
          "aria-disabled": reason !== undefined && "true",
          title: reason,
        });
      }
      for (const { chevron, tools } of chevrons) {
        const reasons = tools.map(({ command }) => command.unavailable?.());
        const reason = reasons.every((one) => one !== undefined) ? reasons[0] : undefined;
        mark(chevron, { "aria-disabled": reason !== undefined && "true", title: reason });
      }
      for (const { button, item } of zooms) {
        const reason = item.unavailable();
        mark(button, { "aria-disabled": reason !== undefined && "true", title: reason });
      }
      zoomed();
      base = next;
      showHint();
    },
    say(text, busy = false) {
      clearTimeout(fading);
      message.textContent = text;
      if (!busy) {
        fading = setTimeout(
          () => (message.textContent = ""),
          MESSAGE_TIME + READING_TIME * text.length,
        );
      }
    },
    unsaved(unsaved) {
      menuButton.classList.toggle("unsaved", unsaved);
      menuButton.setAttribute("aria-label", unsaved ? "Menu, with unsaved changes" : "Menu");
    },
    zoomed,
    explain,
    top: () => host.getBoundingClientRect().top,
  };
}

/** Opened with the pointer, it leaves the focus to the page once closed, as the other buttons do. */
function opens(
  button: HTMLButtonElement,
  label: string,
  entries: () => Entry[],
  place: Place,
): void {
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const toggle = (byPointer: boolean, fromEnd = false) => {
    if (button.getAttribute("aria-expanded") === "true") {
      closeMenu();
      return;
    }
    if (button.getAttribute("aria-disabled") === "true") {
      return;
    }
    button.setAttribute("aria-expanded", "true");
    const closed = () => {
      button.setAttribute("aria-expanded", "false");
      if (byPointer && document.activeElement === button) {
        button.blur();
      }
    };
    openMenu(entries(), { label, place, owner: button, fromEnd, closed });
  };
  button.addEventListener("click", (event) => toggle(event.detail > 0));
  // It opens upwards, so the arrow that points there opens it too, on its nearest item.
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" && button.getAttribute("aria-expanded") !== "true") {
      event.preventDefault();
      toggle(false, true);
    }
  });
}

/**
 * Sideways, where the window is too narrow for every button. A mouse wheel, which only turns
 * vertically, scrolls it too.
 */
function scrolls(bar: HTMLElement, row: HTMLElement): void {
  for (const [side, towards] of [
    ["before", -1],
    ["after", 1],
  ] as const) {
    const edge = document.createElement("span");
    edge.className = `edge ${side}`;
    edge.append(icon("chevron"));
    // A press leaves the focus, and any selection, where they were.
    edge.addEventListener("mousedown", (event) => event.preventDefault());
    edge.addEventListener("click", () => row.scrollBy({ left: (towards * row.clientWidth) / 2 }));
    bar.append(edge);
  }
  const reach = () => {
    const { scrollLeft, scrollWidth, clientWidth } = row;
    // Scrolling may stop a fraction of a pixel short of an end.
    bar.classList.toggle("before", scrollLeft > 1);
    bar.classList.toggle("after", scrollLeft + clientWidth < scrollWidth - 1);
  };
  row.addEventListener("scroll", reach, { passive: true });
  new ResizeObserver(reach).observe(row);
  // The edges, outside the row, would otherwise stop it.
  bar.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey || row.scrollWidth <= row.clientWidth) {
        return;
      }
      event.preventDefault();
      // It would point at a button moving away.
      closeMenu();
      const [dx, dy] = scrolled(event, row.clientWidth);
      // At once, as the wheel's own steps already follow each other.
      row.scrollBy({ left: Math.abs(dy) > Math.abs(dx) ? dy : dx, behavior: "instant" });
    },
    { passive: false },
  );
}

function mark(button: HTMLButtonElement, states: Record<string, string | false | undefined>): void {
  for (const [name, value] of Object.entries(states)) {
    if (!value) {
      button.removeAttribute(name);
    } else if (button.getAttribute(name) !== value) {
      button.setAttribute(name, value);
    }
  }
}

export function explanation(command: Command): string {
  const shortcut = command.keys?.[0];
  return shortcut ? `${named(command)} · ${describe(shortcut)}` : named(command);
}

export function dress(button: HTMLButtonElement, { command, icon: name }: Button): void {
  button.setAttribute("aria-label", named(command));
  button.replaceChildren(icon(name));
  const shortcut = command.keys?.[0];
  button.toggleAttribute("aria-keyshortcuts", shortcut !== undefined);
  if (shortcut) {
    button.setAttribute("aria-keyshortcuts", ariaKeys(shortcut));
  }
  // A lone key only, as a chord would not fit, which the hint names instead.
  if (shortcut && !shortcut.command && !shortcut.ctrl && !shortcut.shift && !shortcut.alt) {
    const key = document.createElement("span");
    key.className = "key";
    key.setAttribute("aria-hidden", "true");
    key.textContent = describe(shortcut);
    button.append(key);
  }
}

function separator(): HTMLElement {
  const line = document.createElement("div");
  line.className = "separator";
  line.setAttribute("role", "separator");
  line.setAttribute("aria-orientation", "vertical");
  return line;
}
