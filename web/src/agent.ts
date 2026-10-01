// What agents read of the open board, as the desktop shell passes their tools' calls on. The
// board is read as it stands, since a call is answered between two events, up to its first wait.

import { write, type Writing } from "./author.js";
import { decodeAsset, files, readAsset, release, type Opened } from "./board.js";
import { MOST_SIDE, capture, type Capture } from "./capture.js";
import * as core from "./core.js";
import type { Element, Kind, Rect } from "./core.js";
import type { AgentCall } from "./platform.js";
import type { Rendered, Request } from "./render.js";

/** The page's state that agents read. */
export interface Reading {
  opened(): Opened | undefined;
  unsaved(): boolean;
  selection(): string[];
  entered(): string | undefined;
  writing(): string | undefined;
  /** The part of the board the window shows, `undefined` when nothing is shown. */
  shown(): Rect | undefined;
  /** While a board shows half drawn, its images still being read and decoded. */
  halfDrawn(): boolean;
  drawNow(): HTMLCanvasElement | undefined;
  /** Draws part of the board off the window, which it leaves as it is. */
  render(request: Request): Promise<Rendered>;
  /** The colour behind the board. */
  background(): string;
}

/** Longer texts are cut in the outline, and read whole by id. */
const MOST_TEXT = 280;
/** Pixels along the longest side, at least, of an SVG, which draws sharp at any size. */
const SMALLEST_VECTOR = 512;

/** Rejects with what the agent reads when there is no answer. */
export async function answer({ tool, args, deadline }: AgentCall, page: Reading & Writing): Promise<unknown> {
  const reading: Reading = page;
  const opened = reading.opened();
  if (opened === undefined) {
    throw new Error("No board is open in Planche yet");
  }
  const board = { name: opened.folder.name, unsaved: reading.unsaved() };
  const given = (args ?? {}) as Record<string, unknown>;
  const written = await write(tool, given, page, deadline);
  if (written !== undefined) {
    return { board: { ...board, unsaved: reading.unsaved() }, ...written };
  }
  switch (tool) {
    case "board":
      return { board, view: reading.shown() ?? null, ...outline(opened, given) };
    case "elements":
      return { board, elements: elements(opened, given.ids) };
    case "selection":
      return {
        board,
        selected: reading.selection(),
        entered: reading.entered() ?? null,
        writing: reading.writing() ?? null,
      };
    case "image":
      return { board, ...(await image(opened, given.id, reading.background())) };
    case "screenshot":
      return { board, ...screenshot(reading) };
    case "render":
      return { board, ...(await render(reading, opened, given)) };
    default:
      throw new Error(`Planche has no tool called ${tool}`);
  }
}

function outline(opened: Opened, { offset, limit, area }: Record<string, unknown>) {
  const ids = area == null ? opened.board.draw_order : within(opened, area as Rect);
  const from = typeof offset === "number" ? offset : 0;
  // The shell bounds it.
  const count = typeof limit === "number" ? limit : ids.length;
  const next = from + count < ids.length ? from + count : null;
  const page = ids.slice(from, from + count);
  return { total: ids.length, offset: from, next, elements: page.map((id) => entry(opened, id)) };
}

function within(opened: Opened, { x, y, width, height }: Rect): string[] {
  const touching = new Set(opened.editor.touching(x, y, width, height));
  return opened.board.draw_order.filter((id) => {
    const { kind } = opened.board.elements[id]!;
    if (kind.type !== "comment") {
      return touching.has(id);
    }
    const { at } = kind;
    return x <= at.x && at.x <= x + width && y <= at.y && at.y <= y + height;
  });
}

function entry(opened: Opened, id: string) {
  const { group, kind } = opened.board.elements[id]!;
  return {
    id,
    type: kind.type,
    group,
    // A comment covers nothing, so it is where it is pinned.
    bounds: kind.type === "comment" ? { ...kind.at, width: 0, height: 0 } : core.bounds(opened.editor, [id]),
    rotation: "rotation" in kind ? kind.rotation : undefined,
    text: cut(text(kind)),
    targets: targets(kind),
    image:
      kind.type === "image"
        ? { filename: kind.filename, source: kind.source, caption: kind.caption, natural_size: kind.natural_size }
        : undefined,
  };
}

function text(kind: Kind): string | undefined {
  if (kind.type === "comment") {
    return kind.text;
  }
  return "text" in kind ? kind.text.content : undefined;
}

function cut(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= MOST_TEXT) {
    return text;
  }
  // Never between the halves of a character, which the shell could not read back.
  const last = text.charCodeAt(MOST_TEXT - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MOST_TEXT - 1 : MOST_TEXT;
  return `${text.slice(0, end)}…`;
}

function targets(kind: Kind): string[] | undefined {
  const found = [
    "target" in kind ? kind.target : undefined,
    "from_target" in kind ? kind.from_target : undefined,
    "to_target" in kind ? kind.to_target : undefined,
  ].filter((id) => id !== undefined);
  return found.length > 0 ? found : undefined;
}

/** Read again, as the renderer keeps only its textures. */
async function image(opened: Opened, id: unknown, background: string) {
  if (typeof id !== "string" || !Object.hasOwn(opened.board.elements, id)) {
    throw new Error(`${opened.folder.name} has no element ${String(id)}`);
  }
  const { kind } = opened.board.elements[id]!;
  if (kind.type !== "image") {
    throw new Error(`${id} has type ${kind.type}, not image`);
  }
  const { natural_size: natural, frame, rotation, edits, filename, source, caption } = kind;
  const unreadable = (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    return new Error(`Planche cannot read the picture of ${id} (${reason})`);
  };
  const asset = await readAsset(files(opened), kind.asset, natural).catch((error: unknown) => {
    throw unreadable(error);
  });
  // Engines load no video for a hidden page, until it shows.
  if (asset.video && document.hidden) {
    throw new Error("Planche shows a video's first frame only while its window shows");
  }
  const decoded = await decodeAsset(asset, MOST_SIDE).catch((error: unknown) => {
    throw unreadable(error);
  });
  let image: Capture;
  try {
    if (decoded instanceof ImageBitmap) {
      image = capture(decoded, { width: decoded.width, height: decoded.height }, background);
    } else {
      const scale = Math.max(1, SMALLEST_VECTOR / Math.max(natural.width, natural.height));
      image = capture(decoded.image, { width: natural.width * scale, height: natural.height * scale }, background);
    }
  } finally {
    release(decoded);
  }
  const still = asset.video ? "the video's first frame" : asset.moving ? "the first frame" : undefined;
  return { id, filename, source, caption, natural_size: natural, frame, rotation, edits, still, image };
}

/** Drawn and read in this task, as a canvas holds its drawing no longer. */
function screenshot(reading: Reading) {
  if (reading.halfDrawn()) {
    throw new Error("A board is opening in Planche");
  }
  const canvas = reading.drawNow();
  const view = reading.shown();
  if (canvas === undefined || view === undefined || canvas.width === 0 || canvas.height === 0) {
    throw new Error("Planche shows no board yet");
  }
  const image = capture(canvas, { width: canvas.width, height: canvas.height }, reading.background());
  return { view, pixels_per_unit: image.width / view.width, image };
}

/** Drawn at the size asked, so that `capture` has nothing to scale. */
async function render(reading: Reading, opened: Opened, { area, ids, size }: Record<string, unknown>) {
  if (reading.halfDrawn()) {
    throw new Error("A board is opening in Planche");
  }
  if ((area == null) === (ids == null)) {
    throw new Error("Give either an area or ids, not both or neither");
  }
  if (size != null && !(typeof size === "number" && Number.isFinite(size) && size >= 1)) {
    throw new Error("size must be a number of pixels");
  }
  const request: Request = { size: size == null ? undefined : (size as number) };
  if (area != null) {
    const { x, y, width, height } = area as Rect;
    if (![x, y, width, height].every(Number.isFinite) || !(width > 0 && height > 0)) {
      throw new Error("area needs a position and a size above zero");
    }
    request.area = { x, y, width, height };
  } else {
    elements(opened, ids);
    request.ids = ids as string[];
  }
  const { area: covered, canvas } = await reading.render(request);
  const image = capture(canvas, { width: canvas.width, height: canvas.height }, reading.background());
  return { area: covered, pixels_per_unit: image.width / covered.width, image };
}

function elements(opened: Opened, ids: unknown): Record<string, Element> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error("ids must be a list of element ids");
  }
  const unknown = ids.filter((id) => !Object.hasOwn(opened.board.elements, id));
  if (unknown.length > 0) {
    throw new Error(`${opened.folder.name} has no element ${unknown.join(", ")}`);
  }
  return Object.fromEntries(ids.map((id) => [id, opened.board.elements[id]!]));
}
