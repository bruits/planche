// Finds any command by typing part of its name, with its keys and why it cannot run, as the menus
// offer only what applies where they open, and some commands sit in none. It follows the combobox
// pattern, its field keeping the focus while the arrow keys pick an option.

import { composing, named, typed } from "./commands.js";
import { closeMenu, present, type Item } from "./menu.js";

/** With the name of the menu it sits in, where its own would not tell alone. */
export type Listed = Item & { within?: string | undefined };

let open: { close: () => void } | undefined;

export function finderOpen(): boolean {
  return open !== undefined;
}

export function closeFinder(): void {
  open?.close();
}

/**
 * Those holding every word of `query`, those starting with it first, then those with a word
 * starting with each, and at each rank those that can run first, otherwise as listed.
 */
export function ranked(listed: Listed[], query: string): Listed[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const whole = words.join(" ");
  return listed
    .flatMap((entry) => {
      const name = named(entry).toLowerCase();
      const full = entry.within ? `${entry.within.toLowerCase()} ${name}` : name;
      if (!words.every((word) => full.includes(word))) {
        return [];
      }
      const starts = full.split(/\s+/);
      const rank =
        name.startsWith(whole) || full.startsWith(whole)
          ? 0
          : words.every((word) => starts.some((start) => start.startsWith(word)))
            ? 1
            : 2;
      return [{ entry, rank: rank * 2 + (entry.unavailable?.() === undefined ? 0 : 1) }];
    })
    .toSorted((one, other) => one.rank - other.rank)
    .map(({ entry }) => entry);
}

/** Focus goes back where it was once it closes, before what it runs. */
export function openFinder(list: () => Listed[]): void {
  closeMenu();
  closeFinder();
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const listed = list();
  const dialog = document.createElement("div");
  dialog.className = "finder";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Commands");
  const field = document.createElement("input");
  field.type = "text";
  field.placeholder = "Find a command";
  field.autocomplete = "off";
  field.spellcheck = false;
  field.setAttribute("role", "combobox");
  field.setAttribute("aria-label", "Find a command");
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-expanded", "true");
  field.setAttribute("aria-controls", "finder-options");
  const options = document.createElement("div");
  options.id = "finder-options";
  options.setAttribute("role", "listbox");
  options.setAttribute("aria-label", "Commands");
  // Why the option picked cannot run, which its row has no room to say, or that none is found.
  const why = document.createElement("p");
  why.className = "why";
  why.setAttribute("aria-live", "polite");
  dialog.append(field, options, why);

  let shown: Listed[] = [];
  let active = 0;
  const pick = (at: number) => {
    const rows = [...options.children];
    rows[active]?.setAttribute("aria-selected", "false");
    active = (at + shown.length) % Math.max(shown.length, 1);
    const row = rows[active];
    row?.setAttribute("aria-selected", "true");
    row?.scrollIntoView({ block: "nearest" });
    if (row) {
      field.setAttribute("aria-activedescendant", row.id);
    } else {
      field.removeAttribute("aria-activedescendant");
    }
    why.textContent =
      shown.length === 0 ? "No command by that name" : (shown[active]?.unavailable?.() ?? "");
  };
  const show = () => {
    shown = ranked(listed, field.value);
    options.replaceChildren(...shown.map(option));
    active = 0;
    pick(0);
  };
  function option(entry: Listed, at: number): HTMLElement {
    const row = document.createElement("div");
    row.id = `finder-option-${at}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    const [name] = present(row, entry);
    if (entry.within) {
      const within = document.createElement("span");
      within.className = "within";
      within.textContent = `${entry.within}:`;
      name.prepend(within);
    }
    if (entry.unavailable?.() !== undefined) {
      row.setAttribute("aria-disabled", "true");
    }
    row.addEventListener("pointermove", () => at !== active && pick(at));
    row.addEventListener("click", () => run(entry));
    return row;
  }
  // Asked again, as things may have changed since it showed.
  const run = (entry: Listed) => {
    if (entry.unavailable?.() === undefined) {
      close();
      entry.run();
    }
  };

  field.addEventListener("input", show);
  field.addEventListener("keydown", (event) => {
    if (composing(event)) {
      return;
    }
    const entry = shown[active];
    if (event.key === "ArrowDown") {
      pick(active + 1);
    } else if (event.key === "ArrowUp") {
      pick(active - 1);
    } else if (event.key === "Enter") {
      if (entry) {
        run(entry);
      }
    } else if (
      event.key === "Escape" ||
      event.key === "Tab" ||
      ((event.metaKey || event.ctrlKey) && ["k", "/"].includes(typed(event)))
    ) {
      // Once, as its own keys held would open it again at once, and close it by turns.
      if (!event.repeat) {
        close();
      }
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  // A press on an option would move the focus out of the field, and its keys with it.
  dialog.addEventListener("mousedown", (event) => event.target !== field && event.preventDefault());
  const outside = (event: Event) => {
    if (!dialog.contains(event.target as Node)) {
      close();
    }
  };
  const left = (event: Event) => event.target === window && close();
  const close = () => {
    if (open?.close !== close) {
      return;
    }
    open = undefined;
    removeEventListener("pointerdown", outside, true);
    removeEventListener("blur", left, true);
    dialog.remove();
    back?.focus();
  };

  document.body.append(dialog);
  open = { close };
  addEventListener("pointerdown", outside, true);
  addEventListener("blur", left, true);
  show();
  field.focus();
}
