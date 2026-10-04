// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { listen, typed, type Command } from "./commands.js";

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

  it("runs a command once while its Enter is held", () => {
    const enter = command("Write", { keys: [{ key: "enter" }] });
    listening([enter]);
    press({ key: "Enter", code: "Enter" });
    press({ key: "Enter", code: "Enter", repeat: true });
    press({ key: "Enter", code: "Enter", repeat: true });
    expect(enter.run).toHaveBeenCalledOnce();
  });
});

describe("typed", () => {
  it("reads a Cyrillic layout's letter as the Latin letter of its key", () => {
    expect(typed(new KeyboardEvent("keydown", { key: "ф", code: "KeyA" }))).toBe("a");
  });

  it("reads a character the layout types as itself", () => {
    expect(typed(new KeyboardEvent("keydown", { key: "+", code: "BracketRight" }))).toBe("+");
  });
});
