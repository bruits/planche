// The app: start a board, or open one from a folder or a ZIP file, look around it, add images
// to it and edit it, and save it elsewhere or export it.

import * as core from "./core.js";
import type { Point } from "./core.js";
import { receive, type Incoming } from "./add.js";
import {
  decode,
  files,
  imageKind,
  images,
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
import { edits } from "./edit.js";
import { heapInUse, megabytes, milliseconds, timed, watchFrameRate } from "./metrics.js";
import { overlay } from "./overlay.js";
import { platform, type Folder } from "./platform.js";
import { create, type Renderer } from "./renderer.js";
import { view } from "./view.js";
import { writeZip, zipFolder } from "./zip.js";

/** WebGL2 guarantees textures this large. */
const LONGEST_SIDE = 2048;

const newButton = byId<HTMLButtonElement>("new");
const openButton = byId<HTMLButtonElement>("open");
const openZipButton = byId<HTMLButtonElement>("open-zip");
const saveButton = byId<HTMLButtonElement>("save-as");
const exportButton = byId<HTMLButtonElement>("export");
const status = byId("status");
const unsavedMark = byId("unsaved");
const details = new Map<string, string>();
const shown = overlay(byId("viewport"));
const viewport = view(byId("viewport"), {
  drawn: (camera, size) => shown.frame(camera, size),
  failed: (error) => fail(error),
});
const editing = edits(viewport, shown, () => opened, changed);

let opened: Opened | undefined;
let renderer: Renderer | undefined;
let unsaved = false;
/** On the desktop, a second export to the same file would take over the first one's draft. */
let exporting = false;

await core.start();
byId("platform").textContent = platform.name;
saveButton.title = platform.cannotSave ?? "";
newButton.addEventListener("click", () => report(newBoard()));
openButton.addEventListener("click", () => report(openBoard(() => platform.open())));
openZipButton.addEventListener("click", () => report(openBoard(openZip)));
saveButton.addEventListener("click", () => report(saveAs()));
exportButton.addEventListener("click", () => report(exportZip()));
receive(viewport, (incoming, at) => report(addImages(incoming, at)));
watchFrameRate(showMetrics);
// Something to drop images on from the start.
report(opening(() => show(untitled())));

async function openZip(): Promise<Folder | null> {
  const file = await platform.openZip();
  return file && zipFolder(file);
}

/** Two boards opening at once would free each other's editor. */
async function opening(work: () => Promise<void>): Promise<void> {
  const buttons = [newButton, openButton, openZipButton];
  buttons.forEach((button) => (button.disabled = true));
  try {
    await work();
  } finally {
    buttons.forEach((button) => (button.disabled = false));
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
  editing.reset();
  saveButton.disabled = platform.cannotSave !== undefined;
  exportButton.disabled = exporting;
  const summary = summarise(next);
  status.textContent = summary;
  viewport.clear();
  const [assets, reading] = await timed(() => readAssets(next));
  details.set(`read ${assets.length} images`, milliseconds(reading));
  const { width, height } = viewport.size();
  const created = await create(viewport.host, width, height);
  details.set("renderer", created.backend);
  viewport.show(created, fit(core.bounds(next.editor, next.board.draw_order), viewport.size()));
  renderer = created;
  status.textContent = `${summary}, decoding ${assets.length} images…`;
  const [bitmaps, decoding] = await timed(() => decode(assets, LONGEST_SIDE));
  details.set("decode", milliseconds(decoding));
  const [, uploading] = await timed(() => created.load(bitmaps));
  details.set("upload", milliseconds(uploading));
  created.place(images(next.board));
  viewport.redraw();
  status.textContent = summary;
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
    editor.beginGesture();
    try {
      added.forEach(({ asset, bytes, natural }, at) => {
        target.added.set(core.assetPath(asset), bytes);
        touched.push(...editor.add(ids[at]!, JSON.stringify(imageKind(asset, natural, frames[at]!))));
      });
    } finally {
      editor.endGesture();
    }
    changed(touched);
    editing.select(ids);
    status.textContent = summarise(target);
  } else {
    added.forEach(({ bitmap }) => bitmap.close());
  }
  if (failures.length > 0) {
    status.textContent = `Not added, ${failures.join("; ")}`;
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
  renderer?.place(images(opened.board));
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
    status.textContent = `Saved as ${target.name}`;
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
  exportButton.disabled = true;
  const snapshot = editor.snapshot();
  try {
    const sink = await platform.pickZip(`${folder.name}.zip`);
    if (sink === null) {
      return;
    }
    status.textContent = `Exporting ${sink.name}…`;
    const [count, writing] = await timed(() => writeZip(snapshot, folder, sink));
    details.set(`export ${count} files`, milliseconds(writing));
    status.textContent = `Exported ${sink.name}`;
    saved(editor, snapshot);
  } finally {
    snapshot.free();
    exporting = false;
    exportButton.disabled = false;
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
    unsavedMark.hidden = !unsaved;
    platform.markUnsaved(unsaved);
  }
}

function showMetrics(fps: number): void {
  const heap = heapInUse();
  const lines = new Map([
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
  status.textContent = error instanceof Error ? error.message : String(error);
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, content: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
