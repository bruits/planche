// The bar at the bottom of the window: the tools, the commands that act at once, and a menu
// of the rest. Above it sit a line of hints, and the app's messages.

import { ariaKeys, describe, type Command } from "./commands.js";
import { icon, type Icon } from "./icons.js";
import { closeMenu, openMenu, type Entry } from "./menu.js";

export interface Button {
  command: Command;
  icon: Icon;
  /** For a tool, whether it is the one in use. */
  pressed?(): boolean;
}

export interface Toolbar {
  /** Shows which tool is in use, and `hint` unless a button's own is showing. */
  refresh(hint: string): void;
  /** Stays until the next message when `busy`, and fades after a while otherwise. */
  say(message: string, busy?: boolean): void;
  /** Marks the menu's button while the board has changes to lose. */
  unsaved(unsaved: boolean): void;
}

/** How long a message shows, in milliseconds, plus a little per character to read. */
const MESSAGE_TIME = 4000;
const READING_TIME = 40;

/** `groups` of buttons, apart from each other, then the button of the menu that `entries` fills. */
export function toolbar(host: HTMLElement, groups: Button[][], entries: () => Entry[]): Toolbar {
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
  host.append(message, hint, bar);

  let base = "";
  // Apart, since a click takes the focus away from the button still under the pointer.
  let hovered: string | undefined;
  let focused: string | undefined;
  // Refreshed at every pointer move of a drag, when it seldom changes.
  const showHint = () => {
    const text = hovered ?? focused ?? base;
    if (hint.textContent !== text) {
      hint.textContent = text;
    }
  };

  const buttons = groups.flatMap((group, at) => {
    if (at > 0) {
      bar.append(separator());
    }
    return group.map((item) => {
      const button = barButton(item);
      const { label, keys } = item.command;
      const shown = keys?.[0] ? `${label} · ${describe(keys[0])}` : label;
      button.addEventListener("click", (event) => {
        if (item.command.unavailable?.() === undefined) {
          item.command.run();
        }
        // A click leaves the focus to the page, where keys and Space act on the board.
        if (event.detail > 0) {
          button.blur();
        }
      });
      explain(button, shown);
      bar.append(button);
      return { button, item };
    });
  });

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "menu-button";
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.setAttribute("aria-label", "Menu");
  menuButton.append(icon("menu"));
  /** Opened with the pointer, it leaves the focus to the page once closed, as the other buttons do. */
  const toggle = (byPointer: boolean, fromEnd = false) => {
    if (menuButton.getAttribute("aria-expanded") === "true") {
      closeMenu();
      return;
    }
    menuButton.setAttribute("aria-expanded", "true");
    const closed = () => {
      menuButton.setAttribute("aria-expanded", "false");
      if (byPointer && document.activeElement === menuButton) {
        menuButton.blur();
      }
    };
    openMenu(entries(), { label: "Menu", place: { above: menuButton }, owner: menuButton, fromEnd, closed });
  };
  menuButton.addEventListener("click", (event) => toggle(event.detail > 0));
  // It opens upwards, so the arrow that points there opens it too, on its nearest item.
  menuButton.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" && menuButton.getAttribute("aria-expanded") !== "true") {
      event.preventDefault();
      toggle(false, true);
    }
  });
  explain(menuButton, "Menu");
  bar.append(separator(), menuButton);

  // One stop for Tab, and the arrow keys between buttons, as the toolbar pattern wants.
  const stops = [...buttons.map(({ button }) => button), menuButton];
  const stop = (next: HTMLButtonElement) => stops.forEach((button) => (button.tabIndex = button === next ? 0 : -1));
  stop(stops[0]!);
  bar.addEventListener("focusin", (event) => stop(event.target as HTMLButtonElement));
  bar.addEventListener("keydown", (event) => {
    const at = stops.indexOf(document.activeElement as HTMLButtonElement);
    const moves: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: -1 };
    const to = moves[event.key];
    if (at < 0 || to === undefined) {
      return;
    }
    event.preventDefault();
    stops[(to + stops.length) % stops.length]!.focus();
  });

  function explain(button: HTMLButtonElement, shown: string): void {
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
      for (const { button, item } of buttons) {
        const reason = item.command.unavailable?.();
        const states = {
          "aria-pressed": item.pressed && String(item.pressed()),
          "aria-disabled": reason !== undefined && "true",
          title: reason,
        };
        for (const [name, value] of Object.entries(states)) {
          if (!value) {
            button.removeAttribute(name);
          } else if (button.getAttribute(name) !== value) {
            button.setAttribute(name, value);
          }
        }
      }
      base = next;
      showHint();
    },
    say(text, busy = false) {
      clearTimeout(fading);
      message.textContent = text;
      if (!busy) {
        fading = setTimeout(() => (message.textContent = ""), MESSAGE_TIME + READING_TIME * text.length);
      }
    },
    unsaved(unsaved) {
      menuButton.classList.toggle("unsaved", unsaved);
      menuButton.setAttribute("aria-label", unsaved ? "Menu, with unsaved changes" : "Menu");
    },
  };
}

function barButton({ command, icon: name, pressed }: Button): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", command.label);
  if (pressed) {
    button.setAttribute("aria-pressed", "false");
  }
  button.append(icon(name));
  const shortcut = command.keys?.[0];
  if (shortcut) {
    button.setAttribute("aria-keyshortcuts", ariaKeys(shortcut));
    const key = document.createElement("span");
    key.className = "key";
    key.setAttribute("aria-hidden", "true");
    key.textContent = describe(shortcut);
    button.append(key);
  }
  return button;
}

function separator(): HTMLElement {
  const line = document.createElement("div");
  line.className = "separator";
  line.setAttribute("role", "separator");
  line.setAttribute("aria-orientation", "vertical");
  return line;
}
