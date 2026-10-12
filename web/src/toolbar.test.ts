// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { move, pointer, press } from "../test/events.js";
import { closeMenu, menuOpen } from "./menu.js";
import { toolbar } from "./toolbar.js";

describe("toolbar", () => {
  afterEach(() => {
    closeMenu();
  });

  it("moves between its buttons with Left and Right, and keeps Up and Down from the board", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const run = vi.fn<() => void>();
    toolbar(
      host,
      [
        [
          { command: { label: "Select", run }, icon: "pointer" },
          { command: { label: "Hand", run }, icon: "hand" },
        ],
      ],
      () => [],
    );
    const [select, hand] = host.querySelectorAll<HTMLButtonElement>(".bar button");
    select!.focus();
    expect(press({ key: "ArrowRight" }, document.activeElement!).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(hand);
    expect(press({ key: "ArrowDown" }, document.activeElement!).defaultPrevented).toBe(true);
    expect(press({ key: "ArrowUp" }, document.activeElement!).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(hand);
  });

  it("keeps naming the last button hovered in the gap to the next, until the pointer leaves", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const run = vi.fn<() => void>();
    const bar = toolbar(
      host,
      [
        [
          { command: { label: "Select", run }, icon: "pointer" },
          { command: { label: "Hand", run }, icon: "hand" },
        ],
      ],
      () => [],
    );
    bar.refresh("Drop or paste images");
    const hint = host.querySelector(".hint")!;
    const row = host.querySelector(".row")!;
    const [select, hand] = host.querySelectorAll(".bar button");
    move(document.body, select!);
    expect(hint.textContent).toBe("Select");
    move(select!, row);
    expect(hint.textContent).toBe("Select");
    move(row, hand!);
    move(hand!, hand!.firstElementChild!);
    expect(hint.textContent).toBe("Hand");
    move(hand!.firstElementChild!, row);
    move(row, document.body);
    expect(hint.textContent).toBe("Drop or paste images");
  });

  it("drops the hint of a button gone from under the pointer, and only its own", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const bar = toolbar(host, [[]], () => []);
    bar.refresh("Drop or paste images");
    const [opacity, other] = ["Opacity", "Other"].map((name) => {
      const made = document.body.appendChild(document.createElement("input"));
      bar.explain(made, () => name);
      return made;
    });
    move(document.body, opacity!);
    pointer(other!, "pointerout");
    expect(host.querySelector(".hint")!.textContent).toBe("Opacity");
    pointer(opacity!, "pointerout");
    expect(host.querySelector(".hint")!.textContent).toBe("Drop or paste images");
  });

  it("opens its menu upwards with Up, on its nearest item", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const run = vi.fn<() => void>();
    toolbar(host, [[]], () => [
      { label: "New board", run },
      { label: "Open a board…", run },
    ]);
    host.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')!.focus();
    expect(press({ key: "ArrowUp" }, document.activeElement!).defaultPrevented).toBe(true);
    expect(menuOpen()).toBe(true);
    expect(document.activeElement?.textContent).toBe("Open a board…");
  });
});
