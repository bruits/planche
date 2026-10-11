// The app, wired together: start a board, or open one from a folder or a ZIP file, look around
// it, add images to it and edit it, which it saves as it goes, and save it elsewhere or export it.

import * as core from "./core.js";
import type { Point, Size, Tip } from "./core.js";
import { actions } from "./actions.js";
import { pick, receive } from "./add.js";
import { adding } from "./adding.js";
import { access } from "./agent.js";
import { animations } from "./animation.js";
import { bugReport } from "./bugreport.js";
import {
  assetSizes,
  copiedAssets,
  decodeAsset,
  exposing,
  extent,
  isAnnotation,
  loneImage,
  placed,
  reader,
  refresh,
  release,
  type Added,
  type Decoded,
  type Hold,
  type Opened,
} from "./board.js";
import { fit, onScreen, type Camera } from "./camera.js";
import { card } from "./card.js";
import { clipboard } from "./clipboard.js";
import { learnLayout, listen, mac, typed, typing, type Command } from "./commands.js";
import { drawTool, edits, isTip, type Draw, type Pen, type Tool } from "./edit.js";
import { message } from "./errors.js";
import { exportCard, recalled, remembered } from "./exportcard.js";
import { exporting } from "./exporting.js";
import { failures } from "./failures.js";
import { handle } from "./handle.js";
import type { Icon } from "./icons.js";
import { lifecycle } from "./lifecycle.js";
import { menuOpen } from "./menu.js";
import { menus, percent } from "./menus.js";
import { heapInUse, measurements, megabytes, milliseconds, percentile } from "./metrics.js";
import { overlay } from "./overlay.js";
import { together } from "./playback.js";
import { lockedPin, pinned, pins } from "./pins.js";
import { titledGroup, titles } from "./titles.js";
import { platform } from "./platform.js";
import { recall, remember } from "./preferences.js";
import { TEXTURE_SIDE } from "./raster.js";
import { backing, planned, render } from "./render.js";
import { create, type Placed, type Renderer } from "./renderer.js";
import { ACROSS, sampler } from "./sampler.js";
import { showing } from "./showing.js";
import { still } from "./still.js";
import { styles } from "./style.js";
import { loadFont, texts } from "./text.js";
import { theme } from "./theme.js";
import { toolbar, type Button } from "./toolbar.js";
import { updating } from "./updates.js";
import { vectors } from "./vector.js";
import { videos } from "./video.js";
import { view } from "./view.js";
import { welcome } from "./welcome.js";

let opened: Opened | undefined;
let renderer: Renderer | undefined;
let halfDrawn = false;
let looking: Promise<void> | undefined;
let tool: Tool = "select";
/** What the pen draws while pressed, over the board. */
let inking: Pen | undefined;
/** Left out of the board, it starts as the board's background suggests. */
let snapping = false;
/** The assets whose images show crossed out, as their files or this machine cannot show them. */
let crossedOut: ReadonlySet<string> = new Set();
/** The assets the renderer holds a texture or a drawing of, which adding them again needs not decode. */
const loaded = new Set<string>();
let spaceHeld = false;
/** Left out of the preferences, as annotations hidden at the next launch would look lost. */
let annotationsShown = true;
/** Whether an agent's screenshot draws, which shows every annotation, whatever the window hides. */
let screenshotting = false;
let copying: { key: string; png: Promise<Blob> } | undefined;
/** What of the export card's picture the board last drew. */
let exposed = "";

/** What the measurements show, which the details of a failure tell too. */
const details = new Map<string, string>();
// First after them, to hear of whatever fails while the rest is set up.
const failing = failures(byId("toolbar"), {
  say,
  log: platform.errorLog,
  // Async, so that a page without a clipboard, served over plain HTTP, rejects rather than throws.
  copy: async (text) => navigator.clipboard.writeText(text),
  about: () => [navigator.userAgent, details.get("renderer") ?? "No renderer yet"],
  closing: () => life.closing(),
  confirm: (question) => platform.confirm(question),
  reload() {
    // So that the browser asks no more, once the user chose.
    platform.markUnsaved(false);
    location.reload();
  },
  halt() {
    viewport.halt();
    // Not the animated images, whose reset would free what the renderer holds.
    films.halt();
    // Such as a progress, which `say` would no longer end.
    bar.say("");
  },
});
failing.watch(window);
const { fail, report } = failing;
const updates = updating(byId("toolbar"), platform.updater, {
  closing: () => life.closing(),
  confirm: (question) => platform.confirm(question),
  report,
});
updates.watch(window);
const halted = () => failing.stopped() || updates.installing();

/** The rows of the measurements that the next draw ends, with when each began. */
const untilDrawn = new Map<string, number>();
const metrics = measurements(byId("measurements"), byId("metrics"), (draws) => {
  const heap = heapInUse();
  const lines = new Map([
    ["platform", platform.name],
    ["draws", draws],
    ["core memory", megabytes(core.coreMemory())],
  ]);
  if (renderer !== undefined) {
    lines.set("textures", megabytes(renderer.textureBytes));
    lines.set("texts", String(lettering.count()));
  }
  if (heap !== undefined) {
    lines.set("JS heap", megabytes(heap));
  }
  details.forEach((value, name) => lines.set(name, value));
  return [...lines];
});
const overlaid = overlay(byId("viewport"));
const viewport = view(byId("viewport"), {
  advance: () => editing.catchUp(),
  panned() {
    styleCard.refresh();
    reframe();
  },
  frame(camera, size) {
    bar.zoomed();
    overlaid.frame(camera, size);
    const mirrored = viewport.mirrored() ? size : undefined;
    comments.frame(camera, mirrored);
    groupTitles.frame(camera, mirrored);
    editing.follow();
    styleCard.frame();
    pictureCard.frame();
    if (opened && renderer) {
      present.free();
      drawings.update(opened.board, renderer, camera, size);
      media.update(opened.board, renderer, camera, size);
      if (lettering.update(opened.board, renderer, camera, size, editing.writing())) {
        placeNow(renderer, opened);
      }
    }
  },
  painted() {
    metrics.drew();
    if (untilDrawn.size > 0) {
      const now = performance.now();
      untilDrawn.forEach((since, name) => details.set(name, milliseconds(now - since)));
      untilDrawn.clear();
    }
  },
  failed: fail,
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
  () => say("A video cannot play here"),
);
const media = together(animated, films);
const editing = edits(viewport, overlaid, () => opened, {
  changed,
  retitle: (id) => groupTitles.write(id),
  failed: fail,
  stopped: halted,
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
  aligning: () => app.aligning(),
  showsAnnotations: () => annotationsShown,
  reveal: () => showAnnotations(true),
  drawing: () => drawTool(tool),
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
const greeting = welcome(byId("viewport"), () => bar.top());
const appearance = theme(restyle);

const life = lifecycle({
  platform,
  opened: () => opened,
  show,
  camera: () => viewport.camera(),
  say,
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
  say,
  reset(next) {
    // The core's memory holds it until freed.
    opened?.editor.free();
    opened = next;
    renderer = undefined;
    snapping = next.board.background !== "plain";
    lettering.reset();
    // Before the edits let go of the selection, which shows the pins and titles of the board.
    letGo();
    life.showSaved();
    showTitle();
    editing.reset();
    viewport.clear();
    greeting.follow(next.board);
    refreshBar();
  },
  async attach(next, camera, wanted) {
    const { width, height } = viewport.size();
    const created = await create(viewport.host, width, height, failing.stop).catch(
      (error: unknown) => {
        details.set("renderer", `failed: ${message(error).replace(/\s+/g, " ")}`);
        throw error;
      },
    );
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
  decode: (read) => decodeAsset(read, TEXTURE_SIDE).catch(() => undefined),
  release,
  load(into, asset, decoded, read) {
    load(into, new Map([[asset, decoded]]));
    // Once their texture is there, which they play onto.
    media.keep([read]);
    // Its file came back.
    if (crossedOut.has(asset)) {
      crossedOut = new Set([...crossedOut].filter((other) => other !== asset));
      if (opened) {
        placeNow(into, opened);
      }
    }
    // As sharp at any size once known to be an SVG.
    reframe();
  },
  crossOut,
  crossed: (asset) => crossedOut.has(asset),
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
    // After the edits let go of the selection, which would show the board's pins and titles again.
    editing.reset();
    letGo();
  },
  changed,
  drawn: (name, since) => untilDrawn.set(name, since),
});

const agents = access(platform.agent, {
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
  stopped: () => failing.stopped(),
  installing: () => updates.installing(),
  crossedOut: (asset) =>
    crossedOut.has(asset) ? (present.crossedOut(asset) ?? "it cannot show") : undefined,
  drawNow() {
    if (annotationsShown || opened === undefined || renderer === undefined) {
      return viewport.drawNow();
    }
    // Through `placeNow`, as texts drawn anew meanwhile place the board again.
    screenshotting = true;
    try {
      placeNow(renderer, opened);
      return viewport.drawNow();
    } finally {
      screenshotting = false;
      placeNow(renderer, opened);
      viewport.redraw();
    }
  },
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
});
const outgoing = exporting({
  platform,
  opened: () => opened,
  hold,
  ready,
  editing,
  showsAnnotations: () => annotationsShown,
  life,
  drawings,
  crossedOut: () => crossedOut,
  loaded: (asset) => loaded.has(asset),
  media,
  clip: () => clip,
  pictureCard: () => pictureCard,
  timings: details,
  say,
  report,
});
const intake = adding({
  hold,
  renderer: () => renderer,
  load,
  keep,
  heldSize,
  editing,
  viewport,
  // A press on the handle drags the window instead. It measures 0 while hidden.
  between: () => ({ top: byId("handle").getBoundingClientRect().bottom, bottom: bar.top() }),
  savesToFiles: () => life.savesToFiles(),
  stopped: halted,
  say,
  drawn: (name, since) => untilDrawn.set(name, since),
});
const app = actions({
  platform,
  opened: () => opened,
  hold,
  crossedOut: () => crossedOut,
  editing,
  viewport,
  life,
  media,
  films,
  appearance,
  groupTitles,
  measurements: metrics,
  agents,
  updates,
  exports: outgoing,
  greeting,
  styleCard: () => styleCard,
  pictureCard: () => pictureCard,
  picker: () => picker,
  clip: () => clip,
  tool: () => tool,
  useTool,
  spaceHeld: () => spaceHeld,
  penStyling,
  showsAnnotations: () => annotationsShown,
  showAnnotations,
  snapping: () => snapping,
  snap(on) {
    snapping = on;
  },
  fitTo,
  addPicked,
  duplicate: () => intake.duplicate(),
  contextMenuFromKeys: () => offers.fromKeys(),
  listed: () => offers.listed(),
  openBugReport,
  refreshBar,
  say,
  report,
});
const { commands } = app;
const offers = menus(app, {
  platform,
  viewport,
  editing,
  groupTitles,
  measurements: metrics,
  pictureCard: () => pictureCard,
  savesToFiles: () => life.savesToFiles(),
  addPicked,
  addTestPhotos: (count) => intake.testPhotos(count),
  report,
});

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
        unavailable: app.noneShown,
        entries: offers.zooms,
      },
      { command: steady(commands.undo), icon: "undo" },
      { command: steady(commands.redo), icon: "redo" },
    ],
  ],
  offers.toolbar,
);
const look = styles();
const styleCard = card(
  {
    current: () => opened,
    selection: () => editing.selection(),
    showsAnnotations: () => annotationsShown,
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
    say,
    media,
    trimmed: () => refreshBar(),
  },
  look,
  {
    colours: app.colours,
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
            annotationsShown,
          ),
    client: (point) => viewport.client(point),
    busy,
    floor: () => bar.top(),
    explain: (element, explanation) => bar.explain(element, explanation),
    changed: showPicture,
    chose: (options) => remembered(options).forEach(([key, value]) => remember(key, value)),
    save: (options) => report(outgoing.png(options)),
    copy: (options) => outgoing.copyPng(options),
  },
  recalled(recall),
  { save: commands.savePng.keys[0]!, copy: commands.copy.keys[0]! },
);
// As a message or a hint showing in the toolbar raises it, which the cards stay above, and the
// welcome's arrow clear of.
new ResizeObserver(() => {
  styleCard.frame();
  pictureCard.frame();
  greeting.fit();
}).observe(byId("toolbar"));
app.restore();
const picker = sampler(
  {
    read: readBoard,
    picked(colour) {
      if (styleCard.common().includes("colour")) {
        styleCard.set({ colour });
      } else {
        look.pick(colour);
        say(`Picked ${colour}, which the style card keeps`);
      }
      styleCard.refresh();
    },
    changed: refreshBar,
  },
  viewport.host,
);
refreshBar();
if (platform.titleBar) {
  handle(byId("handle"), viewport.host, platform.titleBar.drag, app.leaveCompact);
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
    app.noneShown()
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
media.reduce(reducedMotion.matches);
reducedMotion.addEventListener("change", () => {
  media.reduce(reducedMotion.matches);
  refreshBar();
});
addEventListener("blur", () => void life.saver()?.flush());
addEventListener("pagehide", () => void life.saver()?.flush());
addEventListener("beforeunload", () => void life.saver()?.flush());
addEventListener("focus", lookAgain);
learnKeys();
addEventListener("focus", learnKeys);
// Before the letter it comes with, as the layout may have changed without the window losing focus.
addEventListener("keydown", (event) => event.key === "Alt" && !event.repeat && learnKeys());
document.addEventListener("visibilitychange", () =>
  document.visibilityState === "hidden" ? void life.saver()?.flush() : lookAgain(),
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
  offers.context(editing.aim(at, pin), at, { x: event.clientX, y: event.clientY }, locked, titled);
});

// Nothing after it runs when the core fails to load.
await failing.started(Promise.all([core.start(failing.stop), loadFont()]));
receive(viewport, (incoming, at) => {
  // The shell's own drops come with no event that a stopped page holds back.
  if (!halted()) {
    report(intake.images(incoming, at));
  }
});
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
    opened ? reader(opened, copiedAssets(copied), life.fleeting()) : async () => new Map(),
  cut: () => editing.remove(),
  png() {
    const image = app.selectedImage();
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
    say(`${copied ? "Copied without the image" : "Nothing was copied"}. ${message(error)}`),
  pasted: (pasted, at) => report(intake.paste(pasted, at)),
  received: (incoming, at) => report(intake.images(incoming, at)),
});
report(agents.serve());
// Something to drop images on from the start.
report(life.start());
report(updates.serve());
failing.ready();

/** A board shows in one renderer at most, which goes once it fails to show. */
function hold(): Hold | undefined {
  const board = opened;
  return board && { board, shows: () => opened === board && renderer !== undefined };
}

function letGo(): void {
  drawings.reset();
  media.reset();
  crossedOut = new Set();
  loaded.clear();
  comments.clear();
  groupTitles.clear();
}

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

function useTool(next: Tool): void {
  const chosen = next !== tool;
  tool = next;
  // So that what it would draw over shows.
  if (chosen && drawTool(tool) !== undefined && !annotationsShown) {
    showAnnotations(true);
  }
  // Whose drawing would go unseen under the picture.
  if (drawTool(tool) !== undefined || tool === "eraser") {
    pictureCard.close();
  }
  // So that the card shows the pen's style.
  if (isTip(tool)) {
    editing.select([]);
  }
  viewport.hand(tool === "hand" || spaceHeld);
  viewport.host.classList.toggle("drawing", drawTool(tool) !== undefined);
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
  into.place(drawnNow(board, annotationsShown || screenshotting));
}

/**
 * What draws, but for the annotations unless they are `shown`, with what the pen draws while
 * pressed over it, or the picture the export card frames.
 */
function drawnNow(board: Opened, shown: boolean): Placed[] {
  const picture = pictureCard.plan();
  const writing = editing.writing();
  if (picture) {
    const { background } = pictureCard.options();
    const behind = { backing: backing(picture.area, background), light: background === "white" };
    const ids = editing.selection();
    return exposing(board, lettering, ids, behind, writing, crossedOut, shown);
  }
  const inked = inking && { item: inking, group: editing.entered() };
  return placed(board, lettering, writing, crossedOut, inked, shown);
}

function showAnnotations(shown: boolean): void {
  annotationsShown = shown;
  viewport.host.classList.toggle("unannotated", !shown);
  const elements = opened?.board.elements;
  if (!shown && elements) {
    editing.select(editing.selection().filter((id) => !isAnnotation(elements[id]!.kind)));
  }
  styleCard.refresh();
  pictureCard.refresh();
  placePicture();
  editing.rehover();
}

function holdSpace(held: boolean): void {
  if (held !== spaceHeld) {
    spaceHeld = held;
    useTool(tool);
  }
}

/** Zooms to fit `ids`, when any of them shows. */
function fitTo(ids: string[]): void {
  const area = opened && extent(opened, ids);
  if (area) {
    viewport.look(fit(area, viewport.size()));
  }
}

function learnKeys(): void {
  if (mac && platform.layout) {
    void platform.layout().then(learnLayout, () => learnLayout(undefined));
  }
}

/** Strokes and text draw in the theme's colours. */
function restyle(): void {
  renderer?.restyle();
  viewport.redraw();
}

function showComments(): void {
  if (opened) {
    comments.show(opened, editing.selection(), editing.writing());
    const lone = app.loneGroup();
    const offered = lone && lone.title === undefined ? editing.selection()[0] : undefined;
    const { editor } = opened;
    groupTitles.show(opened, (id) => core.extent(editor, [id]), editing.selection(), offered);
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
    say(message(error));
  }
}

function refreshBar(): void {
  // Buttons still explain themselves when hovered or focused.
  bar.refresh(app.hint());
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
    items: placed(opened, lettering, editing.writing(), crossedOut, undefined, annotationsShown),
    background: getComputedStyle(document.body).backgroundColor,
    images: new Map(),
    texts: new Map(),
  });
}

/** Opens the picker at once, as browsers only let a page do right after a click or a key. */
function addPicked(at: Point | undefined): void {
  if (at !== undefined) {
    report(intake.images(pick(), at));
  }
}

function lookAgain(): void {
  // Not once the app stopped, which reads the disk again as it reloads, nor while a new version
  // goes in place, after the board's last save.
  if (halted()) {
    return;
  }
  // Images after the board, which reading it again shows afresh. Focus and visibility come
  // together, and the second check would return before the first one ends.
  looking ??= (life.saver()?.check() ?? Promise.resolve())
    .then(() => present.recheck())
    .finally(() => (looking = undefined));
  report(looking);
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
  if (crossedOut.has(asset)) {
    return;
  }
  crossedOut = new Set([...crossedOut, asset]);
  if (opened) {
    placeNow(into, opened);
  }
  // Its outline takes another frame than its image, and none of its pixels.
  reframe();
}

function heldSize(asset: string): Size | undefined {
  return opened && loaded.has(asset) && !crossedOut.has(asset)
    ? assetSizes(opened.board).get(asset)
    : undefined;
}

function keep(target: Opened, added: Added[]): void {
  if (renderer !== undefined) {
    load(
      renderer,
      new Map(added.flatMap(({ asset, decoded }) => (decoded ? [[asset, decoded] as const] : []))),
    );
  }
  media.keep(added);
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
  if (touched.length > 0) {
    greeting.end();
  }
  const { undrawn, groups } = refresh(opened, touched);
  groupTitles.changed([...touched, ...groups]);
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

/** The renderer, once the board shows whole. */
function ready(): Renderer {
  if (renderer === undefined || halfDrawn || life.loading()) {
    throw new Error("A board is opening");
  }
  return renderer;
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

async function openBugReport(): Promise<void> {
  // Awaits nothing in a browser, which opens a tab only right after a click or a key.
  const version = platform.version ? await platform.version() : undefined;
  await platform.openAddress(
    bugReport({
      platform: platform.name,
      version,
      renderer: details.get("renderer"),
      userAgent: navigator.userAgent,
    }),
  );
}

/** Nothing once the app stopped, whose failure then says all there is, such as a save's. */
function say(text: string, lasting?: boolean): void {
  if (!failing.stopped()) {
    bar.say(text, lasting);
  }
}

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}
