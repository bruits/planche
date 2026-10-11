// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { around } from "../test/actions.js";
import { rectangleKind } from "../test/kinds.js";
import { imageKind } from "./board.js";
import { named } from "./commands.js";
import type { Point } from "./core.js";
import { closeMenu, type Entry } from "./menu.js";
import { menus, type Host } from "./menus.js";

const IMAGE = "a".repeat(32);
const SHAPE = "c".repeat(32);
const ASSET = "f".repeat(64);
const AT = { x: 0, y: 0 };
const PLACE = { x: 10, y: 10 };
const shape = rectangleKind(300);
const image = imageKind(
  ASSET,
  { width: 320, height: 240 },
  { x: 0, y: 0, width: 160, height: 120 },
);

function offered(commands: ReturnType<typeof around>, given: Partial<Host> = {}) {
  const { host } = commands;
  return menus(commands.app, {
    platform: {},
    viewport: { ...host.viewport, client: () => undefined },
    editing: { centre: () => undefined, unlock() {} },
    groupTitles: host.groupTitles,
    measurements: host.measurements,
    pictureCard: host.pictureCard,
    savesToFiles: () => false,
    addPicked() {},
    addTestPhotos: async () => {},
    report() {},
    ...given,
  });
}

function shown(): string[] {
  const menu = document.querySelector('[role="menu"]');
  return [...(menu?.children ?? [])].map((child) =>
    child.getAttribute("role") === "separator"
      ? "|"
      : (child.querySelector(".name")?.textContent ?? ""),
  );
}

function viewOf(given: Partial<Host>): Entry[] {
  const view = offered(around(), given)
    .toolbar()
    .find((entry) => entry !== "separator" && named(entry) === "View");
  return view === "separator" ? [] : (view?.options ?? []);
}

describe("the app's menus", () => {
  afterEach(() => {
    closeMenu();
    document.documentElement.removeAttribute("data-compact");
  });

  it("lists every command for the finder but those only keys reach, naming the menus theirs sit in", () => {
    const commands = around();
    const listed = offered(commands).listed();
    const names = listed.map((item) => named(item));
    expect(names).toContain("Select all");
    for (const left of ["Go back up, or deselect", "Show the context menu", "Find a command…"]) {
      expect(names).not.toContain(left);
    }
    expect(names).not.toContain("Save as PNG…");
    expect(names).not.toContain("Get the desktop app");
    const within = (name: string) => listed.find((item) => named(item) === name)?.within;
    expect(within("Left")).toBe("Align");
    expect(within("Lines")).toBe("Grid");
    expect(within("Select all")).toBeUndefined();
    expect(listed.find((item) => named(item) === "No grid")?.checked).toBe(true);
  });

  it("lists the desktop app where a link to it is offered", () => {
    const names = offered(around(), { platform: { desktopApp: "https://example.com" } })
      .listed()
      .map((item) => named(item));
    expect(names).toContain("Get the desktop app");
  });

  it("offers on the selection only what applies to it, without separators left alone", () => {
    offered(around([[SHAPE, shape]], { selected: [SHAPE] })).context(true, AT, PLACE);
    const items = shown();
    expect(items).toContain("Cut");
    expect(items).toContain("Transform");
    expect(items).not.toContain("Playback");
    expect(items).not.toContain("Arrange");
    expect(items).not.toContain("Edit text");
    expect(items[0]).not.toBe("|");
    expect(items.at(-1)).not.toBe("|");
    expect(items.join(" ")).not.toContain("| |");
  });

  it("offers on the board what lands where it opened, and what unlocks what is locked there", () => {
    const addPicked = vi.fn<(at: Point | undefined) => void>();
    const menu = offered(around([[IMAGE, image]]), { addPicked });
    menu.context(false, { x: 40, y: 60 }, PLACE, IMAGE);
    expect(shown()).toEqual([
      "Add images…",
      "Paste",
      "Select all",
      "Unlock",
      "|",
      "Zoom to fit",
      "Grid",
    ]);
    document.querySelector<HTMLElement>('[role="menu"] > *')?.click();
    expect(addPicked).toHaveBeenCalledWith({ x: 40, y: 60 });
  });

  it("puts the way out of compact mode first while the window is compact", async () => {
    const commands = around([], {
      platform: { ...around().host.platform, titleBar: { show: async () => {}, drag() {} } },
    });
    commands.app.commands.compact.run();
    await commands.settled();
    offered(commands).context(false, AT, PLACE);
    expect(shown().slice(0, 2)).toEqual(["Leave compact mode", "|"]);
  });

  it("ticks the zoom shown among those offered", () => {
    const zooms = offered(around()).zooms();
    const ticked = zooms.filter((entry) => entry !== "separator" && entry.checked);
    expect(ticked.map((entry) => entry !== "separator" && named(entry))).toEqual(["100%"]);
  });

  it("offers test photos only while the measurements show, and not on a board saved in files", () => {
    const hidden = viewOf({});
    expect(hidden.some((entry) => entry !== "separator" && named(entry).includes("test"))).toBe(
      false,
    );
    const photos = viewOf({ measurements: { shown: () => true }, savesToFiles: () => true }).filter(
      (entry) => entry !== "separator" && named(entry).includes("test"),
    );
    expect(photos).toHaveLength(3);
    for (const entry of photos) {
      expect(entry !== "separator" && entry.unavailable?.()).toBe(
        "Only on a board not saved in a folder or a ZIP file",
      );
    }
  });
});
