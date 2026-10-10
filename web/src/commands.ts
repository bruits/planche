// What the app can do, each named and bound to its keys in one place, so that the toolbar, the
// menus, and the keyboard offer it alike.

export const mac = /mac|iphone|ipad/i.test(navigator.platform);

/** A click that opens the context menu without the right button, which leaves the selection alone. */
export function opensMenu(event: MouseEvent): boolean {
  return mac && event.button === 0 && event.ctrlKey;
}

/**
 * A key an input method composes text with, such as an accent. WebKit sends the one that ends the
 * composition after it ended, which only its key code, 229, tells.
 */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
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
  keys?: Shortcut[] | undefined;
  /** Why it cannot run now, `undefined` when it can. */
  unavailable?(): string | undefined;
  run(): void;
  /**
   * Whether its keys never reach the browser, which would save, open, or print the page, even
   * from a text field, where they run nothing.
   */
  everywhere?: boolean;
  /**
   * Whether it runs once while its keys are held, as what it opens or turns on would otherwise go
   * off and on again by turns.
   */
  once?: boolean;
}

export function named({ label }: Command): string {
  return typeof label === "string" ? label : label();
}

function pressed(commands: Command[], event: KeyboardEvent): Command | undefined {
  const modified = event.metaKey || event.ctrlKey;
  const held = (shortcut: Shortcut) =>
    Boolean(shortcut.command || shortcut.ctrl) === modified &&
    (shortcut.ctrl !== true || event.ctrlKey) &&
    Boolean(shortcut.shift) === event.shiftKey &&
    Boolean(shortcut.alt) === event.altKey;
  // Commands may share a key, which goes to whichever can run.
  const find = (hit: (shortcut: Shortcut) => boolean) => {
    const matching = commands.filter(({ keys }) =>
      keys?.some((shortcut) => held(shortcut) && hit(shortcut)),
    );
    return matching.find((command) => command.unavailable?.() === undefined) ?? matching[0];
  };
  const key = typed(event);
  return (
    find((shortcut) => shortcut.key === key) ?? find((shortcut) => shortcut.code === event.code)
  );
}

/** What each key types without a modifier in the layout in use, by `KeyboardEvent.code`, where told. */
let layout: ReadonlyMap<string, string> | undefined;

/** As the shell tells it, which browsers and webviews do not all do. */
export function learnLayout(next: ReadonlyMap<string, string> | undefined): void {
  layout = next;
}

/**
 * The character typed, lower-case, or where the layout types none, as Cyrillic ones do, what its
 * key types alone, or else the letter of the key. With Option on macOS, which types other
 * characters, some of them Latin, as @ on Swiss layouts, what the key types alone too.
 */
export function typed(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();
  const alone = layout?.get(event.code)?.toLowerCase();
  const told = alone !== undefined && latin(alone);
  const letter = /^Key[A-Z]$/.test(event.code);
  if (mac && event.altKey && (told || letter)) {
    return told ? alone : event.code.slice(3).toLowerCase();
  }
  if (key.length > 1 ? key !== "dead" : latin(key)) {
    return key;
  }
  if (told) {
    return alone;
  }
  return letter ? event.code.slice(3).toLowerCase() : key;
}

export function reloads(event: KeyboardEvent): boolean {
  return event.key === "F5" || ((event.ctrlKey || event.metaKey) && typed(event) === "r");
}

function latin(character: string): boolean {
  return /^[\x20-\x7e]$/.test(character);
}

export function describe(shortcut: Shortcut): string {
  const name = keyName(shortcut);
  if (mac) {
    const modifiers = [
      shortcut.ctrl && "⌃",
      shortcut.alt && "⌥",
      shortcut.shift && "⇧",
      shortcut.command && "⌘",
    ];
    return `${modifiers.filter(Boolean).join("")}${name}`;
  }
  const modifiers = [
    (shortcut.command || shortcut.ctrl) && "Ctrl",
    shortcut.shift && "Shift",
    shortcut.alt && "Alt",
  ];
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
  return [
    ...modifiers.filter(Boolean),
    key.length === 1 ? key.toUpperCase() : capitalise(key),
  ].join("+");
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
export function listen(commands: Command[], listening: (command: Command) => boolean): () => void {
  const pressedKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || composing(event)) {
      return;
    }
    // A focused button takes Enter to press itself.
    if (event.key === "Enter" && event.target instanceof HTMLButtonElement) {
      return;
    }
    const field = typing(event.target);
    // A field on macOS moves its caret with Ctrl and these letters, as Cocoa has it.
    if (field && mac && !event.metaKey) {
      return;
    }
    const command = pressed(
      field ? commands.filter(({ everywhere }) => everywhere) : commands,
      event,
    );
    if (command === undefined) {
      return;
    }
    event.preventDefault();
    // What Enter does opens a mode, which a held Enter would leave and open again by turns.
    if (field || (event.repeat && (event.key === "Enter" || command.once))) {
      return;
    }
    if (listening(command) && command.unavailable?.() === undefined) {
      command.run();
    }
  };
  addEventListener("keydown", pressedKey);
  addEventListener("keyup", altUp);
  return () => {
    removeEventListener("keydown", pressedKey);
    removeEventListener("keyup", altUp);
  };
}

/** Let go of alone, Alt would hand the focus to the browser's menu, but on macOS. */
function altUp(event: KeyboardEvent): void {
  if (event.key === "Alt") {
    event.preventDefault();
  }
}

/** Whether keys pressed on `target` type text into it. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  const buttons = [
    "button",
    "checkbox",
    "radio",
    "range",
    "color",
    "file",
    "submit",
    "reset",
    "image",
  ];
  return target instanceof HTMLInputElement && !buttons.includes(target.type);
}
