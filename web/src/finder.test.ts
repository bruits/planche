// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { listen, type Command } from "./commands.js";
import { closeFinder, finderOpen, openFinder, ranked, type Listed } from "./finder.js";

function command(label: string, more: Partial<Listed> = {}): Listed {
  return { label, run: vi.fn<() => void>(), ...more };
}

const names = (listed: Listed[]) => listed.map(({ label }) => label);

describe("ranked", () => {
  const listed = [
    command("Flip horizontally"),
    command("Left", { within: "Align" }),
    command("Lines", { within: "Grid" }),
    command("Select all"),
    command("Elliptical crop"),
  ];

  it("keeps those holding every word, those starting with them first", () => {
    expect(names(ranked(listed, "li"))).toEqual([
      "Lines",
      "Flip horizontally",
      "Left",
      "Elliptical crop",
    ]);
    expect(names(ranked(listed, "al le"))).toEqual(["Left", "Select all"]);
  });

  it("finds a command by the menu it sits in", () => {
    expect(names(ranked(listed, "grid"))).toEqual(["Lines"]);
  });

  it("lists those that can run first, otherwise as listed", () => {
    const blocked = command("Bold", { unavailable: () => "Nothing is selected" });
    expect(names(ranked([blocked, command("Bring forward")], ""))).toEqual([
      "Bring forward",
      "Bold",
    ]);
  });
});

const field = () => document.querySelector<HTMLInputElement>(".finder input")!;
const options = () => [...document.querySelectorAll(".finder [role='option']")];
const picked = () => document.getElementById(field().getAttribute("aria-activedescendant")!);

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  field().dispatchEvent(event);
  return event;
}

function type(text: string): void {
  field().value = text;
  field().dispatchEvent(new Event("input"));
}

/** Opened from a button, which takes the focus back once it closes. */
function opened(listed: Listed[]): HTMLButtonElement {
  const button = document.body.appendChild(document.createElement("button"));
  button.focus();
  openFinder(() => listed);
  return button;
}

/** ⌘K held on whatever has the focus, and whether the finder is open after each repeat. */
function held(repeats: boolean[]): boolean[] {
  return repeats.map((repeat) => {
    const event = { key: "k", code: "KeyK", metaKey: true, repeat, bubbles: true };
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", event));
    return finderOpen();
  });
}

describe("the finder", () => {
  afterEach(() => {
    closeFinder();
    document.body.replaceChildren();
  });

  it("lists every command, the menu it sits in, its keys, and whether it is on", () => {
    opened([
      command("Snap to grid", { within: "Grid", checked: true, toggle: true }),
      command("Larger text", { keys: [{ key: ">", command: true, shift: true }] }),
    ]);
    expect(document.activeElement).toBe(field());
    expect(options().map((option) => option.textContent)).toEqual([
      "Grid:Snap to grid",
      "Larger textCtrl+Shift+>",
    ]);
    expect(options()[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("narrows the list as it is typed into, picking the first", () => {
    opened([command("Undo"), command("Redo"), command("Rotate left")]);
    type("r");
    expect(options().map((option) => option.textContent)).toEqual(["Redo", "Rotate left"]);
    expect(picked()?.textContent).toBe("Redo");
  });

  it("moves the pick with the arrow keys, round from one end to the other", () => {
    opened([command("Undo"), command("Redo")]);
    press({ key: "ArrowUp" });
    expect(picked()?.textContent).toBe("Redo");
    press({ key: "ArrowDown" });
    expect(picked()?.textContent).toBe("Undo");
  });

  it("runs the command picked on Enter, once closed and the focus back", () => {
    const redo = command("Redo");
    let focused: Element | null = null;
    vi.mocked(redo.run).mockImplementation(() => (focused = document.activeElement));
    const button = opened([command("Undo"), redo]);
    press({ key: "ArrowDown" });
    expect(press({ key: "Enter" }).defaultPrevented).toBe(true);
    expect(redo.run).toHaveBeenCalledOnce();
    expect(focused).toBe(button);
    expect(finderOpen()).toBe(false);
  });

  it("says why the command picked cannot run, and stays open on Enter", () => {
    const bold: Command = command("Bold", { unavailable: () => "Nothing is selected" });
    opened([bold]);
    expect(options()[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector(".finder .why")?.textContent).toBe("Nothing is selected");
    press({ key: "Enter" });
    expect(bold.run).not.toHaveBeenCalled();
    expect(finderOpen()).toBe(true);
  });

  it("says when no command has the name typed", () => {
    opened([command("Undo")]);
    type("zz");
    expect(options()).toEqual([]);
    expect(document.querySelector(".finder .why")?.textContent).toBe("No command by that name");
  });

  it("runs the command clicked", () => {
    const redo = command("Redo");
    opened([command("Undo"), redo]);
    (options()[1] as HTMLElement).click();
    expect(redo.run).toHaveBeenCalledOnce();
  });

  it("closes on Escape, or its own keys, giving the focus back", () => {
    const button = opened([command("Undo")]);
    press({ key: "Escape" });
    expect(finderOpen()).toBe(false);
    expect(document.activeElement).toBe(button);
    opened([command("Undo")]);
    press({ key: "k", metaKey: true });
    expect(finderOpen()).toBe(false);
  });

  it("leaves Enter to an input method composing", () => {
    const undo = command("Undo");
    opened([undo]);
    press({ key: "Enter", isComposing: true });
    expect(undo.run).not.toHaveBeenCalled();
  });

  it("stays as its own key left it while the key is held, as it repeats", () => {
    const find: Command = {
      label: "Find a command…",
      keys: [{ key: "k", command: true }],
      run: () => opened([]),
      once: true,
    };
    const stop = listen([find], () => true);
    expect(held([false, true, true])).toEqual([true, true, true]);
    expect(held([false, true, true])).toEqual([false, false, false]);
    stop();
  });

  it("closes on a press outside it", () => {
    opened([command("Undo")]);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(finderOpen()).toBe(false);
  });
});
