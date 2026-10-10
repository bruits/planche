// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "./core.js";
import { welcome } from "./welcome.js";

const GROUP = "a".repeat(32);
const EMPTY: Board = { elements: {}, draw_order: [], background: "plain" };
const HOLDING: Board = {
  elements: { [GROUP]: { z: "a0", kind: { type: "group" }, locked: false } },
  draw_order: [GROUP],
  background: "plain",
};

function made(floor: () => number = () => 1000) {
  const host = document.body.appendChild(document.createElement("div"));
  return welcome(host, floor);
}

function shown(): boolean {
  return document.querySelector(".welcome")?.classList.contains("shown") ?? false;
}

describe("welcome", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows over an empty board, in place of the board's hint", () => {
    const greeting = made();
    greeting.follow(EMPTY);
    expect(shown()).toBe(true);
    expect(greeting.quietsHint()).toBe(true);
    expect(document.querySelector(".welcome")?.textContent).toBe(
      "Drop or paste images anywhereOr pick a tool below",
    );
  });

  it("keeps the board's hint out until a board shows", () => {
    const greeting = made();
    expect(shown()).toBe(false);
    expect(greeting.quietsHint()).toBe(true);
  });

  it("stays away from a board that holds something, which ends nothing", () => {
    const greeting = made();
    greeting.follow(HOLDING);
    expect(shown()).toBe(false);
    expect(greeting.quietsHint()).toBe(false);
    greeting.follow(EMPTY);
    expect(shown()).toBe(true);
  });

  it("never shows again from the first edit, even on an empty board or at the next launch", () => {
    const greeting = made();
    greeting.follow(EMPTY);
    greeting.end();
    expect(shown()).toBe(false);
    expect(greeting.quietsHint()).toBe(false);
    greeting.follow(EMPTY);
    expect(shown()).toBe(false);

    document.body.replaceChildren();
    const next = made();
    expect(next.quietsHint()).toBe(false);
    next.follow(EMPTY);
    expect(shown()).toBe(false);
  });

  it("stays away in a second window once the first one's edit ended it", () => {
    // Two windows of one browser share the storage.
    const first = made();
    const second = made();
    const [one, other] = [...document.querySelectorAll(".welcome")];
    first.follow(EMPTY);
    second.follow(EMPTY);
    expect(other!.classList.contains("shown")).toBe(true);

    first.end();
    expect(one!.classList.contains("shown")).toBe(false);

    second.follow(EMPTY);
    expect(other!.classList.contains("shown")).toBe(false);
    expect(second.quietsHint()).toBe(false);
  });

  it("ends for the session when the browser cannot remember it", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    const greeting = made();
    greeting.follow(EMPTY);
    greeting.end();
    expect(localStorage.length).toBe(0);
    greeting.follow(EMPTY);
    expect(shown()).toBe(false);
  });

  it("hides its arrow while the tip would come near the toolbar", () => {
    let floor = 524;
    const greeting = made(() => floor);
    const arrow = document.querySelector<SVGSVGElement>(".welcome .arrow")!;
    arrow.getBoundingClientRect = () => new DOMRect(0, 424, 52, 76);
    greeting.follow(EMPTY);
    expect(arrow.classList.contains("cramped")).toBe(false);
    floor = 523;
    greeting.fit();
    expect(arrow.classList.contains("cramped")).toBe(true);
    floor = 600;
    dispatchEvent(new Event("resize"));
    expect(arrow.classList.contains("cramped")).toBe(false);
  });
});
