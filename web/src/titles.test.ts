// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { boardOf } from "../test/boards.js";
import { press, pressAway } from "../test/events.js";
import { refresh, type Opened } from "./board.js";
import type { Kind, Rect } from "./core.js";
import { titledGroup, titles } from "./titles.js";

const GROUP = "a".repeat(32);
const OTHER = "b".repeat(32);
const AREA: Rect = { x: 100, y: 50, width: 400, height: 300 };

const NOTE: Kind = {
  type: "note",
  frame: { x: 0, y: 0, width: 10, height: 10 },
  rotation: 0,
  text: { content: "", font_size: 20 },
};

function opened(kinds: Record<string, Kind>, locked: string[] = []): Opened {
  const groups = Object.fromEntries(
    Object.keys(kinds).map((group, at) => [
      group,
      [2 * at, 2 * at + 1].map((digit) => digit.toString(16).repeat(32)),
    ]),
  );
  const made = boardOf(
    Object.values(groups).flatMap((members) => members.map((id): [string, Kind] => [id, NOTE])),
    { groups },
  );
  for (const [group, kind] of Object.entries(kinds)) {
    refresh(made, made.editor.update(group, JSON.stringify(kind)));
  }
  // Once titled, as the core refuses to title a locked group.
  refresh(made, made.editor.setLocked(locked, true));
  return made;
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

describe("titles", () => {
  it("names each titled group over the top-left of what it draws, at one size on screen", () => {
    const { made } = shown();
    made.show(
      opened({ [GROUP]: { type: "group", title: "Moods" }, [OTHER]: { type: "group" } }),
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

  it("asks for a group's area again only once told that group changed", () => {
    const { made } = shown();
    const titled = opened({
      [GROUP]: { type: "group", title: "Moods" },
      [OTHER]: { type: "group", title: "Colours" },
    });
    const moved = { ...AREA, x: 300, y: 150 };
    made.show(titled, () => AREA, []);
    made.show(titled, () => moved, []);
    expect(label(GROUP)?.style.transform).toBe("translate(50px, 25px)");
    made.changed([GROUP]);
    made.show(titled, () => moved, []);
    expect(label(GROUP)?.style.transform).toBe("translate(150px, 75px)");
    expect(label(OTHER)?.style.transform).toBe("translate(50px, 25px)");
  });

  it("offers a title to the group selected alone that has none, which a click writes", () => {
    const { made, rename } = shown();
    made.show(opened({ [GROUP]: { type: "group" } }), () => AREA, [GROUP], GROUP);
    const offer = label(GROUP)!;
    expect(offer.textContent).toBe("Add title");
    expect(titledGroup(offer)).toBeUndefined();
    offer.click();
    const field = offer.querySelector("input")!;
    expect(document.activeElement).toBe(field);
    field.value = "Moods";
    press({ key: "Enter" }, field);
    expect(rename).toHaveBeenCalledExactlyOnceWith(GROUP, "Moods");
  });

  it("writes a title in place on a double-click, ended by a press elsewhere before the board hears of it", () => {
    const { made, rename } = shown();
    made.show(opened({ [GROUP]: { type: "group", title: "Moods" } }), () => AREA, []);
    const named = label(GROUP)!;
    expect(titledGroup(named)).toBe(GROUP);
    named.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const field = named.querySelector("input")!;
    expect(field.value).toBe("Moods");
    field.value = "Light";
    pressAway();
    expect(rename).toHaveBeenCalledExactlyOnceWith(GROUP, "Light");
    expect(named.querySelector("input")).toBeNull();
  });

  it("renames nothing when Esc ends a title left as it was", () => {
    const { made, rename } = shown();
    made.show(opened({ [GROUP]: { type: "group", title: "Moods" } }), () => AREA, []);
    made.write(GROUP);
    press({ key: "Escape" }, label(GROUP)!.querySelector("input")!);
    expect(rename).not.toHaveBeenCalled();
    expect(label(GROUP)?.textContent).toBe("Moods");
  });

  it("lets presses through the title of a locked group, and hides one with nothing to stand over", () => {
    const { made } = shown();
    made.show(
      opened(
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
