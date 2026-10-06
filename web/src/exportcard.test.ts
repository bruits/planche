// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportCard,
  recalled,
  remembered,
  type ExportCard,
  type ExportHost,
} from "./exportcard.js";
import { closeFinder, openFinder } from "./finder.js";
import type { Options, Plan } from "./render.js";

const AS_SHOWN: Options = { longest: undefined, background: "board", margin: false };
const KEYS = { save: { key: "enter" }, copy: { key: "c", command: true } };
const opened: ExportCard[] = [];

function planned({ longest }: Options): Plan {
  const zoom = longest === undefined ? 1 : longest / 400;
  const area = { x: 0, y: 0, width: 400, height: 200 };
  return { area, zoom, size: { width: 400 * zoom, height: 200 * zoom }, capped: false };
}

function made(host: Partial<ExportHost> = {}) {
  const board: { shown?: Plan | undefined } = {};
  const full: ExportHost = {
    planned: vi.fn<ExportHost["planned"]>(planned),
    client: ({ x, y }) => ({ clientX: x, clientY: y }),
    busy: () => false,
    floor: () => 800,
    explain: () => {},
    changed: vi.fn<() => void>(() => (board.shown = card.plan())),
    chose: vi.fn<(options: Options) => void>(),
    save: vi.fn<(options: Options) => void>(),
    copy: vi.fn<(options: Options) => void>(),
    ...host,
  };
  const card = exportCard(full, AS_SHOWN, KEYS);
  opened.push(card);
  return { card, host: full, board };
}

function button(name: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.export-card button[aria-label="${name}"]`)!;
}

function pressed(name: string): string | null {
  return button(name).getAttribute("aria-pressed");
}

function shown(): { facts: string | null | undefined; readout: string | null | undefined } {
  return {
    facts: document.querySelector(".export-card .facts")?.textContent,
    readout: document.querySelector(".readout")?.textContent,
  };
}

function copyKey(target: EventTarget = document.body, more: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "c",
    code: "KeyC",
    metaKey: true,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...more,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  opened.splice(0).forEach((card) => card.close());
  document.body.replaceChildren();
});

describe("the export card", () => {
  it("opens with Save focused, and the picture's size on it and over the board", () => {
    const { card, board } = made();
    card.open(true);
    expect(card.isOpen()).toBe(true);
    expect(document.querySelector<HTMLElement>(".export-card")!.hidden).toBe(false);
    expect(document.activeElement).toBe(button("Save as PNG…"));
    expect(shown()).toEqual({ facts: "400 × 200", readout: "400 × 200" });
    expect(board.shown).toEqual(planned(AS_SHOWN));
  });

  it("opens nothing while the selection draws nothing", () => {
    const { card, host } = made({ planned: () => undefined });
    card.open(true);
    expect(card.isOpen()).toBe(false);
    expect(document.querySelector<HTMLElement>(".export-card")!.hidden).toBe(true);
    expect(host.changed).not.toHaveBeenCalled();
  });

  it("shows what it takes, keeps each choice, and frames the picture again with it", () => {
    const { card, host, board } = made();
    card.open(false);
    expect([pressed("Full size"), pressed("Board"), pressed("Margin")]).toEqual([
      "true",
      "true",
      "false",
    ]);
    button("2048 pixels").click();
    button("White").click();
    button("Margin").click();
    const chosen: Options = { longest: 2048, background: "white", margin: true };
    expect(card.options()).toEqual(chosen);
    expect(host.chose).toHaveBeenLastCalledWith(chosen);
    expect(board.shown).toEqual(planned(chosen));
    expect([pressed("Full size"), pressed("2048 pixels"), pressed("White")]).toEqual([
      "false",
      "true",
      "true",
    ]);
    expect(shown()).toEqual({ facts: "2048 × 1024", readout: "2048 × 1024" });
  });

  it("saves and copies with what it took", () => {
    const { card, host } = made();
    card.open(false);
    button("Transparent").click();
    button("Save as PNG…").click();
    button("Copy as PNG").click();
    const chosen = { ...AS_SHOWN, background: "transparent" };
    expect(host.save).toHaveBeenCalledWith(chosen);
    expect(host.copy).toHaveBeenCalledWith(chosen);
  });

  it("names the keys of Save and Copy", () => {
    made();
    expect(button("Save as PNG…").title).toBe("Save as PNG… · Enter");
    expect(button("Copy as PNG").title).toBe("Copy as PNG · Ctrl+C");
  });

  it("copies the picture on the copy keys while open, but not while closed or typing", () => {
    const { card, host } = made();
    expect(copyKey().defaultPrevented).toBe(false);
    card.open(false);
    expect(copyKey().defaultPrevented).toBe(true);
    expect(host.copy).toHaveBeenCalledOnce();
    const field = document.body.appendChild(document.createElement("input"));
    expect(copyKey(field).defaultPrevented).toBe(false);
    card.close();
    copyKey();
    expect(host.copy).toHaveBeenCalledOnce();
  });

  it("copies once while the copy keys are held, yet keeps the page's copy from them", () => {
    const { card, host } = made();
    card.open(false);
    copyKey();
    const held = new KeyboardEvent("keydown", {
      key: "c",
      code: "KeyC",
      metaKey: true,
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    expect(host.copy).toHaveBeenCalledOnce();
  });

  it("leaves Shift and Alt with the copy keys to their own commands, and the keys to the finder or a gesture", () => {
    let busy = false;
    const { card, host } = made({ busy: () => busy });
    card.open(false);
    expect(copyKey(document.body, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(copyKey(document.body, { altKey: true }).defaultPrevented).toBe(false);
    openFinder(() => []);
    expect(copyKey().defaultPrevented).toBe(false);
    closeFinder();
    busy = true;
    expect(copyKey().defaultPrevented).toBe(false);
    expect(host.copy).not.toHaveBeenCalled();
  });

  it("hides while a gesture leaves nothing to frame, and closes once it ends so", () => {
    let busy = true;
    let drawn = true;
    const { card } = made({
      busy: () => busy,
      planned: (options) => (drawn ? planned(options) : undefined),
    });
    card.open(false);
    drawn = false;
    card.refresh();
    expect(card.isOpen()).toBe(true);
    expect(document.querySelector<HTMLElement>(".export-card")!.hidden).toBe(true);
    busy = false;
    card.refresh();
    expect(card.isOpen()).toBe(false);
  });

  it("gives the board and the focus back once closed", () => {
    const { card, board } = made();
    card.open(true);
    card.close();
    expect(card.isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(board.shown).toBeUndefined();
  });
});

describe("the export card's choices, kept", () => {
  it("come back as they were left", () => {
    const chosen: Options = { longest: 1024, background: "transparent", margin: true };
    const kept = new Map(remembered(chosen));
    expect(recalled((key) => kept.get(key) ?? null)).toEqual(chosen);
  });

  it("keep nothing for the defaults, and fall back to them for what they no longer offer", () => {
    expect(remembered(AS_SHOWN).every(([, value]) => value === undefined)).toBe(true);
    const stale = new Map(remembered({ longest: 2048, background: "white", margin: true }));
    const read = (key: string) =>
      key.endsWith("size")
        ? "8192"
        : key.endsWith("background")
          ? "pink"
          : (stale.get(key) ?? null);
    expect(recalled(read)).toEqual({ ...AS_SHOWN, margin: true });
  });
});
