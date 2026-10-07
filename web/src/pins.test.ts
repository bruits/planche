// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import type { Board, Element, Kind } from "./core.js";
import { lockedPin, pinned, pins } from "./pins.js";

const comment = (text: string, group?: string): Element => ({
  z: "a0",
  kind: { type: "comment", at: { x: 0, y: 0 }, text } satisfies Kind,
  ...(group === undefined ? {} : { group }),
});

const board = (elements: Record<string, Element>): Board => ({
  elements,
  draw_order: Object.keys(elements),
  background: "plain",
});

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
    shownOn.show(board({ a: comment("Here") }), []);
    shownOn.frame(camera);
    expect(shown("a").style.transform).toBe("translate(20px, 0px)");
    shownOn.frame(camera, { width: 300, height: 200 });
    expect(shown("a").style.transform).toBe("translate(280px, 0px)");
  });

  it("shows a comment as a pin named after its first line, its text beside the pin describing it", () => {
    layer().show(board({ a: comment(`${"A".repeat(50)}\nAnd more`) }), []);
    const pin = shown("a").querySelector<HTMLButtonElement>(".pin")!;
    const text = shown("a").querySelector<HTMLElement>(".text")!;
    expect(pin.getAttribute("aria-label")).toBe(`Comment: ${"A".repeat(40)}…`);
    expect(pin.getAttribute("aria-describedby")).toBe(text.id);
    expect(text.getAttribute("role")).toBe("tooltip");
    expect(text.textContent).toBe(`${"A".repeat(50)}\nAnd more`);
    expect(pin.contains(text)).toBe(false);
  });

  it("finds the comment from its pin, its text, and the bridge between them", () => {
    layer().show(board({ a: comment("Here") }), []);
    expect(pinned(shown("a").querySelector(".pin"))).toBe("a");
    expect(pinned(shown("a").querySelector(".text"))).toBe("a");
    // A press on the bridge lands on the comment itself.
    expect(pinned(shown("a"))).toBe("a");
    expect(pinned(document.body)).toBeUndefined();
  });

  it("takes a press on a comment's text for the board, and lets go of the pin focused before", () => {
    layer().show(board({ a: comment("Here") }), []);
    const pin = shown("a").querySelector<HTMLButtonElement>(".pin")!;
    pin.focus();
    expect(document.activeElement).toBe(pin);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    shown("a").querySelector(".text")!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(pin);
  });

  it("marks a comment selected through its group, written in, or blank", () => {
    layer().show(
      board({
        g: { z: "a0", kind: { type: "group" } },
        a: comment("Grouped", "g"),
        b: comment("Written"),
        c: comment("  "),
      }),
      ["g"],
      "b",
    );
    expect(shown("a").classList.contains("selected")).toBe(true);
    expect(shown("b").classList.contains("selected")).toBe(false);
    expect(shown("b").classList.contains("writing")).toBe(true);
    expect(shown("c").classList.contains("blank")).toBe(true);
    expect(shown("a").classList.contains("blank")).toBe(false);
  });

  it("lets presses through a comment locked, itself or through its group, but names it apart", () => {
    layer().show(
      board({
        g: { z: "a0", locked: true, kind: { type: "group" } },
        a: comment("Grouped", "g"),
        b: { ...comment("Locked"), locked: true },
        c: comment("Free"),
      }),
      [],
    );
    for (const id of ["a", "b"]) {
      expect(shown(id).classList.contains("locked")).toBe(true);
      expect(pinned(shown(id).querySelector(".pin"))).toBeUndefined();
      expect(lockedPin(shown(id).querySelector(".pin"))).toBe(id);
    }
    expect(pinned(shown("c").querySelector(".pin"))).toBe("c");
    expect(lockedPin(shown("c").querySelector(".pin"))).toBeUndefined();
  });

  it("keeps texts hidden after Escape until the pointer comes to a comment", () => {
    layer().show(board({ a: comment("Here") }), []);
    const all = document.querySelector(".pins")!;
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(all.classList.contains("quiet")).toBe(true);
    shown("a").dispatchEvent(new Event("pointerenter"));
    expect(all.classList.contains("quiet")).toBe(false);
  });
});
