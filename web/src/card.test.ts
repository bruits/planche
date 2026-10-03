// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageKind, untitled } from "./board.js";
import { card, type CardCommands } from "./card.js";
import type { Command } from "./commands.js";
import * as core from "./core.js";
import { styles } from "./style.js";

const IMAGE = "a".repeat(32);
const ASSET = "b".repeat(64);
const frame = { x: 0, y: 0, width: 160, height: 120 };
const command = (): Command => ({ label: "", run: vi.fn<() => void>() });

function field(name: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`.style-card input[aria-label="${name}"]`)!;
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
  const commands: CardCommands = {
    colours: [],
    bold: command(),
    italic: command(),
    strike: command(),
    flipHorizontally: command(),
    flipVertically: command(),
    crop: command(),
    rectangularCrop: command(),
    ellipticalCrop: command(),
    openSource: command(),
    open: command(),
  };
  const shown = card(
    {
      current: () => board,
      selection: () => selected,
      box: () => [
        { x: 0, y: 0 },
        { x: 160, y: 0 },
        { x: 160, y: 120 },
        { x: 0, y: 120 },
      ],
      client: ({ x, y }) => ({ clientX: x, clientY: y }),
      zoom: () => 1,
      busy: () => false,
      reading: () => undefined,
      floor: () => 800,
      apply(work) {
        const touched: string[] = [];
        board.editor.beginGesture();
        work(board.editor, touched);
        board.editor.endGesture();
        board.board = core.board(board.editor);
        // As the app does once an edit is made.
        shown.refresh();
      },
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
  return { board, shown, commands, image, select };
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
