// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { untitled, type Opened } from "./board.js";
import * as core from "./core.js";
import type { Kind } from "./core.js";
import { lockedPin, pinned, pins } from "./pins.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(32);
const G = "e".repeat(32);

const comment = (text: string): Kind => ({ type: "comment", at: { x: 0, y: 0 }, text });

function opened(
  kinds: Record<string, Kind>,
  groups: Record<string, string[]> = {},
  locked: string[] = [],
): Opened {
  const made = untitled();
  for (const [id, kind] of Object.entries(kinds)) {
    made.editor.add(id, undefined, JSON.stringify(kind));
  }
  for (const [group, members] of Object.entries(groups)) {
    made.editor.group(group, members);
  }
  made.editor.setLocked(locked, true);
  made.board = core.board(made.editor);
  return made;
}

function layer() {
  const host = document.body.appendChild(document.createElement("div"));
  return pins(host, {
    choose: vi.fn<(id: string) => void>(),
    write: vi.fn<(id: string) => void>(),
  });
}

const shown = (id: string) =>
  document.querySelector<HTMLElement>(`.comment[data-comment="${id}"]`)!;

describe("pins", () => {
  afterEach(() => document.body.replaceChildren());

  it("lie where the board shows their comments, mirrored or not", () => {
    const shownOn = layer();
    const camera = { x: -10, y: 0, zoom: 2 };
    shownOn.show(opened({ [A]: comment("Here") }), []);
    shownOn.frame(camera);
    expect(shown(A).style.transform).toBe("translate(20px, 0px)");
    shownOn.frame(camera, { width: 300, height: 200 });
    expect(shown(A).style.transform).toBe("translate(280px, 0px)");
  });

  it("shows a comment as a pin named after its first line, its text beside the pin describing it", () => {
    layer().show(opened({ [A]: comment(`${"A".repeat(50)}\nAnd more`) }), []);
    const pin = shown(A).querySelector<HTMLButtonElement>(".pin")!;
    const text = shown(A).querySelector<HTMLElement>(".text")!;
    expect(pin.getAttribute("aria-label")).toBe(`Comment: ${"A".repeat(40)}…`);
    expect(pin.getAttribute("aria-describedby")).toBe(text.id);
    expect(text.getAttribute("role")).toBe("tooltip");
    expect(text.textContent).toBe(`${"A".repeat(50)}\nAnd more`);
    expect(pin.contains(text)).toBe(false);
  });

  it("finds the comment from its pin, its text, and the bridge between them", () => {
    layer().show(opened({ [A]: comment("Here") }), []);
    expect(pinned(shown(A).querySelector(".pin"))).toBe(A);
    expect(pinned(shown(A).querySelector(".text"))).toBe(A);
    // A press on the bridge lands on the comment itself.
    expect(pinned(shown(A))).toBe(A);
    expect(pinned(document.body)).toBeUndefined();
  });

  it("takes a press on a comment's text for the board, and lets go of the pin focused before", () => {
    layer().show(opened({ [A]: comment("Here") }), []);
    const pin = shown(A).querySelector<HTMLButtonElement>(".pin")!;
    pin.focus();
    expect(document.activeElement).toBe(pin);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    shown(A).querySelector(".text")!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(pin);
  });

  it("marks a comment selected through its group, written in, or blank", () => {
    layer().show(
      opened(
        {
          [A]: comment("Grouped"),
          [D]: comment("Grouped too"),
          [B]: comment("Written"),
          [C]: comment("  "),
        },
        { [G]: [A, D] },
      ),
      [G],
      B,
    );
    expect(shown(A).classList.contains("selected")).toBe(true);
    expect(shown(B).classList.contains("selected")).toBe(false);
    expect(shown(B).classList.contains("writing")).toBe(true);
    expect(shown(C).classList.contains("blank")).toBe(true);
    expect(shown(A).classList.contains("blank")).toBe(false);
  });

  it("lets presses through a comment locked, itself or through its group, but names it apart", () => {
    layer().show(
      opened(
        {
          [A]: comment("Grouped"),
          [D]: comment("Grouped too"),
          [B]: comment("Locked"),
          [C]: comment("Free"),
        },
        { [G]: [A, D] },
        [G, B],
      ),
      [],
    );
    for (const id of [A, B]) {
      expect(shown(id).classList.contains("locked")).toBe(true);
      expect(pinned(shown(id).querySelector(".pin"))).toBeUndefined();
      expect(lockedPin(shown(id).querySelector(".pin"))).toBe(id);
    }
    expect(pinned(shown(C).querySelector(".pin"))).toBe(C);
    expect(lockedPin(shown(C).querySelector(".pin"))).toBeUndefined();
  });

  it("keeps texts hidden after Escape until the pointer comes to a comment", () => {
    layer().show(opened({ [A]: comment("Here") }), []);
    const all = document.querySelector(".pins")!;
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(all.classList.contains("quiet")).toBe(true);
    shown(A).dispatchEvent(new Event("pointerenter"));
    expect(all.classList.contains("quiet")).toBe(false);
  });
});
