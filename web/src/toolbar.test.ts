// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { press } from "../test/events.js";
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
