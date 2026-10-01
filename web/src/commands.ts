// What the app can do, each named and bound to its keys in one place, so that the toolbar, the
// menus, and the keyboard offer it alike.

export const mac = /mac|iphone|ipad/i.test(navigator.platform);

/** A click that opens the context menu without the right button, which leaves the selection alone. */
export function opensMenu(event: MouseEvent): boolean {
  return mac && event.button === 0 && event.ctrlKey;
}

/**
 * Letters match the character typed, so that they follow the keyboard layout, and `code`
 * matches where a key sits, for keys that some layouts only type with a modifier, such as
 * brackets. The character typed wins, since on some layouts one shortcut's key types another's
 * character, as German types + where US types ].
 */
export interface Shortcut {
  /** As `KeyboardEvent.key` gives it, lower-case. */
  key?: string;
  /** As `KeyboardEvent.code` gives it. */
  code?: string;
  /** ⌘ on macOS and Ctrl elsewhere, though either is taken everywhere. */
  command?: boolean;
  /** Ctrl itself, even on macOS. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Command {
  /** Read each time it shows, when it follows what it toggles. */
  label: string | (() => string);
  /** The first one is the one shown. */
  keys?: Shortcut[];
  /** Why it cannot run now, `undefined` when it can. */
  unavailable?(): string | undefined;
  run(): void;
}

export function named({ label }: Command): string {
  return typeof label === "string" ? label : label();
}

function pressed(commands: Command[], event: KeyboardEvent): Command | undefined {
  const command = event.metaKey || event.ctrlKey;
  const held = (shortcut: Shortcut) =>
    Boolean(shortcut.command || shortcut.ctrl) === command &&
    (shortcut.ctrl !== true || event.ctrlKey) &&
    Boolean(shortcut.shift) === event.shiftKey &&
    Boolean(shortcut.alt) === event.altKey;
  // Commands may share a key, which goes to whichever can run.
  const find = (hit: (shortcut: Shortcut) => boolean) => {
    const matching = commands.filter(({ keys }) => keys?.some((shortcut) => held(shortcut) && hit(shortcut)));
    return matching.find((command) => command.unavailable?.() === undefined) ?? matching[0];
  };
  const key = typed(event);
  return find((shortcut) => shortcut.key === key) ?? find((shortcut) => shortcut.code === event.code);
}

/**
 * The character typed, lower-case, or the letter of the key where the layout types none, as
 * Cyrillic ones do, or Option does on macOS.
 */
export function typed(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();
  const latin = key.length > 1 ? key !== "dead" : /^[\x20-\x7e]$/.test(key);
  return !latin && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : key;
}

export function describe(shortcut: Shortcut): string {
  const name = keyName(shortcut);
  if (mac) {
    const modifiers = [shortcut.ctrl && "⌃", shortcut.alt && "⌥", shortcut.shift && "⇧", shortcut.command && "⌘"];
    return `${modifiers.filter(Boolean).join("")}${name}`;
  }
  const modifiers = [(shortcut.command || shortcut.ctrl) && "Ctrl", shortcut.shift && "Shift", shortcut.alt && "Alt"];
  return [...modifiers.filter(Boolean), name].join("+");
}

/** For `aria-keyshortcuts`, which names keys as `KeyboardEvent.key` does. */
export function ariaKeys(shortcut: Shortcut): string {
  const modifiers = [
    shortcut.ctrl && "Control",
    shortcut.command && (mac ? "Meta" : "Control"),
    shortcut.alt && "Alt",
    shortcut.shift && "Shift",
  ];
  const key = shortcut.key ?? keyName(shortcut);
  return [...modifiers.filter(Boolean), key.length === 1 ? key.toUpperCase() : capitalise(key)].join("+");
}

function keyName({ key, code }: Shortcut): string {
  const names: Record<string, string> = mac
    ? { backspace: "⌫", delete: "⌦", enter: "↩", escape: "Esc", contextmenu: "Menu" }
    : { backspace: "Backspace", delete: "Del", escape: "Esc", contextmenu: "Menu" };
  if (key !== undefined) {
    return names[key] ?? (key.length === 1 ? key.toUpperCase() : capitalise(key));
  }
  const digit = /^Digit(\d)$/.exec(code ?? "");
  const glyphs: Record<string, string> = {
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Equal: "=",
    Minus: "-",
  };
  return digit?.[1] ?? glyphs[code ?? ""] ?? code ?? "";
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A command that cannot run, or that `listening` holds back, still takes its keys, so that they
 * never fall through to the host, such as ⌘A selecting the page's text or ⌘+ zooming it.
 */
export function listen(commands: Command[], listening: () => boolean): void {
  addEventListener("keydown", (event) => {
    // 229 is what a key composing text, such as an accent, reports in some browsers.
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || typing(event.target)) {
      return;
    }
    // A focused button takes Enter to press itself.
    if (event.key === "Enter" && event.target instanceof HTMLButtonElement) {
      return;
    }
    const command = pressed(commands, event);
    if (command === undefined) {
      return;
    }
    event.preventDefault();
    if (listening() && command.unavailable?.() === undefined) {
      command.run();
    }
  });
}

/** Whether keys pressed on `target` type text into it. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  const buttons = ["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"];
  return target instanceof HTMLInputElement && !buttons.includes(target.type);
}
