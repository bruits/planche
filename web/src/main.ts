// The app: start a board, or open one from a folder or a ZIP file, look around it, add images
// to it and edit it, which it saves as it goes, and save it elsewhere or export it.

import * as core from "./core.js";
import type {
  Alignment,
  Axis,
  Background,
  Copied,
  CropShape,
  Kind,
  Order,
  Point,
  Rect,
  Restack,
  Size,
  Tip,
} from "./core.js";
import { pick, receive, type Incoming } from "./add.js";
import { answer } from "./agent.js";
import { animations } from "./animation.js";
import {
  among,
  assetSizes,
  assetPlayback,
  assetsOf,
  centring,
  copiedAssets,
  duplicateOffset,
  decodeAsset,
  exposing,
  extent,
  files,
  imageKind,
  loneImage,
  placed,
  pool,
  prepare,
  newId,
  reader,
  refresh,
  release,
  renamed,
  webAddress,
  row,
  type Added,
  type Decoded,
  type Opened,
} from "./board.js";
import { fit, onScreen, type Camera } from "./camera.js";
import { card, type CardMedia } from "./card.js";
import { clipboard, type Pasted } from "./clipboard.js";
import { meanColours } from "./colour.js";
import {
  describe,
  learnLayout,
  listen,
  mac,
  named,
  typed,
  typing,
  type Command,
  type Shortcut,
} from "./commands.js";
import { CROP_KEYS, edits, isTip, type Draw, type Pen } from "./edit.js";
import { message } from "./errors.js";
import { exportCard, recalled, remembered } from "./exportcard.js";
import { handle } from "./handle.js";
import type { Icon } from "./icons.js";
import { lifecycle } from "./lifecycle.js";
import { menuOpen, openMenu, type Entry, type Item } from "./menu.js";
import { openFinder, type Listed } from "./finder.js";
import { heapInUse, megabytes, milliseconds, percentile, rate, timed } from "./metrics.js";
import { overlay } from "./overlay.js";
import { testPhotos } from "./photos.js";
import { sped } from "./playback.js";
import { lockedPin, pinned, pins } from "./pins.js";
import { titledGroup, titles } from "./titles.js";
import { platform } from "./platform.js";
import { recall, remember } from "./preferences.js";
import { LONGEST_SIDE } from "./raster.js";
import {
  backing,
  drawnOver,
  exported,
  pictureName,
  planned,
  render,
  type Options,
} from "./render.js";
import type { Saving } from "./save.js";
import { create, type Placed, type Renderer } from "./renderer.js";
import { ACROSS, sampler } from "./sampler.js";
import { showing } from "./showing.js";
import { png, still } from "./still.js";
import { PALETTE, PAPERS, highlight, styles } from "./style.js";
import { loadFont, texts } from "./text.js";
import { theme, type Scheme } from "./theme.js";
import { toolbar, type Button } from "./toolbar.js";
import { vectors } from "./vector.js";
import { videos } from "./video.js";
import { view } from "./view.js";
import { writeZip } from "./zip.js";

/** Where the browser remembers that hints are hidden. */
const HINTS = "planche.hints";
/** Where the browser remembers that agent access is on. */
const AGENT = "planche.agent";
/** Where the browser remembers that the window stays on top. */
const ON_TOP = "planche.ontop";
/** Where the browser remembers that videos play only while the pointer is on them. */
const HOVER_PLAY = "planche.hoverplay";
/** Where the browser remembers that the style card stays open. */
const KEEP_STYLE = "planche.keepstyle";
/** Where the browser remembers that nothing lines up with its neighbours. */
const NEIGHBOURS = "planche.neighbours";
const ZOOM_STEP = 1.25;
/** What the zoom's menu zooms to at once. */
const ZOOMS = [0.25, 0.5, 1, 2, 4];
/** Each side for the other, as a mirrored board shows them. */
const MIRRORED_SIDES: Partial<Record<Alignment, Alignment>> = { left: "right", right: "left" };
/** Left around images added, in CSS pixels, past the zones outside their corners that turn them. */
const ADDED_MARGIN = 48;
/** How far right and down a duplicate lies from what it copies, at least, in CSS pixels. */
const DUPLICATE_OFFSET = 16;
/** In the order the key goes through them. */
const BACKGROUNDS: Background[] = ["plain", "grid", "dots"];
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
const SCHEMES: Scheme[] = ["light", "dark", "system"];
/** How many test photos the measurements offer to add at once, each about 17 MB of textures. */
const TEST_PHOTOS = [10, 50, 100];
/** As their assets would stay in the board's folder or file once undone. */
const NOT_FOR_TEST_PHOTOS = "Only on a board not saved in a folder or a ZIP file";

const measurements = byId("measurements");
const details = new Map<string, string>();
/** The rows of the measurements that the next draw ends, with when each began. */
const untilDrawn = new Map<string, number>();
const draws = rate((perSecond) => {
  drawRate = perSecond;
  showMetrics();
});
const overlaid = overlay(byId("viewport"));
const viewport = view(byId("viewport"), {
  advance: () => editing.catchUp(),
  frame(camera, size) {
    bar.zoomed();
    overlaid.frame(camera, size);
    comments.frame(camera, viewport.mirrored() ? size : undefined);
    groupTitles.frame(camera, viewport.mirrored() ? size : undefined);
    editing.follow();
    styleCard.frame();
    pictureCard.frame();
    if (opened && renderer) {
      present.free();
      drawings.update(opened.board, renderer, camera, size);
      animated.update(opened.board, renderer, camera, size);
      films.update(opened.board, renderer, camera, size);
      if (lettering.update(opened.board, renderer, camera, size, editing.writing())) {
        placeNow(renderer, opened);
      }
    }
  },
  painted() {
    draws.count();
    if (untilDrawn.size > 0) {
      const now = performance.now();
      untilDrawn.forEach((since, name) => details.set(name, milliseconds(now - since)));
      untilDrawn.clear();
    }
  },
  failed: (error) => fail(error),
});
const lettering = texts(() => viewport.redraw());
const drawings = vectors(() => viewport.redraw());
const animated = animations(
  () => viewport.redraw(),
  () => refreshBar(),
);
const films = videos(
  () => viewport.redraw(),
  () => {
    refreshBar();
    // Its frames, once read, give it its timeline.
    styleCard.refresh();
  },
  () => bar.say("A video cannot play here"),
);
const media: CardMedia = {
  playback: (asset) => animated.playback(asset) ?? films.playback(asset),
  play(assets, playing) {
    animated.play(assets, playing);
    films.play(assets, playing);
  },
  seek(asset, at) {
    animated.seek(asset, at);
    films.seek(asset, at);
  },
  preview(asset, span) {
    animated.preview(asset, span);
    films.preview(asset, span);
  },
};
const editing = edits(viewport, overlaid, () => opened, {
  changed,
  retitle: (id) => groupTitles.write(id),
  selectionChanged() {
    films.select(loneImage(opened?.board, editing.selection())?.image.asset);
    refreshBar();
    showComments();
    styleCard.refresh();
    reframe();
  },
  settled() {
    refreshBar();
    styleCard.refresh();
    reframe();
    // A drag ending draws nothing, so what it stopped drawing is freed now.
    present.free();
  },
  snapping: () => snapping,
  aligning: () => aligning,
  drawing: () => drawTool(),
  erasing: () => tool === "eraser",
  sampling: () => picker.sampling() !== undefined,
  drawn: () => useTool("select"),
  styled: (kind, zoom) => look.dressed(kind, zoom),
  inked(stroke) {
    inking = stroke;
    if (opened && renderer) {
      placeNow(renderer, opened);
      viewport.redraw();
    }
  },
  selecting: () => tool === "select" && !spaceHeld && picker.sampling() === undefined,
  hovered: () => refreshBar(),
  pointed(id) {
    const kind = id === undefined ? undefined : opened?.board.elements[id]?.kind;
    films.hover(kind?.type === "image" ? kind.asset : undefined);
  },
  stepped(steps, moves) {
    const [p50, p90] = [percentile(steps, 0.5), percentile(steps, 0.9)];
    details.set(
      "drag step",
      `p50 ${milliseconds(p50)}, p90 ${milliseconds(p90)}, ${steps.length} for ${moves} moves`,
    );
  },
});
// Before the pins, which stand over them.
const groupTitles = titles(byId("viewport"), retitle);
const comments = pins(byId("viewport"), {
  choose: (id) => editing.choose(id),
  write: (id) => editing.write(id),
});
const appearance = theme(restyle);

const life = lifecycle({
  platform,
  opened: () => opened,
  show,
  camera: () => viewport.camera(),
  say: (...said) => bar.say(...said),
  loadingChanged: () => refreshBar(),
  titleChanged() {
    bar.unsaved(life.unsaved());
    showTitle();
  },
  timings: details,
});

const present = showing({
  opened: () => opened,
  saver: () => life.saver(),
  camera: () => viewport.camera(),
  size: () => viewport.size(),
  say: (...said) => bar.say(...said),
  reset(next) {
    // The core's memory holds it until freed.
    opened?.editor.free();
    opened = next;
    renderer = undefined;
    snapping = next.board.background !== "plain";
    lettering.reset();
    drawings.reset();
    animated.reset();
    films.reset();
    crossedOut = new Set();
    loaded.clear();
    comments.clear();
    groupTitles.clear();
    life.showSaved();
    showTitle();
    editing.reset();
    viewport.clear();
    refreshBar();
  },
  async attach(next, camera, wanted) {
    const { width, height } = viewport.size();
    const created = await create(viewport.host, width, height);
    if (!wanted()) {
      created.destroy();
      return undefined;
    }
    // Edits may have changed it while the renderer was created.
    created.backdrop(next.board.background);
    details.set("renderer", created.backend);
    renderer = created;
    placeNow(created, next);
    viewport.show(created, camera ?? fit(extent(next), viewport.size()));
    editing.rehover();
    refreshBar();
    return created;
  },
  decode: (read) => decodeAsset(read, LONGEST_SIDE).catch(() => undefined),
  release,
  load(into, asset, decoded, read) {
    load(into, new Map([[asset, decoded]]));
    // Once their texture is there, which they play onto.
    animated.keep([read]);
    films.keep([read]);
    // As sharp at any size once known to be an SVG.
    reframe();
  },
  crossOut,
  holds: (_, asset) => loaded.has(asset) || crossedOut.has(asset),
  unload(into, asset) {
    drawings.drop(asset);
    into.release(asset);
    loaded.delete(asset);
  },
  busy: () => editing.busy(),
  redraw: () => viewport.redraw(),
  abandon(into) {
    if (into !== undefined && renderer === into) {
      viewport.clear();
      renderer = undefined;
    }
    drawings.reset();
    animated.reset();
    films.reset();
    crossedOut = new Set();
    loaded.clear();
    editing.reset();
    comments.clear();
    groupTitles.clear();
  },
  changed,
  drawn: (name, since) => untilDrawn.set(name, since),
});

let opened: Opened | undefined;
let renderer: Renderer | undefined;
let halfDrawn = false;
/** On the desktop, a second export to the same file would take over the first one's draft. */
let exporting = false;
let tool: "select" | "hand" | "eraser" | Draw = "select";
/** What the pen draws while pressed, over the board. */
let inking: Pen | undefined;
/** Left out of the board, it starts as the board's background suggests. */
let snapping = false;
/** The assets whose images show crossed out, as this machine cannot decode or play them. */
let crossedOut: ReadonlySet<string> = new Set();
/** The assets the renderer holds a texture or a drawing of, which adding them again needs not decode. */
const loaded = new Set<string>();
let spaceHeld = false;
/** Left out of the preferences, as a window without its title bar would open at full size. */
let compact = false;
/** Draws per second, `undefined` until the measurements were shown for a second. */
let drawRate: number | undefined;
let hintsShown = recall(HINTS) !== "hidden";
let agentsAllowed = false;
let onTop = false;
let hoverPlay = recall(HOVER_PLAY) === "on";
let styleKept = recall(KEEP_STYLE) === "on";
let aligning = recall(NEIGHBOURS) !== "off";
let arranging = false;
let copying: { key: string; png: Promise<Blob> } | undefined;
/** Copies as PNG asked for, so that one cancelled clears no later one's message. */
let pngCopies = 0;
/** What of the export card's picture the board last drew. */
let exposed = "";

type Ordering = (opened: Opened, ids: string[]) => Order | Promise<Order>;

const loadingBoard = () => (life.loading() ? "A board is opening" : undefined);
const noBoard = () => (opened === undefined ? "No board is open yet" : undefined);
const noneSelected = () => (editing.selection().length === 0 ? "Nothing is selected" : undefined);
/** With nothing selected, the pen's style is what styling sets. */
const nothingToStyle = () => (penStyling() ? undefined : noneSelected());
const unexportable = () => {
  const ids = editing.selection();
  if (ids.length === 0) {
    return "Select what to export";
  }
  return opened && drawnOver(opened, ids, crossedOut) === undefined
    ? "The selection draws nothing"
    : undefined;
};
// Images within a selected group do not count, as arranging leaves groups where they are.
const fewImages = () =>
  editing.selection().filter((id) => opened?.board.elements[id]?.kind.type === "image").length < 2
    ? "Select two images or more"
    : undefined;
/**
 * What is selected, with what the groups selected hold, but for what is locked, whose looks edits
 * leave alone.
 */
const selectedKinds = (): Kind[] => {
  if (!opened) {
    return [];
  }
  const { board, editor } = opened;
  const chosen = new Set(editing.selection());
  return Object.entries(board.elements).flatMap(([id, { kind }]) =>
    among(board, id, chosen) && editor.lockedBy(id) === undefined ? [kind] : [],
  );
};
const selectedImages = () => selectedKinds().filter((kind) => kind.type === "image");
/** What the lock command unlocks, as nothing is selected. */
const unlocking = () => (editing.selection().length === 0 ? editing.lockedUnder() : undefined);
const selectedImage = () => loneImage(opened?.board, editing.selection())?.image;
const loneGroup = () => {
  const [id, ...more] = editing.selection();
  const kind = id === undefined || more.length > 0 ? undefined : opened?.board.elements[id]?.kind;
  return kind?.type === "group" ? kind : undefined;
};
/** A hair aside, as the core takes it. */
const near = (size: number, pixels: number) => Math.abs(size - pixels) <= 1e-6;
const atActualSize = () =>
  selectedImages().every((kind) => {
    const shown = core.editsOf(kind).crop ?? kind.natural_size;
    return (
      core.rotationOf(kind) === 0 &&
      near(kind.frame.width, shown.width) &&
      near(kind.frame.height, shown.height)
    );
  });
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
const selectedAssets = () => (opened ? assetsOf(opened.board, editing.selection()) : []);
const selectedMoving = () =>
  selectedAssets().filter((asset) => animated.holds(asset) || films.holds(asset));
const moving = (asset: string) => animated.playing(asset) || films.playing(asset);
const selectedStepping = () =>
  selectedAssets().filter((asset) => animated.holds(asset) || films.steps(asset));
const frameStep = (label: string, by: number, keys: Shortcut[]): Command => ({
  label,
  keys,
  unavailable: () =>
    noneSelected() ??
    (selectedStepping().length > 0
      ? undefined
      : "Only animated images and videos go frame by frame"),
  run: () => {
    const assets = selectedStepping();
    animated.step(assets, by);
    films.step(assets, by);
    refreshBar();
  },
});
/**
 * The animated images and videos of the selection's assets, wherever they show, that the speed
 * commands set, as a still selected with them takes no speed, and those locked take it from the
 * others of their asset.
 */
const paced = (): string[] => {
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
  const board = opened?.board;
  const [id] = paced();
  const kind = id === undefined ? undefined : board?.elements[id]?.kind;
  return (
    (kind?.type === "image" ? board && assetPlayback(board).get(kind.asset)?.speed : undefined) ?? 1
  );
};
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
  unavailable: () =>
    noneSelected() ??
    (opened && core.bounds(opened.editor, editing.selection())
      ? undefined
      : "Comments do not turn"),
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
  unavailable: () => (editing.selection().length < 3 ? "Select three elements or more" : undefined),
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
    (styleCard.common().includes("paper") ? PAPERS[at]?.label : undefined) ??
    (styleCard.highlighting() ? highlight(at) : PALETTE[at]!).label,
  keys: [{ key: String(at + 1), code: `Digit${at + 1}` }],
  unavailable() {
    const can = styleCard.common();
    if (can.includes("paper")) {
      return PAPERS[at] ? undefined : `Sticky notes come in ${PAPERS.length} papers`;
    }
    return (
      nothingToStyle() ??
      (can.includes("colour") ? undefined : "Not everything selected takes a colour")
    );
  },
  run: () =>
    styleCard.set(
      styleCard.common().includes("paper")
        ? { paper: PAPERS[at]!.paper }
        : { colour: PALETTE[at]!.colour },
    ),
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
    (styleCard.common().includes(setting) ? undefined : "Not everything selected is text"),
  run: () => styleCard.set({ [setting]: styleCard.value(setting) !== true }),
  once: true,
});
const resize = (label: string, larger: boolean, keys: Shortcut[]): Command => ({
  label,
  keys,
  unavailable: () =>
    noneSelected() ??
    (styleCard.common().includes("size") ? undefined : "Not everything selected is text"),
  run: () => styleCard.resize(larger),
});
const furthest: Shortcut = mac ? { alt: true } : { shift: true };
const backspace: Shortcut = { key: "backspace" };
const deleteKey: Shortcut = { key: "delete" };
const shiftZ: Shortcut = { key: "z", command: true, shift: true };
const ctrlY: Shortcut = { key: "y", ctrl: true };

const commands = {
  select: { label: "Select", keys: [{ key: "v" }], run: () => useTool("select") },
  hand: { label: "Hand", keys: [{ key: "h" }], run: () => useTool("hand") },
  eraser: {
    label: "Eraser",
    keys: [{ key: "e" }],
    unavailable: noneShown,
    run: () => useTool("eraser"),
  },
  pen: {
    label: "Pen",
    keys: [{ key: "d" }],
    unavailable: noneShown,
    run: () => useTool("pen"),
  },
  highlighter: {
    label: "Highlighter",
    keys: [{ key: "d", shift: true }],
    unavailable: noneShown,
    run: () => useTool("highlighter"),
  },
  arrow: {
    label: "Arrow",
    keys: [{ key: "a" }],
    unavailable: noneShown,
    run: () => useTool("arrow"),
  },
  line: { label: "Line", keys: [{ key: "l" }], unavailable: noneShown, run: () => useTool("line") },
  rectangle: {
    label: "Rectangle",
    keys: [{ key: "r" }],
    unavailable: noneShown,
    run: () => useTool("rectangle"),
  },
  ellipse: {
    label: "Ellipse",
    keys: [{ key: "o" }],
    unavailable: noneShown,
    run: () => useTool("ellipse"),
  },
  cross: {
    label: "Cross",
    keys: [{ key: "x" }],
    unavailable: noneShown,
    run: () => useTool("cross"),
  },
  triangle: { label: "Triangle", unavailable: noneShown, run: () => useTool("triangle") },
  diamond: { label: "Diamond", unavailable: noneShown, run: () => useTool("diamond") },
  star: { label: "Star", unavailable: noneShown, run: () => useTool("star") },
  polygon: { label: "Polygon", unavailable: noneShown, run: () => useTool("polygon") },
  note: { label: "Text", keys: [{ key: "t" }], unavailable: noneShown, run: () => useTool("note") },
  sticky: {
    label: "Sticky note",
    keys: [{ key: "n" }],
    unavailable: noneShown,
    run: () => useTool("sticky"),
  },
  comment: {
    label: "Comment",
    keys: [{ key: "c" }],
    unavailable: noneShown,
    run: () => useTool("comment"),
  },
  addImages: {
    label: "Add images…",
    keys: [{ key: "i" }],
    unavailable: noneShown,
    run: () => addPicked(viewport.centre()),
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
    label: () => (savesToFiles() ? "Save" : "Save…"),
    keys: [{ key: "s", command: true }],
    unavailable: () => loadingBoard() ?? noBoard(),
    // Where the browser cannot write a board, as a ZIP file it downloads.
    run: () =>
      report(platform.cannotSave !== undefined && !savesToFiles() ? exportZip() : life.save()),
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
    unavailable: () => (exporting ? "An export is under way" : noBoard()),
    run: () => report(exportZip()),
  },
  exportPng: {
    label: () => (pictureCard.isOpen() ? "Hide export" : "Export the selection as PNG…"),
    keys: [{ key: "e", command: true, shift: true }],
    unavailable: unexportable,
    run: () => {
      if (pictureCard.isOpen()) {
        pictureCard.close();
      } else {
        styleCard.close();
        // As the picture would hide what they draw or erase, which closes it again.
        if (drawTool() !== undefined || tool === "eraser") {
          useTool("select");
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
    unavailable: () => (pictureCard.isOpen() ? unexportable() : "Open the export card first"),
    run: () => report(exportPng(pictureCard.options())),
  },
  copyPng: {
    label: "Copy as PNG",
    keys: [{ key: "c", shift: true, alt: true }],
    unavailable: unexportable,
    run: () => copyPng(pictureCard.options()),
    once: true,
  },
  undo: {
    label: "Undo",
    keys: [{ key: "z", command: true }],
    unavailable: () => (opened?.editor.canUndo() ? undefined : "Nothing to undo"),
    run: () => editing.undo(),
  },
  redo: {
    label: "Redo",
    keys: mac ? [shiftZ, ctrlY] : [ctrlY, shiftZ],
    unavailable: () => (opened?.editor.canRedo() ? undefined : "Nothing to redo"),
    run: () => editing.redo(),
  },
  selectAll: {
    label: "Select all",
    keys: [{ key: "a", command: true }],
    // Not before the board shows, which would select what nobody sees yet.
    unavailable: () =>
      noneShown() ?? (opened?.board.draw_order.length ? undefined : "The board is empty"),
    run: () => editing.selectAll(),
  },
  escape: { label: "Go back up, or deselect", keys: [{ key: "escape" }], run: escape },
  cut: {
    label: "Cut",
    keys: [{ key: "x", command: true }],
    unavailable: noneSelected,
    run: () => clip.copy(true),
  },
  copy: {
    label: "Copy",
    keys: [{ key: "c", command: true }],
    unavailable: noneSelected,
    run: () => clip.copy(false),
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
    run: duplicate,
  },
  remove: {
    label: "Delete",
    keys: mac ? [backspace, deleteKey] : [deleteKey, backspace],
    unavailable: noneSelected,
    run: () => editing.remove(),
  },
  // By the bracket typed, or where it sits on US keys where the layout types it with more keys, as
  // with AltGr. With ⌥ on macOS, whose browsers switch tabs on ⌘⇧ and a bracket, but Shift
  // elsewhere, where Ctrl and Alt together are AltGr.
  front: restack("Bring to front", "front", {
    key: "]",
    code: "BracketRight",
    command: true,
    ...furthest,
  }),
  forward: restack("Bring forward", "forward", { key: "]", code: "BracketRight", command: true }),
  backward: restack("Send backward", "backward", { key: "[", code: "BracketLeft", command: true }),
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
  sameWidth: { label: "Same width", unavailable: fewImages, run: () => editing.normalize("width") },
  // Figma's keys.
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
      (selectedKinds().some((kind) => core.rotationOf(kind) !== 0)
        ? undefined
        : "Nothing selected is turned"),
    run: () => editing.straighten(),
  },
  actualSize: {
    label: "Actual size",
    keys: [{ key: "t", alt: true }],
    unavailable: () =>
      noneSelected() ??
      (selectedImages().length > 0 ? undefined : "Only images have an actual size") ??
      (atActualSize() ? "Already at actual size" : undefined),
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
    label: () => (selectedMoving().some(moving) ? "Pause" : "Play"),
    keys: [{ key: "p" }],
    unavailable: () =>
      noneSelected() ??
      (selectedMoving().length > 0 ? undefined : "Only animated images and videos play"),
    run: () => {
      const assets = selectedMoving();
      const playing = !assets.some(moving);
      animated.play(assets, playing);
      films.play(assets, playing);
      refreshBar();
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
      noneSelected() ?? (selectedAssets().some(films.holds) ? undefined : "Only videos have sound"),
    run: () => {
      const assets = selectedAssets().filter(films.holds);
      films.sound(assets, !assets.some(films.sounding));
      refreshBar();
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
    unavailable: () => (editing.selection().length < 2 ? "Select two elements or more" : undefined),
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
    run: () => groupTitles.write(editing.selection()[0]!),
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
      if (opened) {
        viewport.look(fit(extent(opened), viewport.size()));
      }
    },
  },
  fitSelection: {
    label: "Zoom to selection",
    keys: [{ code: "Digit2", shift: true }],
    unavailable: noneSelected,
    run: () => fitTo(editing.selection()),
  },
  hints: {
    label: "Hints",
    run: () => {
      hintsShown = !hintsShown;
      remember(HINTS, hintsShown ? undefined : "hidden");
      refreshBar();
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
      const at = BACKGROUNDS.indexOf(opened!.board.background);
      useBackground(BACKGROUNDS[(at + 1) % BACKGROUNDS.length]!);
    },
    once: true,
  },
  snap: {
    label: "Snap to grid",
    run: () => {
      snapping = !snapping;
    },
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
    run: () => report(allowAgents(!agentsAllowed)),
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
      refreshBar();
    },
  },
  keepStyle: {
    label: "Keep style open",
    run: () => {
      styleKept = !styleKept;
      remember(KEEP_STYLE, styleKept ? "on" : undefined);
      styleCard.keepOpen(styleKept);
      refreshBar();
    },
  },
  measurements: {
    label: "Measurements",
    run: () => {
      measurements.hidden = !measurements.hidden;
      drawRate = undefined;
      draws.watch(!measurements.hidden);
      showMetrics();
    },
  },
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
  style: {
    label: () => (styleCard.isOpen() ? "Hide style" : "Show style"),
    keys: [{ key: "s", shift: true }],
    unavailable: () =>
      nothingToStyle() ??
      (styleCard.common().length > 0 || styleCard.images() || styleCard.frames()
        ? undefined
        : "Comments have no style"),
    run: () => {
      if (styleCard.isOpen()) {
        styleCard.close();
      } else {
        pictureCard.close();
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
      noneSelected() ?? (styleCard.common().length > 0 ? undefined : "Comments have no style"),
    run: () => styleCard.copy(),
  },
  pasteStyle: {
    label: "Paste style",
    keys: [{ key: "v", code: "KeyV", command: true, alt: true }],
    unavailable: () => noneSelected() ?? (styleCard.canPaste() ? undefined : "Copy a style first"),
    run: () => styleCard.paste(),
  },
  contextMenu: {
    label: "Show the context menu",
    keys: [{ key: "contextmenu" }, { key: "f10", shift: true }],
    unavailable: noneShown,
    run: contextMenuFromKeys,
  },
  find: {
    label: "Find a command…",
    keys: [
      { key: "k", command: true },
      { key: "/", code: "Slash", command: true },
    ],
    run: () => openFinder(listed),
    once: true,
  },
} satisfies Record<string, Command>;
const leaveCompact: Command = { ...commands.compact, label: "Leave compact mode" };
const colourCommands = [
  commands.colour1,
  commands.colour2,
  commands.colour3,
  commands.colour4,
  commands.colour5,
  commands.colour6,
];
/** Whether what each turns on and off is on. */
const SWITCHES = new Map<Command, () => boolean>([
  [commands.ellipticalCrop, elliptical],
  [commands.greyscale, greyed],
  [commands.snap, () => snapping],
  [commands.snapNeighbours, () => aligning],
  [commands.highContrast, () => appearance.highContrast()],
  [commands.hints, () => hintsShown],
  [commands.measurements, () => !measurements.hidden],
  [commands.greyBoard, () => viewport.greyed()],
  [commands.mirrorBoard, () => viewport.mirrored()],
  [commands.alwaysOnTop, () => onTop],
  [commands.compact, () => compact],
  [commands.hoverPlay, () => hoverPlay],
  [commands.keepStyle, () => styleKept],
  [commands.agentAccess, () => agentsAllowed],
]);
/** Whether each is the one in use among those that exclude each other. */
const TICKS = new Map<Command, () => boolean>([
  ...BACKGROUNDS.map((to): [Command, () => boolean] => [
    commands[to],
    () => opened?.board.background === to,
  ]),
  ...SCHEMES.map((to): [Command, () => boolean] => [
    commands[to],
    () => appearance.scheme() === to,
  ]),
]);
/** The menu each sits in, which the finder names where theirs would not tell alone. */
const WITHIN = new Map<Command, string>(
  (
    [
      ["Align", [commands.alignLeft, commands.alignCentre, commands.alignRight]],
      ["Align", [commands.alignTop, commands.alignMiddle, commands.alignBottom]],
      [
        "Arrange",
        [
          commands.arrangeByName,
          commands.arrangeBySize,
          commands.arrangeByColour,
          commands.arrangeRandomly,
          commands.sameHeight,
          commands.sameWidth,
        ],
      ],
      [
        "Grid",
        [commands.plain, commands.grid, commands.dots, commands.snap, commands.snapNeighbours],
      ],
      ["Theme", [commands.light, commands.dark, commands.system, commands.highContrast]],
      [
        "View",
        [
          commands.greyBoard,
          commands.mirrorBoard,
          commands.hints,
          commands.measurements,
          commands.alwaysOnTop,
          commands.compact,
        ],
      ],
      ["Settings", [commands.hoverPlay, commands.keepStyle, commands.agentAccess]],
      ["Colour", colourCommands],
    ] satisfies [string, Command[]][]
  ).flatMap(([name, members]) => members.map((member): [Command, string] => [member, name])),
);
/** What only answers keys, or opens the finder. */
const UNLISTED = new Set<Command>([
  commands.escape,
  commands.contextMenu,
  commands.find,
  // The export card's own button, which says its keys.
  commands.savePng,
]);

const bar = toolbar(
  byId("toolbar"),
  [
    [
      { command: commands.select, icon: "pointer", pressed: () => tool === "select" },
      { command: commands.hand, icon: "hand", pressed: () => tool === "hand" },
      { command: commands.addImages, icon: "photo" },
    ],
    [
      {
        label: "Pens and eraser",
        tools: [
          drawing("pen", "pencil"),
          drawing("highlighter", "highlighter"),
          { command: commands.eraser, icon: "eraser", pressed: () => tool === "eraser" },
        ],
      },
      {
        label: "Shapes",
        tools: [
          drawing("arrow", "arrow"),
          drawing("line", "line"),
          drawing("rectangle", "square"),
          drawing("ellipse", "circle"),
          drawing("triangle", "triangle"),
          drawing("diamond", "diamond"),
          drawing("star", "star"),
          drawing("polygon", "pentagon"),
          drawing("cross", "cross"),
        ],
      },
      {
        label: "Text, sticky notes, and comments",
        tools: [
          drawing("note", "typography"),
          drawing("sticky", "note"),
          drawing("comment", "pinnedNote"),
        ],
      },
    ],
    [
      {
        zoom: () => {
          const zoom = viewport.zoom();
          return zoom === undefined ? undefined : percent(zoom);
        },
        unavailable: noneShown,
        entries: zooms,
      },
      { command: steady(commands.undo), icon: "undo" },
      { command: steady(commands.redo), icon: "redo" },
    ],
  ],
  () => [
    commands.find,
    "separator",
    commands.newBoard,
    commands.open,
    commands.openZip,
    commands.save,
    commands.saveAs,
    commands.exportZip,
    "separator",
    grids(),
    themes(),
    views(),
    settings(),
  ],
);
const look = styles();
const styleCard = card(
  {
    current: () => opened,
    selection: () => editing.selection(),
    box: () => editing.box(),
    tool: () => {
      const tip = penStyling();
      return tip && look.dressed(core.strokeKind([{ x: 0, y: 0 }], 0, tip), 1);
    },
    client: (point) => viewport.client(point),
    zoom: () => viewport.zoom(),
    // Its chip makes way for the export card.
    busy: () => busy() || pictureCard.isOpen(),
    reading: () => editing.reading(),
    floor: () => bar.top(),
    apply: (work) => editing.apply(work),
    adjust: (work) => editing.adjust(work),
    finishAdjusting: () => editing.finishAdjusting(),
    adjusting: () => editing.adjusting(),
    pick: () => picker.start(false),
    explain: (element, explanation) => bar.explain(element, explanation),
    say: (said) => bar.say(said),
    media,
    trimmed: () => refreshBar(),
  },
  look,
  {
    colours: colourCommands,
    bold: commands.bold,
    italic: commands.italic,
    strike: commands.strike,
    greyscale: commands.greyscale,
    flipHorizontally: commands.flipHorizontally,
    flipVertically: commands.flipVertically,
    crop: commands.crop,
    rectangularCrop: commands.rectangularCrop,
    ellipticalCrop: commands.ellipticalCrop,
    play: commands.play,
    previousFrame: commands.previousFrame,
    nextFrame: commands.nextFrame,
    slower: commands.slower,
    faster: commands.faster,
    sound: commands.sound,
    open: commands.style,
  },
);
const pictureCard = exportCard(
  {
    planned: (options) =>
      opened === undefined || renderer === undefined || editing.cropping() !== undefined
        ? undefined
        : planned(
            { opened, drawings, crossedOut },
            editing.selection(),
            options,
            renderer.maxTextureSide,
          ),
    client: (point) => viewport.client(point),
    busy,
    floor: () => bar.top(),
    explain: (element, explanation) => bar.explain(element, explanation),
    changed: showPicture,
    chose: (options) => remembered(options).forEach(([key, value]) => remember(key, value)),
    save: (options) => report(exportPng(options)),
    copy: copyPng,
  },
  recalled(recall),
  { save: commands.savePng.keys[0]!, copy: commands.copy.keys[0]! },
);
// As a message or a hint showing in the toolbar raises it, which the cards stay above.
new ResizeObserver(() => {
  styleCard.frame();
  pictureCard.frame();
}).observe(byId("toolbar"));
styleCard.keepOpen(styleKept);
const picker = sampler(
  {
    read: readBoard,
    picked(colour) {
      if (styleCard.common().includes("colour")) {
        styleCard.set({ colour });
      } else {
        look.pick(colour);
        bar.say(`Picked ${colour}, which the style card keeps`);
      }
      styleCard.refresh();
    },
    changed: refreshBar,
  },
  viewport.host,
);
refreshBar();
if (platform.titleBar) {
  handle(byId("handle"), viewport.host, platform.titleBar.drag, leaveCompact);
}
// The page's own copy, cut, and paste events run these, which handling their keys would cancel.
const native = new Set<Command>([commands.cut, commands.copy, commands.paste]);
// The browser would print the page, which shows nothing of the board.
const print: Command = {
  label: "Print",
  keys: [{ key: "p", command: true }],
  unavailable: () => "Planche does not print",
  run() {},
  everywhere: true,
};
listen(
  [...Object.values(commands).filter((command) => !native.has(command)), print],
  (command) =>
    !menuOpen() &&
    (!busy() ||
      (editing.cropping() !== undefined &&
        (command === commands.resetCrop || command === commands.ellipticalCrop))),
);
addEventListener("keydown", (event) => {
  // A focused button takes Space to press itself.
  if (
    event.key !== " " ||
    spaceHeld ||
    menuOpen() ||
    typing(event.target) ||
    event.target instanceof HTMLButtonElement
  ) {
    return;
  }
  event.preventDefault();
  holdSpace(true);
});
addEventListener("keyup", (event) => event.key === " " && holdSpace(false));
addEventListener("keydown", (event) => {
  const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  if (
    typed(event) !== "s" ||
    !plain ||
    event.repeat ||
    menuOpen() ||
    busy() ||
    typing(event.target) ||
    noneShown()
  ) {
    return;
  }
  event.preventDefault();
  picker.start(true);
});
addEventListener(
  "keyup",
  (event) => typed(event) === "s" && picker.sampling() === "holding" && picker.end(),
);
addEventListener("blur", () => holdSpace(false));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
animated.reduce(reducedMotion.matches);
films.reduce(reducedMotion.matches);
films.playOnHover(hoverPlay);
reducedMotion.addEventListener("change", () => {
  animated.reduce(reducedMotion.matches);
  films.reduce(reducedMotion.matches);
  refreshBar();
});
addEventListener("blur", () => void life.saver()?.flush());
addEventListener("pagehide", () => void life.saver()?.flush());
addEventListener("beforeunload", () => void life.saver()?.flush());
addEventListener("focus", () => report(life.saver()?.check() ?? Promise.resolve()));
learnKeys();
addEventListener("focus", learnKeys);
// Before the letter it comes with, as the layout may have changed without the window losing focus.
addEventListener("keydown", (event) => event.key === "Alt" && !event.repeat && learnKeys());
document.addEventListener("visibilitychange", () =>
  document.visibilityState === "hidden"
    ? void life.saver()?.flush()
    : report(life.saver()?.check() ?? Promise.resolve()),
);
platform.whenClosing?.(() => life.closing());
document.addEventListener("contextmenu", (event) => {
  // The field's own menu offers to paste.
  if (typing(event.target)) {
    return;
  }
  // The webview's own menu would offer to reload, and lose the board.
  event.preventDefault();
  const at = viewport.host.contains(event.target as Node) ? viewport.at(event) : undefined;
  // One that the keys opened already, or any over the toolbar.
  if (at === undefined || menuOpen() || busy()) {
    return;
  }
  const titled = titledGroup(event.target);
  const pin = pinned(event.target) ?? lockedPin(event.target) ?? titled;
  const locked = editing.lockedAt(at, pin);
  contextMenu(editing.aim(at, pin), at, { x: event.clientX, y: event.clientY }, locked, titled);
});

// The window outlives a reload of the page, so it follows how the page starts, even when the
// browser forgot.
if (platform.keepOnTop) {
  report(keepOnTop(recall(ON_TOP) === "on"));
}
if (platform.titleBar) {
  report(platform.titleBar.show(true));
}
await Promise.all([core.start(), loadFont()]);
receive(viewport, (incoming, at) => report(addImages(incoming, at)));
const clip = clipboard(viewport, {
  copy(cut) {
    const ids = editing.selection();
    if (opened === undefined || ids.length === 0 || (cut && busy())) {
      return undefined;
    }
    return core.copy(opened.editor, ids);
  },
  copyable: () => editing.selection().length > 0,
  bytes: (copied) =>
    opened ? reader(opened, copiedAssets(copied), fleeting()) : async () => new Map(),
  cut: () => editing.remove(),
  png() {
    const image = selectedImage();
    // Not a video, whose whole file a copy would read and hash for its first frame.
    if (!opened || !image || crossedOut.has(image.asset) || films.holds(image.asset)) {
      return undefined;
    }
    const key = `${image.asset} ${JSON.stringify(image.edits)}`;
    if (copying?.key !== key) {
      const made = {
        key,
        png: still(opened, image).finally(() => {
          if (copying === made) {
            copying = undefined;
          }
        }),
      };
      copying = made;
    }
    return copying.png;
  },
  failed: (error, copied) =>
    bar.say(`${copied ? "Copied without the image" : "Nothing was copied"}. ${message(error)}`),
  pasted: (pasted, at) => report(pasteElements(pasted, at)),
  received: (incoming, at) => report(addImages(incoming, at)),
});
report(serveAgents());
// Something to drop images on from the start.
report(life.start());

/** A drag under way, which a command or a menu would cut across. */
function busy(): boolean {
  return editing.busy() || viewport.panning();
}

function drawing(draw: Draw, name: Icon): Button {
  return { command: commands[draw], icon: name, pressed: () => tool === draw };
}

/** For its button, which keeps its state while a gesture or writing holds undo and redo back. */
function steady(command: Command): Command {
  let reason = command.unavailable?.();
  return {
    ...command,
    unavailable: () => (editing.busy() ? reason : (reason = command.unavailable?.())),
  };
}

function drawTool(): Draw | undefined {
  return tool === "select" || tool === "hand" || tool === "eraser" ? undefined : tool;
}

function useTool(next: typeof tool): void {
  tool = next;
  // Whose drawing would go unseen under the picture.
  if (drawTool() !== undefined || tool === "eraser") {
    pictureCard.close();
  }
  // So that the card shows the pen's style.
  if (isTip(tool)) {
    editing.select([]);
  }
  viewport.hand(tool === "hand" || spaceHeld);
  viewport.host.classList.toggle("drawing", drawTool() !== undefined);
  viewport.host.classList.toggle("erasing", tool === "eraser");
  refreshBar();
  styleCard.refresh();
}

/** The tip whose style the card sets, with nothing selected. */
function penStyling(): Tip | undefined {
  return isTip(tool) && editing.selection().length === 0 ? tool : undefined;
}

function placeNow(into: Renderer, board: Opened): void {
  exposed = exposure();
  into.place(drawnNow(board));
}

/** What draws, with what the pen draws while pressed over it, or the picture the export card frames. */
function drawnNow(board: Opened): Placed[] {
  const picture = pictureCard.plan();
  if (picture) {
    const { background } = pictureCard.options();
    const behind = { backing: backing(picture.area, background), light: background === "white" };
    const ids = editing.selection();
    return exposing(board, lettering, ids, behind, editing.writing(), crossedOut);
  }
  const adding = inking && { item: inking, group: editing.entered() };
  return placed(board, lettering, editing.writing(), crossedOut, adding);
}

function holdSpace(held: boolean): void {
  if (held !== spaceHeld) {
    spaceHeld = held;
    useTool(tool);
  }
}

function percent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

function zooms(): Entry[] {
  const now = viewport.zoom();
  return [
    commands.zoomIn,
    commands.zoomOut,
    commands.fit,
    commands.fitSelection,
    "separator",
    ...ZOOMS.map((zoom) => ({
      ...zoomTo(percent(zoom), zoom, zoom === 1 ? commands.zoomActual.keys : undefined),
      checked: now !== undefined && percent(now) === percent(zoom),
    })),
  ];
}

/** Zooms to fit `ids`, when any of them shows. */
function fitTo(ids: string[]): void {
  const area = opened && extent(opened, ids);
  if (area) {
    viewport.look(fit(area, viewport.size()));
  }
}

function grids(): Entry {
  return {
    ...commands.nextBackground,
    options: [
      ...BACKGROUNDS.map((background) => stated(commands[background])),
      "separator",
      stated(commands.snap),
      stated(commands.snapNeighbours),
    ],
  };
}

function themes(): Entry {
  return submenu("Theme", [
    ...SCHEMES.map((scheme) => stated(commands[scheme])),
    "separator",
    stated(commands.highContrast),
  ]);
}

function views(): Entry {
  return submenu(
    "View",
    sectioned([
      [stated(commands.greyBoard), stated(commands.mirrorBoard)],
      [
        stated(commands.hints),
        stated(commands.measurements),
        ...(platform.keepOnTop ? [stated(commands.alwaysOnTop)] : []),
        ...(platform.titleBar ? [stated(commands.compact)] : []),
      ],
      measurements.hidden ? [] : TEST_PHOTOS.map(testPhotosItem),
    ]),
  );
}

/** Ticked, or switched on or off, where it says what it does. */
function stated(command: Command): Item {
  const on = SWITCHES.get(command);
  if (on) {
    return { ...command, checked: on(), toggle: true };
  }
  const ticked = TICKS.get(command);
  return ticked ? { ...command, checked: ticked() } : command;
}

function listed(): Listed[] {
  return Object.values(commands)
    .filter((command) => !UNLISTED.has(command))
    .map((command) => ({ ...stated(command), within: WITHIN.get(command) }));
}

function testPhotosItem(count: number): Item {
  return {
    label: `Add ${count} test photos`,
    unavailable: () => noneShown() ?? (savesToFiles() ? NOT_FOR_TEST_PHOTOS : undefined),
    run: () => report(addTestPhotos(count)),
  };
}

function learnKeys(): void {
  if (mac && platform.layout) {
    void platform.layout().then(learnLayout, () => learnLayout(undefined));
  }
}

/** Whether the board saves itself into a folder or a ZIP file, rather than in the session or nowhere. */
function savesToFiles(): boolean {
  const saver = life.saver();
  return saver !== undefined && !saver.store.session;
}

function settings(): Entry {
  return submenu("Settings", [
    stated(commands.hoverPlay),
    stated(commands.keepStyle),
    ...(platform.agent ? [stated(commands.agentAccess)] : []),
  ]);
}

/**
 * Ready to answer before any agent may ask, then on or off as it was left. The shell follows,
 * even when the browser forgot, so that the menu's switch never hides access left on.
 */
async function serveAgents(): Promise<void> {
  const { agent } = platform;
  if (agent === undefined) {
    return;
  }
  await agent.serve((call) =>
    answer(call, {
      opened: () => opened,
      unsaved: () => life.unsaved(),
      selection: () => editing.selection(),
      entered: () => editing.entered(),
      writing: () => editing.writing(),
      shown: () => {
        const camera = viewport.camera();
        return camera && onScreen(camera, viewport.size());
      },
      halfDrawn: () => halfDrawn || present.reloading(),
      drawNow: () => viewport.drawNow(),
      async render(request) {
        if (opened === undefined || renderer === undefined) {
          throw new Error("Planche shows no board yet");
        }
        const background = getComputedStyle(document.body).backgroundColor;
        return render({ opened, renderer, drawings, crossedOut, background }, request);
      },
      background: () => getComputedStyle(document.body).backgroundColor,
      loading: () => life.loading(),
      busy: () => editing.busy(),
      idle: () => editing.idle(),
      apply: (work) => editing.apply(work),
      keep,
      zoom: () => viewport.zoom(),
      centre: () => viewport.centre(),
      select: (ids) => editing.select(ids),
      frame: fitTo,
    }),
  );
  await allowAgents(recall(AGENT) === "on");
}

/** Remembered once it works, so that a refusal leaves the choice as it was. */
async function allowAgents(on: boolean): Promise<void> {
  try {
    await platform.agent?.allow(on);
  } catch (error) {
    throw new Error(on ? `Agent access stays off, as ${String(error)}` : String(error), {
      cause: error,
    });
  }
  agentsAllowed = on;
  remember(AGENT, on ? "on" : undefined);
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
    bar.say(
      `Compact mode: drag the top edge to move, ${describe(commands.compact.keys[0]!)} or right-click to leave`,
    );
  }
}

/** One that only opens its options, so never runs. */
function submenu(label: string, options: Entry[]): Item {
  return { label, run() {}, options };
}

function sectioned(sections: Entry[][]): Entry[] {
  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, at) => (at > 0 ? ["separator", ...section] : section));
}

/** Of the options that apply to the selection, and left out of it when none does. */
function relevantSubmenu(label: string, options: Entry[]): Item {
  const shown = relevant(options);
  return {
    ...submenu(label, shown),
    unavailable: () => (shown.length > 0 ? undefined : "None applies"),
  };
}

/** Strokes and text draw in the theme's colours. */
function restyle(): void {
  renderer?.restyle();
  viewport.redraw();
}

function useBackground(background: Background): void {
  if (background !== "plain") {
    snapping = true;
  }
  editing.background(background);
}

/**
 * Esc lets go of a colour being picked first, then of the style card or the export card, then of
 * the tool in use, which leaves the selection to act on, then of the group gone into, one level
 * at a time, then of the selection.
 */
function escape(): void {
  if (picker.sampling()) {
    picker.end(true);
  } else if (styleCard.isOpen()) {
    styleCard.close();
  } else if (pictureCard.isOpen()) {
    pictureCard.close();
  } else if (tool !== "select") {
    useTool("select");
  } else if (!editing.up()) {
    editing.select([]);
  }
}

async function arrange(label: string, order: Ordering): Promise<void> {
  const target = opened;
  const ids = editing.selection();
  if (target === undefined || arranging) {
    return;
  }
  arranging = true;
  try {
    const working = order(target, ids);
    const slow = working instanceof Promise;
    if (slow) {
      bar.say(`Arranging ${label.toLowerCase()}…`, true);
    }
    const chosen = await working;
    await editing.idle();
    const selection = new Set(editing.selection());
    if (
      opened !== target ||
      selection.size !== ids.length ||
      ids.some((id) => !selection.has(id))
    ) {
      bar.say("Not arranged, as the selection changed");
    } else {
      editing.arrange(chosen);
      if (slow) {
        bar.say(`Arranged ${label.toLowerCase()}`);
      }
    }
  } finally {
    arranging = false;
  }
}

function selectsGroup(): boolean {
  return editing.selection().some((id) => opened?.board.elements[id]?.kind.type === "group");
}

function showComments(): void {
  if (opened) {
    const { board, editor } = opened;
    comments.show(board, editing.selection(), editing.writing());
    const lone = loneGroup();
    const offered = lone && lone.title === undefined ? editing.selection()[0] : undefined;
    groupTitles.show(board, (id) => core.extent(editor, [id]), editing.selection(), offered);
  }
}

/** Gives the group `id` its title, none when blank. */
function retitle(id: string, title: string): void {
  const kind = opened?.board.elements[id]?.kind;
  if (kind?.type !== "group") {
    return;
  }
  try {
    editing.apply((editor, touched) =>
      touched.push(...editor.update(id, JSON.stringify({ ...kind, title }))),
    );
  } catch (error) {
    bar.say(message(error));
  }
}

function refreshBar(): void {
  // Buttons still explain themselves when hovered or focused.
  bar.refresh(hintsShown ? hint() : "");
}

function hint(): string {
  // As the menus name them.
  const [escapeKey, insideKey] = [commands.escape, commands.goInside].map(({ keys }) =>
    describe(keys[0]!),
  );
  const [freeKey, centreKey, stepKey] = mac ? ["⌘", "⌥", "⇧"] : ["Ctrl", "Alt", "Shift"];
  const picking = picker.sampling();
  if (picking !== undefined) {
    return `${picking === "holding" ? "Let go of S" : "Click"} to pick the colour under the pointer · ${escapeKey} to cancel`;
  }
  if (editing.writing() !== undefined) {
    return `${escapeKey} or click away to finish`;
  }
  if (styleCard.trimming()) {
    return `Drag an end, or press ← → on it, to choose what loops · ${insideKey} when done · ${escapeKey} to leave it as it was`;
  }
  if (editing.cropping() !== undefined) {
    const [resetKey, turnKey, guidesKey] = [
      commands.resetCrop.keys[0]!,
      { key: CROP_KEYS.turn },
      { key: CROP_KEYS.guides },
    ].map(describe);
    return `Drag an edge or a corner to crop, holding ${stepKey} to keep its proportions, or the inside to move it · ${turnKey} to turn it · ${guidesKey} for guides · ${resetKey} to start over · ${insideKey} or click away to crop · ${escapeKey} to leave it as it was`;
  }
  if (pictureCard.isOpen()) {
    const [saveKey, copyKey] = [commands.savePng.keys[0]!, commands.copy.keys[0]!].map(describe);
    return `${saveKey} to save · ${copyKey} to copy · click with ${stepKey} to add or take out · ${escapeKey} to leave`;
  }
  const styling =
    commands.style.unavailable() === undefined
      ? `${describe(commands.style.keys[0]!)} to style · `
      : "";
  if (tool === "hand") {
    return `Drag to move around · ${escapeKey} to select again`;
  }
  if (spaceHeld) {
    return "Drag to move around";
  }
  const offGrid = snapping ? ` · hold ${freeKey} to keep off the grid` : "";
  switch (tool === "select" ? editing.grab() : undefined) {
    case "corner":
      return `Drag to scale · hold ${centreKey} while dragging to scale around the centre${offGrid}`;
    case "side":
      return `Drag to stretch${offGrid}`;
    case "turn":
      return `Drag to turn · hold ${stepKey} to turn by 15°${snapping ? ` · hold ${freeKey} to turn freely` : ""}`;
  }
  if (tool === "eraser") {
    return `Click or drag over what to erase · a drag spares the image or note it starts on · ${escapeKey} to select again`;
  }
  if (isTip(tool)) {
    return `Drag to draw, or click for a dot · hold ${stepKey} to draw straight, by steps of 45° · ${escapeKey} to select again`;
  }
  if (tool === "arrow") {
    return `Drag from where the arrow starts to where it points · hold ${stepKey} to keep to steps of 45° · hold ${freeKey} to keep its ends from sticking · ${escapeKey} to select again`;
  }
  if (tool === "line") {
    return `Drag from one end to the other · hold ${stepKey} to keep to steps of 45° · hold ${freeKey} to keep its ends from sticking · ${escapeKey} to select again`;
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
  const opens = commands.goInside.unavailable() === undefined;
  if (editing.entered() !== undefined) {
    return `Inside a group · ${opens ? `${insideKey} to go inside · ` : ""}${escapeKey} to go back up`;
  }
  if (opens) {
    return `Drag to move · double-click or ${insideKey} to go inside · right-click for more`;
  }
  if (editing.writable()) {
    return `Drag to move · double-click or ${insideKey} to edit the text · ${styling}right-click for more`;
  }
  if (editing.loneSegment()) {
    return `Drag to move · drag an end to move it, holding ${stepKey} to keep to steps of 45° or ${freeKey} to keep it from sticking · ${styling}right-click for more`;
  }
  if (editing.selection().length > 0) {
    const crops =
      commands.crop.unavailable() === undefined ? `double-click or ${insideKey} to crop · ` : "";
    const keys = [commands.resetCrop, commands.play, commands.sound, commands.openSource]
      .filter((command) => command.unavailable() === undefined)
      .map((command) => `${describe(command.keys[0]!)} to ${named(command).toLowerCase()} · `);
    return `Drag to move, holding ${centreKey} to copy · corners scale · turn from outside a corner · ${crops}${keys.join("")}${styling}right-click for more`;
  }
  if (unlocking() !== undefined) {
    return `Locked · right-click or ${describe(commands.lock.keys[0]!)} to unlock`;
  }
  return `Drop or paste images · scroll to move around · right-click or ${describe(commands.find.keys[0]!)} for more`;
}

/**
 * About the selection, or else the board, with its images landing where it opens. Each keeps to
 * three groups, and each submenu to two, so that it stays quick to scan. What the style card and
 * the keys already reach, such as colours, stays out.
 */
function contextMenu(
  onSelection: boolean,
  at: Point,
  place: { x: number; y: number },
  locked?: string,
  titled?: string,
): void {
  const paste = { ...commands.paste, run: () => pasteAt(at) };
  // The title right-clicked, which may be a group's within the one selected.
  const rename =
    titled === undefined
      ? commands.rename
      : { label: "Rename", run: () => groupTitles.write(titled) };
  // What the right-click landed on, though the selection's box may hold it.
  const unlock =
    locked === undefined ? [] : [{ label: "Unlock", run: () => editing.unlock([locked]) }];
  const entries: Entry[] = onSelection
    ? [
        commands.cut,
        commands.copy,
        commands.copyPng,
        paste,
        commands.duplicate,
        {
          ...commands.exportPng,
          label: () => (pictureCard.isOpen() ? "Hide export" : "Export as PNG…"),
        },
        commands.remove,
        "separator",
        commands.write,
        rename,
        commands.play,
        commands.sound,
        commands.openSource,
        relevantSubmenu("Frames", [
          commands.previousFrame,
          commands.nextFrame,
          "separator",
          commands.slower,
          commands.faster,
        ]),
        {
          ...submenu("Style", [
            commands.style,
            "separator",
            commands.copyStyle,
            commands.pasteStyle,
          ]),
          unavailable: commands.style.unavailable,
        },
        relevantSubmenu("Image", [
          commands.crop,
          commands.resetCrop,
          "separator",
          stated(commands.ellipticalCrop),
          stated(commands.greyscale),
        ]),
        relevantSubmenu("Transform", [
          commands.rotateLeft,
          commands.rotateRight,
          commands.straighten,
          commands.actualSize,
          "separator",
          commands.flipHorizontally,
          commands.flipVertically,
        ]),
        "separator",
        commands.group,
        commands.ungroup,
        commands.goInside,
        commands.lock,
        ...unlock,
        relevantSubmenu("Order", [
          commands.front,
          commands.forward,
          commands.backward,
          commands.back,
        ]),
        // By the axis they move along.
        relevantSubmenu("Align", [
          commands.alignLeft,
          commands.alignCentre,
          commands.alignRight,
          commands.distributeHorizontally,
          "separator",
          commands.alignTop,
          commands.alignMiddle,
          commands.alignBottom,
          commands.distributeVertically,
        ]),
        {
          ...submenu("Arrange", [
            commands.arrangeByName,
            commands.arrangeBySize,
            commands.arrangeByColour,
            commands.arrangeRandomly,
            "separator",
            commands.sameHeight,
            commands.sameWidth,
          ]),
          unavailable: fewImages,
        },
      ]
    : [
        { ...commands.addImages, run: () => addPicked(at) },
        paste,
        commands.selectAll,
        // Which the lock command does too, as nothing is selected then.
        ...unlock.map((entry) => ({ ...entry, keys: commands.lock.keys })),
        "separator",
        commands.fit,
        grids(),
      ];
  const shown = onSelection ? relevant(entries) : entries;
  // First, as the menu may not fit a small window.
  if (compact) {
    shown.unshift(leaveCompact, "separator");
  }
  openMenu(shown, { label: onSelection ? "Selection" : "Board", place });
}

/**
 * Leaves out what does not apply to the selection, and the separators that would stand alone. Every
 * reason the entries give must be about what is selected, as one that passes would hide them for a
 * while.
 */
function relevant(entries: Entry[]): Entry[] {
  const kept: Entry[] = [];
  let parted = false;
  for (const entry of entries) {
    if (entry === "separator") {
      parted = kept.length > 0;
    } else if (entry.unavailable?.() === undefined) {
      if (parted) {
        kept.push("separator");
      }
      kept.push(entry);
      parted = false;
    }
  }
  return kept;
}

/**
 * The pixels around the device pixel under `at` as the board draws them, from the textures the
 * window already holds.
 */
async function readBoard(at: { clientX: number; clientY: number }): Promise<ImageData | undefined> {
  const camera = viewport.camera();
  if (opened === undefined || renderer === undefined || camera === undefined) {
    return undefined;
  }
  const origin = viewport.host.getBoundingClientRect();
  const scale = camera.zoom * devicePixelRatio;
  const half = Math.floor(ACROSS / 2);
  const [left, top] = [at.clientX - origin.left, at.clientY - origin.top].map((offset) =>
    Math.floor(offset * devicePixelRatio),
  );
  // The canvas's own, as it shows mirrored.
  const across = viewport.mirrored() ? renderer.canvas.width - 1 - left! : left!;
  const [x, y] = [across - half, top! - half];
  return renderer.render({
    area: {
      x: camera.x + x / scale,
      y: camera.y + y / scale,
      width: ACROSS / scale,
      height: ACROSS / scale,
    },
    size: { width: ACROSS, height: ACROSS },
    items: placed(opened, lettering, editing.writing(), crossedOut),
    background: getComputedStyle(document.body).backgroundColor,
    images: new Map(),
    texts: new Map(),
  });
}

/** Over the selection's centre, or the viewport's, as the keys point nowhere. */
function contextMenuFromKeys(): void {
  const selection = editing.centre();
  const at = selection ?? viewport.centre();
  const place = at && viewport.client(at);
  if (at && place) {
    contextMenu(selection !== undefined, at, { x: place.clientX, y: place.clientY });
  }
}

/** Opens the picker at once, as browsers only let a page do right after a click or a key. */
function addPicked(at: Point | undefined): void {
  if (at !== undefined) {
    report(addImages(pick(), at));
  }
}

/** What the clipboard holds, centred on `at`, as the menus paste. */
function pasteAt(at: Point | undefined): void {
  if (at !== undefined) {
    const key = describe(commands.paste.keys[0]!);
    report(
      clip.paste(at).catch(() => {
        throw new Error(`The browser lets only ${key} paste here`);
      }),
    );
  }
}

/** The selection again, right and down of it, as one edit that selects it. */
function duplicate(): void {
  const zoom = viewport.zoom();
  if (opened === undefined || zoom === undefined) {
    return;
  }
  const by = duplicateOffset(zoom, DUPLICATE_OFFSET);
  placeCopy(core.copy(opened.editor, editing.selection()), () => ({ x: by, y: by }));
}

/**
 * Centred on `at` by whole steps of the grid, as one edit that selects them. Images whose assets the
 * board lacks take them from the bytes copied, or are left out without them, as when copied in
 * another window.
 */
async function pasteElements({ copied, assets }: Pasted, at: Point): Promise<void> {
  const target = opened;
  const into = renderer;
  if (target === undefined) {
    return;
  }
  const shown = assetSizes(target.board);
  const lacking = copiedAssets(copied).filter((asset) => !shown.has(asset));
  const bytes = lacking.length > 0 ? await assets(lacking) : new Map<string, Blob>();
  const prepared: Added[] = [];
  const pending = lacking.values();
  await pool(
    () => pending.next().value,
    async (asset) => {
      const blob = bytes.get(asset);
      const one = blob && (await prepare(blob, LONGEST_SIDE, heldSize).catch(() => undefined));
      if (one?.asset === asset) {
        loadAtOnce(one, target, into);
        prepared.push(one);
      } else {
        release(one?.decoded);
      }
    },
  );
  await editing.idle();
  const zoom = viewport.zoom();
  if (target !== opened || renderer === undefined || zoom === undefined) {
    prepared.forEach(({ decoded }) => release(decoded));
    return;
  }
  keep(target, prepared);
  const kept = [...assetSizes(target.board).keys(), ...prepared.map(({ asset }) => asset)];
  const pasting = core.keeping(copied, kept);
  if (Object.keys(pasting.elements).length > 0) {
    placeCopy(pasting, (area) => centring(area, at, zoom));
  }
  if (Object.keys(pasting.elements).length < Object.keys(copied.elements).length) {
    bar.say("Not pasted, the images whose files are out of reach here");
  }
}

/** Into the group gone into, moved by what `by` gives for its extent, as one edit that selects it. */
function placeCopy(copied: Copied, by: (extent: Rect) => Point): void {
  const group = editing.entered();
  let pasted: string[] = [];
  editing.apply((editor, touched) => {
    const ids = renamed(copied);
    touched.push(...core.paste(editor, copied, ids, group));
    pasted = core.outermost(editor, ids, group);
    const area = core.extent(editor, pasted);
    if (area) {
      touched.push(...core.transform(editor, pasted, { place: { by: by(area) } }));
    }
  });
  editing.select(pasted);
}

/**
 * The open board's saver when the files of its images may be gone by the time a paste reads them,
 * the session's own, which leaving the board clears, or a ZIP file's, whose saves drop what the
 * board no longer shows.
 */
function fleeting(): Saving | undefined {
  const saver = life.saver();
  if (opened === undefined || saver === undefined) {
    return undefined;
  }
  // The session also saves boards read from elsewhere, whose files it leaves alone.
  const ownFiles = "write" in opened.folder;
  return (saver.store.session ? ownFiles : !ownFiles) ? saver : undefined;
}

async function show(next: Opened, camera?: Camera): Promise<string | undefined> {
  halfDrawn = true;
  try {
    return await present.show(next, camera);
  } finally {
    halfDrawn = false;
  }
}

/** Its images show crossed out, from the next draw on. */
function crossOut(into: Renderer, asset: string): void {
  crossedOut = new Set([...crossedOut, asset]);
  if (opened) {
    placeNow(into, opened);
  }
  // Its outline takes another frame than its image, and none of its pixels.
  reframe();
}

/** Side by side around `at`, at their natural size unless they would not show whole, and as one edit. */
async function addImages(incoming: Promise<Incoming[]>, at: Point): Promise<void> {
  const target = opened;
  const into = renderer;
  // By where each came, which they are laid out in.
  const prepared: (Added | undefined)[] = [];
  const failures: (string | undefined)[] = [];
  const images = await incoming;
  // Once read, as the user's pace and the platform's reading are not the app's.
  const since = performance.now();
  const pending = images.entries();
  let done = 0;
  await pool(
    () => pending.next().value,
    async ([index, image]) => {
      try {
        if ("failure" in image) {
          failures[index] = `${image.name}: ${image.failure}`;
          return;
        }
        const one: Added = {
          ...(await prepare(image.bytes, LONGEST_SIDE, heldSize)),
          filename: image.filename,
          source: image.source,
        };
        loadAtOnce(one, target, into);
        prepared[index] = one;
      } catch (error) {
        failures[index] = `${image.name}: this app cannot open it here (${message(error)})`;
      } finally {
        done += 1;
        if (images.length > 1) {
          bar.say(`Adding ${done} of ${images.length} images…`, true);
        }
      }
    },
  );
  const added = prepared.filter((one) => one !== undefined);
  // Nor the time an edit under way takes to end.
  const [, waited] = await timed(() => editing.idle());
  if (added.length > 0 && target !== undefined && target === opened && renderer !== undefined) {
    keep(target, added);
    const frames = row(
      added.map(({ natural }) => natural),
      at,
      room(),
    );
    const ids = added.map(() => newId());
    // Into the group gone into, where they stay selected.
    const group = editing.entered();
    editing.apply((editor, touched) =>
      added.forEach(({ asset, natural, filename, source }, index) => {
        touched.push(
          ...editor.add(
            ids[index]!,
            group,
            JSON.stringify(imageKind(asset, natural, frames[index]!, { filename, source })),
          ),
        );
      }),
    );
    editing.select(ids);
    untilDrawn.set(`add ${added.length} images`, since + waited);
  } else {
    added.forEach(({ decoded }) => release(decoded));
  }
  const failed = failures.filter((failure) => failure !== undefined);
  if (failed.length > 0) {
    bar.say(`Not added, ${failed.join("; ")}`);
  } else if (images.length > 1) {
    bar.say("");
  }
}

/** At once, so that bitmaps do not pile up. */
function loadAtOnce(one: Added, target: Opened | undefined, into: Renderer | undefined): void {
  if (one.decoded && into && target === opened && into === renderer) {
    load(into, new Map([[one.asset, one.decoded]]));
    one.decoded = undefined;
  }
}

function heldSize(asset: string): Size | undefined {
  return opened && loaded.has(asset) && !crossedOut.has(asset)
    ? assetSizes(opened.board).get(asset)
    : undefined;
}

/**
 * Into the board shown when asked, as `addImages` adds, unless it saves into a folder or a file once they
 * are made. A Save as while they are prepared still lets them in, as one right after they are added would.
 */
async function addTestPhotos(count: number): Promise<void> {
  const at = viewport.centre();
  if (at === undefined) {
    return;
  }
  const photos = testPhotos(count, (done) =>
    bar.say(`Making test photos, ${done} of ${count}…`, true),
  );
  await addImages(
    photos.then((made) => {
      if (!savesToFiles()) {
        return made;
      }
      bar.say("Not added, as the board now saves into a folder or a ZIP file");
      return [];
    }),
    at,
  );
}

/** What of the board shows between the handle and the toolbar, less a margin, `undefined` when none of it shows. */
function room(): Rect | undefined {
  const camera = viewport.camera();
  if (camera === undefined) {
    return undefined;
  }
  const { width, height } = viewport.size();
  // A press on the handle drags the window instead. It measures 0 while hidden.
  const top = byId("handle").getBoundingClientRect().bottom;
  const shown = onScreen(
    { ...camera, y: camera.y + top / camera.zoom },
    { width, height: Math.min(height, bar.top()) - top },
  );
  if (shown.width <= 0 || shown.height <= 0) {
    return undefined;
  }
  const margin = Math.min(ADDED_MARGIN / camera.zoom, Math.min(shown.width, shown.height) / 10);
  return {
    x: shown.x + margin,
    y: shown.y + margin,
    width: shown.width - 2 * margin,
    height: shown.height - 2 * margin,
  };
}

function keep(target: Opened, added: Added[]): void {
  if (renderer !== undefined) {
    load(
      renderer,
      new Map(added.flatMap(({ asset, decoded }) => (decoded ? [[asset, decoded] as const] : []))),
    );
  }
  animated.keep(added);
  films.keep(added);
  const fresh = new Set(added.map(({ asset }) => asset));
  crossedOut = new Set([...crossedOut].filter((asset) => !fresh.has(asset)));
  added.forEach(({ asset, bytes }) => target.added.set(core.assetPath(asset), bytes));
}

/** Bitmaps to the renderer, which takes them over, and SVGs to rasterise as they show. */
function load(into: Renderer, decoded: Map<string, Decoded>): void {
  const bitmaps = new Map<string, ImageBitmap>();
  for (const [asset, image] of decoded) {
    if (image instanceof ImageBitmap) {
      bitmaps.set(asset, image);
    } else {
      drawings.keep(asset, image);
    }
  }
  into.load(bitmaps);
  decoded.forEach((_, asset) => loaded.add(asset));
}

function changed(touched: string[]): void {
  if (
    opened === undefined ||
    (touched.length === 0 && core.background(opened.editor) === opened.board.background)
  ) {
    return;
  }
  const undrawn = refresh(opened, touched);
  pictureCard.refresh();
  overlaid.exporting(pictureCard.plan()?.area);
  if (renderer) {
    renderer.backdrop(opened.board.background);
    placeNow(renderer, opened);
  }
  life.touched(touched);
  present.edited(undrawn);
  viewport.redraw();
}

async function exportZip(): Promise<void> {
  if (opened === undefined || exporting) {
    return;
  }
  const current = opened;
  const { editor } = current;
  exporting = true;
  const snapshot = editor.snapshot();
  try {
    const sink = await platform.pickExport(`${current.folder.name}.zip`, "zip");
    if (sink === null) {
      return;
    }
    bar.say(`Exporting ${sink.name}…`, true);
    // Its images from where they lie once no save moves them.
    const write = () => writeZip(snapshot, files(current), sink);
    const saver = life.saver();
    const [count, writing] = await timed(() => (saver ? saver.during(write) : write()));
    details.set(`export ${count} files`, milliseconds(writing));
    bar.say(`Exported ${sink.name}`);
    life.saved(editor, snapshot);
  } finally {
    snapshot.free();
    exporting = false;
  }
}

async function exportPng(options: Options): Promise<void> {
  if (opened === undefined) {
    return;
  }
  if (exporting) {
    throw new Error("An export is under way");
  }
  // Before the user picks where, which would be in vain.
  ready();
  const current = opened;
  const ids = editing.selection();
  exporting = true;
  try {
    const sink = await platform.pickExport(
      pictureName(current.board, ids, current.folder.name),
      "png",
    );
    if (sink === null) {
      return;
    }
    bar.say(`Exporting ${sink.name}…`, true);
    let made: Picture;
    try {
      if (opened !== current) {
        throw new Error("Another board opened meanwhile");
      }
      made = await selectionPng(current, ids, options);
      await sink.append(new Uint8Array(await made.blob.arrayBuffer()));
    } catch (error) {
      await sink.discard().catch(() => {});
      throw error;
    }
    await sink.close();
    bar.say(`Exported ${sink.name}, ${sized(made)}`);
    pictureCard.close();
  } finally {
    exporting = false;
  }
}

function copyPng(options: Options): void {
  if (opened === undefined) {
    return;
  }
  pngCopies += 1;
  const copy = pngCopies;
  const made = selectionPng(opened, editing.selection(), options);
  const written = clip.copyImage(made.then(({ blob }) => blob));
  bar.say("Copying as PNG…", true);
  report(
    (async () => {
      if (await written) {
        bar.say(`Copied as PNG, ${sized(await made)}`);
      } else if (copy === pngCopies) {
        bar.say("");
      }
    })(),
  );
}

interface Picture {
  blob: Blob;
  size: Size;
  /** Whether it is smaller than its images would have it. */
  capped: boolean;
}

/** The elements `ids` as the board shows them, as `options` frame them. */
async function selectionPng(current: Opened, ids: string[], options: Options): Promise<Picture> {
  const scene = {
    opened: current,
    renderer: ready(),
    drawings,
    crossedOut,
    background: getComputedStyle(document.body).backgroundColor,
  };
  const textures = {
    holds: (asset: string) => loaded.has(asset),
    plays: (asset: string) => animated.holds(asset) || films.holds(asset),
    current: () => opened === current && renderer === scene.renderer,
  };
  // Its images from where they lie once no save moves them.
  const draw = () => exported(scene, ids, textures, options);
  const saver = life.saver();
  const { canvas, capped } = await (saver ? saver.during(draw) : draw());
  return { blob: await png(canvas), size: { width: canvas.width, height: canvas.height }, capped };
}

/** The renderer, once the board shows whole. */
function ready(): Renderer {
  if (renderer === undefined || halfDrawn || life.loading()) {
    throw new Error("A board is opening");
  }
  return renderer;
}

function sized({ size, capped }: Picture): string {
  return `${size.width} × ${size.height}${capped ? ", scaled down to fit" : ""}`;
}

function showPicture(): void {
  placePicture();
  styleCard.refresh();
  refreshBar();
}

function placePicture(): void {
  overlaid.exporting(pictureCard.plan()?.area);
  if (opened && renderer) {
    placeNow(renderer, opened);
  }
  viewport.redraw();
}

/**
 * What the export card frames, once the selection, or what its images show as, changed, placed
 * again only when that changed what the board shows, which an edit placed already.
 */
function reframe(): void {
  if (!pictureCard.isOpen()) {
    return;
  }
  pictureCard.refresh();
  // Closing showed the board already.
  if (pictureCard.isOpen() && exposure() !== exposed) {
    placePicture();
  }
}

/** What of the export card's picture the board shows, the same while nothing changes it. */
function exposure(): string {
  const picture = pictureCard.plan();
  return picture ? JSON.stringify([picture.area, editing.selection(), pictureCard.options()]) : "";
}

/** The desktop window keeps its own title, so there only the menu's button marks changes. */
function showTitle(): void {
  document.title = opened
    ? `${life.unsaved() ? "• " : ""}${opened.folder.name} — Planche`
    : "Planche";
}

function showMetrics(): void {
  if (measurements.hidden) {
    return;
  }
  const heap = heapInUse();
  const lines = new Map([
    ["platform", platform.name],
    ["draws", drawRate === undefined ? "…" : `${drawRate.toFixed(0)} a second`],
    ["core memory", megabytes(core.coreMemory())],
    ...(renderer === undefined
      ? []
      : [
          ["textures", megabytes(renderer.textureBytes)] as [string, string],
          ["texts", String(lettering.count())] as [string, string],
        ]),
    ...(heap === undefined ? [] : [["JS heap", megabytes(heap)] as [string, string]]),
    ...details,
  ]);
  byId("metrics").replaceChildren(
    ...[...lines].flatMap(([name, value]) => [withText("dt", name), withText("dd", value)]),
  );
}

function report(work: Promise<void>): void {
  work.catch(fail);
}

function fail(error: unknown): void {
  bar.say(message(error));
}

function withText<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}
