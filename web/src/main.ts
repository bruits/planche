// The app: open a board, look around it, and save it elsewhere.

import * as core from "./core.js";
import { decode, open, readImages, type Opened } from "./board.js";
import { bounds, fit } from "./camera.js";
import { heapInUse, megabytes, milliseconds, timed, watchFrameRate } from "./metrics.js";
import { platform } from "./platform.js";
import { create } from "./renderer.js";
import { view } from "./view.js";

/** WebGL2 guarantees textures this large. */
const LONGEST_SIDE = 2048;

const openButton = byId<HTMLButtonElement>("open");
const saveButton = byId<HTMLButtonElement>("save-as");
const status = byId("status");
const viewport = view(byId("viewport"));
const details = new Map<string, string>();

let opened: Opened | undefined;

await core.start();
byId("platform").textContent = platform.name;
saveButton.title = platform.cannotSave ?? "";
openButton.addEventListener("click", () => report(openBoard()));
saveButton.addEventListener("click", () => report(saveAs()));
watchFrameRate(showMetrics);

async function openBoard(): Promise<void> {
  openButton.disabled = true;
  try {
    const next = await open(details);
    if (next === null) {
      return;
    }
    opened = next;
    saveButton.disabled = platform.cannotSave !== undefined;
    const summary = `${next.folder.name}: ${next.board.draw_order.length} elements`;
    status.textContent = summary;
    viewport.clear();
    const [images, reading] = await timed(() => readImages(next));
    details.set(`read ${images.length} images`, milliseconds(reading));
    if (images.length === 0) {
      return;
    }
    const { width, height } = viewport.size();
    const renderer = await create(viewport.host, width, height);
    details.set("renderer", renderer.backend);
    viewport.show(renderer, fit(bounds(images.map(({ frame }) => frame)), viewport.size()));
    status.textContent = `${summary}, decoding ${images.length} images…`;
    const [quads, decoding] = await timed(() => decode(images, LONGEST_SIDE));
    details.set("decode", milliseconds(decoding));
    const [, uploading] = await timed(() => renderer.load(quads));
    details.set("upload", milliseconds(uploading));
    viewport.redraw();
    status.textContent = summary;
  } finally {
    openButton.disabled = false;
  }
}

async function saveAs(): Promise<void> {
  if (opened === undefined) {
    return;
  }
  const { folder, paths, board } = opened;
  const target = await platform.pickTarget();
  if (target === null) {
    return;
  }
  const [count, writing] = await timed(async () => {
    // Assets first, so that no element ever points at a missing one.
    for (const path of paths.filter(core.isAssetFile)) {
      await target.write(path, await folder.read(path));
    }
    const files = [...core.newFiles(), ...core.write(board)];
    for (const [path, bytes] of files) {
      await target.write(path, bytes);
    }
    return files.length;
  });
  details.set(`save ${count} files and the assets`, milliseconds(writing));
  status.textContent = `Saved as ${target.name}`;
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
  work.catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  });
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, content: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
