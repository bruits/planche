// The app: start a board, or open one from a folder or a ZIP file, look around it, add images
// to it and edit it, and save it elsewhere or export it.

import * as core from "./core.js";
import type { Background, Kind, Order, Point } from "./core.js";
import { pick, receive, type Incoming } from "./add.js";
import { answer } from "./agent.js";
import { animations } from "./animation.js";
import {
  among,
  assetsOf,
  decode,
  extent,
  files,
  holdsImage,
  imageKind,
  placed,
  open,
  prepare,
  readAssets,
  newId,
  refresh,
  release,
  row,
  untitled,
  type Added,
  type Decoded,
  type Opened,
} from "./board.js";
import { fit } from "./camera.js";
import { card } from "./card.js";
import { meanColours } from "./colour.js";
import { describe, listen, mac, typed, typing, type Command, type Shortcut } from "./commands.js";
import { edits, type Draw, type Restack } from "./edit.js";
import { handle } from "./handle.js";
import type { Icon } from "./icons.js";
import { menuOpen, openMenu, type Entry, type Item } from "./menu.js";
import { heapInUse, megabytes, milliseconds, timed, watchFrameRate } from "./metrics.js";
import { overlay } from "./overlay.js";
import { css, type Paint } from "./paint.js";
import { pinned, pins } from "./pins.js";
import { platform, type Folder } from "./platform.js";
import { recall, remember } from "./preferences.js";
import { LONGEST_SIDE, onScreen } from "./raster.js";
import { render } from "./render.js";
import { create, type Renderer } from "./renderer.js";
import { ACROSS, sampler } from "./sampler.js";
import { PALETTE, PAPERS, styles } from "./style.js";
import { loadFont, texts } from "./text.js";
import { theme, type Scheme } from "./theme.js";
import { toolbar, type Button } from "./toolbar.js";
import { vectors } from "./vector.js";
import { videos } from "./video.js";
import { view } from "./view.js";
import { writeZip, zipFolder } from "./zip.js";

/** Where the browser remembers that hints are hidden. */
const HINTS = "planche.hints";
/** Where the browser remembers that agent access is on. */
const AGENT = "planche.agent";
/** Where the browser remembers that the window stays on top. */
const ON_TOP = "planche.ontop";
const ZOOM_STEP = 1.25;
/** In the order the key goes through them. */
const BACKGROUNDS: Background[] = ["plain", "grid", "dots"];
const SCHEMES: Scheme[] = ["light", "dark", "system"];

const measurements = byId("measurements");
const details = new Map<string, string>();
const shown = overlay(byId("viewport"));
const viewport = view(byId("viewport"), {
  frame(camera, size) {
    shown.frame(camera, size);
    comments.frame(camera);
    editing.follow();
    styleCard.frame();
    if (opened && renderer) {
      drawings.update(opened.board, renderer, camera, size);
      animated.update(opened.board, renderer, camera, size);
      films.update(opened.board, renderer, camera, size);
      if (lettering.update(opened.board, renderer, camera, size, editing.writing())) {
        renderer.place(placed(opened.board, lettering, editing.writing(), unplayable));
      }
    }
  },
  failed: (error) => fail(error),
});
const lettering = texts(() => viewport.redraw());
const drawings = vectors(() => viewport.redraw());
const animated = animations(() => viewport.redraw(), () => refreshBar());
const films = videos(
  () => viewport.redraw(),
  () => refreshBar(),
  () => bar.say("A video cannot play here"),
);
const editing = edits(viewport, shown, () => opened, {
  changed,
  selectionChanged() {
    refreshBar();
    showComments();
    styleCard.refresh();
  },
  settled() {
    refreshBar();
    styleCard.refresh();
  },
  snapping: () => snapping,
  drawing: () => drawTool(),
  erasing: () => tool === "eraser",
  sampling: () => picker.sampling() !== undefined,
  drawn: () => useTool("select"),
  styled: (kind, zoom) => look.dressed(kind, zoom),
  selecting: () => tool === "select" && !spaceHeld && picker.sampling() === undefined,
  hovered: () => refreshBar(),
});
const comments = pins(byId("viewport"), { choose: (id) => editing.choose(id), write: (id) => editing.write(id) });
const appearance = theme(restyle);

let opened: Opened | undefined;
let renderer: Renderer | undefined;
let unsaved = false;
/**
 * Two boards opening at once would free each other's editor. The first one opens once the core
 * starts, which nothing may use before.
 */
let loading = true;
let halfDrawn = false;
/** On the desktop, a second export to the same file would take over the first one's draft. */
let exporting = false;
let tool: "select" | "hand" | "eraser" | Draw = "select";
/** Left out of the board, it starts as the board's background suggests. */
let snapping = false;
let unplayable: ReadonlySet<string> = new Set();
let spaceHeld = false;
/** Left out of the preferences, as a window without its title bar would open at full size. */
let compact = false;
/** Kept while the measurements are hidden, so that they show at once when opened. */
let frameRate = 0;
let hintsShown = recall(HINTS) !== "hidden";
let agentsAllowed = false;
let onTop = false;
let arranging = false;

type Ordering = (opened: Opened, ids: string[]) => Order | Promise<Order>;

const loadingBoard = () => (loading ? "A board is opening" : undefined);
const noBoard = () => (opened === undefined ? "No board is open yet" : undefined);
const noneSelected = () => (editing.selection().length === 0 ? "Nothing is selected" : undefined);
// Images within a selected group do not count, as arranging leaves groups where they are.
const fewImages = () =>
  editing.selection().filter((id) => opened?.board.elements[id]?.kind.type === "image").length < 2
    ? "Select two images or more"
    : undefined;
/** What is selected, with what the groups selected hold. */
const selectedKinds = (): Kind[] => {
  const board = opened?.board;
  const chosen = new Set(editing.selection());
  return board ? Object.entries(board.elements).flatMap(([id, { kind }]) => (among(board, id, chosen) ? [kind] : [])) : [];
};
const selectedImages = () => selectedKinds().filter((kind) => kind.type === "image");
const greyed = () => {
  const images = selectedImages();
  return images.length > 0 && images.every((kind) => kind.edits.greyscale);
};
const noneShown = () => (viewport.zoom() === undefined ? "No board is shown yet" : undefined);
const selectedAssets = () => (opened ? assetsOf(opened.board, editing.selection()) : []);
const selectedMoving = () => selectedAssets().filter((asset) => animated.holds(asset) || films.holds(asset));
const moving = (asset: string) => animated.playing(asset) || films.playing(asset);
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
    noneSelected() ?? (opened && holdsImage(opened.board, editing.selection()) ? undefined : "Only images flip"),
  run: () => editing.flip(horizontally),
});
const turn = (label: string, degrees: number, key: string): Command => ({
  label,
  keys: [{ key, shift: true }],
  unavailable: () =>
    noneSelected() ?? (opened && core.bounds(opened.editor, editing.selection()) ? undefined : "Comments do not turn"),
  run: () => editing.rotate(degrees),
});
const arrangement = (label: string, order: Ordering): Command => ({
  label,
  unavailable: () => (arranging ? "Images are being arranged" : fewImages()),
  run: () => report(arrange(label, order)),
});
const backdrop = (label: string, background: Background): Command => ({
  label,
  unavailable: noBoard,
  run: () => useBackground(background),
});
const palette = (label: string, to: Scheme): Command => ({ label, run: () => appearance.choose(to) });
/** The palette's colour, or a sticky note's paper, at `at`. */
const colour = (at: number): Command => ({
  label: () => (styleCard.common().includes("paper") ? PAPERS[at]?.label : undefined) ?? PALETTE[at]!.label,
  keys: [{ key: String(at + 1), code: `Digit${at + 1}` }],
  unavailable() {
    const can = styleCard.common();
    if (can.includes("paper")) {
      return PAPERS[at] ? undefined : `Sticky notes come in ${PAPERS.length} papers`;
    }
    return noneSelected() ?? (can.includes("colour") ? undefined : "Not everything selected takes a colour");
  },
  run: () =>
    styleCard.set(styleCard.common().includes("paper") ? { paper: PAPERS[at]!.paper } : { colour: PALETTE[at]!.colour }),
});
const textStyle = (label: string, setting: "bold" | "italic" | "strike", shortcut: Shortcut): Command => ({
  label,
  keys: [shortcut],
  unavailable: () => noneSelected() ?? (styleCard.common().includes(setting) ? undefined : "Not everything selected is text"),
  run: () => styleCard.set({ [setting]: styleCard.value(setting) !== true }),
});
const resize = (label: string, larger: boolean, keys: Shortcut[]): Command => ({
  label,
  keys,
  unavailable: () => noneSelected() ?? (styleCard.common().includes("size") ? undefined : "Not everything selected is text"),
  run: () => styleCard.resize(larger),
});
const backspace: Shortcut = { key: "backspace" };
const deleteKey: Shortcut = { key: "delete" };
const shiftZ: Shortcut = { key: "z", command: true, shift: true };
const ctrlY: Shortcut = { key: "y", ctrl: true };

const commands = {
  select: { label: "Select", keys: [{ key: "v" }], run: () => useTool("select") },
  hand: { label: "Hand", keys: [{ key: "h" }], run: () => useTool("hand") },
  eraser: { label: "Eraser", keys: [{ key: "e" }], unavailable: noneShown, run: () => useTool("eraser") },
  arrow: { label: "Arrow", keys: [{ key: "a" }], unavailable: noneShown, run: () => useTool("arrow") },
  line: { label: "Line", keys: [{ key: "l" }], unavailable: noneShown, run: () => useTool("line") },
  rectangle: { label: "Rectangle", keys: [{ key: "r" }], unavailable: noneShown, run: () => useTool("rectangle") },
  ellipse: { label: "Ellipse", keys: [{ key: "o" }], unavailable: noneShown, run: () => useTool("ellipse") },
  cross: { label: "Cross", keys: [{ key: "x" }], unavailable: noneShown, run: () => useTool("cross") },
  note: { label: "Text", keys: [{ key: "t" }], unavailable: noneShown, run: () => useTool("note") },
  sticky: { label: "Sticky note", keys: [{ key: "n" }], unavailable: noneShown, run: () => useTool("sticky") },
  comment: { label: "Comment", keys: [{ key: "c" }], unavailable: noneShown, run: () => useTool("comment") },
  addImages: {
    label: "Add images…",
    keys: [{ key: "i" }],
    unavailable: noneShown,
    run: () => addPicked(viewport.centre()),
  },
  newBoard: { label: "New board", unavailable: loadingBoard, run: () => report(newBoard()) },
  open: { label: "Open a board…", unavailable: loadingBoard, run: () => report(openBoard(() => platform.open())) },
  openZip: { label: "Open a ZIP file…", unavailable: loadingBoard, run: () => report(openBoard(openZip)) },
  saveAs: { label: "Save as…", unavailable: () => platform.cannotSave ?? noBoard(), run: () => report(saveAs()) },
  exportZip: {
    label: "Export a ZIP file…",
    unavailable: () => (exporting ? "An export is under way" : noBoard()),
    run: () => report(exportZip()),
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
    unavailable: () => noneShown() ?? (opened?.board.draw_order.length ? undefined : "The board is empty"),
    run: () => editing.selectAll(),
  },
  escape: { label: "Go back up, or deselect", keys: [{ key: "escape" }], run: escape },
  remove: {
    label: "Delete",
    keys: mac ? [backspace, deleteKey] : [deleteKey, backspace],
    unavailable: noneSelected,
    run: () => editing.remove(),
  },
  // With Alt only where the brackets sit on US keys, since AltGr, which types them on many
  // layouts, counts as Ctrl and Alt.
  front: restack("Bring to front", "front", { code: "BracketRight", command: true, alt: true }),
  forward: restack("Bring forward", "forward", { key: "]", code: "BracketRight", command: true }),
  backward: restack("Send backward", "backward", { key: "[", code: "BracketLeft", command: true }),
  back: restack("Send to back", "back", { code: "BracketLeft", command: true, alt: true }),
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
  sameHeight: { label: "Same height", unavailable: fewImages, run: () => editing.normalize("height") },
  sameWidth: { label: "Same width", unavailable: fewImages, run: () => editing.normalize("width") },
  rotateLeft: turn("Rotate left", -90, "l"),
  rotateRight: turn("Rotate right", 90, "r"),
  straighten: {
    label: "Straighten",
    keys: [{ key: "r", alt: true }],
    unavailable: () =>
      noneSelected() ??
      (selectedKinds().some((kind) => "rotation" in kind && kind.rotation !== 0) ? undefined : "Nothing selected is turned"),
    run: () => editing.straighten(),
  },
  flipHorizontally: flip("Flip horizontally", "h", true),
  flipVertically: flip("Flip vertically", "v", false),
  crop: {
    label: "Crop",
    keys: [{ key: "enter" }],
    unavailable: () => {
      const selection = editing.selection();
      const kind = selection.length === 1 ? opened?.board.elements[selection[0]!]?.kind : undefined;
      return kind?.type === "image" ? undefined : "Select one image";
    },
    run: () => editing.crop(),
  },
  resetCrop: {
    label: "Reset crop",
    keys: [{ key: "c", alt: true }],
    unavailable: () =>
      noneSelected() ?? (selectedImages().some((kind) => kind.edits.crop) ? undefined : "Nothing selected is cropped"),
    run: () => editing.resetCrop(),
  },
  greyscale: {
    label: "Greyscale",
    keys: [{ key: "g", alt: true }],
    unavailable: () =>
      noneSelected() ?? (opened && holdsImage(opened.board, editing.selection()) ? undefined : "Only images turn grey"),
    run: () => editing.greyscale(!greyed()),
  },
  play: {
    label: () => (selectedMoving().some(moving) ? "Pause" : "Play"),
    keys: [{ key: "p" }],
    unavailable: () =>
      noneSelected() ?? (selectedMoving().length > 0 ? undefined : "Only animated images and videos play"),
    run: () => {
      const assets = selectedMoving();
      const playing = !assets.some(moving);
      animated.play(assets, playing);
      films.play(assets, playing);
      refreshBar();
    },
  },
  sound: {
    label: () => (selectedAssets().some(films.sounding) ? "Turn sound off" : "Turn sound on"),
    keys: [{ key: "m" }],
    unavailable: () => noneSelected() ?? (selectedAssets().some(films.holds) ? undefined : "Only videos have sound"),
    run: () => {
      const assets = selectedAssets().filter(films.holds);
      films.sound(assets, !assets.some(films.sounding));
      refreshBar();
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
  goInside: {
    label: "Go inside",
    keys: [{ key: "enter" }],
    unavailable: () => (editing.selection().length === 1 && selectsGroup() ? undefined : "Select one group"),
    run: () => editing.goInside(),
  },
  write: {
    label: "Edit text",
    keys: [{ key: "enter" }],
    unavailable: () => (editing.writable() ? undefined : "Select one text, sticky note, shape, or comment"),
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
  actualSize: {
    label: "Zoom to 100%",
    keys: [{ key: "0", code: "Digit0", command: true }],
    unavailable: noneShown,
    run: () => viewport.zoomBy(1 / viewport.zoom()!),
  },
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
    unavailable: () => (platform.titleBar ? undefined : "Only the desktop app has a window of its own"),
    run: () => report(useCompact(!compact)),
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
  },
  snap: {
    label: "Snap to grid",
    run: () => {
      snapping = !snapping;
    },
  },
  light: palette("Light", "light"),
  dark: palette("Dark", "dark"),
  system: palette("System", "system"),
  highContrast: { label: "High contrast", run: () => appearance.toggleContrast() },
  agentAccess: { label: "Agent access", run: () => report(allowAgents(!agentsAllowed)) },
  alwaysOnTop: { label: "Always on top", run: () => report(keepOnTop(!onTop)) },
  measurements: {
    label: "Measurements",
    run: () => {
      measurements.hidden = !measurements.hidden;
      showMetrics(frameRate);
    },
  },
  style: {
    label: () => (styleCard.isOpen() ? "Hide style" : "Show style"),
    keys: [{ key: "s", shift: true }],
    unavailable: () =>
      noneSelected() ?? (styleCard.common().length > 0 || styleCard.images() ? undefined : "Comments and groups have no style"),
    run: () => (styleCard.isOpen() ? styleCard.close() : styleCard.open(true)),
  },
  colour1: colour(0),
  colour2: colour(1),
  colour3: colour(2),
  colour4: colour(3),
  colour5: colour(4),
  colour6: colour(5),
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
      noneSelected() ?? (styleCard.common().length > 0 ? undefined : "Only arrows, lines, shapes, and text have a style"),
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

const bar = toolbar(
  byId("toolbar"),
  [
    [
      { command: commands.select, icon: "pointer", pressed: () => tool === "select" },
      { command: commands.hand, icon: "hand", pressed: () => tool === "hand" },
      { command: commands.eraser, icon: "eraser", pressed: () => tool === "eraser" },
    ],
    [
      {
        label: "Shapes",
        tools: [
          drawing("arrow", "arrow"),
          drawing("line", "line"),
          drawing("rectangle", "square"),
          drawing("ellipse", "circle"),
          drawing("cross", "cross"),
        ],
      },
      {
        label: "Text, sticky notes, and comments",
        tools: [drawing("note", "typography"), drawing("sticky", "note"), drawing("comment", "message")],
      },
      { command: commands.addImages, icon: "photo" },
    ],
    [
      { command: steady(commands.undo), icon: "undo" },
      { command: steady(commands.redo), icon: "redo" },
    ],
  ],
  () => [
    commands.newBoard,
    commands.open,
    commands.openZip,
    commands.saveAs,
    commands.exportZip,
    "separator",
    commands.fit,
    commands.actualSize,
    "separator",
    grids(),
    themes(),
    views(),
  ],
);
const look = styles();
const styleCard = card(
  {
    current: () => opened,
    selection: () => editing.selection(),
    box: () => editing.box(),
    client: (point) => viewport.client(point),
    zoom: () => viewport.zoom(),
    busy,
    reading: () => editing.reading(),
    floor: () => bar.top(),
    apply: (work) => editing.apply(work),
    pick: () => picker.start(false),
    explain: (element, text) => bar.explain(element, text),
    say: (message) => bar.say(message),
  },
  look,
  {
    colours: colourCommands,
    bold: commands.bold,
    italic: commands.italic,
    strike: commands.strike,
    flipHorizontally: commands.flipHorizontally,
    flipVertically: commands.flipVertically,
    open: commands.style,
  },
);
// As a message or a hint showing in the toolbar raises it, which the card stays above.
new ResizeObserver(() => styleCard.frame()).observe(byId("toolbar"));
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
listen(Object.values(commands), () => !menuOpen() && !busy());
addEventListener("keydown", (event) => {
  // A focused button takes Space to press itself.
  if (event.key !== " " || spaceHeld || menuOpen() || typing(event.target) || event.target instanceof HTMLButtonElement) {
    return;
  }
  event.preventDefault();
  holdSpace(true);
});
addEventListener("keyup", (event) => event.key === " " && holdSpace(false));
addEventListener("keydown", (event) => {
  const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  if (typed(event) !== "s" || !plain || event.repeat || menuOpen() || busy() || typing(event.target) || noneShown()) {
    return;
  }
  event.preventDefault();
  picker.start(true);
});
addEventListener("keyup", (event) => typed(event) === "s" && picker.sampling() === "holding" && picker.end());
addEventListener("blur", () => holdSpace(false));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
animated.reduce(reducedMotion.matches);
films.reduce(reducedMotion.matches);
reducedMotion.addEventListener("change", () => {
  animated.reduce(reducedMotion.matches);
  films.reduce(reducedMotion.matches);
  refreshBar();
});
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
  contextMenu(editing.aim(at, pinned(event.target)), at, { x: event.clientX, y: event.clientY });
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
report(serveAgents());
watchFrameRate(showMetrics);
// Something to drop images on from the start.
report(opening(() => show(untitled())));

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
  return { ...command, unavailable: () => (editing.busy() ? reason : (reason = command.unavailable?.())) };
}

function drawTool(): Draw | undefined {
  return tool === "select" || tool === "hand" || tool === "eraser" ? undefined : tool;
}

function useTool(next: typeof tool): void {
  tool = next;
  viewport.hand(tool === "hand" || spaceHeld);
  viewport.host.classList.toggle("drawing", drawTool() !== undefined);
  viewport.host.classList.toggle("erasing", tool === "eraser");
  refreshBar();
}

function holdSpace(held: boolean): void {
  if (held !== spaceHeld) {
    spaceHeld = held;
    useTool(tool);
  }
}

function grids(): Entry {
  const current = opened?.board.background;
  return {
    ...commands.nextBackground,
    options: [
      ...BACKGROUNDS.map((background) => ({ ...commands[background], checked: background === current })),
      "separator",
      { ...commands.snap, checked: snapping, toggle: true },
    ],
  };
}

function themes(): Entry {
  const current = appearance.scheme();
  return submenu("Theme", [
    ...SCHEMES.map((scheme) => ({ ...commands[scheme], checked: scheme === current })),
    "separator",
    { ...commands.highContrast, checked: appearance.highContrast(), toggle: true },
  ]);
}

function views(): Entry {
  return submenu("View", [
    { ...commands.hints, checked: hintsShown, toggle: true },
    { ...commands.measurements, checked: !measurements.hidden, toggle: true },
    ...(platform.keepOnTop ? [{ ...commands.alwaysOnTop, checked: onTop, toggle: true }] : []),
    ...(platform.titleBar ? [{ ...commands.compact, checked: compact, toggle: true }] : []),
    ...(platform.agent ? [{ ...commands.agentAccess, checked: agentsAllowed, toggle: true }] : []),
  ]);
}

/**
 * Ready to answer before any agent may ask, then on or off as it was left. The shell follows,
 * even when the browser forgot, so that the menu's tick never hides access left on.
 */
async function serveAgents(): Promise<void> {
  const { agent } = platform;
  if (agent === undefined) {
    return;
  }
  await agent.serve((call) =>
    answer(call, {
      opened: () => opened,
      unsaved: () => unsaved,
      selection: () => editing.selection(),
      entered: () => editing.entered(),
      writing: () => editing.writing(),
      shown: () => {
        const camera = viewport.camera();
        return camera && onScreen(camera, viewport.size());
      },
      halfDrawn: () => halfDrawn,
      drawNow: () => viewport.drawNow(),
      async render(request) {
        if (opened === undefined || renderer === undefined) {
          throw new Error("Planche shows no board yet");
        }
        const background = getComputedStyle(document.body).backgroundColor;
        return render({ opened, renderer, drawings, unplayable, background }, request);
      },
      background: () => getComputedStyle(document.body).backgroundColor,
      loading: () => loading,
      busy: () => editing.busy(),
      idle: () => editing.idle(),
      apply: (work) => editing.apply(work),
      keep,
      zoom: () => viewport.zoom(),
      centre: () => viewport.centre(),
      select: (ids) => editing.select(ids),
      frame(ids) {
        const area = opened && extent(opened, ids);
        if (area) {
          viewport.look(fit(area, viewport.size()));
        }
      },
    }),
  );
  await allowAgents(recall(AGENT) === "on");
}

/** Remembered once it works, so that a refusal leaves the choice as it was. */
async function allowAgents(on: boolean): Promise<void> {
  try {
    await platform.agent?.allow(on);
  } catch (error) {
    throw new Error(on ? `Agent access stays off, as ${String(error)}` : String(error));
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
    bar.say(`Compact mode: drag the top edge to move, ${describe(commands.compact.keys[0]!)} or right-click to leave`);
  }
}

/** One that only opens its options, so never runs. */
function submenu(label: string, options: Entry[]): Item {
  return { label, run() {}, options };
}

/** Of the options that apply to the selection, and left out of it when none does. */
function relevantSubmenu(label: string, options: Entry[]): Item {
  const shown = relevant(options);
  return { ...submenu(label, shown), unavailable: () => (shown.length > 0 ? undefined : "None applies") };
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
 * Esc lets go of a colour being picked first, then of the style card, then of the tool in use,
 * which leaves the selection to act on, then of the group gone into, one level at a time, then
 * of the selection.
 */
function escape(): void {
  if (picker.sampling()) {
    picker.end(true);
  } else if (styleCard.isOpen()) {
    styleCard.close();
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
    if (opened !== target || selection.size !== ids.length || ids.some((id) => !selection.has(id))) {
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
    comments.show(opened.board, editing.selection(), editing.writing());
  }
}

function refreshBar(): void {
  // Buttons still explain themselves when hovered or focused.
  bar.refresh(hintsShown ? hint() : "");
}

function hint(): string {
  // As the menus name them.
  const [escapeKey, insideKey] = [commands.escape, commands.goInside].map(({ keys }) => describe(keys[0]!));
  const [freeKey, centreKey, stepKey] = mac ? ["⌘", "⌥", "⇧"] : ["Ctrl", "Alt", "Shift"];
  const picking = picker.sampling();
  if (picking !== undefined) {
    return `${picking === "holding" ? "Let go of S" : "Click"} to pick the colour under the pointer · ${escapeKey} to cancel`;
  }
  if (editing.writing() !== undefined) {
    return `${escapeKey} or click away to finish`;
  }
  if (editing.cropping() !== undefined) {
    return `Drag an edge or a corner to crop, or the inside to move the crop · ${insideKey} or click away to crop · ${escapeKey} to leave it as it was`;
  }
  const styles = commands.style.unavailable() === undefined ? `${describe(commands.style.keys[0]!)} to style · ` : "";
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
  if (tool === "arrow") {
    return `Drag from where the arrow starts to where it points · hold ${freeKey} to keep its ends from sticking · ${escapeKey} to select again`;
  }
  if (tool === "line") {
    return `Drag from one end to the other · hold ${freeKey} to keep its ends from sticking · ${escapeKey} to select again`;
  }
  if (tool === "rectangle" || tool === "ellipse" || tool === "cross" || tool === "sticky") {
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
    return `Drag to move · double-click or ${insideKey} to edit the text · ${styles}right-click for more`;
  }
  if (editing.loneSegment()) {
    return `Drag to move · drag an end to move it, holding ${freeKey} to keep it from sticking · ${styles}right-click for more`;
  }
  if (editing.selection().length > 0) {
    const crops = commands.crop.unavailable() === undefined ? `double-click or ${insideKey} to crop · ` : "";
    const keys = [commands.play, commands.sound]
      .filter((command) => command.unavailable() === undefined)
      .map((command) => `${describe(command.keys[0]!)} to ${command.label().toLowerCase()} · `);
    return `Drag to move · corners scale · turn from outside a corner · ${crops}${keys.join("")}${styles}right-click for more`;
  }
  return "Drop or paste images · scroll to move around · right-click for more";
}

/** About the selection, or else the board, with its images landing where it opens. */
function contextMenu(onSelection: boolean, at: Point, place: { x: number; y: number }): void {
  const entries: Entry[] = onSelection
    ? [
        commands.group,
        commands.ungroup,
        commands.goInside,
        commands.write,
        styleMenu(),
        "separator",
        relevantSubmenu("Order", [commands.front, commands.forward, commands.backward, commands.back]),
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
        relevantSubmenu("Transform", [
          commands.rotateLeft,
          commands.rotateRight,
          commands.straighten,
          "separator",
          commands.flipHorizontally,
          commands.flipVertically,
          "separator",
          commands.crop,
          commands.resetCrop,
          "separator",
          { ...commands.greyscale, checked: greyed(), toggle: true },
        ]),
        "separator",
        commands.play,
        commands.sound,
        "separator",
        commands.remove,
      ]
    : [
        { ...commands.addImages, run: () => addPicked(at) },
        commands.selectAll,
        "separator",
        commands.fit,
        "separator",
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

/** What sets the selection's style, as the card and the keys do, for when the card is out of reach. */
function styleMenu(): Entry {
  const can = new Set(styleCard.common());
  const papers = can.has("paper");
  const current = papers ? styleCard.value("paper") : styleCard.value("colour");
  const choices: { value: string; paint: Paint }[] = papers
    ? PAPERS.map(({ paper }) => ({ value: paper, paint: `paper-${paper}` }))
    : PALETTE.map(({ colour }) => ({ value: colour, paint: colour }));
  const colours: Entry[] =
    papers || can.has("colour")
      ? choices.map(({ value, paint }, at) => ({
          ...colourCommands[at]!,
          swatch: css(paint, viewport.host),
          checked: current === value,
        }))
      : [];
  const text: Entry[] = can.has("bold")
    ? ([commands.bold, commands.italic, commands.strike] as const).map((command, at) => ({
        ...command,
        checked: styleCard.value((["bold", "italic", "strike"] as const)[at]!) === true,
        toggle: true,
      }))
    : [];
  const sizes: Entry[] = can.has("size") ? [commands.larger, commands.smaller] : [];
  const sections = [[commands.style], colours, text, sizes, [commands.copyStyle, commands.pasteStyle]];
  return submenu(
    "Style",
    sections.filter((section) => section.length > 0).flatMap((section, at) => (at > 0 ? ["separator", ...section] : section)),
  );
}

/**
 * The pixels around the device pixel under `at` as the board shows them, from the textures the
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
  const [x, y] = [at.clientX - origin.left, at.clientY - origin.top].map((offset) => Math.floor(offset * devicePixelRatio) - half);
  return renderer.render({
    area: { x: camera.x + x! / scale, y: camera.y + y! / scale, width: ACROSS / scale, height: ACROSS / scale },
    size: { width: ACROSS, height: ACROSS },
    items: placed(opened.board, lettering, editing.writing(), unplayable),
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

async function openZip(): Promise<Folder | null> {
  const file = await platform.openZip();
  return file && zipFolder(file);
}

async function opening(work: () => Promise<void>): Promise<void> {
  loading = true;
  refreshBar();
  try {
    await work();
  } finally {
    loading = false;
    refreshBar();
  }
}

const question = "Leave this board, and lose its changes?";

async function newBoard(): Promise<void> {
  await opening(async () => {
    if (opened === undefined || opened.editor.isSaved() || (await platform.confirm(question))) {
      await show(untitled());
    }
  });
}

async function openBoard(pick: () => Promise<Folder | null>): Promise<void> {
  await opening(async () => {
    // Asked once picked, since a browser only opens a picker right after a click.
    const next = await open(async () => {
      const folder = await pick();
      const losing = folder !== null && opened !== undefined && !opened.editor.isSaved();
      return losing && !(await platform.confirm(question)) ? null : folder;
    }, details);
    if (next !== null) {
      await show(next);
    }
  });
}

async function show(next: Opened): Promise<void> {
  halfDrawn = true;
  try {
    await present(next);
  } finally {
    halfDrawn = false;
  }
}

async function present(next: Opened): Promise<void> {
  // The core's memory holds it until freed.
  opened?.editor.free();
  opened = next;
  renderer = undefined;
  snapping = next.board.background !== "plain";
  lettering.reset();
  drawings.reset();
  animated.reset();
  films.reset();
  unplayable = new Set();
  comments.clear();
  showSaved();
  showTitle();
  editing.reset();
  const summary = summarise(next);
  const empty = next.board.draw_order.length === 0;
  if (!empty) {
    bar.say(summary, true);
  }
  viewport.clear();
  // Nothing shows until its images are read, which may take a while.
  refreshBar();
  const [assets, reading] = await timed(() => readAssets(next));
  details.set(`read ${assets.length} images`, milliseconds(reading));
  const { width, height } = viewport.size();
  const created = await create(viewport.host, width, height);
  // Edits may have changed it while the renderer was created.
  created.backdrop(next.board.background);
  details.set("renderer", created.backend);
  viewport.show(created, fit(extent(next), viewport.size()));
  renderer = created;
  refreshBar();
  if (assets.length > 0) {
    bar.say(`${summary}, decoding ${assets.length} images…`, true);
  }
  const [decoded, decoding] = await timed(() => decode(assets, LONGEST_SIDE));
  details.set("decode", milliseconds(decoding));
  const [, uploading] = await timed(() => load(created, decoded));
  details.set("upload", milliseconds(uploading));
  animated.keep(assets);
  films.keep(assets.filter(({ asset }) => decoded.has(asset)));
  unplayable = new Set(assets.filter(({ asset, video }) => video && !decoded.has(asset)).map(({ asset }) => asset));
  created.place(placed(next.board, lettering, undefined, unplayable));
  viewport.redraw();
  if (unplayable.size > 0) {
    bar.say(`${summary}, ${unplayable.size === 1 ? "a video" : `${unplayable.size} videos`} this machine cannot play`);
  } else if (!empty) {
    bar.say(summary);
  }
}

/** At their natural size, side by side around `at`, and as one edit. */
async function addImages(incoming: Promise<Incoming[]>, at: Point): Promise<void> {
  const target = opened;
  const added: Added[] = [];
  const failures: string[] = [];
  for (const image of await incoming) {
    if ("failure" in image) {
      failures.push(`${image.name}: ${image.failure}`);
      continue;
    }
    try {
      added.push({ ...(await prepare(image.bytes, LONGEST_SIDE)), filename: image.filename });
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      failures.push(`${image.name}: this app cannot open it here (${reason})`);
    }
  }
  await editing.idle();
  if (added.length > 0 && target !== undefined && target === opened && renderer !== undefined) {
    keep(target, added);
    const frames = row(
      added.map(({ natural }) => natural),
      at,
    );
    const ids = added.map(() => newId());
    // Into the group gone into, where they stay selected.
    const group = editing.entered();
    editing.apply((editor, touched) =>
      added.forEach(({ asset, natural, filename }, at) => {
        touched.push(...editor.add(ids[at]!, group, JSON.stringify(imageKind(asset, natural, frames[at]!, { filename }))));
      }),
    );
    editing.select(ids);
  } else {
    added.forEach(({ decoded }) => release(decoded));
  }
  if (failures.length > 0) {
    bar.say(`Not added, ${failures.join("; ")}`);
  }
}

function keep(target: Opened, added: Added[]): void {
  if (renderer !== undefined) {
    load(renderer, new Map(added.map(({ asset, decoded }) => [asset, decoded])));
  }
  animated.keep(added);
  films.keep(added);
  const fresh = new Set(added.map(({ asset }) => asset));
  unplayable = new Set([...unplayable].filter((asset) => !fresh.has(asset)));
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
}

function summarise({ folder, board }: Opened): string {
  return `${folder.name}: ${board.draw_order.length} elements`;
}

function changed(touched: string[]): void {
  if (opened === undefined || (touched.length === 0 && core.background(opened.editor) === opened.board.background)) {
    return;
  }
  refresh(opened, touched);
  renderer?.backdrop(opened.board.background);
  renderer?.place(placed(opened.board, lettering, editing.writing(), unplayable));
  showSaved();
  viewport.redraw();
}

async function saveAs(): Promise<void> {
  if (opened === undefined) {
    return;
  }
  const { editor } = opened;
  const folder = files(opened);
  // Editing goes on while the files are written, and another board may even open.
  const snapshot = editor.snapshot();
  try {
    const target = await platform.pickTarget();
    if (target === null) {
      return;
    }
    const [count, writing] = await timed(async () => {
      // Assets first, so that no element ever points at a missing one.
      for (const path of snapshot.zipPaths().filter(core.isAssetFile)) {
        await target.write(path, await folder.read(path));
      }
      const files = [...core.newFiles(), ...core.write(snapshot)];
      for (const [path, bytes] of files) {
        await target.write(path, bytes);
      }
      return files.length;
    });
    details.set(`save ${count} files and the assets`, milliseconds(writing));
    bar.say(`Saved as ${target.name}`);
    saved(editor, snapshot);
  } finally {
    snapshot.free();
  }
}

async function exportZip(): Promise<void> {
  if (opened === undefined || exporting) {
    return;
  }
  const { editor } = opened;
  const folder = files(opened);
  exporting = true;
  const snapshot = editor.snapshot();
  try {
    const sink = await platform.pickZip(`${folder.name}.zip`);
    if (sink === null) {
      return;
    }
    bar.say(`Exporting ${sink.name}…`, true);
    const [count, writing] = await timed(() => writeZip(snapshot, folder, sink));
    details.set(`export ${count} files`, milliseconds(writing));
    bar.say(`Exported ${sink.name}`);
    saved(editor, snapshot);
  } finally {
    snapshot.free();
    exporting = false;
  }
}

/** Unless another board opened meanwhile, which freed `editor`. */
function saved(editor: core.Editor, snapshot: core.Snapshot): void {
  if (opened?.editor === editor) {
    editor.markSaved(snapshot);
    showSaved();
  }
}

/** Edits come at every pointer move, but the host only hears when this changes. */
function showSaved(): void {
  const now = opened !== undefined && !opened.editor.isSaved();
  if (now !== unsaved) {
    unsaved = now;
    bar.unsaved(unsaved);
    platform.markUnsaved(unsaved);
    showTitle();
  }
}

/** The desktop window keeps its own title, so there only the menu's button marks changes. */
function showTitle(): void {
  document.title = opened ? `${unsaved ? "• " : ""}${opened.folder.name} — Planche` : "Planche";
}

function showMetrics(fps: number): void {
  frameRate = fps;
  if (measurements.hidden) {
    return;
  }
  const heap = heapInUse();
  const lines = new Map([
    ["platform", platform.name],
    ["frames", `${fps.toFixed(0)} fps`],
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
    ...[...lines].flatMap(([name, value]) => [text("dt", name), text("dd", value)]),
  );
}

function report(work: Promise<void>): void {
  work.catch(fail);
}

function fail(error: unknown): void {
  bar.say(error instanceof Error ? error.message : String(error));
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, content: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
