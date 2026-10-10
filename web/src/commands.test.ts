// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { learnLayout, listen, reloads, typed, type Command } from "./commands.js";

const stops: (() => void)[] = [];

function listening(commands: Command[], allowed = () => true): void {
  stops.push(listen(commands, allowed));
}

function press(init: KeyboardEventInit, on: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  on.dispatchEvent(event);
  return event;
}

function command(label: string, more: Partial<Command>): Command {
  return { label, run: vi.fn<() => void>(), ...more };
}

describe("listen", () => {
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
  });

  it("runs the command of the letter typed wherever its key sits, as on AZERTY", () => {
    const selectAll = command("Select all", { keys: [{ key: "a", command: true }] });
    const quit = command("Quit", { keys: [{ key: "q", command: true }] });
    listening([selectAll, quit]);
    // AZERTY types a where QWERTY types q.
    press({ key: "a", code: "KeyQ", ctrlKey: true });
    expect(selectAll.run).toHaveBeenCalledOnce();
    expect(quit.run).not.toHaveBeenCalled();
  });

  it("runs the command of the character typed before the one of where its key sits, as on German", () => {
    const zoomIn = command("Zoom in", { keys: [{ key: "+" }] });
    const forward = command("Bring forward", { keys: [{ code: "BracketRight" }] });
    listening([zoomIn, forward]);
    // German types + where US types ].
    press({ key: "+", code: "BracketRight" });
    expect(zoomIn.run).toHaveBeenCalledOnce();
    expect(forward.run).not.toHaveBeenCalled();
  });

  it("leaves a key ending an input method's composition to it", () => {
    const remove = command("Delete", { keys: [{ key: "backspace" }] });
    listening([remove]);
    const event = press({ key: "Backspace", code: "Backspace", keyCode: 229 });
    expect(remove.run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves keys typed into a text field to the field", () => {
    const remove = command("Delete", { keys: [{ key: "backspace" }] });
    listening([remove]);
    const field = document.body.appendChild(document.createElement("textarea"));
    const event = press({ key: "Backspace", code: "Backspace" }, field);
    expect(remove.run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("takes the keys of a command that cannot run, so that they never reach the browser", () => {
    const selectAll = command("Select all", {
      keys: [{ key: "a", command: true }],
      unavailable: () => "No board is open yet",
    });
    listening([selectAll]);
    const event = press({ key: "a", code: "KeyA", metaKey: true });
    expect(selectAll.run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("gives a key that commands share to the one that can run", () => {
    const leave = command("Leave the group", {
      keys: [{ key: "escape" }],
      unavailable: () => "Not in a group",
    });
    const deselect = command("Select nothing", { keys: [{ key: "escape" }] });
    listening([leave, deselect]);
    press({ key: "Escape", code: "Escape" });
    expect(leave.run).not.toHaveBeenCalled();
    expect(deselect.run).toHaveBeenCalledOnce();
  });

  it("takes the keys of a command meant everywhere from a text field, running nothing there", () => {
    const save = command("Save", { keys: [{ key: "s", command: true }], everywhere: true });
    const bold = command("Bold", { keys: [{ key: "b", command: true }] });
    listening([save, bold]);
    const field = document.body.appendChild(document.createElement("textarea"));
    expect(press({ key: "s", code: "KeyS", metaKey: true }, field).defaultPrevented).toBe(true);
    expect(press({ key: "b", code: "KeyB", metaKey: true }, field).defaultPrevented).toBe(false);
    expect(save.run).not.toHaveBeenCalled();
    press({ key: "s", code: "KeyS", metaKey: true });
    expect(save.run).toHaveBeenCalledOnce();
  });

  it("keeps Alt, let go of alone, from handing the focus to the browser's menu", () => {
    listening([]);
    const up = new KeyboardEvent("keyup", { key: "Alt", bubbles: true, cancelable: true });
    window.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
  });

  it("runs a command that turns something on and off once while its key is held", () => {
    const play = command("Play", { keys: [{ key: "p" }], once: true });
    const undo = command("Undo", { keys: [{ key: "z", command: true }] });
    listening([play, undo]);
    for (const repeat of [false, true, true]) {
      press({ key: "p", code: "KeyP", repeat });
      press({ key: "z", code: "KeyZ", metaKey: true, repeat });
    }
    expect(play.run).toHaveBeenCalledOnce();
    expect(undo.run).toHaveBeenCalledTimes(3);
  });

  it("runs a command once while its Enter is held", () => {
    const enter = command("Write", { keys: [{ key: "enter" }] });
    listening([enter]);
    press({ key: "Enter", code: "Enter" });
    press({ key: "Enter", code: "Enter", repeat: true });
    press({ key: "Enter", code: "Enter", repeat: true });
    expect(enter.run).toHaveBeenCalledOnce();
  });
});

/** The module as macOS loads it. */
async function macOS() {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  vi.resetModules();
  return import("./commands.js");
}

describe("on macOS", () => {
  const platform = navigator.platform;

  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
    vi.resetModules();
  });

  it("leaves Ctrl and a letter to a field, which moves its caret with them", async () => {
    const { listen: listenOnMac } = await macOS();
    const print = command("Print", { keys: [{ key: "p", command: true }], everywhere: true });
    stops.push(listenOnMac([print], () => true));
    const field = document.body.appendChild(document.createElement("textarea"));
    expect(press({ key: "p", code: "KeyP", metaKey: true }, field).defaultPrevented).toBe(true);
    expect(press({ key: "p", code: "KeyP", ctrlKey: true }, field).defaultPrevented).toBe(false);
  });

  it("follows the letter printed on a key under ⌥, once the layout is told, as on AZERTY", async () => {
    const { learnLayout: learn, listen: listenOnMac } = await macOS();
    const left = command("Align left", { keys: [{ key: "a", alt: true }] });
    const top = command("Align top", { keys: [{ key: "w", alt: true }] });
    stops.push(listenOnMac([left, top], () => true));
    // What macOS's French layout types with ⌥, æ on the key printed A, where QWERTY has Q.
    learn(
      new Map([
        ["KeyQ", "a"],
        ["KeyA", "q"],
        ["KeyZ", "w"],
        ["KeyW", "z"],
      ]),
    );
    press({ key: "‡", code: "KeyA", altKey: true });
    press({ key: "Â", code: "KeyW", altKey: true });
    expect(left.run).not.toHaveBeenCalled();
    expect(top.run).not.toHaveBeenCalled();
    press({ key: "æ", code: "KeyQ", altKey: true });
    press({ key: "‹", code: "KeyZ", altKey: true });
    expect(left.run).toHaveBeenCalledOnce();
    expect(top.run).toHaveBeenCalledOnce();
  });

  it("follows it where ⌥ types another Latin character, as @ on Swiss layouts", async () => {
    const { learnLayout: learn, typed: typedOnMac } = await macOS();
    const event = new KeyboardEvent("keydown", { key: "@", code: "KeyG", altKey: true });
    expect(typedOnMac(event)).toBe("g");
    learn(new Map([["KeyG", "g"]]));
    expect(typedOnMac(event)).toBe("g");
  });

  it("follows it where the layout puts a letter on punctuation, as Dvorak does", async () => {
    const { learnLayout: learn, typed: typedOnMac } = await macOS();
    learn(
      new Map([
        ["Comma", "w"],
        ["KeyW", ","],
      ]),
    );
    expect(
      typedOnMac(new KeyboardEvent("keydown", { key: "∑", code: "Comma", altKey: true })),
    ).toBe("w");
  });

  it("follows where a key sits on QWERTY under ⌥ while the layout is untold", async () => {
    const { listen: listenOnMac } = await macOS();
    const left = command("Align left", { keys: [{ key: "a", alt: true }] });
    stops.push(listenOnMac([left], () => true));
    press({ key: "å", code: "KeyA", altKey: true });
    expect(left.run).toHaveBeenCalledOnce();
  });
});

describe("typed", () => {
  afterEach(() => {
    learnLayout(undefined);
  });

  it("reads a Cyrillic layout's letter as the Latin letter of its key", () => {
    expect(typed(new KeyboardEvent("keydown", { key: "ф", code: "KeyA" }))).toBe("a");
    learnLayout(new Map([["KeyA", "ф"]]));
    expect(typed(new KeyboardEvent("keydown", { key: "ф", code: "KeyA" }))).toBe("a");
  });

  it("reads what a key types alone, as told, where a modifier makes it type something else", () => {
    learnLayout(new Map([["KeyQ", "a"]]));
    expect(typed(new KeyboardEvent("keydown", { key: "æ", code: "KeyQ", altKey: true }))).toBe("a");
  });

  it("reads what AltGr types as itself, off macOS, whatever the layout told", () => {
    learnLayout(new Map([["KeyQ", "q"]]));
    const event = new KeyboardEvent("keydown", {
      key: "@",
      code: "KeyQ",
      ctrlKey: true,
      altKey: true,
    });
    expect(typed(event)).toBe("@");
  });

  it("reads a character the layout types as itself", () => {
    expect(typed(new KeyboardEvent("keydown", { key: "+", code: "BracketRight" }))).toBe("+");
  });
});

describe("reloads", () => {
  afterEach(() => {
    learnLayout(undefined);
  });

  const DVORAK = new Map([
    ["KeyO", "r"],
    ["KeyR", "p"],
  ]);
  const RUSSIAN = new Map([["KeyR", "к"]]);
  it.each<[string, Map<string, string> | undefined, KeyboardEventInit, boolean]>([
    ["F5", undefined, { key: "F5", code: "F5" }, true],
    ["Ctrl R", undefined, { key: "r", code: "KeyR", ctrlKey: true }, true],
    ["⌘R", undefined, { key: "r", code: "KeyR", metaKey: true }, true],
    ["Ctrl Shift R", undefined, { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }, true],
    ["Ctrl R on a Russian layout", RUSSIAN, { key: "к", code: "KeyR", ctrlKey: true }, true],
    [
      "Ctrl R on a layout it cannot tell",
      undefined,
      { key: "к", code: "KeyR", ctrlKey: true },
      true,
    ],
    ["Ctrl R on Dvorak", DVORAK, { key: "r", code: "KeyO", ctrlKey: true }, true],
    [
      "Ctrl P on Dvorak, where QWERTY has R",
      DVORAK,
      { key: "p", code: "KeyR", ctrlKey: true },
      false,
    ],
    ["R alone", undefined, { key: "r", code: "KeyR" }, false],
    ["Shift R", undefined, { key: "R", code: "KeyR", shiftKey: true }, false],
    ["Alt R", undefined, { key: "r", code: "KeyR", altKey: true }, false],
  ])("tells whether %s reloads the page", (_, layout, init, reloading) => {
    learnLayout(layout);
    expect(reloads(new KeyboardEvent("keydown", init))).toBe(reloading);
  });
});
