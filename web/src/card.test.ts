// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageKind, untitled } from "./board.js";
import { card, type CardCommands } from "./card.js";
import type { Command } from "./commands.js";
import * as core from "./core.js";
import type { Tip } from "./core.js";
import { styles } from "./style.js";

const IMAGE = "a".repeat(32);
const ARROW = "d".repeat(32);
const OTHER = "e".repeat(32);
const ASSET = "b".repeat(64);
const frame = { x: 0, y: 0, width: 160, height: 120 };
const ORIGIN = { x: 0, y: 0 };
const command = (keys?: Command["keys"]): Command => ({
  label: "",
  keys,
  run: vi.fn<() => void>(),
});

function field(name: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`.style-card input[aria-label="${name}"]`)!;
}

function titled(name: string): string | null | undefined {
  return document.querySelector(`.style-card button[aria-label="${name}"]`)?.getAttribute("title");
}

function slider(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('.style-card input[type="range"]')!;
}

function press(type: "pointerdown" | "pointerup", init: PointerEventInit = {}) {
  slider().dispatchEvent(new PointerEvent(type, init));
}

function key(type: "keydown" | "keyup") {
  slider().dispatchEvent(new KeyboardEvent(type, { key: "ArrowLeft" }));
}

function slide(percent: number, { release = false } = {}) {
  slider().value = String(percent);
  slider().dispatchEvent(new Event("input"));
  if (release) {
    slider().dispatchEvent(new Event("change"));
  }
}

/** The card over a board holding one image, selected, which comes from `source`. */
function opened(source?: string) {
  const board = untitled();
  const kind = imageKind(ASSET, { width: 320, height: 240 }, frame, {
    filename: "cat.png",
    source,
  });
  board.editor.add(IMAGE, undefined, JSON.stringify(kind));
  board.board = core.board(board.editor);
  let selected = [IMAGE];
  let held = false;
  const commands: CardCommands = {
    colours: [],
    bold: command(),
    italic: command(),
    strike: command(),
    greyscale: command([{ key: "g", alt: true }]),
    flipHorizontally: command(),
    flipVertically: command(),
    crop: command(),
    rectangularCrop: command(),
    ellipticalCrop: command([{ key: "c", alt: true }]),
    openSource: command(),
    open: command(),
  };
  const shown = card(
    {
      current: () => board,
      selection: () => selected,
      tool: () => undefined,
      box: () => [
        { x: 0, y: 0 },
        { x: 160, y: 0 },
        { x: 160, y: 120 },
        { x: 0, y: 120 },
      ],
      client: ({ x, y }) => ({ clientX: x, clientY: y }),
      zoom: () => 1,
      busy: () => held,
      reading: () => undefined,
      floor: () => 800,
      apply(work) {
        if (held) {
          throw new Error("Someone is editing in Planche");
        }
        const touched: string[] = [];
        board.editor.beginGesture();
        work(board.editor, touched);
        board.editor.endGesture();
        board.board = core.board(board.editor);
        // As the app does once an edit is made.
        shown.refresh();
      },
      adjust(work) {
        held = true;
        board.editor.beginGesture();
        work(board.editor, []);
        board.board = core.board(board.editor);
        shown.refresh();
      },
      finishAdjusting() {
        if (!held) {
          return;
        }
        held = false;
        board.editor.endGesture();
        board.board = core.board(board.editor);
        shown.refresh();
      },
      adjusting: () => held,
      pick() {},
      explain() {},
      say() {},
    },
    styles(),
    commands,
  );
  shown.open(false);
  const image = () => {
    const now = core.element(board.editor, IMAGE)?.kind;
    return now?.type === "image" ? now : undefined;
  };
  const select = (ids: string[]) => {
    selected = ids;
    shown.refresh();
  };
  /** As the app does once its board goes. */
  const drop = () => {
    held = false;
    board.editor.endGesture();
  };
  return { board, shown, commands, image, select, drop };
}

describe("the card of a lone image", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("says what it is, and how large it lies on the board", () => {
    opened();
    expect(document.querySelector(".style-card .facts")?.textContent).toBe(
      "cat.png · 320 × 240 · 50%",
    );
  });

  it("turns its images grey as the greyscale command does", () => {
    const { commands } = opened();
    (document.querySelector('button[aria-label="Greyscale"]') as HTMLButtonElement).click();
    expect(commands.greyscale.run).toHaveBeenCalledOnce();
  });

  it("names the keys of its greyscale and elliptical crop", () => {
    opened();
    expect(titled("Greyscale")).toBe("Greyscale · Alt+G");
    expect(titled("Elliptical crop")).toBe("Elliptical crop · Alt+C");
  });

  it("writes its caption as one edit, and none when left blank", () => {
    const { board, image } = opened();
    field("Caption").value = "Morning light";
    field("Caption").dispatchEvent(new Event("change"));
    expect(image()?.caption).toBe("Morning light");
    field("Caption").value = "  ";
    field("Caption").dispatchEvent(new Event("change"));
    expect(image()).not.toHaveProperty("caption");
    board.editor.undo();
    expect(image()?.caption).toBe("Morning light");
  });

  it("leaves its source as it was on Esc", () => {
    const { image } = opened("https://example.com/cat.png");
    field("Source").value = "elsewhere";
    field("Source").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    field("Source").dispatchEvent(new Event("change"));
    expect(image()?.source).toBe("https://example.com/cat.png");
  });

  it("keeps what its source is being written as when Esc ends a composition", () => {
    const { image } = opened("https://example.com/cat.png");
    field("Source").value = "elsewhere";
    field("Source").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229 }));
    field("Source").dispatchEvent(new Event("change"));
    expect(image()?.source).toBe("elsewhere");
  });

  it("opens its source only when a web page", () => {
    const { commands } = opened("https://example.com/cat.png");
    document.querySelector<HTMLButtonElement>('button[aria-label="Open example.com"]')!.click();
    expect(commands.openSource.run).toHaveBeenCalledOnce();
    document.body.replaceChildren();
    opened("javascript:alert(1)");
    expect(document.querySelector('button[aria-label^="Open"]:not([hidden])')).toBeNull();
  });

  // A browser saves a field as the focus moves on, to the next field or to the button pressed,
  // which a card built again would drop.
  it("leaves in place what the focus or a press moves on to once a field is saved", () => {
    opened();
    const greyscale = document.querySelector('button[aria-label="Greyscale"]')!;
    const caption = field("Caption");
    const source = field("Source");
    caption.value = "Morning light";
    caption.dispatchEvent(new Event("change"));
    source.value = "https://other.org/cat.png";
    source.dispatchEvent(new Event("change"));
    expect([caption, source, greyscale].map((element) => element.isConnected)).toEqual([
      true,
      true,
      true,
    ]);
    expect(document.querySelector('button[aria-label="Open other.org"]')).not.toBeNull();
  });

  it("keeps what is being written while the image changes from elsewhere", () => {
    const { board, shown } = opened();
    field("Caption").focus();
    field("Caption").value = "Half a tho";
    const kind = core.element(board.editor, IMAGE)!.kind;
    if (kind.type === "image") {
      board.editor.update(
        IMAGE,
        JSON.stringify({ ...kind, edits: { ...kind.edits, greyscale: true } }),
      );
    }
    board.board = core.board(board.editor);
    shown.refresh();
    expect(document.activeElement).toBe(field("Caption"));
    expect(field("Caption").value).toBe("Half a tho");
  });

  it("keeps its fields to the image they were built for while one is written in", () => {
    const { board, select } = opened("https://a.example/cat.png");
    const other = "c".repeat(32);
    const kind = imageKind(ASSET, { width: 10, height: 10 }, frame, {
      source: "https://b.example/dog.png",
    });
    board.editor.add(other, undefined, JSON.stringify(kind));
    board.board = core.board(board.editor);
    field("Caption").focus();
    field("Caption").value = "Half a tho";
    select([other]);
    expect(field("Caption").value).toBe("Half a tho");
    expect(field("Source").value).toBe("https://a.example/cat.png");
    expect(document.querySelector('button[aria-label="Open a.example"]')).not.toBeNull();
  });

  it("fades it as its opacity slides, and as one edit once let go", () => {
    const { board, image } = opened();
    const sliding = slider();
    press("pointerdown");
    slide(40);
    slide(60);
    expect(image()?.opacity).toBe(60);
    expect(slider()).toBe(sliding);
    expect(document.querySelector<HTMLElement>(".style-card")?.hidden).toBe(false);
    expect(board.editor.canUndo()).toBe(false);
    press("pointerup");
    board.editor.undo();
    expect(image()).not.toHaveProperty("opacity");
  });

  it("lets go of its opacity once released, though no change comes, nor counts after", () => {
    const { board, image } = opened();
    const sliding = slider();
    press("pointerdown");
    slide(52);
    press("pointerup");
    expect(image()?.opacity).toBe(50);
    expect(board.editor.canUndo()).toBe(true);
    // As a browser sends it after the release, to the slider the card has since built again.
    sliding.dispatchEvent(new Event("change"));
    board.editor.undo();
    expect(image()).not.toHaveProperty("opacity");
  });

  it("writes nothing of its opacity once whole again", () => {
    const { image } = opened();
    slide(50, { release: true });
    expect(image()?.opacity).toBe(50);
    slide(100, { release: true });
    expect(image()).not.toHaveProperty("opacity");
  });

  it("snaps its opacity to a step under a pointer, but not under the keys", () => {
    const { image } = opened();
    press("pointerdown");
    slide(52);
    press("pointerup");
    expect(image()?.opacity).toBe(50);
    key("keydown");
    slide(51, { release: true });
    key("keyup");
    expect(image()?.opacity).toBe(51);
  });

  it("makes one edit of a key held on its opacity, once the key is up", () => {
    const { board, image } = opened();
    const sliding = slider();
    for (const percent of [99, 98, 97]) {
      key("keydown");
      slide(percent, { release: true });
    }
    expect(slider()).toBe(sliding);
    key("keyup");
    expect(image()?.opacity).toBe(97);
    board.editor.undo();
    expect(image()).not.toHaveProperty("opacity");
  });

  it("keeps the focus on its opacity as the keys change it", () => {
    opened();
    slider().focus();
    key("keydown");
    slide(99, { release: true });
    key("keyup");
    expect(document.activeElement).toBe(slider());
    expect(slider().getAttribute("aria-valuetext")).toBe("99%");
  });

  it("lays its opacity under its own row, as a shape's comes last", () => {
    opened();
    const rows = [...document.querySelectorAll('.style-card [role="group"]')].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(rows).toEqual(["Image", "Opacity", "Info"]);
  });

  it("lets go of a field before a press elsewhere reaches the board", () => {
    opened();
    field("Caption").focus();
    field("Source").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(field("Caption"));
    const board = document.body.appendChild(document.createElement("div"));
    let focused: Element | null = null;
    board.addEventListener("pointerdown", () => (focused = document.activeElement));
    board.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(focused).not.toBe(field("Caption"));
  });

  it("shows a caption written elsewhere", () => {
    const { board, shown } = opened();
    board.editor.update(
      IMAGE,
      JSON.stringify({ ...core.element(board.editor, IMAGE)!.kind, caption: "From an agent" }),
    );
    board.board = core.board(board.editor);
    shown.refresh();
    expect(field("Caption").value).toBe("From an agent");
  });
});

/** An arrow as its tool would draw it now. */
function drawn() {
  return styles().dressed({ type: "arrow", from: ORIGIN, to: ORIGIN }, 1);
}

function both() {
  const made = opened();
  const arrow = { type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } } as const;
  made.board.editor.add(ARROW, undefined, JSON.stringify({ ...arrow, colour: "red" }));
  made.board.editor.add(OTHER, undefined, JSON.stringify(arrow));
  made.board.board = core.board(made.board.editor);
  made.select([IMAGE, ARROW]);
  const kind = (id: string) => core.element(made.board.editor, id)?.kind;
  return { ...made, kind };
}

describe("the card of an image and an arrow", () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("shows a highlighter's colours as it draws them, though an image is selected with it", () => {
    const { board, select } = opened();
    const line = [ORIGIN, { x: 50, y: 50 }];
    board.editor.add(OTHER, undefined, JSON.stringify(core.strokeKind(line, 0, "highlighter")));
    board.board = core.board(board.editor);
    select([IMAGE, OTHER]);
    expect(button("Ink")).toBeNull();
    expect(button("Yellow").getAttribute("aria-pressed")).toBe("true");
  });

  it("offers what the arrow takes, as an image narrows it to nothing but opacity", () => {
    const { shown, kind } = both();
    expect(shown.common()).toEqual(expect.arrayContaining(["colour", "opacity"]));
    shown.set({ colour: "blue", opacity: 50 });
    expect(kind(ARROW)).toMatchObject({ colour: "blue", opacity: 50 });
    expect(kind(IMAGE)).toMatchObject({ opacity: 50 });
    expect(kind(IMAGE)).not.toHaveProperty("colour");
  });

  it("shows a mixed opacity, which a press sets on them all, but not a right-click", () => {
    const { board, shown, kind } = both();
    board.editor.update(IMAGE, JSON.stringify({ ...kind(IMAGE), opacity: 40 }));
    board.board = core.board(board.editor);
    shown.refresh();
    expect(document.querySelector(".style-card .slider.mixed .value")?.textContent).toBe("Mixed");
    press("pointerdown", { button: 2 });
    press("pointerup", { button: 2 });
    expect(kind(IMAGE)).toMatchObject({ opacity: 40 });
    press("pointerdown");
    press("pointerup");
    expect(kind(IMAGE)).not.toHaveProperty("opacity");
    expect(kind(ARROW)).not.toHaveProperty("opacity");
  });

  it("leaves the arrow tool's opacity alone while ⌥ is held", () => {
    both();
    press("pointerdown", { altKey: true });
    slide(40);
    press("pointerup");
    expect(drawn()).not.toHaveProperty("opacity");
    press("pointerdown");
    slide(25);
    press("pointerup");
    expect(drawn()).toMatchObject({ opacity: 25 });
  });

  it("builds again once the edit its opacity holds ends elsewhere, as the board goes", () => {
    const { select, drop } = both();
    press("pointerdown");
    slide(40);
    drop();
    select([IMAGE]);
    const rows = [...document.querySelectorAll('.style-card [role="group"]')].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(rows).toEqual(["Image", "Opacity", "Info"]);
  });

  it("copies the arrow's style", () => {
    const { shown, kind, select } = both();
    shown.copy();
    select([OTHER]);
    shown.paste();
    expect(kind(OTHER)).toMatchObject({ colour: "red" });
  });
});

function refused(): never {
  throw new Error("The pen's style is no edit");
}

/** The card with the `tip` in use and nothing selected, over a board with nothing on it. */
function inking(tip: Tip = "pen") {
  const board = untitled();
  const store = styles();
  const pen = () => store.dressed(core.strokeKind([ORIGIN], 0, tip), 1);
  card(
    {
      current: () => board,
      selection: () => [],
      tool: pen,
      box: () => undefined,
      client: ({ x, y }) => ({ clientX: x, clientY: y }),
      zoom: () => 1,
      busy: () => false,
      reading: () => undefined,
      floor: () => 800,
      apply: refused,
      adjust: refused,
      finishAdjusting() {},
      adjusting: () => false,
      pick() {},
      explain() {},
      say() {},
    },
    store,
    {
      colours: [],
      bold: command(),
      italic: command(),
      strike: command(),
      greyscale: command(),
      flipHorizontally: command(),
      flipVertically: command(),
      crop: command(),
      rectangularCrop: command(),
      ellipticalCrop: command(),
      openSource: command(),
      open: command(),
    },
  ).open(false);
  return { board, pen };
}

function button(name: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.style-card button[aria-label="${name}"]`)!;
}

describe("the card of the pen", () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("sets what the pen draws next, as no edit, and shows it at once", () => {
    const { board, pen } = inking();
    button("Orange").click();
    button("Thick stroke").click();
    slide(40, { release: true });
    expect(pen()).toMatchObject({ colour: "orange", weight: "thick", opacity: 40 });
    expect(button("Orange").getAttribute("aria-pressed")).toBe("true");
    expect(board.editor.canUndo()).toBe(false);
  });

  it("shows a highlighter's colours as it draws them, its ink yellow, which stays its own", () => {
    const { pen } = inking("highlighter");
    expect(button("Ink")).toBeNull();
    button("Yellow").click();
    expect(pen()).toMatchObject({ tip: "highlighter" });
    expect(pen()).not.toHaveProperty("colour");
    button("Red").click();
    expect(pen()).toMatchObject({ tip: "highlighter", colour: "red" });
  });
});
