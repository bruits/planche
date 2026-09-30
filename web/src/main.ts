// The app: start a board, or open one from a folder or a ZIP file, look around it, add images
// to it and edit it, and save it elsewhere or export it.

import * as core from "./core.js";
import type { Point } from "./core.js";
import { pick, receive, type Incoming } from "./add.js";
import {
  decode,
  files,
  holdsImage,
  imageKind,
  placed,
  open,
  prepare,
  readAssets,
  newId,
  refresh,
  row,
  untitled,
  type Added,
  type Opened,
} from "./board.js";
import { fit } from "./camera.js";
import { describe, listen, mac, typing, type Command, type Shortcut } from "./commands.js";
import { edits, type Draw, type Restack } from "./edit.js";
import { menuOpen, openMenu, type Entry } from "./menu.js";
import { heapInUse, megabytes, milliseconds, timed, watchFrameRate } from "./metrics.js";
import { overlay } from "./overlay.js";
import { platform, type Folder } from "./platform.js";
import { create, type Renderer } from "./renderer.js";
import { toolbar } from "./toolbar.js";
import { view } from "./view.js";
import { writeZip, zipFolder } from "./zip.js";

/** WebGL2 guarantees textures this large. */
const LONGEST_SIDE = 2048;
const ZOOM_STEP = 1.25;

const measurements = byId("measurements");
const details = new Map<string, string>();
const shown = overlay(byId("viewport"));
const viewport = view(byId("viewport"), {
  drawn: (camera, size) => shown.frame(camera, size),
  failed: (error) => fail(error),
});
const editing = edits(viewport, shown, () => opened, {
  changed,
  selectionChanged: () => refreshBar(),
  drawing: () => drawTool(),
  drawn: () => useTool("select"),
});

let opened: Opened | undefined;
let renderer: Renderer | undefined;
let unsaved = false;
/**
 * Two boards opening at once would free each other's editor. The first one opens once the core
 * starts, which nothing may use before.
 */
let loading = true;
/** On the desktop, a second export to the same file would take over the first one's draft. */
let exporting = false;
let tool: "select" | "hand" | Draw = "select";
let spaceHeld = false;
/** Kept while the measurements are hidden, so that they show at once when opened. */
let frameRate = 0;

const loadingBoard = () => (loading ? "A board is opening" : undefined);
const noBoard = () => (opened === undefined ? "No board is open yet" : undefined);
const noneSelected = () => (editing.selection().length === 0 ? "Nothing is selected" : undefined);
const noneShown = () => (viewport.zoom() === undefined ? "No board is shown yet" : undefined);
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
const backspace: Shortcut = { key: "backspace" };
const deleteKey: Shortcut = { key: "delete" };
const shiftZ: Shortcut = { key: "z", command: true, shift: true };
const ctrlY: Shortcut = { key: "y", ctrl: true };

const commands = {
  select: { label: "Select", keys: [{ key: "v" }], run: () => useTool("select") },
  hand: { label: "Hand", keys: [{ key: "h" }], run: () => useTool("hand") },
  arrow: { label: "Arrow", keys: [{ key: "a" }], unavailable: noneShown, run: () => useTool("arrow") },
  rectangle: { label: "Rectangle", keys: [{ key: "r" }], unavailable: noneShown, run: () => useTool("rectangle") },
  ellipse: { label: "Ellipse", keys: [{ key: "o" }], unavailable: noneShown, run: () => useTool("ellipse") },
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
  flipHorizontally: flip("Flip horizontally", "h", true),
  flipVertically: flip("Flip vertically", "v", false),
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
        viewport.look(fit(core.bounds(opened.editor, opened.board.draw_order), viewport.size()));
      }
    },
  },
  measurements: {
    label: "Show measurements",
    checked: () => !measurements.hidden,
    run: () => {
      measurements.hidden = !measurements.hidden;
      showMetrics(frameRate);
    },
  },
  contextMenu: {
    label: "Show the context menu",
    keys: [{ key: "contextmenu" }, { key: "f10", shift: true }],
    unavailable: noneShown,
    run: contextMenuFromKeys,
  },
} satisfies Record<string, Command>;

const bar = toolbar(
  byId("toolbar"),
  [
    [
      { command: commands.select, icon: "pointer", pressed: () => tool === "select" },
      { command: commands.hand, icon: "hand", pressed: () => tool === "hand" },
    ],
    [
      { command: commands.arrow, icon: "arrow", pressed: () => tool === "arrow" },
      { command: commands.rectangle, icon: "square", pressed: () => tool === "rectangle" },
      { command: commands.ellipse, icon: "circle", pressed: () => tool === "ellipse" },
      { command: commands.addImages, icon: "photo" },
    ],
  ],
  () => [
    commands.newBoard,
    commands.open,
    commands.openZip,
    commands.saveAs,
    commands.exportZip,
    "separator",
    commands.undo,
    commands.redo,
    "separator",
    commands.fit,
    commands.actualSize,
    "separator",
    commands.measurements,
  ],
);
refreshBar();
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
addEventListener("blur", () => holdSpace(false));
// Strokes draw in the theme's ink.
for (const query of ["(prefers-color-scheme: dark)", "(forced-colors: active)"]) {
  matchMedia(query).addEventListener("change", () => {
    renderer?.restyle();
    viewport.redraw();
  });
}
document.addEventListener("contextmenu", (event) => {
  // The webview's own menu would offer to reload, and lose the board.
  event.preventDefault();
  const at = viewport.host.contains(event.target as Node) ? viewport.at(event) : undefined;
  // One that the keys opened already, or any over the toolbar.
  if (at === undefined || menuOpen() || busy()) {
    return;
  }
  contextMenu(editing.aim(at), at, { x: event.clientX, y: event.clientY });
});

await core.start();
receive(viewport, (incoming, at) => report(addImages(incoming, at)));
watchFrameRate(showMetrics);
// Something to drop images on from the start.
report(opening(() => show(untitled())));

/** A drag under way, which a command or a menu would cut across. */
function busy(): boolean {
  return editing.busy() || viewport.panning();
}

function drawTool(): Draw | undefined {
  return tool === "select" || tool === "hand" ? undefined : tool;
}

function useTool(next: typeof tool): void {
  tool = next;
  viewport.hand(tool === "hand" || spaceHeld);
  viewport.host.classList.toggle("drawing", drawTool() !== undefined);
  refreshBar();
}

function holdSpace(held: boolean): void {
  if (held !== spaceHeld) {
    spaceHeld = held;
    useTool(tool);
  }
}

/**
 * Esc lets go of the tool in use first, which leaves the selection to act on, then of the group
 * gone into, one level at a time, then of the selection.
 */
function escape(): void {
  if (tool !== "select") {
    useTool("select");
  } else if (!editing.up()) {
    editing.select([]);
  }
}

function selectsGroup(): boolean {
  return editing.selection().some((id) => opened?.board.elements[id]?.kind.type === "group");
}

function refreshBar(): void {
  bar.refresh(hint());
}

function hint(): string {
  // As the menus name them.
  const [escapeKey, insideKey] = [commands.escape, commands.goInside].map(({ keys }) => describe(keys[0]!));
  if (tool === "hand") {
    return `Drag to move around · ${escapeKey} to select again`;
  }
  if (spaceHeld) {
    return "Drag to move around";
  }
  if (tool === "arrow") {
    return `Drag from where the arrow starts to where it points · ${escapeKey} to select again`;
  }
  if (tool === "rectangle" || tool === "ellipse") {
    return `Drag to draw, or click to place · ${escapeKey} to select again`;
  }
  const opens = commands.goInside.unavailable() === undefined;
  if (editing.entered() !== undefined) {
    return `Inside a group · ${opens ? `${insideKey} to go inside · ` : ""}${escapeKey} to go back up`;
  }
  if (opens) {
    return `Drag to move · double-click or ${insideKey} to go inside · right-click for more`;
  }
  if (editing.loneArrow()) {
    return "Drag to move · drag an end to move it · right-click for more";
  }
  if (editing.selection().length > 0) {
    return "Drag to move · corners scale · the circle rotates · right-click for more";
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
        "separator",
        commands.front,
        commands.forward,
        commands.backward,
        commands.back,
        "separator",
        commands.flipHorizontally,
        commands.flipVertically,
        "separator",
        commands.remove,
      ]
    : [{ ...commands.addImages, run: () => addPicked(at) }, commands.selectAll, "separator", commands.fit];
  openMenu(entries, { label: onSelection ? "Selection" : "Board", place });
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
  // The core's memory holds it until freed.
  opened?.editor.free();
  opened = next;
  renderer = undefined;
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
  details.set("renderer", created.backend);
  viewport.show(created, fit(core.bounds(next.editor, next.board.draw_order), viewport.size()));
  renderer = created;
  refreshBar();
  if (assets.length > 0) {
    bar.say(`${summary}, decoding ${assets.length} images…`, true);
  }
  const [bitmaps, decoding] = await timed(() => decode(assets, LONGEST_SIDE));
  details.set("decode", milliseconds(decoding));
  const [, uploading] = await timed(() => created.load(bitmaps));
  details.set("upload", milliseconds(uploading));
  created.place(placed(next.board));
  viewport.redraw();
  if (!empty) {
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
      added.push(await prepare(image.bytes, LONGEST_SIDE));
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      failures.push(`${image.name}: this app cannot open it here (${reason})`);
    }
  }
  await editing.idle();
  if (added.length > 0 && target !== undefined && target === opened && renderer !== undefined) {
    renderer.load(new Map(added.map(({ asset, bitmap }) => [asset, bitmap])));
    const { editor } = target;
    const frames = row(
      added.map(({ natural }) => natural),
      at,
    );
    const ids = added.map(() => newId());
    const touched: string[] = [];
    // Into the group gone into, where they stay selected.
    const group = editing.entered();
    editor.beginGesture();
    try {
      added.forEach(({ asset, bytes, natural }, at) => {
        target.added.set(core.assetPath(asset), bytes);
        touched.push(...editor.add(ids[at]!, group, JSON.stringify(imageKind(asset, natural, frames[at]!))));
      });
    } finally {
      editor.endGesture();
    }
    changed(touched);
    editing.select(ids);
  } else {
    added.forEach(({ bitmap }) => bitmap.close());
  }
  if (failures.length > 0) {
    bar.say(`Not added, ${failures.join("; ")}`);
  }
}

function summarise({ folder, board }: Opened): string {
  return `${folder.name}: ${board.draw_order.length} elements`;
}

function changed(touched: string[]): void {
  if (opened === undefined || touched.length === 0) {
    return;
  }
  refresh(opened, touched);
  renderer?.place(placed(opened.board));
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
