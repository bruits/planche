// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { closeMenu, menuOpen } from "./menu.js";
import { toolbar } from "./toolbar.js";

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(event);
  return event;
}

describe("toolbar", () => {
  afterEach(() => {
    closeMenu();
    document.body.replaceChildren();
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
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(hand);
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(press("ArrowUp").defaultPrevented).toBe(true);
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
    expect(press("ArrowUp").defaultPrevented).toBe(true);
    expect(menuOpen()).toBe(true);
    expect(document.activeElement?.textContent).toBe("Open a board…");
  });
});
