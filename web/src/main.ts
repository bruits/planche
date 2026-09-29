// The app shell until the canvas lands.

import * as core from "./core.js";
import type { Board, Files } from "./core.js";
import { heapInUse, megabytes, milliseconds, timed, watchFrameRate } from "./metrics.js";
import { platform, type Folder } from "./platform.js";

const openButton = byId<HTMLButtonElement>("open");
const saveButton = byId<HTMLButtonElement>("save-as");
const status = byId("status");
const rows = byId<HTMLTableSectionElement>("elements");
const timings = new Map<string, string>();

let opened: { folder: Folder; paths: string[]; board: Board } | undefined;

await core.start();
byId("platform").textContent = platform.name;
saveButton.title = platform.cannotSave ?? "";
openButton.addEventListener("click", () => report(open()));
saveButton.addEventListener("click", () => report(saveAs()));
watchFrameRate(showMetrics);

async function open(): Promise<void> {
  const folder = await platform.open();
  if (folder === null) {
    return;
  }
  const [paths, listing] = await timed(() => folder.list(core.fileDepth()));
  const [files, reading] = await timed(async () => {
    const files: Files = new Map();
    for (const path of paths.filter(core.isBoardFile)) {
      files.set(path, await folder.read(path));
    }
    return files;
  });
  const [board, parsing] = await timed(() => core.read(files));
  opened = { folder, paths, board };
  saveButton.disabled = platform.cannotSave !== undefined;
  timings.clear();
  timings.set(`list ${paths.length} files`, milliseconds(listing));
  timings.set(`read ${files.size} files`, milliseconds(reading));
  timings.set("parse", milliseconds(parsing));
  status.textContent = `${folder.name}: ${board.draw_order.length} elements`;
  const [, decoding] = await timed(() => listElements(folder, board));
  timings.set("decode images", milliseconds(decoding));
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
  timings.set(`save ${count} files and the assets`, milliseconds(writing));
  status.textContent = `Saved as ${target.name}`;
}

async function listElements(folder: Folder, board: Board): Promise<void> {
  rows.replaceChildren();
  const images: [HTMLTableCellElement, string, { width: number; height: number }][] = [];
  for (const id of board.draw_order) {
    const { group, z, kind } = board.elements[id]!;
    const detail = cell("");
    rows.append(row(kind.type, id.slice(0, 8), z, group?.slice(0, 8) ?? "", detail));
    if (kind.type === "image") {
      images.push([detail, kind.asset, kind.natural_size]);
    } else if (kind.type === "note") {
      detail.textContent = kind.text;
    }
  }
  for (const [detail, asset, natural] of images) {
    detail.textContent = await decode(folder, asset, natural);
  }
}

async function decode(
  folder: Folder,
  asset: string,
  natural: { width: number; height: number },
): Promise<string> {
  try {
    const [bytes, reading] = await timed(() => folder.read(core.assetPath(asset)));
    core.verifyAsset(asset, bytes);
    // Browsers apply the EXIF orientation, as the natural size expects.
    const [bitmap, decoding] = await timed(() => createImageBitmap(new Blob([bytes])));
    const size = `${bitmap.width}×${bitmap.height}`;
    const matches = bitmap.width === natural.width && bitmap.height === natural.height;
    bitmap.close();
    const check = matches ? size : `${size}, expected ${natural.width}×${natural.height}`;
    return `${check}, ${megabytes(bytes.length)}, read ${milliseconds(reading)}, decoded ${milliseconds(decoding)}`;
  } catch (error) {
    return message(error);
  }
}

function showMetrics(fps: number): void {
  const heap = heapInUse();
  const lines = new Map([
    ["frames", `${fps.toFixed(0)} fps`],
    ["core memory", megabytes(core.coreMemory())],
    ...(heap === undefined ? [] : [["JS heap", megabytes(heap)] as [string, string]]),
    ...timings,
  ]);
  byId("metrics").replaceChildren(
    ...[...lines].flatMap(([name, value]) => [text("dt", name), text("dd", value)]),
  );
}

function report(work: Promise<void>): void {
  work.catch((error: unknown) => {
    status.textContent = message(error);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function row(...cells: (string | HTMLTableCellElement)[]): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.append(...cells.map((content) => (typeof content === "string" ? cell(content) : content)));
  return row;
}

function cell(content: string): HTMLTableCellElement {
  return text("td", content);
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, content: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
