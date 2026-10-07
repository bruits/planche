// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Board, Kind, Rect } from "./core.js";
import { titledGroup, titles } from "./titles.js";

const GROUP = "a".repeat(32);
const OTHER = "b".repeat(32);
const AREA: Rect = { x: 100, y: 50, width: 400, height: 300 };

function board(kinds: Record<string, Kind>, locked: string[] = []): Board {
  const ids = Object.keys(kinds);
  return {
    elements: Object.fromEntries(
      ids.map((id, at) => [id, { z: `a${at}`, kind: kinds[id]!, locked: locked.includes(id) }]),
    ),
    draw_order: ids,
    background: "plain",
  };
}

function shown() {
  const host = document.body.appendChild(document.createElement("div"));
  const rename = vi.fn<(id: string, title: string) => void>();
  const made = titles(host, rename);
  made.frame({ x: 0, y: 0, zoom: 0.5 });
  return { made, rename };
}

function label(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.group-title[data-group="${id}"]`);
}

function key(target: EventTarget, name: string) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  );
}

describe("titles", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("names each titled group over the top-left of what it draws, at one size on screen", () => {
    const { made } = shown();
    made.show(
      board({ [GROUP]: { type: "group", title: "Moods" }, [OTHER]: { type: "group" } }),
      () => AREA,
      [GROUP],
    );
    expect(label(GROUP)?.textContent).toBe("Moods");
    expect(label(GROUP)?.style.transform).toBe("translate(50px, 25px)");
    expect(label(GROUP)?.classList.contains("selected")).toBe(true);
    expect(label(OTHER)).toBeNull();
    made.frame({ x: 0, y: 0, zoom: 0.5 }, { width: 800, height: 600 });
    // Over the corner that shows on the left once mirrored, its right one, at 250.
    expect(label(GROUP)?.style.transform).toBe("translate(550px, 25px)");
  });

  it("offers a title to the group selected alone that has none, which a click writes", () => {
    const { made, rename } = shown();
    made.show(board({ [GROUP]: { type: "group" } }), () => AREA, [GROUP], GROUP);
    const offer = label(GROUP)!;
    expect(offer.textContent).toBe("Add title");
    expect(titledGroup(offer)).toBeUndefined();
    offer.click();
    const field = offer.querySelector("input")!;
    expect(document.activeElement).toBe(field);
    field.value = "Moods";
    key(field, "Enter");
    expect(rename).toHaveBeenCalledExactlyOnceWith(GROUP, "Moods");
  });

  it("writes a title in place on a double-click, ended by a press elsewhere before the board hears of it", () => {
    const { made, rename } = shown();
    made.show(board({ [GROUP]: { type: "group", title: "Moods" } }), () => AREA, []);
    const named = label(GROUP)!;
    expect(titledGroup(named)).toBe(GROUP);
    named.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const field = named.querySelector("input")!;
    expect(field.value).toBe("Moods");
    field.value = "Light";
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(rename).toHaveBeenCalledExactlyOnceWith(GROUP, "Light");
    expect(named.querySelector("input")).toBeNull();
  });

  it("renames nothing when Esc ends a title left as it was", () => {
    const { made, rename } = shown();
    made.show(board({ [GROUP]: { type: "group", title: "Moods" } }), () => AREA, []);
    made.write(GROUP);
    key(label(GROUP)!.querySelector("input")!, "Escape");
    expect(rename).not.toHaveBeenCalled();
    expect(label(GROUP)?.textContent).toBe("Moods");
  });

  it("lets presses through the title of a locked group, and hides one with nothing to stand over", () => {
    const { made } = shown();
    made.show(
      board(
        { [GROUP]: { type: "group", title: "Moods" }, [OTHER]: { type: "group", title: "Later" } },
        [GROUP],
      ),
      (id) => (id === GROUP ? AREA : undefined),
      [],
    );
    expect(titledGroup(label(GROUP))).toBeUndefined();
    expect(label(OTHER)?.hidden).toBe(true);
  });
});
