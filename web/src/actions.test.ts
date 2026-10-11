// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { around } from "../test/actions.js";
import { press } from "../test/events.js";
import { commentKind, rectangleKind } from "../test/kinds.js";
import { deferred } from "../test/waits.js";
import { assetPlayback, imageKind } from "./board.js";
import type { Card } from "./card.js";
import { listen, named } from "./commands.js";
import * as core from "./core.js";
import type { Kind, Order, Tip } from "./core.js";
import type { Options } from "./render.js";

const IMAGE = "a".repeat(32);
const OTHER = "b".repeat(32);
const SHAPE = "c".repeat(32);
const COMMENT = "d".repeat(32);
const GROUP = "e".repeat(32);
const ASSET = "f".repeat(64);
const natural = { width: 320, height: 240 };

function image(
  x: number,
  {
    whole = false,
    rotation = 0,
    source = undefined as string | undefined,
    speed = undefined as number | undefined,
  } = {},
): Kind {
  const size = whole ? natural : { width: 160, height: 120 };
  const kind = imageKind(ASSET, natural, { x, y: 0, ...size }, { source });
  return kind.type === "image"
    ? { ...kind, rotation, ...(speed && { edits: { ...core.editsOf(kind), speed } }) }
    : kind;
}

const shape = rectangleKind(300);
const comment = commentKind();

function pen(): Tip {
  return "pen";
}

function styling(styled: Partial<Card>, selected = [COMMENT], penStyling?: () => Tip) {
  const elements: [string, Kind][] = [
    [IMAGE, image(0)],
    [COMMENT, comment],
  ];
  return around(elements, { selected, styled, ...(penStyling && { penStyling }) }).app.commands;
}

describe("what the commands offer", () => {
  beforeEach(() => localStorage.clear());
  const leaving: (() => void)[] = [];
  afterEach(() => leaving.splice(0).forEach((leave) => leave()));

  it("says that nothing is selected, for what acts on the selection", () => {
    const { commands } = around([[IMAGE, image(0)]]).app;
    for (const command of [commands.remove, commands.duplicate, commands.flipHorizontally]) {
      expect(command.unavailable?.()).toBe("Nothing is selected");
    }
    expect(commands.group.unavailable()).toBe("Select two elements or more");
  });

  it("waits for a board to show before tools draw or the selection grows", () => {
    const { commands } = around([[IMAGE, image(0)]], {
      viewport: { ...around().host.viewport, zoom: () => undefined },
    }).app;
    expect(commands.pen.unavailable()).toBe("No board is shown yet");
    expect(commands.selectAll.unavailable()).toBe("No board is shown yet");
  });

  it("selects all only on a board that holds something", () => {
    expect(around().app.commands.selectAll.unavailable()).toBe("The board is empty");
    expect(around([[IMAGE, image(0)]]).app.commands.selectAll.unavailable()).toBeUndefined();
  });

  it("exports what the selection draws, which hidden annotations do not", () => {
    expect(around([[SHAPE, shape]]).app.commands.exportPng.unavailable()).toBe(
      "Select what to export",
    );
    const shown = around([[SHAPE, shape]], { selected: [SHAPE] });
    expect(shown.app.commands.exportPng.unavailable()).toBeUndefined();
    const hidden = around([[SHAPE, shape]], { selected: [SHAPE], showsAnnotations: () => false });
    expect(hidden.app.commands.exportPng.unavailable()).toBe("The selection draws nothing");
    expect(hidden.app.commands.copyPng.unavailable()).toBe("The selection draws nothing");
  });

  it("saves as PNG only while the export card is open", () => {
    const closed = around([[SHAPE, shape]], { selected: [SHAPE] });
    expect(closed.app.commands.savePng.unavailable()).toBe("Open the export card first");
    const open = around([[SHAPE, shape]], {
      selected: [SHAPE],
      pictureCard: () => ({ ...closed.host.pictureCard(), isOpen: () => true }),
    });
    expect(open.app.commands.savePng.unavailable()).toBeUndefined();
  });

  it("arranges two images or more, as the shapes beside them do not count", () => {
    const one = around(
      [
        [IMAGE, image(0)],
        [SHAPE, shape],
      ],
      { selected: [IMAGE, SHAPE] },
    );
    expect(one.app.commands.arrangeByName.unavailable?.()).toBe("Select two images or more");
    expect(one.app.commands.sameHeight.unavailable()).toBe("Select two images or more");
    const two = around(
      [
        [IMAGE, image(0)],
        [OTHER, image(400)],
      ],
      { selected: [IMAGE, OTHER] },
    );
    expect(two.app.commands.arrangeByName.unavailable?.()).toBeUndefined();
  });

  it("leaves what is locked alone when it straightens the selection", () => {
    const turned = around([[IMAGE, image(0, { rotation: 30 })]], { selected: [IMAGE] });
    expect(turned.app.commands.straighten.unavailable()).toBeUndefined();
    turned.opened.editor.setLocked([IMAGE], true);
    expect(turned.app.commands.straighten.unavailable()).toBe("Nothing selected is turned");
    const upright = around([[IMAGE, image(0)]], { selected: [IMAGE] });
    expect(upright.app.commands.straighten.unavailable()).toBe("Nothing selected is turned");
  });

  it("tells an image already at its actual size", () => {
    const whole = around([[IMAGE, image(0, { whole: true })]], { selected: [IMAGE] });
    expect(whole.app.commands.actualSize.unavailable()).toBe("Already at actual size");
    const half = around([[IMAGE, image(0)]], { selected: [IMAGE] });
    expect(half.app.commands.actualSize.unavailable()).toBeUndefined();
    const notImage = around([[SHAPE, shape]], { selected: [SHAPE] });
    expect(notImage.app.commands.actualSize.unavailable()).toBe("Only images have an actual size");
  });

  it("crops, flips, and greys images only", () => {
    const { commands } = around([[SHAPE, shape]], { selected: [SHAPE] }).app;
    expect(commands.crop.unavailable()).toBe("Select one image");
    expect(commands.ellipticalCrop.unavailable()).toBe("Only images are cropped");
    expect(commands.flipVertically.unavailable?.()).toBe("Only images flip");
    expect(commands.greyscale.unavailable()).toBe("Only images turn grey");
    expect(commands.resetCrop.unavailable()).toBe("Nothing selected is cropped");
  });

  it("resets a crop under way, though nothing is cropped yet", () => {
    const board: [string, Kind][] = [[IMAGE, image(0)]];
    const idle = around(board, { selected: [IMAGE] });
    expect(idle.app.commands.resetCrop.unavailable()).toBe("Nothing selected is cropped");
    const cropping = around(board, { selected: [IMAGE], edits: { cropping: () => IMAGE } });
    expect(cropping.app.commands.resetCrop.unavailable()).toBeUndefined();
  });

  it("turns all but comments", () => {
    const { commands } = around([[COMMENT, comment]], { selected: [COMMENT] }).app;
    expect(commands.rotateLeft.unavailable?.()).toBe("Comments do not turn");
    const turning = around([[SHAPE, shape]], { selected: [SHAPE] }).app.commands;
    expect(turning.rotateRight.unavailable?.()).toBeUndefined();
  });

  it("plays, steps, and paces animated images and videos only", () => {
    const still = around([[IMAGE, image(0)]], { selected: [IMAGE] }).app.commands;
    expect(still.play.unavailable()).toBe("Only animated images and videos play");
    expect(still.nextFrame.unavailable?.()).toBe(
      "Only animated images and videos go frame by frame",
    );
    expect(still.faster.unavailable?.()).toBe("Only animated images and videos change speed");
    expect(still.sound.unavailable()).toBe("Only videos have sound");
    const media = {
      ...around().host.media,
      holds: () => true,
      steps: () => true,
      playing: () => true,
      play: vi.fn<(assets: string[], playing: boolean) => void>(),
    };
    const moving = around([[IMAGE, image(0)]], { selected: [IMAGE], media });
    const { commands } = moving.app;
    expect(commands.play.unavailable()).toBeUndefined();
    expect(named(commands.play)).toBe("Pause");
    commands.play.run();
    expect(media.play).toHaveBeenCalledWith([ASSET], false);
    expect(commands.slower.unavailable?.()).toBeUndefined();
  });

  it("goes frame by frame through a video whose frames are not read yet", () => {
    const step = vi.fn<(assets: string[], by: number) => void>();
    const media = { ...around().host.media, steps: () => true, step };
    const { commands } = around([[IMAGE, image(0)]], { selected: [IMAGE], media }).app;
    expect(commands.previousFrame.unavailable?.()).toBeUndefined();
    expect(commands.play.unavailable()).toBe("Only animated images and videos play");
    commands.previousFrame.run();
    expect(step).toHaveBeenCalledWith([ASSET], -1);
  });

  it("stops speeding up at the fastest speed, and slowing down at the slowest", () => {
    const media = { ...around().host.media, holds: () => true };
    const pacing = (speed: number) =>
      around([[IMAGE, image(0, { speed })]], { selected: [IMAGE], media }).app.commands;
    expect(pacing(2).faster.unavailable?.()).toBe("Already at the fastest");
    expect(pacing(2).slower.unavailable?.()).toBeUndefined();
    expect(pacing(0.25).slower.unavailable?.()).toBe("Already at the slowest");
    expect(pacing(0.25).faster.unavailable?.()).toBeUndefined();
  });

  it("paces an asset through its images that are not locked, which the locked ones follow", () => {
    const media = { ...around().host.media, holds: () => true };
    const alone = around([[IMAGE, image(0)]], { selected: [IMAGE], media });
    alone.opened.editor.setLocked([IMAGE], true);
    expect(alone.app.commands.faster.unavailable?.()).toBe(
      "Only animated images and videos change speed",
    );
    const shared = around(
      [
        [IMAGE, image(0)],
        [OTHER, image(400)],
      ],
      { selected: [IMAGE], media },
    );
    shared.opened.editor.setLocked([IMAGE], true);
    shared.editing.apply = (work) => {
      const touched: string[] = [];
      work(shared.opened.editor, touched);
      shared.opened.board = core.board(shared.opened.editor);
      return touched;
    };
    expect(shared.app.commands.faster.unavailable?.()).toBeUndefined();
    shared.app.commands.faster.run();
    expect(assetPlayback(shared.opened.board).get(ASSET)?.speed).toBe(1.25);
  });

  it("undoes and redoes as the board's history allows", () => {
    // Adding the image is the one edit made.
    const { app, opened } = around([[IMAGE, image(0)]]);
    expect(app.commands.undo.unavailable()).toBeUndefined();
    expect(app.commands.redo.unavailable()).toBe("Nothing to redo");
    opened.editor.undo();
    expect(app.commands.undo.unavailable()).toBe("Nothing to undo");
    expect(app.commands.redo.unavailable()).toBeUndefined();
  });

  it("unlocks what the pointer rests on while nothing is selected", () => {
    const { app } = around([[IMAGE, image(0)]], { edits: { lockedUnder: () => IMAGE } });
    expect(named(app.commands.lock)).toBe("Unlock");
    expect(app.commands.lock.unavailable()).toBeUndefined();
    expect(named(around().app.commands.lock)).toBe("Lock");
    expect(around().app.commands.lock.unavailable()).toBe("Nothing is selected");
  });

  it("titles a group selected alone, or renames it once titled", () => {
    const { app, opened } = around(
      [
        [IMAGE, image(0)],
        [OTHER, image(400)],
      ],
      { selected: [GROUP] },
    );
    opened.editor.group(GROUP, [IMAGE, OTHER]);
    opened.board = core.board(opened.editor);
    expect(named(app.commands.rename)).toBe("Add title");
    expect(app.commands.ungroup.unavailable()).toBeUndefined();
    expect(app.commands.goInside.unavailable()).toBeUndefined();
    const kind = opened.board.elements[GROUP]!.kind;
    opened.editor.update(GROUP, JSON.stringify({ ...kind, title: "Cats" }));
    opened.board = core.board(opened.editor);
    expect(named(app.commands.rename)).toBe("Rename");
    const lone = around([[IMAGE, image(0)]], { selected: [IMAGE] }).app.commands;
    expect(lone.rename.unavailable()).toBe("Select one group");
    expect(lone.ungroup.unavailable()).toBe("Only groups ungroup");
  });

  it("opens no other board while one opens", () => {
    const { commands } = around([], {
      life: { ...around().host.life, loading: () => true },
    }).app;
    expect(commands.open.unavailable()).toBe("A board is opening");
    expect(commands.newBoard.unavailable()).toBe("A board is opening");
    expect(commands.save.unavailable()).toBe("A board is opening");
  });

  it("offers no save, export, or background before a board is open", () => {
    const { commands } = around([], { opened: () => undefined }).app;
    const needing = [
      commands.save,
      commands.saveAs,
      commands.exportZip,
      commands.plain,
      commands.grid,
      commands.dots,
      commands.nextBackground,
    ];
    for (const command of needing) {
      expect(command.unavailable?.()).toBe("No board is open yet");
    }
  });

  it("exports one ZIP file at a time", () => {
    const exports = { ...around().host.exports, busy: () => true };
    expect(around([], { exports }).app.commands.exportZip.unavailable()).toBe(
      "An export is under way",
    );
    expect(around().app.commands.exportZip.unavailable()).toBeUndefined();
  });

  it("says why a browser cannot save into a folder, and saves a ZIP file there instead", () => {
    const exports = { ...around().host.exports, zip: vi.fn<() => Promise<void>>(async () => {}) };
    const life = { ...around().host.life, save: vi.fn<() => Promise<void>>(async () => {}) };
    const { app } = around([], {
      platform: { ...around().host.platform, cannotSave: "Not here" },
      exports,
      life,
    });
    expect(app.commands.saveAs.unavailable()).toBe("Not here");
    expect(named(app.commands.save)).toBe("Save…");
    app.commands.save.run();
    expect(exports.zip).toHaveBeenCalledOnce();
    expect(life.save).not.toHaveBeenCalled();
  });

  it("names what only the desktop app does", () => {
    const { commands } = around().app;
    expect(commands.compact.unavailable()).toBe("Only the desktop app has a window of its own");
    expect(commands.alwaysOnTop.unavailable()).toBe("Only the desktop app has a window of its own");
    expect(commands.agentAccess.unavailable()).toBe("Only the desktop app lets agents in");
    expect(commands.errorLog.unavailable()).toBe("Only the desktop app keeps one");
  });

  it("ticks the board's background, and switches snapping on with a grid", () => {
    const { app, host } = around();
    const { commands, stated } = app;
    expect(stated(commands.plain).checked).toBe(true);
    expect(stated(commands.grid).checked).toBe(false);
    expect(stated(commands.snap)).toMatchObject({ checked: false, toggle: true });
    commands.snap.run();
    expect(host.snapping()).toBe(true);
    expect(stated(commands.snap).checked).toBe(true);
    expect(stated(commands.undo)).toBe(commands.undo);
  });

  it("remembers that hints are hidden, which then say nothing", () => {
    const first = around();
    expect(first.app.hint()).toBe(
      "Drop or paste images · scroll to move around · right-click for more",
    );
    first.app.commands.hints.run();
    expect(first.app.hint()).toBe("");
    expect(around().app.hint()).toBe("");
  });

  it("hints at the tool in use, and at the selection", () => {
    const drawing = around([], { tool: () => "rectangle" });
    expect(drawing.app.hint()).toMatch(/^Drag to draw, or click to place · Esc to select again$/);
    const selected = around([[IMAGE, image(0)]], { selected: [IMAGE] });
    expect(selected.app.hint()).toBe(
      "Drag to move · double-click to zoom to it and back · right-click for more",
    );
  });

  it("lets Esc put down the tool in use before it lets go of the selection", () => {
    const { app, host, editing } = around([[IMAGE, image(0)]], {
      selected: [IMAGE],
      edits: { up: () => false, select: vi.fn<(ids: string[]) => void>() },
    });
    host.useTool("pen");
    app.commands.escape.run();
    expect(host.tool()).toBe("select");
    expect(editing.select).not.toHaveBeenCalled();
    app.commands.escape.run();
    expect(editing.select).toHaveBeenCalledWith([]);
  });

  it("saves the export on Enter while its card is open, before cropping the image selected", () => {
    const { host } = around();
    const pictureCard = { ...host.pictureCard(), isOpen: () => true };
    const exports = {
      ...host.exports,
      png: vi.fn<(options: Options) => Promise<void>>(async () => {}),
    };
    const crop = vi.fn<() => void>();
    const { app } = around([[IMAGE, image(0)]], {
      selected: [IMAGE],
      pictureCard: () => pictureCard,
      exports,
      edits: { crop },
    });
    leaving.push(listen(Object.values(app.commands), () => true));
    press({ key: "Enter" }, window);
    expect(exports.png).toHaveBeenCalledOnce();
    expect(crop).not.toHaveBeenCalled();
  });

  it("arranges nothing once another board shows meanwhile", async () => {
    const arrange = vi.fn<(order: Order) => void>();
    const { promise: idle, resolve: finish } = deferred();
    const { app, said, settled, leave } = around(
      [
        [IMAGE, image(0)],
        [OTHER, image(400)],
      ],
      { selected: [IMAGE, OTHER], edits: { arrange, idle: () => idle } },
    );
    app.commands.arrangeByName.run();
    expect(app.commands.arrangeByName.unavailable?.()).toBe("Images are being arranged");
    leave();
    finish();
    await settled();
    expect(arrange).not.toHaveBeenCalled();
    expect(said).toEqual(["Not arranged, as the selection changed"]);
    expect(app.commands.arrangeByName.unavailable?.()).toBeUndefined();
  });

  it("arranges the images selected once nothing changed meanwhile", async () => {
    const arrange = vi.fn<(order: Order) => void>();
    const { app, settled } = around(
      [
        [IMAGE, image(0)],
        [OTHER, image(400)],
      ],
      { selected: [IMAGE, OTHER], edits: { arrange } },
    );
    app.commands.arrangeByName.run();
    await settled();
    expect(arrange).toHaveBeenCalledWith({ by: "name" });
  });

  it("aligns two elements or more, and distributes three or more", () => {
    const board: [string, Kind][] = [
      [IMAGE, image(0)],
      [OTHER, image(400)],
      [SHAPE, shape],
    ];
    const offered = (count: number) =>
      around(board, { selected: [IMAGE, OTHER, SHAPE].slice(0, count) }).app.commands;
    expect(offered(1).alignLeft.unavailable?.()).toBe("Select two elements or more");
    expect(offered(2).alignLeft.unavailable?.()).toBeUndefined();
    expect(offered(2).distributeVertically.unavailable?.()).toBe("Select three elements or more");
    expect(offered(3).distributeVertically.unavailable?.()).toBeUndefined();
  });

  it("opens the source of one image, when it is a web address", () => {
    const two = around(
      [
        [IMAGE, image(0, { source: "https://example.org/cat" })],
        [OTHER, image(400, { source: "https://example.org/dog" })],
      ],
      { selected: [IMAGE, OTHER] },
    );
    for (const { app } of [around(), around([[SHAPE, shape]], { selected: [SHAPE] }), two]) {
      expect(app.commands.openSource.unavailable()).toBe("Select one image");
    }
    const web = around([[IMAGE, image(0, { source: "https://example.org/cat" })]], {
      selected: [IMAGE],
    });
    expect(web.app.commands.openSource.unavailable()).toBeUndefined();
    web.app.commands.openSource.run();
    expect(web.host.platform.openAddress).toHaveBeenCalledWith("https://example.org/cat");
  });

  it.each([undefined, "a book", "file:///etc/hosts"])(
    "opens no source that is no web address, such as %s",
    (source) => {
      const { app, host } = around([[IMAGE, image(0, { source })]], { selected: [IMAGE] });
      expect(app.commands.openSource.unavailable()).toBe("Its source is no web address");
      app.commands.openSource.run();
      expect(host.platform.openAddress).not.toHaveBeenCalled();
    },
  );

  it("sets a sticky note's paper, a highlighter's colour, or a colour with the number keys", () => {
    const named12: [Partial<Card>, string, string][] = [
      [{ common: () => ["paper"] }, "Yellow paper", "Pink paper"],
      [{ common: () => ["colour"] }, "Ink", "Red"],
      [{ common: () => ["colour"], highlighting: () => true }, "Yellow", "Red"],
    ];
    for (const [styled, first, second] of named12) {
      const commands = styling(styled);
      expect([named(commands.colour1), named(commands.colour2)]).toEqual([first, second]);
      expect(commands.colour2.unavailable?.()).toBeUndefined();
    }
    const set = vi.fn<Card["set"]>();
    styling({ common: () => ["paper"], set }).colour2.run();
    expect(set).toHaveBeenLastCalledWith({ paper: "pink" });
    styling({ common: () => ["colour"], set }).colour2.run();
    expect(set).toHaveBeenLastCalledWith({ colour: "red" });
    // As a comment, or text beside a comment, takes no colour.
    for (const styled of [{}, { common: () => ["size" as const] }]) {
      expect(styling(styled).colour3.unavailable?.()).toBe(
        "Not everything selected takes a colour",
      );
    }
  });

  it("colours what the pen draws next while nothing is selected", () => {
    const colour = { common: () => ["colour" as const] };
    expect(styling(colour, []).colour1.unavailable?.()).toBe("Nothing is selected");
    expect(styling(colour, [], () => "pen").colour1.unavailable?.()).toBeUndefined();
    expect(styling({}, [], () => "pen").colour1.unavailable?.()).toBe(
      "Not everything selected takes a colour",
    );
  });

  it("styles text only as what everything selected takes", () => {
    const offered = (common: ReturnType<Card["common"]>, selected?: string[]) => {
      const commands = styling({ common: () => common }, selected);
      const texts = ["bold", "italic", "strike", "larger", "smaller"] as const;
      return texts.filter((name) => commands[name].unavailable?.() === undefined);
    };
    expect(offered(["bold"])).toEqual(["bold"]);
    expect(offered(["size"])).toEqual(["larger", "smaller"]);
    expect(offered(["bold", "italic", "strike", "size"], [])).toEqual([]);
    expect(styling({}).italic.unavailable?.()).toBe("Not everything selected is text");
    expect(styling({}, []).larger.unavailable?.()).toBe("Nothing is selected");
  });

  it("turns bold on and off, and sizes text a step up or down", () => {
    const set = vi.fn<Card["set"]>();
    const resize = vi.fn<Card["resize"]>();
    let bold: boolean | undefined;
    const value = (() => bold) as Card["value"];
    const commands = styling({ common: () => ["bold", "size"], set, resize, value });
    commands.larger.run();
    expect(resize).toHaveBeenLastCalledWith(true);
    commands.smaller.run();
    expect(resize).toHaveBeenLastCalledWith(false);
    commands.bold.run();
    expect(set).toHaveBeenLastCalledWith({ bold: true });
    bold = true;
    commands.bold.run();
    expect(set).toHaveBeenLastCalledWith({ bold: false });
  });

  it("shows the style of what has one, which comments do not", () => {
    expect(styling({}, []).style.unavailable?.()).toBe("Nothing is selected");
    expect(styling({}).style.unavailable?.()).toBe("Comments have no style");
    expect(styling({ common: () => ["colour"] }).style.unavailable?.()).toBeUndefined();
    // An image takes only opacity, and has the card of its own.
    expect(styling({ images: () => true }, [IMAGE]).style.unavailable?.()).toBeUndefined();
    // While the pen is out, its style is what shows.
    expect(styling({}, [], pen).style.unavailable?.()).toBe("Comments have no style");
    expect(styling({ common: () => ["colour"] }, [], pen).style.unavailable?.()).toBeUndefined();
  });

  it("copies the style of what has one, and pastes one that was copied", () => {
    expect(styling({}, []).copyStyle.unavailable?.()).toBe("Nothing is selected");
    expect(styling({}).copyStyle.unavailable?.()).toBe("Comments have no style");
    expect(styling({ common: () => ["colour"] }).copyStyle.unavailable?.()).toBeUndefined();
    expect(styling({}, []).pasteStyle.unavailable?.()).toBe("Nothing is selected");
    expect(styling({}).pasteStyle.unavailable?.()).toBe("Copy a style first");
    expect(styling({ canPaste: () => true }).pasteStyle.unavailable?.()).toBeUndefined();
  });
});

function shell() {
  return vi.fn<(on: boolean) => Promise<void>>(async () => {});
}

function started(keepOnTop?: (on: boolean) => Promise<void>) {
  const keepOpen = vi.fn<Card["keepOpen"]>();
  const playOnHover = vi.fn<(on: boolean) => void>();
  const run = around([], {
    styled: { keepOpen },
    films: { ...around().host.films, playOnHover },
    platform: { ...around().host.platform, ...(keepOnTop && { keepOnTop }) },
  });
  return { ...run, keepOpen, playOnHover };
}

describe("what the app remembers of its window and its cards", () => {
  beforeEach(() => localStorage.clear());

  it("restores the style card kept open and videos played on hover, as the last run left them", () => {
    const first = started();
    first.app.restore();
    expect(first.keepOpen).toHaveBeenLastCalledWith(false);
    expect(first.playOnHover).toHaveBeenLastCalledWith(false);
    first.app.commands.keepStyle.run();
    first.app.commands.hoverPlay.run();
    const second = started();
    second.app.restore();
    expect(second.keepOpen).toHaveBeenLastCalledWith(true);
    expect(second.playOnHover).toHaveBeenLastCalledWith(true);
    second.app.commands.keepStyle.run();
    second.app.commands.hoverPlay.run();
    const third = started();
    third.app.restore();
    expect(third.keepOpen).toHaveBeenLastCalledWith(false);
    expect(third.playOnHover).toHaveBeenLastCalledWith(false);
  });

  it("keeps the window on top as the last run left it", async () => {
    const firstShell = shell();
    const first = started(firstShell);
    first.app.commands.alwaysOnTop.run();
    await first.settled();
    expect(firstShell).toHaveBeenCalledExactlyOnceWith(true);
    expect(first.app.stated(first.app.commands.alwaysOnTop).checked).toBe(true);
    const secondShell = shell();
    const second = started(secondShell);
    second.app.restore();
    await second.settled();
    expect(secondShell).toHaveBeenCalledExactlyOnceWith(true);
    expect(second.app.stated(second.app.commands.alwaysOnTop).checked).toBe(true);
    second.app.commands.alwaysOnTop.run();
    await second.settled();
    expect(secondShell).toHaveBeenCalledTimes(2);
    expect(secondShell).toHaveBeenLastCalledWith(false);
    const thirdShell = shell();
    const third = started(thirdShell);
    third.app.restore();
    await third.settled();
    expect(thirdShell).toHaveBeenCalledExactlyOnceWith(false);
    expect(third.app.stated(third.app.commands.alwaysOnTop).checked).toBe(false);
  });

  it("forgets that the window stays on top once the shell refuses to put it there", async () => {
    const first = started(shell());
    first.app.commands.alwaysOnTop.run();
    await first.settled();
    const refused = started(async () => {
      throw new Error("The window stays where it is");
    });
    refused.app.restore();
    await expect(refused.settled()).rejects.toThrow("The window stays where it is");
    expect(refused.app.stated(refused.app.commands.alwaysOnTop).checked).toBe(false);
    const nextShell = shell();
    const next = started(nextShell);
    next.app.restore();
    await next.settled();
    expect(nextShell).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("remembers the window on top when the shell refuses to let it go", async () => {
    const first = started(shell());
    first.app.commands.alwaysOnTop.run();
    await first.settled();
    const stuck = started(async (on) => {
      if (!on) {
        throw new Error("The window stays on top");
      }
    });
    stuck.app.restore();
    await stuck.settled();
    stuck.app.commands.alwaysOnTop.run();
    await expect(stuck.settled()).rejects.toThrow("The window stays on top");
    expect(stuck.app.stated(stuck.app.commands.alwaysOnTop).checked).toBe(true);
    const again = shell();
    const next = started(again);
    next.app.restore();
    await next.settled();
    expect(again).toHaveBeenCalledExactlyOnceWith(true);
  });
});
