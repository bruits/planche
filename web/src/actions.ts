// What the app can do: each command, with its keys and why it cannot run when it cannot, which the
// toolbar, the menus, the finder, and the keys share, and the hint the toolbar gives for what is
// under way.

import type { Access } from "./agent.js";
import {
  assetPlayback,
  assetsOf,
  extent,
  loneImage,
  newId,
  shownOrder,
  webAddress,
  type Hold,
  type Opened,
} from "./board.js";
import { fit } from "./camera.js";
import type { Card } from "./card.js";
import type { Clipboard } from "./clipboard.js";
import { meanColours } from "./colour.js";
import { describe, mac, type Command, type Shortcut } from "./commands.js";
import * as core from "./core.js";
import type {
  Alignment,
  Axis,
  Background,
  CropShape,
  Kind,
  Order,
  Point,
  Restack,
  Tip,
} from "./core.js";
import { drawTool, isTip, type Draw, type Edits, type Tool } from "./edit.js";
import type { ExportCard } from "./exportcard.js";
import type { Exporting } from "./exporting.js";
import { openFinder, type Listed } from "./finder.js";
import type { Lifecycle } from "./lifecycle.js";
import type { Item } from "./menu.js";
import type { Measurements } from "./metrics.js";
import { sped, type Media } from "./playback.js";
import type { ErrorLog, Platform } from "./platform.js";
import { recall, remember } from "./preferences.js";
import { drawnOver } from "./render.js";
import type { Sampler } from "./sampler.js";
import { PALETTE, PAPERS, highlight } from "./style.js";
import type { Scheme, Theme } from "./theme.js";
import type { Titles } from "./titles.js";
import type { Updating } from "./updates.js";
import type { Videos } from "./video.js";
import type { View } from "./view.js";
import type { Welcome } from "./welcome.js";

/** Where the browser remembers that hints are hidden. */
const HINTS = "planche.hints";
/** Where the browser remembers that the window stays on top. */
const ON_TOP = "planche.ontop";
/** Where the browser remembers that videos play only while the pointer is on them. */
const HOVER_PLAY = "planche.hoverplay";
/** Where the browser remembers that the style card stays open. */
const KEEP_STYLE = "planche.keepstyle";
/** Where the browser remembers that nothing lines up with its neighbours. */
const NEIGHBOURS = "planche.neighbours";
const ZOOM_STEP = 1.25;
/** Each side for the other, as a mirrored board shows them. */
const MIRRORED_SIDES: Partial<Record<Alignment, Alignment>> = { left: "right", right: "left" };
/** In the order the key goes through them. */
export const BACKGROUNDS: Background[] = ["plain", "grid", "dots"];
export const SCHEMES: Scheme[] = ["light", "dark", "system"];
/** The tools a drag draws with, or a click places. */
const FRAMED: ReadonlySet<string> = new Set([
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "star",
  "polygon",
  "cross",
  "sticky",
] satisfies Draw[]);

export interface Host {
  platform: Pick<
    Platform,
    | "titleBar"
    | "keepOnTop"
    | "agent"
    | "errorLog"
    | "updater"
    | "cannotSave"
    | "desktopApp"
    | "openAddress"
  >;
  opened(): Opened | undefined;
  hold(): Hold | undefined;
  crossedOut(): ReadonlySet<string>;
  editing: Edits;
  viewport: Pick<
    View,
    "zoom" | "zoomBy" | "look" | "size" | "centre" | "mirrored" | "mirror" | "greyed" | "grey"
  >;
  life: Pick<
    Lifecycle,
    "loading" | "newBoard" | "openFolder" | "openZip" | "save" | "saveAs" | "savesToFiles"
  >;
  media: Pick<Media<never>, "holds" | "playing" | "steps" | "play" | "step">;
  films: Pick<Videos, "holds" | "sounding" | "sound" | "playOnHover">;
  appearance: Theme;
  groupTitles: Pick<Titles, "write">;
  measurements: Pick<Measurements, "shown" | "toggle">;
  agents: Pick<Access, "allowed" | "allow">;
  updates: Pick<Updating, "allowed" | "allow">;
  exports: Pick<Exporting, "busy" | "zip" | "png" | "copyPng">;
  greeting: Pick<Welcome, "quietsHint">;
  // The cards, the picker, and the clipboard come once the commands they offer are made.
  styleCard(): Pick<
    Card,
    | "canPaste"
    | "close"
    | "common"
    | "copy"
    | "highlighting"
    | "images"
    | "isOpen"
    | "keepOpen"
    | "open"
    | "paste"
    | "resize"
    | "set"
    | "trimming"
    | "value"
  >;
  pictureCard(): Pick<ExportCard, "isOpen" | "open" | "close" | "options">;
  picker(): Pick<Sampler, "sampling" | "end">;
  clip(): Pick<Clipboard, "copy" | "paste">;
  tool(): Tool;
  useTool(next: Tool): void;
  spaceHeld(): boolean;
  /** The tip whose style the card sets, with nothing selected. */
  penStyling(): Tip | undefined;
  showsAnnotations(): boolean;
  showAnnotations(shown: boolean): void;
  /** Whether what moves snaps to the grid, which a board's background starts. */
  snapping(): boolean;
  snap(on: boolean): void;
  /** Zooms to fit `ids`, when any of them shows. */
  fitTo(ids: string[]): void;
  /** Opens the picker of images to add around `at`. */
  addPicked(at: Point | undefined): void;
  duplicate(): void;
  /** Over the selection's centre, or the viewport's, as the keys point nowhere. */
  contextMenuFromKeys(): void;
  listed(): Listed[];
  openBugReport(): Promise<void>;
  refreshBar(): void;
  /** `busy` while what it tells of goes on. */
  say(text: string, busy?: boolean): void;
  report(work: Promise<unknown>): void;
}

type Ordering = (opened: Opened, ids: string[]) => Order | Promise<Order>;

export type Actions = ReturnType<typeof actions>;

export function actions(host: Host) {
  const {
    platform,
    editing,
    viewport,
    life,
    media,
    films,
    appearance,
    measurements,
    agents,
    updates,
    exports,
    report,
    say,
  } = host;
  let hintsShown = recall(HINTS) !== "hidden";
  let hoverPlay = recall(HOVER_PLAY) === "on";
  let styleKept = recall(KEEP_STYLE) === "on";
  let aligning = recall(NEIGHBOURS) !== "off";
  let onTop = false;
  /** Left out of the preferences, as a window without its title bar would open at full size. */
  let compact = false;
  let arranging = false;

  const loadingBoard = () => (life.loading() ? "A board is opening" : undefined);
  const noBoard = () => (host.opened() === undefined ? "No board is open yet" : undefined);
  const noneSelected = () => (editing.selection().length === 0 ? "Nothing is selected" : undefined);
  /** With nothing selected, the pen's style is what styling sets. */
  const nothingToStyle = () => (host.penStyling() ? undefined : noneSelected());
  const unexportable = () => {
    const ids = editing.selection();
    if (ids.length === 0) {
      return "Select what to export";
    }
    const opened = host.opened();
    return opened &&
      drawnOver(opened, ids, host.crossedOut(), host.showsAnnotations()) === undefined
      ? "The selection draws nothing"
      : undefined;
  };
  // Images within a selected group do not count, as arranging leaves groups where they are.
  const fewImages = () =>
    editing.selection().filter((id) => host.opened()?.board.elements[id]?.kind.type === "image")
      .length < 2
      ? "Select two images or more"
      : undefined;
  /**
   * What is selected, with what the groups selected hold, but for what is locked, whose looks edits
   * leave alone.
   */
  const selectedKinds = (): Kind[] => {
    const opened = host.opened();
    if (!opened) {
      return [];
    }
    const { board, editor } = opened;
    return editor.withDescendants(editing.selection()).flatMap((id) => {
      const kind = board.elements[id]?.kind;
      return kind && editor.lockedBy(id) === undefined ? [kind] : [];
    });
  };
  const selectedImages = () => selectedKinds().filter((kind) => kind.type === "image");
  /** What the lock command unlocks, as nothing is selected. */
  const unlocking = () => (editing.selection().length === 0 ? editing.lockedUnder() : undefined);
  const selectedImage = () => loneImage(host.opened()?.board, editing.selection())?.image;
  const loneGroup = () => {
    const [id, ...more] = editing.selection();
    const kind =
      id === undefined || more.length > 0 ? undefined : host.opened()?.board.elements[id]?.kind;
    return kind?.type === "group" ? kind : undefined;
  };
  const selectsGroup = () =>
    editing.selection().some((id) => host.opened()?.board.elements[id]?.kind.type === "group");
  const greyed = () => {
    const images = selectedImages();
    return images.length > 0 && images.every((kind) => core.editsOf(kind).greyscale);
  };
  const shapedAs = (shape: CropShape) => {
    const images = selectedImages();
    return (
      images.length > 0 &&
      images.every((kind) => (core.editsOf(kind).crop_shape ?? "rectangle") === shape)
    );
  };
  /** Whether the crop under way, or else every image selected, is an ellipse. */
  const elliptical = () => {
    const cropping = editing.croppedAs();
    return cropping === undefined ? shapedAs("ellipse") : cropping === "ellipse";
  };
  const croppable = () =>
    noneSelected() ?? (selectedImages().length > 0 ? undefined : "Only images are cropped");
  const noneShown = () => (viewport.zoom() === undefined ? "No board is shown yet" : undefined);
  // Not before the board shows, which would select what nobody sees yet.
  const nothingToSelect = () =>
    noneShown() ?? (host.opened()?.board.draw_order.length ? undefined : "The board is empty");
  const selectedAssets = () => {
    const opened = host.opened();
    return opened ? assetsOf(opened, editing.selection()) : [];
  };
  const selectedMoving = () => selectedAssets().filter(media.holds);
  const selectedStepping = () => selectedAssets().filter(media.steps);
  /**
   * The animated images and videos of the selection's assets, wherever they show, that the speed
   * commands set, as a still selected with them takes no speed, and those locked take it from the
   * others of their asset.
   */
  const paced = (): string[] => {
    const opened = host.opened();
    if (!opened) {
      return [];
    }
    const { board, editor } = opened;
    const assets = new Set(selectedMoving());
    return Object.entries(board.elements).flatMap(([id, { kind }]) =>
      kind.type === "image" && assets.has(kind.asset) && editor.lockedBy(id) === undefined
        ? [id]
        : [],
    );
  };
  /** Of an asset the speed commands set, which leave out those whose images are all locked. */
  const speedOf = (): number => {
    const board = host.opened()?.board;
    const [id] = paced();
    const kind = id === undefined ? undefined : board?.elements[id]?.kind;
    return (
      (kind?.type === "image" ? board && assetPlayback(board).get(kind.asset)?.speed : undefined) ??
      1
    );
  };

  const frameStep = (label: string, by: number, keys: Shortcut[]): Command => ({
    label,
    keys,
    unavailable: () =>
      noneSelected() ??
      (selectedStepping().length > 0
        ? undefined
        : "Only animated images and videos go frame by frame"),
    run: () => {
      media.step(selectedStepping(), by);
      host.refreshBar();
    },
  });
  const pace = (label: string, faster: boolean, keys: Shortcut[]): Command => ({
    label,
    keys,
    unavailable: () =>
      noneSelected() ??
      (paced().length > 0 ? undefined : "Only animated images and videos change speed") ??
      (sped(speedOf(), faster) === undefined
        ? `Already at the ${faster ? "fastest" : "slowest"}`
        : undefined),
    run: () => {
      const speed = sped(speedOf(), faster);
      const ids = paced();
      if (speed === undefined || ids.length === 0) {
        return;
      }
      editing.apply((editor, touched) => touched.push(...editor.setSpeed(ids, speed)));
    },
  });
  const restack = (label: string, to: Restack, shortcut: Shortcut): Command => ({
    label,
    keys: [shortcut],
    unavailable: noneSelected,
    run: () => editing.restack(to),
  });
  const flip = (label: string, key: string, horizontally: boolean): Command => ({
    label,
    keys: [{ key, shift: true }],
    unavailable: () =>
      noneSelected() ?? (selectedImages().length > 0 ? undefined : "Only images flip"),
    run: () => editing.flip(horizontally),
    once: true,
  });
  const turn = (label: string, degrees: number, key: string): Command => ({
    label,
    keys: [{ key, shift: true }],
    unavailable: () => {
      const opened = host.opened();
      return (
        noneSelected() ??
        (opened && core.bounds(opened.editor, editing.selection())
          ? undefined
          : "Comments do not turn")
      );
    },
    // As the board shows.
    run: () => editing.rotate(viewport.mirrored() ? -degrees : degrees),
  });
  const arrangement = (label: string, order: Ordering): Command => ({
    label,
    unavailable: () => (arranging ? "Images are being arranged" : fewImages()),
    run: () => report(arrange(label, order)),
  });
  const alignment = (label: string, to: Alignment, key: string): Command => ({
    label,
    keys: [{ key, alt: true }],
    unavailable: () => (editing.selection().length < 2 ? "Select two elements or more" : undefined),
    run: () => editing.align(viewport.mirrored() ? (MIRRORED_SIDES[to] ?? to) : to),
  });
  const distribution = (label: string, axis: Axis, key: string): Command => ({
    label,
    keys: [{ key, alt: true, shift: true }],
    unavailable: () =>
      editing.selection().length < 3 ? "Select three elements or more" : undefined,
    run: () => editing.distribute(axis),
  });
  const backdrop = (label: string, background: Background): Command => ({
    label,
    unavailable: noBoard,
    run: () => useBackground(background),
  });
  const zoomTo = (label: string, zoom: number, keys?: Shortcut[]): Command => ({
    label,
    keys,
    unavailable: noneShown,
    run: () => viewport.zoomBy(zoom / viewport.zoom()!),
  });
  const palette = (label: string, to: Scheme): Command => ({
    label,
    run: () => appearance.choose(to),
  });
  /** The palette's colour, or a sticky note's paper, at `at`. */
  const colourCommand = (at: number): Command => ({
    label: () =>
      (host.styleCard().common().includes("paper") ? PAPERS[at]?.label : undefined) ??
      (host.styleCard().highlighting() ? highlight(at) : PALETTE[at]!).label,
    keys: [{ key: String(at + 1), code: `Digit${at + 1}` }],
    unavailable() {
      const can = host.styleCard().common();
      if (can.includes("paper")) {
        return PAPERS[at] ? undefined : `Sticky notes come in ${PAPERS.length} papers`;
      }
      return (
        nothingToStyle() ??
        (can.includes("colour") ? undefined : "Not everything selected takes a colour")
      );
    },
    run: () => {
      const styleCard = host.styleCard();
      styleCard.set(
        styleCard.common().includes("paper")
          ? { paper: PAPERS[at]!.paper }
          : { colour: PALETTE[at]!.colour },
      );
    },
  });
  const textStyle = (
    label: string,
    setting: "bold" | "italic" | "strike",
    shortcut: Shortcut,
  ): Command => ({
    label,
    keys: [shortcut],
    unavailable: () =>
      noneSelected() ??
      (host.styleCard().common().includes(setting) ? undefined : "Not everything selected is text"),
    run: () => host.styleCard().set({ [setting]: host.styleCard().value(setting) !== true }),
    once: true,
  });
  const resize = (label: string, larger: boolean, keys: Shortcut[]): Command => ({
    label,
    keys,
    unavailable: () =>
      noneSelected() ??
      (host.styleCard().common().includes("size") ? undefined : "Not everything selected is text"),
    run: () => host.styleCard().resize(larger),
  });
  const furthest: Shortcut = mac ? { alt: true } : { shift: true };
  const backspace: Shortcut = { key: "backspace" };
  const deleteKey: Shortcut = { key: "delete" };
  const shiftZ: Shortcut = { key: "z", command: true, shift: true };
  const ctrlY: Shortcut = { key: "y", ctrl: true };

  const commands = {
    select: { label: "Select", keys: [{ key: "v" }], run: () => host.useTool("select") },
    hand: { label: "Hand", keys: [{ key: "h" }], run: () => host.useTool("hand") },
    eraser: {
      label: "Eraser",
      keys: [{ key: "e" }],
      unavailable: noneShown,
      run: () => host.useTool("eraser"),
    },
    pen: {
      label: "Pen",
      keys: [{ key: "d" }],
      unavailable: noneShown,
      run: () => host.useTool("pen"),
    },
    highlighter: {
      label: "Highlighter",
      keys: [{ key: "d", shift: true }],
      unavailable: noneShown,
      run: () => host.useTool("highlighter"),
    },
    arrow: {
      label: "Arrow",
      keys: [{ key: "a" }],
      unavailable: noneShown,
      run: () => host.useTool("arrow"),
    },
    line: {
      label: "Line",
      keys: [{ key: "l" }],
      unavailable: noneShown,
      run: () => host.useTool("line"),
    },
    rectangle: {
      label: "Rectangle",
      keys: [{ key: "r" }],
      unavailable: noneShown,
      run: () => host.useTool("rectangle"),
    },
    ellipse: {
      label: "Ellipse",
      keys: [{ key: "o" }],
      unavailable: noneShown,
      run: () => host.useTool("ellipse"),
    },
    cross: {
      label: "Cross",
      keys: [{ key: "x" }],
      unavailable: noneShown,
      run: () => host.useTool("cross"),
    },
    triangle: { label: "Triangle", unavailable: noneShown, run: () => host.useTool("triangle") },
    diamond: { label: "Diamond", unavailable: noneShown, run: () => host.useTool("diamond") },
    star: { label: "Star", unavailable: noneShown, run: () => host.useTool("star") },
    polygon: { label: "Polygon", unavailable: noneShown, run: () => host.useTool("polygon") },
    note: {
      label: "Text",
      keys: [{ key: "t" }],
      unavailable: noneShown,
      run: () => host.useTool("note"),
    },
    sticky: {
      label: "Sticky note",
      keys: [{ key: "n" }],
      unavailable: noneShown,
      run: () => host.useTool("sticky"),
    },
    comment: {
      label: "Comment",
      keys: [{ key: "c" }],
      unavailable: noneShown,
      run: () => host.useTool("comment"),
    },
    addImages: {
      label: "Add images…",
      keys: [{ key: "i" }],
      unavailable: noneShown,
      run: () => host.addPicked(viewport.centre()),
    },
    newBoard: {
      label: "New board",
      // Where the app has a window of its own, as browsers keep their keys for a new one.
      keys: platform.titleBar ? [{ key: "n", command: true }] : undefined,
      unavailable: loadingBoard,
      run: () => report(life.newBoard()),
      everywhere: true,
    },
    open: {
      label: "Open a board…",
      keys: [{ key: "o", command: true }],
      unavailable: loadingBoard,
      run: () => report(life.openFolder()),
      everywhere: true,
    },
    openZip: {
      label: "Open a ZIP file…",
      unavailable: loadingBoard,
      run: () => report(life.openZip()),
    },
    save: {
      label: () => (life.savesToFiles() ? "Save" : "Save…"),
      keys: [{ key: "s", command: true }],
      unavailable: () => loadingBoard() ?? noBoard(),
      // Where the browser cannot write a board, as a ZIP file it downloads.
      run: () =>
        report(
          platform.cannotSave !== undefined && !life.savesToFiles() ? exports.zip() : life.save(),
        ),
      everywhere: true,
    },
    saveAs: {
      label: "Save as…",
      keys: [{ key: "s", command: true, shift: true }],
      unavailable: () => platform.cannotSave ?? noBoard(),
      run: () => report(life.saveAs()),
      everywhere: true,
    },
    exportZip: {
      label: "Export a ZIP file…",
      unavailable: () => (exports.busy() ? "An export is under way" : noBoard()),
      run: () => report(exports.zip()),
    },
    exportPng: {
      label: () => (host.pictureCard().isOpen() ? "Hide export" : "Export the selection as PNG…"),
      keys: [{ key: "e", command: true, shift: true }],
      unavailable: unexportable,
      run: () => {
        const pictureCard = host.pictureCard();
        if (pictureCard.isOpen()) {
          pictureCard.close();
        } else {
          host.styleCard().close();
          // As the picture would hide what they draw or erase, which closes it again.
          const tool = host.tool();
          if (drawTool(tool) !== undefined || tool === "eraser") {
            host.useTool("select");
          }
          pictureCard.open(true);
        }
      },
      once: true,
    },
    // Before the others on its key, which it takes while the export card is open.
    savePng: {
      label: "Save as PNG…",
      keys: [{ key: "enter" }],
      unavailable: () =>
        host.pictureCard().isOpen() ? unexportable() : "Open the export card first",
      run: () => report(exports.png(host.pictureCard().options())),
    },
    copyPng: {
      label: "Copy as PNG",
      keys: [{ key: "c", shift: true, alt: true }],
      unavailable: unexportable,
      run: () => exports.copyPng(host.pictureCard().options()),
      once: true,
    },
    undo: {
      label: "Undo",
      keys: [{ key: "z", command: true }],
      unavailable: () => (host.opened()?.editor.canUndo() ? undefined : "Nothing to undo"),
      run: () => editing.undo(),
    },
    redo: {
      label: "Redo",
      keys: mac ? [shiftZ, ctrlY] : [ctrlY, shiftZ],
      unavailable: () => (host.opened()?.editor.canRedo() ? undefined : "Nothing to redo"),
      run: () => editing.redo(),
    },
    selectAll: {
      label: "Select all",
      keys: [{ key: "a", command: true }],
      unavailable: nothingToSelect,
      run: () => editing.selectAll(),
    },
    invertSelection: {
      label: "Invert selection",
      keys: [{ key: "a", command: true, shift: true }],
      unavailable: nothingToSelect,
      run: () => editing.invertSelection(),
      once: true,
    },
    selectSameType: {
      label: "Select same type",
      keys: [{ key: "a", code: "KeyA", command: true, alt: true }],
      unavailable: noneSelected,
      run: () => editing.selectSameType(),
    },
    escape: { label: "Go back up, or deselect", keys: [{ key: "escape" }], run: escape },
    cut: {
      label: "Cut",
      keys: [{ key: "x", command: true }],
      unavailable: noneSelected,
      run: () => host.clip().copy(true),
    },
    copy: {
      label: "Copy",
      keys: [{ key: "c", command: true }],
      unavailable: noneSelected,
      run: () => host.clip().copy(false),
    },
    paste: {
      label: "Paste",
      keys: [{ key: "v", command: true }],
      unavailable: noneShown,
      run: () => pasteAt(viewport.centre()),
    },
    duplicate: {
      label: "Duplicate",
      keys: [{ key: "d", command: true }],
      unavailable: noneSelected,
      run: () => host.duplicate(),
    },
    remove: {
      label: "Delete",
      keys: mac ? [backspace, deleteKey] : [deleteKey, backspace],
      unavailable: noneSelected,
      run: () => editing.remove(),
    },
    // By the bracket typed, or where it sits on US keys where the layout types it with more keys,
    // as with AltGr. With ⌥ on macOS, whose browsers switch tabs on ⌘⇧ and a bracket, but Shift
    // elsewhere, where Ctrl and Alt together are AltGr.
    front: restack("Bring to front", "front", {
      key: "]",
      code: "BracketRight",
      command: true,
      ...furthest,
    }),
    forward: restack("Bring forward", "forward", { key: "]", code: "BracketRight", command: true }),
    backward: restack("Send backward", "backward", {
      key: "[",
      code: "BracketLeft",
      command: true,
    }),
    back: restack("Send to back", "back", {
      key: "[",
      code: "BracketLeft",
      command: true,
      ...furthest,
    }),
    arrangeByName: arrangement("By name", () => ({ by: "name" })),
    arrangeBySize: arrangement("By size", () => ({ by: "size" })),
    arrangeByColour: arrangement("By colour", async (target, ids) => ({
      by: "hue",
      colours: await meanColours(target, ids),
    })),
    arrangeRandomly: arrangement("At random", () => ({
      by: "random",
      seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
    })),
    sameHeight: {
      label: "Same height",
      unavailable: fewImages,
      run: () => editing.normalize("height"),
    },
    sameWidth: {
      label: "Same width",
      unavailable: fewImages,
      run: () => editing.normalize("width"),
    },
    // Web design tools' keys.
    alignLeft: alignment("Left", "left", "a"),
    alignCentre: alignment("Centre", "centre", "h"),
    alignRight: alignment("Right", "right", "d"),
    alignTop: alignment("Top", "top", "w"),
    alignMiddle: alignment("Middle", "middle", "v"),
    alignBottom: alignment("Bottom", "bottom", "s"),
    distributeHorizontally: distribution("Distribute horizontally", "horizontal", "h"),
    distributeVertically: distribution("Distribute vertically", "vertical", "v"),
    rotateLeft: turn("Rotate left", -90, "l"),
    rotateRight: turn("Rotate right", 90, "r"),
    straighten: {
      label: "Straighten",
      keys: [{ key: "r", alt: true }],
      unavailable: () =>
        noneSelected() ??
        (selectedKinds().some((kind) => core.rotationOf(kind) !== 0 || core.bendOf(kind) !== 0)
          ? undefined
          : "Nothing selected is turned or bent"),
      run: () => editing.straighten(),
    },
    actualSize: {
      label: "Actual size",
      keys: [{ key: "t", alt: true }],
      unavailable: () =>
        noneSelected() ??
        (selectedImages().length > 0 ? undefined : "Only images have an actual size") ??
        (host.opened()?.editor.atActualSize(editing.selection())
          ? "Already at actual size"
          : undefined),
      run: () => editing.actualSize(),
    },
    flipHorizontally: flip("Flip horizontally", "h", true),
    flipVertically: flip("Flip vertically", "v", false),
    crop: {
      label: "Crop",
      keys: [{ key: "enter" }],
      unavailable: () => (selectedImage() ? undefined : "Select one image"),
      run: () => editing.crop(),
    },
    resetCrop: {
      label: "Reset crop",
      keys: [{ key: "c", command: true, shift: true }],
      unavailable: () =>
        editing.cropping() !== undefined
          ? undefined
          : (noneSelected() ??
            (selectedImages().some(
              (kind) => core.editsOf(kind).crop || core.editsOf(kind).crop_shape === "ellipse",
            )
              ? undefined
              : "Nothing selected is cropped")),
      run: () => editing.resetCrop(),
    },
    rectangularCrop: {
      label: "Rectangular crop",
      unavailable: croppable,
      run: () => editing.cropShape("rectangle"),
    },
    ellipticalCrop: {
      label: "Elliptical crop",
      keys: [{ key: "c", alt: true }],
      unavailable: croppable,
      run: () => editing.cropShape(elliptical() ? "rectangle" : "ellipse"),
      once: true,
    },
    greyscale: {
      label: "Greyscale",
      keys: [{ key: "g", alt: true }],
      unavailable: () =>
        noneSelected() ?? (selectedImages().length > 0 ? undefined : "Only images turn grey"),
      run: () => editing.greyscale(!greyed()),
      once: true,
    },
    play: {
      label: () => (selectedMoving().some(media.playing) ? "Pause" : "Play"),
      keys: [{ key: "p" }],
      unavailable: () =>
        noneSelected() ??
        (selectedMoving().length > 0 ? undefined : "Only animated images and videos play"),
      run: () => {
        const assets = selectedMoving();
        media.play(assets, !assets.some(media.playing));
        host.refreshBar();
      },
      once: true,
    },
    previousFrame: frameStep("Previous frame", -1, [{ key: "," }]),
    // AZERTY types it with Shift.
    nextFrame: frameStep("Next frame", 1, [{ key: "." }, { key: ".", shift: true }]),
    // US types them with Shift, AZERTY one of them without.
    slower: pace("Slower", false, [{ key: "<" }, { key: "<", shift: true }]),
    faster: pace("Faster", true, [{ key: ">" }, { key: ">", shift: true }]),
    sound: {
      label: () => (selectedAssets().some(films.sounding) ? "Turn sound off" : "Turn sound on"),
      keys: [{ key: "m" }],
      unavailable: () =>
        noneSelected() ??
        (selectedAssets().some(films.holds) ? undefined : "Only videos have sound"),
      run: () => {
        const assets = selectedAssets().filter(films.holds);
        films.sound(assets, !assets.some(films.sounding));
        host.refreshBar();
      },
      once: true,
    },
    openSource: {
      label: "Open source",
      keys: [{ key: "o", command: true, shift: true }],
      unavailable: () => {
        const image = selectedImage();
        if (image === undefined) {
          return "Select one image";
        }
        return webAddress(image.source) === undefined ? "Its source is no web address" : undefined;
      },
      run: () => {
        const address = webAddress(selectedImage()?.source);
        if (address !== undefined) {
          report(platform.openAddress(address));
        }
      },
    },
    group: {
      label: "Group",
      keys: [{ key: "g", command: true }],
      unavailable: () =>
        editing.selection().length < 2 ? "Select two elements or more" : undefined,
      run: () => editing.group(newId()),
    },
    ungroup: {
      label: "Ungroup",
      keys: [{ key: "g", command: true, shift: true }],
      unavailable: () => noneSelected() ?? (selectsGroup() ? undefined : "Only groups ungroup"),
      run: () => editing.ungroup(),
    },
    lock: {
      label: () => (unlocking() === undefined ? "Lock" : "Unlock"),
      keys: [{ key: "l", command: true, shift: true }],
      unavailable: () => (unlocking() === undefined ? noneSelected() : undefined),
      run: () => {
        const under = unlocking();
        if (under === undefined) {
          editing.lock();
        } else {
          editing.unlock([under]);
        }
      },
      once: true,
    },
    goInside: {
      label: "Go inside",
      keys: [{ key: "enter" }],
      unavailable: () =>
        editing.selection().length === 1 && selectsGroup() ? undefined : "Select one group",
      run: () => editing.goInside(),
    },
    rename: {
      label: () => (loneGroup()?.title === undefined ? "Add title" : "Rename"),
      unavailable: () => (loneGroup() ? undefined : "Select one group"),
      run: () => host.groupTitles.write(editing.selection()[0]!),
    },
    write: {
      label: "Edit text",
      keys: [{ key: "enter" }],
      unavailable: () =>
        editing.writable() ? undefined : "Select one text, sticky note, shape, or comment",
      run: () => editing.write(),
    },
    zoomIn: {
      label: "Zoom in",
      // Shift types + on most layouts, but not on a number pad.
      keys: [
        { key: "+", command: true },
        { key: "+", command: true, shift: true },
        { key: "=", code: "Equal", command: true },
      ],
      unavailable: noneShown,
      run: () => viewport.zoomBy(ZOOM_STEP),
    },
    zoomOut: {
      label: "Zoom out",
      keys: [{ key: "-", code: "Minus", command: true }],
      unavailable: noneShown,
      run: () => viewport.zoomBy(1 / ZOOM_STEP),
    },
    zoomActual: zoomTo("Zoom to 100%", 1, [{ key: "0", code: "Digit0", command: true }]),
    fit: {
      label: "Zoom to fit",
      keys: [{ code: "Digit1", shift: true }],
      unavailable: noneShown,
      run: () => {
        const opened = host.opened();
        if (opened) {
          viewport.look(
            fit(extent(opened, shownOrder(opened.board, host.showsAnnotations())), viewport.size()),
          );
        }
      },
    },
    fitSelection: {
      label: "Zoom to selection",
      keys: [{ code: "Digit2", shift: true }],
      unavailable: noneSelected,
      run: () => host.fitTo(editing.selection()),
    },
    hints: {
      label: "Hints",
      run: () => {
        hintsShown = !hintsShown;
        remember(HINTS, hintsShown ? undefined : "hidden");
        host.refreshBar();
      },
    },
    compact: {
      label: "Compact mode",
      keys: [{ key: "\\", code: "Backslash", command: true }],
      unavailable: () =>
        platform.titleBar ? undefined : "Only the desktop app has a window of its own",
      run: () => report(useCompact(!compact)),
      once: true,
    },
    plain: backdrop("No grid", "plain"),
    grid: backdrop("Lines", "grid"),
    dots: backdrop("Dots", "dots"),
    nextBackground: {
      label: "Grid",
      keys: [{ key: "g" }],
      unavailable: noBoard,
      run: () => {
        const at = BACKGROUNDS.indexOf(host.opened()!.board.background);
        useBackground(BACKGROUNDS[(at + 1) % BACKGROUNDS.length]!);
      },
      once: true,
    },
    snap: {
      label: "Snap to grid",
      run: () => host.snap(!host.snapping()),
    },
    snapNeighbours: {
      label: "Snap to neighbours",
      run: () => {
        aligning = !aligning;
        remember(NEIGHBOURS, aligning ? undefined : "off");
      },
    },
    light: palette("Light", "light"),
    dark: palette("Dark", "dark"),
    system: palette("System", "system"),
    highContrast: { label: "High contrast", run: () => appearance.toggleContrast() },
    agentAccess: {
      label: "Agent access",
      unavailable: () => (platform.agent ? undefined : "Only the desktop app lets agents in"),
      run: () => report(agents.allow(!agents.allowed())),
    },
    checkUpdates: {
      label: "Check for updates automatically",
      unavailable: () => (platform.updater ? undefined : "Only the desktop app updates itself"),
      run: () => report(updates.allow(!updates.allowed())),
    },
    errorLog: {
      label: "Open the error log",
      unavailable: () => (platform.errorLog ? undefined : "Only the desktop app keeps one"),
      run: () => {
        if (platform.errorLog) {
          report(showErrorLog(platform.errorLog));
        }
      },
    },
    alwaysOnTop: {
      label: "Always on top",
      unavailable: () =>
        platform.keepOnTop ? undefined : "Only the desktop app has a window of its own",
      run: () => report(keepOnTop(!onTop)),
    },
    hoverPlay: {
      label: "Play videos on hover",
      run: () => {
        hoverPlay = !hoverPlay;
        remember(HOVER_PLAY, hoverPlay ? "on" : undefined);
        films.playOnHover(hoverPlay);
        host.refreshBar();
      },
    },
    keepStyle: {
      label: "Keep style open",
      run: () => {
        styleKept = !styleKept;
        remember(KEEP_STYLE, styleKept ? "on" : undefined);
        host.styleCard().keepOpen(styleKept);
        host.refreshBar();
      },
    },
    measurements: { label: "Measurements", run: () => measurements.toggle() },
    greyBoard: {
      label: "Greyscale board",
      keys: [{ key: "g", code: "KeyG", command: true, alt: true }],
      run: () => viewport.grey(!viewport.greyed()),
      once: true,
    },
    mirrorBoard: {
      label: "Mirror board",
      keys: [{ key: "f", code: "KeyF", command: true, alt: true }],
      run: () => viewport.mirror(!viewport.mirrored()),
      once: true,
    },
    annotations: {
      label: "Annotations",
      keys: [{ key: "h", command: true, shift: true }],
      run: () => host.showAnnotations(!host.showsAnnotations()),
      once: true,
    },
    style: {
      label: () => (host.styleCard().isOpen() ? "Hide style" : "Show style"),
      keys: [{ key: "s", shift: true }],
      unavailable: () =>
        nothingToStyle() ??
        (host.styleCard().common().length > 0 || host.styleCard().images()
          ? undefined
          : "Comments have no style"),
      run: () => {
        const styleCard = host.styleCard();
        if (styleCard.isOpen()) {
          styleCard.close();
        } else {
          host.pictureCard().close();
          styleCard.open(true);
        }
      },
      once: true,
    },
    colour1: colourCommand(0),
    colour2: colourCommand(1),
    colour3: colourCommand(2),
    colour4: colourCommand(3),
    colour5: colourCommand(4),
    colour6: colourCommand(5),
    bold: textStyle("Bold", "bold", { key: "b", command: true }),
    italic: textStyle("Italic", "italic", { key: "i", command: true }),
    strike: textStyle("Strikethrough", "strike", { key: "x", command: true, shift: true }),
    // Where < and > sit apart from comma and period, on a key of their own, as on AZERTY.
    larger: resize("Larger text", true, [
      { key: ">", command: true, shift: true },
      { key: ">", command: true },
      { code: "Period", command: true, shift: true },
    ]),
    smaller: resize("Smaller text", false, [
      { key: "<", command: true, shift: true },
      { key: "<", command: true },
      { code: "Comma", command: true, shift: true },
    ]),
    copyStyle: {
      label: "Copy style",
      keys: [{ key: "c", code: "KeyC", command: true, alt: true }],
      unavailable: () =>
        noneSelected() ??
        (host.styleCard().common().length > 0 ? undefined : "Comments have no style"),
      run: () => host.styleCard().copy(),
    },
    pasteStyle: {
      label: "Paste style",
      keys: [{ key: "v", code: "KeyV", command: true, alt: true }],
      unavailable: () =>
        noneSelected() ?? (host.styleCard().canPaste() ? undefined : "Copy a style first"),
      run: () => host.styleCard().paste(),
    },
    contextMenu: {
      label: "Show the context menu",
      keys: [{ key: "contextmenu" }, { key: "f10", shift: true }],
      unavailable: noneShown,
      run: () => host.contextMenuFromKeys(),
    },
    find: {
      label: "Find a command…",
      keys: [
        { key: "k", command: true },
        { key: "/", code: "Slash", command: true },
      ],
      run: () => openFinder(host.listed),
      once: true,
    },
    desktopApp: {
      label: "Get the desktop app",
      run: () => {
        if (platform.desktopApp !== undefined) {
          report(platform.openAddress(platform.desktopApp));
        }
      },
    },
    reportBug: {
      label: "Report a bug",
      run: () => report(host.openBugReport()),
    },
  } satisfies Record<string, Command>;
  const colours = [
    commands.colour1,
    commands.colour2,
    commands.colour3,
    commands.colour4,
    commands.colour5,
    commands.colour6,
  ];

  /** Whether what each turns on and off is on. */
  const switches = new Map<Command, () => boolean>([
    [commands.ellipticalCrop, elliptical],
    [commands.greyscale, greyed],
    [commands.bold, () => host.styleCard().value("bold") === true],
    [commands.italic, () => host.styleCard().value("italic") === true],
    [commands.strike, () => host.styleCard().value("strike") === true],
    [commands.snap, () => host.snapping()],
    [commands.snapNeighbours, () => aligning],
    [commands.highContrast, () => appearance.highContrast()],
    [commands.hints, () => hintsShown],
    [commands.measurements, () => measurements.shown()],
    [commands.greyBoard, () => viewport.greyed()],
    [commands.mirrorBoard, () => viewport.mirrored()],
    [commands.annotations, () => host.showsAnnotations()],
    [commands.alwaysOnTop, () => onTop],
    [commands.compact, () => compact],
    [commands.hoverPlay, () => hoverPlay],
    [commands.keepStyle, () => styleKept],
    [commands.agentAccess, () => agents.allowed()],
    [commands.checkUpdates, () => updates.allowed()],
  ]);
  /** Whether each is the one in use among those that exclude each other. */
  const ticks = new Map<Command, () => boolean>([
    ...BACKGROUNDS.map((to): [Command, () => boolean] => [
      commands[to],
      () => host.opened()?.board.background === to,
    ]),
    ...SCHEMES.map((to): [Command, () => boolean] => [
      commands[to],
      () => appearance.scheme() === to,
    ]),
  ]);

  async function arrange(label: string, order: Ordering): Promise<void> {
    const held = host.hold();
    const ids = editing.selection();
    if (held === undefined || arranging) {
      return;
    }
    arranging = true;
    try {
      const working = order(held.board, ids);
      const slow = working instanceof Promise;
      if (slow) {
        say(`Arranging ${label.toLowerCase()}…`, true);
      }
      const chosen = await working;
      await editing.idle();
      const selection = new Set(editing.selection());
      if (!held.shows() || selection.size !== ids.length || ids.some((id) => !selection.has(id))) {
        say("Not arranged, as the selection changed");
      } else {
        editing.arrange(chosen);
        if (slow) {
          say(`Arranged ${label.toLowerCase()}`);
        }
      }
    } finally {
      arranging = false;
    }
  }

  function useBackground(background: Background): void {
    if (background !== "plain") {
      host.snap(true);
    }
    editing.background(background);
  }

  /**
   * Esc lets go of a colour being picked first, then of the style card or the export card, then of
   * the tool in use, which leaves the selection to act on, then of the group gone into, one level
   * at a time, then of the selection.
   */
  function escape(): void {
    const picker = host.picker();
    const styleCard = host.styleCard();
    const pictureCard = host.pictureCard();
    if (picker.sampling()) {
      picker.end(true);
    } else if (styleCard.isOpen()) {
      styleCard.close();
    } else if (pictureCard.isOpen()) {
      pictureCard.close();
    } else if (host.tool() !== "select") {
      host.useTool("select");
    } else if (!editing.up()) {
      editing.select([]);
    }
  }

  /** What the clipboard holds, centred on `at`, as the menus paste. */
  function pasteAt(at: Point | undefined): void {
    if (at !== undefined) {
      const key = describe(commands.paste.keys[0]!);
      report(
        host
          .clip()
          .paste(at)
          .catch(() => {
            throw new Error(`The browser lets only ${key} paste here`);
          }),
      );
    }
  }

  /** Remembered as the window is, so that a start the shell refuses forgets the choice. */
  async function keepOnTop(on: boolean): Promise<void> {
    try {
      await platform.keepOnTop?.(on);
      onTop = on;
    } finally {
      remember(ON_TOP, onTop ? "on" : undefined);
    }
  }

  async function useCompact(on: boolean): Promise<void> {
    await platform.titleBar?.show(!on);
    compact = on;
    document.documentElement.toggleAttribute("data-compact", on);
    if (on) {
      say(
        `Compact mode: drag the top edge to move, ${describe(commands.compact.keys[0]!)} or right-click to leave`,
      );
    }
  }

  async function showErrorLog(log: ErrorLog): Promise<void> {
    if (!(await log.show())) {
      say("No error was logged yet");
    }
  }

  function hint(): string {
    // As the menus name them.
    const [escapeKey, insideKey] = [commands.escape, commands.goInside].map(({ keys }) =>
      describe(keys[0]!),
    );
    const [centreKey, stepKey] = mac ? ["⌥", "⇧"] : ["Alt", "Shift"];
    const picking = host.picker().sampling();
    if (picking !== undefined) {
      return `${picking === "holding" ? "Let go of S" : "Click"} to pick a colour · ${escapeKey} to cancel`;
    }
    if (editing.writing() !== undefined) {
      return `${escapeKey} or click away to finish`;
    }
    if (host.styleCard().trimming()) {
      return `Drag an end to trim · ${insideKey} when done · ${escapeKey} to cancel`;
    }
    if (editing.cropping() !== undefined) {
      return `Drag the edges to crop · ${insideKey} when done · ${escapeKey} to cancel`;
    }
    if (host.pictureCard().isOpen()) {
      const [saveKey, copyKey] = [commands.savePng.keys[0]!, commands.copy.keys[0]!].map(describe);
      return `${saveKey} to save · ${copyKey} to copy · ${escapeKey} to close`;
    }
    const tool = host.tool();
    if (tool === "hand") {
      return `Drag to move around · ${escapeKey} to select again`;
    }
    if (host.spaceHeld()) {
      return "Drag to move around";
    }
    // The handles leave the menu out, as a right-click outside the selection's box, where turns
    // start, clears it.
    switch (tool === "select" ? editing.grab() : undefined) {
      case "corner":
        return `Drag to scale · hold ${centreKey} to scale around the centre`;
      case "side":
        return "Drag to stretch";
      case "turn":
        return `Drag to turn · hold ${stepKey} for steps of 15°`;
    }
    if (tool === "eraser") {
      return `Click or drag over what to erase · ${escapeKey} to select again`;
    }
    if (isTip(tool)) {
      return `Drag to draw · hold ${stepKey} to draw straight · ${escapeKey} to select again`;
    }
    if (tool === "arrow" || tool === "line") {
      return `Drag to draw · hold ${stepKey} for steps of 45° · ${escapeKey} to select again`;
    }
    if (FRAMED.has(tool)) {
      return `Drag to draw, or click to place · ${escapeKey} to select again`;
    }
    if (tool === "comment") {
      return `Click where to comment · ${escapeKey} to select again`;
    }
    if (tool === "note") {
      return `Click to write, or drag to set how wide · ${escapeKey} to select again`;
    }
    if (editing.entered() !== undefined) {
      return `Inside a group · ${escapeKey} to go back up · right-click for more`;
    }
    if (commands.goInside.unavailable() === undefined) {
      return "Drag to move · double-click to go inside · right-click for more";
    }
    if (editing.writable()) {
      return "Drag to move · double-click to write · right-click for more";
    }
    if (editing.loneSegment()) {
      return "Drag to move · drag an end or the middle to reshape it · right-click for more";
    }
    if (editing.selection().length > 0) {
      const focuses =
        editing.selection().length === 1 ? "double-click to zoom to it and back · " : "";
      return `Drag to move · ${focuses}right-click for more`;
    }
    if (unlocking() !== undefined) {
      return "Locked · right-click to unlock";
    }
    return host.greeting.quietsHint()
      ? ""
      : "Drop or paste images · scroll to move around · right-click for more";
  }

  return {
    commands,
    colours,
    leaveCompact: { ...commands.compact, label: "Leave compact mode" } satisfies Command,
    /** Ticked, or switched on or off, where it says what it does. */
    stated(command: Command): Item {
      const on = switches.get(command);
      if (on) {
        return { ...command, checked: on(), toggle: true };
      }
      const ticked = ticks.get(command);
      return ticked ? { ...command, checked: ticked() } : command;
    },
    hint: () => (hintsShown ? hint() : ""),
    aligning: () => aligning,
    compact: () => compact,
    zoomTo,
    pasteAt,
    noneShown,
    fewImages,
    loneGroup,
    selectedImage,
    /**
     * Once the cards are made. The window outlives a reload of the page, so it follows how the
     * page starts, even when the browser forgot.
     */
    restore(): void {
      host.styleCard().keepOpen(styleKept);
      films.playOnHover(hoverPlay);
      if (platform.keepOnTop) {
        report(keepOnTop(recall(ON_TOP) === "on"));
      }
      if (platform.titleBar) {
        report(platform.titleBar.show(true));
      }
    },
  };
}
