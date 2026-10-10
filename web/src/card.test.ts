// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { startsOf, trimOf, type Playback } from "./playback.js";
import { imageKind, untitled } from "./board.js";
import { card, type CardCommands, type CardMedia } from "./card.js";
import type { Command } from "./commands.js";
import * as core from "./core.js";
import type { Kind, Tip } from "./core.js";
import { styles } from "./style.js";

const IMAGE = "a".repeat(32);
const ARROW = "d".repeat(32);
const OTHER = "e".repeat(32);
const GROUP = "f".repeat(32);
const ASSET = "b".repeat(64);
const frame = { x: 0, y: 0, width: 160, height: 120 };
const ORIGIN = { x: 0, y: 0 };
const command = (keys?: Command["keys"]): Command => ({
  label: "",
  keys,
  run: vi.fn<() => void>(),
});

function titled(name: string): string | null | undefined {
  return document.querySelector(`.style-card button[aria-label="${name}"]`)?.getAttribute("title");
}

function panel(): HTMLElement {
  return document.querySelector<HTMLElement>(".style-card")!;
}

function chip(): HTMLElement {
  return document.querySelector<HTMLElement>(".style-chip")!;
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

/** The card over a board holding one image, selected, which plays as `moving` says when given. */
function opened(moving?: Playback, showsAnnotations = () => true) {
  const board = untitled();
  const kind = imageKind(ASSET, { width: 320, height: 240 }, frame, { filename: "cat.png" });
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
    play: command([{ key: "p" }]),
    previousFrame: command([{ key: "," }]),
    nextFrame: command([{ key: "." }]),
    slower: command([{ key: "<" }]),
    faster: command([{ key: ">" }]),
    sound: command([{ key: "m" }]),
    open: command(),
  };
  const media = {
    playback: (asset: string) => (asset === ASSET ? moving : undefined),
    play: vi.fn<CardMedia["play"]>((_, playing) => {
      if (moving) {
        moving.playing = playing;
      }
    }),
    seek: vi.fn<CardMedia["seek"]>((_, at) => {
      if (moving) {
        moving.at = at;
      }
    }),
    preview: vi.fn<CardMedia["preview"]>(),
  };
  const trimmed = vi.fn<() => void>();
  const shown = card(
    {
      current: () => board,
      selection: () => selected,
      showsAnnotations,
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
      media,
      trimmed,
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
  return { board, shown, commands, media, trimmed, image, select, drop };
}

describe("the card of a lone image", () => {
  afterEach(() => {
    document.body.replaceChildren();
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
    expect(rows).toEqual(["Image", "Opacity"]);
  });
});

function gif(): Playback {
  return { at: 2, count: 24, playing: true, span: [0, 23], starts: startsOf(Array(24).fill(100)) };
}

function named(name: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.style-card button[aria-label="${name}"]`)!;
}

function groups(): (string | null)[] {
  return [...document.querySelectorAll('.style-card [role="group"]')].map((row) =>
    row.getAttribute("aria-label"),
  );
}

function typed(target: EventTarget, name: string) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  );
}

describe("the card of a lone animated image", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows the frame it plays as it goes, over how it plays", () => {
    const playback = gif();
    const { shown } = opened(playback);
    expect(groups()).toEqual(["Timeline", "Playback", "Image", "Opacity"]);
    expect(document.querySelector(".style-card .count")?.textContent).toBe("3 / 24");
    expect(named("Pause")).not.toBeNull();
    playback.at = 5;
    playback.playing = false;
    shown.frame();
    expect(document.querySelector(".style-card .count")?.textContent).toBe("6 / 24");
    expect(named("Play").title).toBe("Play · P");
  });

  it("goes to the frame its track is dragged to, paused meanwhile", () => {
    const playback = gif();
    const { media } = opened(playback);
    const track = document.querySelector<HTMLInputElement>(".style-card .scrub input")!;
    track.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    track.value = "10";
    track.dispatchEvent(new Event("input"));
    expect(media.seek).toHaveBeenLastCalledWith(ASSET, 10);
    expect(media.play).toHaveBeenLastCalledWith([ASSET], false);
    track.dispatchEvent(new PointerEvent("pointerup"));
    expect(media.play).toHaveBeenLastCalledWith([ASSET], true);
  });

  it("goes to the frames of the one selected after another just as long", () => {
    const playback = gif();
    const { board, media, select } = opened(playback);
    const other = "c".repeat(64);
    board.editor.add(
      OTHER,
      undefined,
      JSON.stringify(imageKind(other, { width: 320, height: 240 }, frame)),
    );
    board.board = core.board(board.editor);
    media.playback = (asset) => (asset === ASSET || asset === other ? playback : undefined);
    select([OTHER]);
    const track = document.querySelector<HTMLInputElement>(".style-card .scrub input")!;
    track.value = "10";
    track.dispatchEvent(new Event("input"));
    expect(media.seek).toHaveBeenLastCalledWith(other, 10);
  });

  it("steps and plays as its keys do, and plays at the normal speed again", () => {
    const { board, commands, image, select } = opened(gif());
    named("Previous frame").click();
    named("Pause").click();
    expect(commands.previousFrame.run).toHaveBeenCalledOnce();
    expect(commands.play.run).toHaveBeenCalledOnce();
    board.editor.setSpeed([IMAGE], 1.5);
    board.board = core.board(board.editor);
    select([IMAGE]);
    expect(named("Normal speed").textContent).toBe("1.5×");
    named("Normal speed").click();
    expect(image()?.edits?.speed).toBeUndefined();
  });

  it("dims a speed it cannot go to", () => {
    const { commands, select } = opened(gif());
    commands.slower.unavailable = () => "Already at the slowest";
    select([IMAGE]);
    expect(named("Slower").getAttribute("aria-disabled")).toBe("true");
    expect(named("Faster").hasAttribute("aria-disabled")).toBe(false);
  });

  it("trims to what plays between its ends once done, as its frames start", () => {
    const playback = gif();
    const { media, image } = opened(playback);
    named("Trim").click();
    expect(groups()).toEqual(["Timeline", "Trim", "Image", "Opacity"]);
    expect(media.play).toHaveBeenLastCalledWith([ASSET], false);
    typed(named("Trim start"), "ArrowRight");
    typed(named("Trim start"), "ArrowRight");
    typed(named("Trim end"), "ArrowLeft");
    expect(media.preview).toHaveBeenLastCalledWith(ASSET, [2, 22]);
    expect(media.seek).toHaveBeenLastCalledWith(ASSET, 22);
    expect(document.querySelector(".style-card .note")?.textContent).toBe("Loops 3–23 of 24");
    typed(document.body, "Enter");
    expect(image()?.edits?.trim).toEqual(trimOf(playback.starts, [2, 22]));
    expect(media.preview).toHaveBeenLastCalledWith(ASSET, undefined);
    expect(media.play).toHaveBeenLastCalledWith([ASSET], true);
    expect(groups()).toEqual(["Timeline", "Playback", "Image", "Opacity"]);
  });

  it("shows the frame it showed again once an end is let go, or the nearest one kept", () => {
    const playback = gif();
    const { media, image } = opened(playback);
    named("Trim").click();
    const drag = (name: string, to: number) => {
      const end = named(name);
      end.setPointerCapture = () => {};
      end.hasPointerCapture = () => true;
      // A frame every 10 pixels, from the thumb's centre.
      end.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, 23 * 10 + 14, 14);
      end.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1 }));
      end.dispatchEvent(new PointerEvent("pointermove", { clientX: 7 + to * 10, pointerId: 1 }));
      expect(media.seek).toHaveBeenLastCalledWith(ASSET, to);
      end.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 }));
      end.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    };
    drag("Trim end", 10);
    expect(media.seek).toHaveBeenLastCalledWith(ASSET, 2);
    drag("Trim start", 5);
    expect(media.seek).toHaveBeenLastCalledWith(ASSET, 5);
    expect(media.preview).toHaveBeenLastCalledWith(ASSET, [5, 10]);
    const sought = media.seek.mock.calls.length;
    typed(document.body, "Enter");
    expect(image()?.edits?.trim).toEqual(trimOf(playback.starts, [5, 10]));
    expect(media.seek).toHaveBeenCalledTimes(sought);
    expect(media.play).toHaveBeenLastCalledWith([ASSET], true);
  });

  it("tells once it starts trimming, and once it stops, which the hint follows", () => {
    const { trimmed } = opened(gif());
    named("Trim").click();
    expect(trimmed).toHaveBeenCalledOnce();
    typed(document.body, "Escape");
    expect(trimmed).toHaveBeenCalledTimes(2);
  });

  it("leaves ↩ to a button the keys press while trimming", () => {
    const { image } = opened(gif());
    named("Trim").click();
    typed(named("Trim start"), "ArrowRight");
    const reset = named("Play every frame");
    reset.focus();
    typed(reset, "Enter");
    expect(image()?.edits?.trim).toBeUndefined();
    expect(groups()).toContain("Trim");
    // Out of trim, as the window keeps listening to each card's keys.
    reset.blur();
    typed(document.body, "Escape");
  });

  it("leaves the trim as it was on Esc, or once another element is selected", () => {
    const { shown, image, select } = opened(gif());
    named("Trim").click();
    typed(named("Trim start"), "ArrowRight");
    typed(document.body, "Escape");
    expect(image()?.edits?.trim).toBeUndefined();
    expect(groups()).toEqual(["Timeline", "Playback", "Image", "Opacity"]);
    named("Trim").click();
    typed(named("Trim start"), "ArrowRight");
    select([]);
    select([IMAGE]);
    shown.open(false);
    expect(image()?.edits?.trim).toBeUndefined();
    expect(groups()).toEqual(["Timeline", "Playback", "Image", "Opacity"]);
  });

  it("shows no frames for a still image", () => {
    opened();
    expect(groups()).toEqual(["Image", "Opacity"]);
  });
});

describe("the card of a lone video", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("tells the time it shows, with its frame, and loops its trim by time", () => {
    opened({ ...gif(), sound: false });
    expect(document.querySelector(".style-card .count")?.textContent).toBe("0:00.20");
    expect(slider().getAttribute("aria-valuetext")).toBe("0:00.20, frame 3 of 24");
    named("Trim").click();
    typed(named("Trim end"), "ArrowLeft");
    expect(document.querySelector(".style-card .note")?.textContent).toBe("Loops 0:00.00–0:02.30");
    // Out of trim, as the window keeps listening to each card's keys.
    typed(document.body, "Escape");
  });

  it("turns its sound on and off as its key does, by its frames", () => {
    const playback: Playback = { ...gif(), sound: false };
    const { shown, commands } = opened(playback);
    expect(groups()).toEqual(["Timeline", "Playback", "Image", "Opacity"]);
    expect(named("Trim")).not.toBeNull();
    named("Turn sound on").click();
    expect(commands.sound.run).toHaveBeenCalledOnce();
    playback.sound = true;
    shown.frame();
    expect(named("Turn sound off").title).toBe("Turn sound off · M");
  });

  it("only plays, at its speed, while its frames are not known", () => {
    opened({ at: 0, count: 0, playing: true, span: [0, 0], starts: [], sound: false });
    expect(groups()).toEqual(["Playback", "Image", "Opacity"]);
    for (const absent of ["Previous frame", "Next frame", "Trim"]) {
      expect(document.querySelector(`.style-card [aria-label="${absent}"]`)).toBeNull();
    }
    expect(named("Pause")).not.toBeNull();
    expect(named("Normal speed")).not.toBeNull();
    expect(named("Turn sound on")).not.toBeNull();
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

  it("leaves alone the annotations hidden in a group selected with an image", () => {
    const { board, select, shown } = opened(undefined, () => false);
    const arrow = { type: "arrow", from: ORIGIN, to: { x: 100, y: 0 }, colour: "red" };
    board.editor.add(ARROW, undefined, JSON.stringify(arrow));
    const other = imageKind(ASSET, { width: 320, height: 240 }, { ...frame, x: 400 });
    board.editor.add(OTHER, undefined, JSON.stringify(other));
    board.editor.group(GROUP, [IMAGE, ARROW]);
    board.board = core.board(board.editor);
    select([GROUP, OTHER]);
    expect(shown.common()).toEqual(["opacity"]);
    shown.set({ colour: "blue" });
    expect(core.element(board.editor, ARROW)?.kind).toMatchObject({ colour: "red" });
  });

  it("styles the elements of a group selected with others but those locked", () => {
    const { board, select, shown, kind } = both();
    board.editor.group(GROUP, [IMAGE, ARROW]);
    board.editor.setLocked([ARROW], true);
    board.board = core.board(board.editor);
    select([GROUP, OTHER]);
    shown.set({ opacity: 50 });
    expect(kind(IMAGE)).toMatchObject({ opacity: 50 });
    expect(kind(OTHER)).toMatchObject({ opacity: 50 });
    expect(kind(ARROW)).not.toHaveProperty("opacity");
  });

  it("fades the elements of a group selected alone but those locked", () => {
    const { board, select, kind } = both();
    board.editor.group(GROUP, [IMAGE, ARROW]);
    board.editor.setLocked([ARROW], true);
    board.board = core.board(board.editor);
    select([GROUP]);
    slide(50, { release: true });
    expect(kind(IMAGE)).toMatchObject({ opacity: 50 });
    expect(kind(ARROW)).not.toHaveProperty("opacity");
    expect(kind(GROUP)).not.toHaveProperty("opacity");
  });

  it("styles a group selected alone by its background and its elements' opacity", () => {
    const { board, select, shown, kind } = both();
    board.editor.group(GROUP, [IMAGE, ARROW]);
    board.board = core.board(board.editor);
    select([GROUP]);
    expect(groups()).toEqual(["Background", "Fill", "Opacity"]);
    expect(shown.common()).toEqual(["colour", "fill"]);
    expect(named("Pick a colour from the board")).not.toBeNull();
    // Its colour shows only on a panel, which it lacks.
    expect(named("Ink background").getAttribute("aria-pressed")).toBe("false");
    expect(named("No background").getAttribute("aria-pressed")).toBe("true");
    named("Blue background").click();
    expect(kind(GROUP)).toMatchObject({ colour: "blue", fill: "tint" });
    // As the keys and the pipette set it.
    shown.set({ colour: "green" });
    expect(kind(GROUP)).toMatchObject({ colour: "green", fill: "tint" });
    expect(kind(ARROW)).toMatchObject({ colour: "red" });
    named("No background").click();
    expect(kind(GROUP)).not.toHaveProperty("colour");
    expect(kind(GROUP)).not.toHaveProperty("fill");
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
    expect(rows).toEqual(["Image", "Opacity"]);
  });

  it("copies the arrow's style", () => {
    const { shown, kind, select } = both();
    shown.copy();
    select([OTHER]);
    shown.paste();
    expect(kind(OTHER)).toMatchObject({ colour: "red" });
  });
});

/** Blank, in the frame of the image the card starts over. */
function counting(form: "star" | "polygon"): Kind {
  return { type: "shape", frame, rotation: 0, shape: form, text: { content: "", font_size: 20 } };
}

function tally() {
  return document.querySelector(".style-card .tally")?.textContent;
}

/** The card over a star and a polygon of `corners`, the star selected. */
function counted(corners: number) {
  const made = opened();
  made.board.editor.add(ARROW, undefined, JSON.stringify(counting("star")));
  made.board.editor.add(OTHER, undefined, JSON.stringify({ ...counting("polygon"), corners }));
  made.board.board = core.board(made.board.editor);
  made.select([ARROW]);
  const kind = (id: string) => core.element(made.board.editor, id)?.kind;
  return { ...made, kind };
}

describe("the card of a star and a polygon", () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("counts a star's points up and down, which its tool draws next", () => {
    const { kind } = counted(7);
    expect(tally()).toBe("5 points");
    button("More points").click();
    button("More points").click();
    expect(kind(ARROW)).toMatchObject({ corners: 7 });
    expect(tally()).toBe("7 points");
    expect(styles().dressed(counting("star"), 1)).toMatchObject({ corners: 7 });
    // As it comes again, it writes nothing.
    button("Fewer points").click();
    button("Fewer points").click();
    expect(kind(ARROW)).not.toHaveProperty("corners");
  });

  it("counts each up from its own, and none past the most", () => {
    const { kind, select } = counted(12);
    select([IMAGE, ARROW, OTHER]);
    expect(tally()).toBe("Mixed");
    expect(button("More corners").getAttribute("aria-disabled")).toBeNull();
    button("More corners").click();
    expect(kind(ARROW)).toMatchObject({ corners: 6 });
    expect(kind(OTHER)).toMatchObject({ corners: 12 });
    select([OTHER]);
    expect(tally()).toBe("12 sides");
    expect(button("More sides").getAttribute("aria-disabled")).toBe("true");
  });

  it("leaves what the star tool draws alone while ⌥ is held", () => {
    const { kind } = counted(5);
    button("More points").dispatchEvent(new MouseEvent("click", { altKey: true }));
    expect(kind(ARROW)).toMatchObject({ corners: 6 });
    expect(styles().dressed(counting("star"), 1)).not.toHaveProperty("corners");
  });

  it("offers no count for a triangle", () => {
    const { board, select } = opened();
    const triangle = { type: "shape", frame, rotation: 0, shape: "triangle" };
    board.editor.add(
      ARROW,
      undefined,
      JSON.stringify({ ...triangle, text: { content: "", font_size: 20 } }),
    );
    board.board = core.board(board.editor);
    select([ARROW]);
    expect(document.querySelector('.style-card [aria-label="Corners"]')).toBeNull();
    expect(button("Solid fill")).not.toBeNull();
  });
});

describe("the card as the selection goes", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("closes once nothing is selected", () => {
    const { shown, select } = opened();
    select([]);
    select([IMAGE]);
    expect(shown.isOpen()).toBe(false);
    expect(chip().hidden).toBe(false);
  });

  it("shows again once something is selected when kept open, without taking the focus", () => {
    const { shown, select } = opened();
    shown.keepOpen(true);
    select([]);
    expect(panel().hidden).toBe(true);
    select([IMAGE]);
    expect(shown.isOpen()).toBe(true);
    expect(chip().hidden).toBe(true);
    expect(panel().contains(document.activeElement)).toBe(false);
  });

  it("stays closed when kept open but closed", () => {
    const { shown, select } = opened();
    shown.keepOpen(true);
    shown.close();
    select([]);
    select([IMAGE]);
    expect(shown.isOpen()).toBe(false);
  });

  it("opens as it is kept open, and stays so until nothing is selected once no longer", () => {
    const { shown, select } = opened();
    shown.close();
    shown.keepOpen(true);
    expect(shown.isOpen()).toBe(true);
    shown.keepOpen(false);
    expect(shown.isOpen()).toBe(true);
    select([]);
    select([IMAGE]);
    expect(shown.isOpen()).toBe(false);
  });

  it("closes once no longer kept open while nothing is selected", () => {
    const { shown, select } = opened();
    shown.keepOpen(true);
    select([]);
    shown.keepOpen(false);
    select([IMAGE]);
    expect(shown.isOpen()).toBe(false);
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
      showsAnnotations: () => true,
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
      media: { playback: () => undefined, play() {}, seek() {}, preview() {} },
      trimmed() {},
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
      play: command(),
      previousFrame: command(),
      nextFrame: command(),
      slower: command(),
      faster: command(),
      sound: command(),
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
