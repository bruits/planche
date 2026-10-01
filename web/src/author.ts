// What agents change on the open board, as the desktop shell passes their tools' calls on. Each
// call waits for the user to finish a drag or a text, then edits in one go, which undoes in one
// step, as an edit made during a gesture would join it.

import { fromBase64 } from "./add.js";
import { extent, holdsImage, imageKind, newId, prepare, release, row, type Added, type Opened } from "./board.js";
import * as core from "./core.js";
import type { Editor, Kind, Point, Rect, Size } from "./core.js";
import { FONT_SIZE, NOTE_WIDTH, PLACED_SIZE, STICKY_SIZE, type Restack } from "./edit.js";
import { LONGEST_SIDE } from "./raster.js";
import { anchored, fitted, holdsText } from "./text.js";

/** The page's state that agents change. */
export interface Writing {
  opened(): Opened | undefined;
  /** Whether a board is opening, which an edit would miss. */
  loading(): boolean;
  busy(): boolean;
  idle(): Promise<void>;
  apply(work: (editor: Editor, touched: string[]) => void): string[];
  /** To draw and to save the images, before they are added. */
  keep(target: Opened, added: Added[]): void;
  zoom(): number | undefined;
  centre(): Point | undefined;
  select(ids: string[]): void;
  selection(): string[];
  entered(): string | undefined;
  /** Turns the view on the elements. */
  frame(ids: string[]): void;
}

const IDLE_WAIT = 10_000;
/**
 * Before the shell's deadline, which the edit and its answer fit within, so that a call the
 * shell gave up on changed nothing.
 */
const MARGIN = 5_000;

/** When the call began, by `performance.now()`, and when the shell gives up on it, by `Date.now()`. */
interface Clock {
  started: number;
  deadline: number;
}

type Args = Record<string, unknown>;

/** Throws what the agent reads when nothing changed. */
export async function write(tool: string, args: Args, page: Writing, deadline: number): Promise<unknown> {
  const clock = { started: performance.now(), deadline };
  const target = page.opened()!;
  switch (tool) {
    case "add_images":
      return addImages(page, target, clock, args.images as NewImage[]);
    case "add":
      return add(page, target, clock, args.elements as New[], args.stick !== false);
    case "update":
      return update(page, target, clock, args.updates as Change[]);
    case "transform":
      return transform(page, target, clock, args as unknown as Transform);
    case "restack": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      return { touched: page.apply((editor, touched) => touched.push(...editor.restack(ids, args.to as Restack))) };
    }
    case "group": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      const group = newId();
      return { group, touched: page.apply((editor, touched) => touched.push(...editor.group(group, ids))) };
    }
    case "ungroup": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      return { touched: page.apply((editor, touched) => ids.forEach((id) => touched.push(...editor.ungroup(id)))) };
    }
    case "remove": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      const touched = page.apply((editor, touched) => touched.push(...editor.remove(ids)));
      return { touched, removed: touched.filter((id) => !Object.hasOwn(target.board.elements, id)) };
    }
    case "select": {
      // A selection that changes under a press breaks it.
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      page.select(ids);
      if (args.frame === true && ids.length > 0) {
        page.frame(ids);
      }
      return { selected: page.selection(), entered: page.entered() ?? null };
    }
    default:
      return undefined;
  }
}

async function ready(page: Writing, target: Opened, { started, deadline }: Clock): Promise<void> {
  const until = started + IDLE_WAIT;
  while (page.busy()) {
    const left = until - performance.now();
    const waited = left > 0 && (await Promise.race([page.idle().then(() => true), delay(left).then(() => false)]));
    if (!waited) {
      throw new Error("The user is editing in Planche, dragging or writing a text, so nothing changed: try again");
    }
  }
  if (page.opened() !== target) {
    throw new Error("Another board opened in Planche meanwhile, so nothing changed");
  }
  if (page.loading()) {
    throw new Error("A board is opening in Planche, so nothing changed");
  }
  if (Date.now() > deadline - MARGIN) {
    throw new Error("Planche took too long, so nothing changed");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function known(target: Opened, ids: unknown): string[] {
  const given = ids as string[];
  const unknown = given.filter((id) => !Object.hasOwn(target.board.elements, id));
  if (unknown.length > 0) {
    throw new Error(`${target.folder.name} has no element ${unknown.join(", ")}`);
  }
  return given;
}

function positive(value: number, what: string): number {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new Error(`${what} must be a positive number`);
  }
  return value;
}

interface NewImage {
  /** In base64, which the shell reads from a path. */
  data: string;
  filename?: string;
  x?: number;
  y?: number;
  width?: number;
  source?: string;
  caption?: string;
  group?: string;
}

async function addImages(page: Writing, target: Opened, clock: Clock, images: NewImage[]) {
  const added: Added[] = [];
  let frames: Rect[];
  try {
    for (const [at, image] of images.entries()) {
      const name = image.filename ?? `image ${at + 1}`;
      try {
        added.push({ ...(await prepare(fromBase64(image.data), LONGEST_SIDE)), filename: image.filename });
      } catch (error) {
        throw new Error(`${name} cannot be opened here (${reason(error)}), so nothing changed`);
      }
    }
    frames = placed(page, images, added);
    await ready(page, target, clock);
    // The images would stay kept otherwise, though none showed them.
    for (const { group } of images) {
      const kind = group !== undefined && Object.hasOwn(target.board.elements, group) ? target.board.elements[group]!.kind : undefined;
      if (group !== undefined && kind?.type !== "group") {
        throw new Error(`${target.folder.name} has no group ${group}, so nothing changed`);
      }
    }
  } catch (error) {
    added.forEach(({ decoded }) => release(decoded));
    throw error;
  }
  page.keep(target, added);
  const ids = added.map(() => newId());
  const touched = page.apply((editor, touched) =>
    added.forEach(({ asset, natural, filename }, at) => {
      const { source, caption, group } = images[at]!;
      const kind = imageKind(asset, natural, frames[at]!, { filename, source: filled(source), caption: filled(caption) });
      touched.push(...editor.add(ids[at]!, group, JSON.stringify(kind)));
    }),
  );
  return { touched, added: ids.map((id, at) => ({ id, filename: added[at]!.filename, frame: frames[at] })) };
}

function placed(page: Writing, images: NewImage[], added: Added[]): Rect[] {
  const sizes = added.map(({ natural }, at): Size => {
    const { width } = images[at]!;
    const scale = width === undefined ? 1 : positive(width, "width") / natural.width;
    return { width: natural.width * scale, height: natural.height * scale };
  });
  const unplaced = sizes.filter((_, at) => images[at]!.x === undefined || images[at]!.y === undefined);
  const lined = row(unplaced, page.centre() ?? { x: 0, y: 0 });
  return sizes.map((size, at) => {
    const { x, y } = images[at]!;
    return x === undefined || y === undefined ? lined.shift()! : { x, y, ...size };
  });
}

function filled(text: string | undefined): string | undefined {
  return text?.trim() ? text : undefined;
}

function reason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

type New = { group?: string } & (
  | { type: "note"; x: number; y: number; width?: number; text: string; font_size?: number; rotation?: number }
  | {
      type: "sticky" | "shape";
      x: number;
      y: number;
      width?: number;
      height?: number;
      text?: string;
      font_size?: number;
      shape?: "rectangle" | "ellipse" | "cross";
      rotation?: number;
    }
  | { type: "arrow" | "line"; from: Point; to: Point }
  | { type: "comment"; at: Point; text: string }
);

async function add(page: Writing, target: Opened, clock: Clock, elements: New[], stick: boolean) {
  await ready(page, target, clock);
  // The size a click places, which reads as well as the board around it in the view.
  const zoom = page.zoom() ?? 1;
  const ids = elements.map(() => newId());
  const touched = page.apply((editor, touched) =>
    elements.forEach((element, at) => {
      const id = ids[at]!;
      touched.push(...editor.add(id, element.group, JSON.stringify(kindOf(editor, element, zoom, stick))));
      if ("rotation" in element && element.rotation) {
        const { x, y, width, height } = core.bounds(editor, [id])!;
        touched.push(...editor.rotate([id], x + width / 2, y + height / 2, element.rotation));
      }
      if (element.type !== "arrow" && element.type !== "line") {
        touched.push(...(stick ? editor.land([id]) : editor.unstick([id])));
      }
    }),
  );
  const bounds = (id: string) => core.bounds(target.editor, [id]) ?? null;
  return { touched, added: ids.map((id, at) => ({ id, type: elements[at]!.type, bounds: bounds(id) })) };
}

function kindOf(editor: Editor, element: New, zoom: number, stick: boolean): Kind {
  switch (element.type) {
    case "note":
    case "sticky":
    case "shape": {
      const text = element.text ?? "";
      if (element.type === "note" && !text.trim()) {
        throw new Error("A note needs some text");
      }
      const side = element.type === "sticky" ? STICKY_SIZE : PLACED_SIZE;
      const width = positive(element.width ?? (element.type === "note" ? NOTE_WIDTH : side) / zoom, "width");
      const height = "height" in element && element.height !== undefined ? positive(element.height, "height") : side / zoom;
      const font_size = positive(element.font_size ?? FONT_SIZE / zoom, "font_size");
      const frame = { x: element.x, y: element.y, width, height };
      const content = { content: text, font_size };
      if (element.type === "shape") {
        return fitted({ type: "shape", frame, rotation: 0, shape: element.shape ?? "rectangle", text: content });
      }
      return fitted({ type: element.type, frame, rotation: 0, text: content });
    }
    case "arrow":
    case "line": {
      if (element.from.x === element.to.x && element.from.y === element.to.y) {
        throw new Error(`An ${element.type === "arrow" ? "arrow" : "line"} needs two ends apart`);
      }
      const end = (point: Point): { at: Point; target?: string } => (stick ? core.stick(editor, point, 0) : undefined) ?? { at: point };
      const [from, to] = [end(element.from), end(element.to)];
      return { type: element.type, from: from.at, to: to.at, from_target: from.target, to_target: to.target };
    }
    case "comment":
      if (!element.text.trim()) {
        throw new Error("A comment needs some text");
      }
      return { type: "comment", at: element.at, text: element.text };
  }
}

interface Change {
  id: string;
  text?: string;
  font_size?: number;
  shape?: "rectangle" | "ellipse" | "cross";
  caption?: string;
  source?: string;
  greyscale?: boolean;
  /** In the image's pixels, all of them for none. */
  crop?: Rect;
}

async function update(page: Writing, target: Opened, clock: Clock, changes: Change[]) {
  await ready(page, target, clock);
  known(
    target,
    changes.map(({ id }) => id),
  );
  const touched = page.apply((editor, touched) =>
    changes.forEach((change) => touched.push(...editor.update(change.id, JSON.stringify(patched(editor, change))))),
  );
  return { touched };
}

/** From the core, as earlier changes of the call left it. */
function patched(editor: Editor, { id, text, font_size, shape, caption, source, greyscale, crop }: Change): Kind {
  const kind = core.element(editor, id)!.kind;
  const refuse = (field: string) => new Error(`${id} has type ${kind.type}, which takes no ${field}`);
  if (text !== undefined) {
    if (kind.type === "comment") {
      kind.text = text;
    } else if (holdsText(kind)) {
      kind.text.content = text;
    } else {
      throw refuse("text");
    }
    if ((kind.type === "note" || kind.type === "comment") && !text.trim()) {
      throw new Error(`${id} needs some text, as a ${kind.type}`);
    }
  }
  if (font_size !== undefined) {
    if (!holdsText(kind)) {
      throw refuse("font_size");
    }
    kind.text.font_size = positive(font_size, "font_size");
  }
  if (shape !== undefined) {
    if (kind.type !== "shape") {
      throw refuse("shape");
    }
    kind.shape = shape;
  }
  const imageField = [
    caption !== undefined && "caption",
    source !== undefined && "source",
    greyscale !== undefined && "greyscale",
    crop !== undefined && "crop",
  ].find((field) => field);
  if (imageField) {
    if (kind.type !== "image") {
      throw refuse(imageField);
    }
    if (caption !== undefined) {
      kind.caption = filled(caption);
    }
    if (source !== undefined) {
      kind.source = filled(source);
    }
    if (greyscale !== undefined) {
      kind.edits.greyscale = greyscale;
    }
    if (crop !== undefined) {
      const { width, height } = kind.natural_size;
      const inside = (area: Rect) =>
        area.x >= 0 && area.y >= 0 && area.width > 0 && area.height > 0 && area.x + area.width <= width && area.y + area.height <= height;
      if (!inside(crop)) {
        throw new Error(`The crop must lie within the image's ${width} by ${height} pixels`);
      }
      // The image keeps its scale, and its top left corner where it is, as turned.
      const shown = kind.edits.crop ?? { x: 0, y: 0, width, height };
      const { width: across, height: down } = kind.frame;
      const size = { width: (crop.width * across) / shown.width, height: (crop.height * down) / shown.height };
      kind.frame = anchored(kind.frame, kind.rotation, size);
      const whole = crop.x === 0 && crop.y === 0 && crop.width === width && crop.height === height;
      kind.edits.crop = whole ? null : crop;
    }
  }
  return holdsText(kind) ? fitted(kind) : kind;
}

interface Transform {
  ids: string[];
  flip?: "horizontal" | "vertical";
  scale?: number;
  width?: number;
  about?: Point;
  rotate?: number;
  translate?: Point;
  move_to?: Point;
  stick?: boolean;
}

async function transform(page: Writing, target: Opened, clock: Clock, given: Transform) {
  if (given.scale !== undefined && given.width !== undefined) {
    throw new Error("Give scale or width, not both");
  }
  if (given.translate !== undefined && given.move_to !== undefined) {
    throw new Error("Give translate or move_to, not both");
  }
  await ready(page, target, clock);
  const ids = known(target, given.ids);
  const bounds = extent(target, ids);
  if (bounds === undefined) {
    throw new Error("These elements take no room on the board");
  }
  if (given.flip !== undefined && !holdsImage(target.board, ids)) {
    throw new Error("Only images flip, and these hold none");
  }
  const about = given.about ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const touched = page.apply((editor, touched) => {
    if (given.flip !== undefined) {
      touched.push(...editor.flip(ids, given.flip === "horizontal"));
    }
    const factor = given.width === undefined ? given.scale : positive(given.width, "width") / bounds.width;
    if (factor !== undefined) {
      touched.push(...editor.scale(ids, about.x, about.y, positive(factor, "scale")));
    }
    if (given.rotate) {
      touched.push(...editor.rotate(ids, about.x, about.y, given.rotate));
    }
    const moved = given.translate ?? (given.move_to && offset(target, editor, ids, given.move_to));
    if (moved !== undefined) {
      touched.push(...editor.translate(ids, moved.x, moved.y));
    }
    // As the user's moves set down what they move, and a flip sets nothing down.
    if (factor !== undefined || given.rotate || moved !== undefined || given.stick !== undefined) {
      touched.push(...(given.stick === false ? editor.unstick(ids) : editor.land(ids)));
    }
  });
  return { touched };
}

/** From where the elements are now, as earlier steps of the call moved them. */
function offset(target: Opened, editor: Editor, ids: string[], to: Point): Point {
  const now = extent({ ...target, board: core.board(editor) }, ids)!;
  return { x: to.x - now.x, y: to.y - now.y };
}
