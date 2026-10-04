// What agents change on the open board, as the desktop shell passes their tools' calls on. Each
// call waits for the user to finish a drag, a text, or a crop, then edits in one go, which undoes
// in one step, as an edit made during a gesture would join it.

import { fromBase64 } from "./add.js";
import type { NewElement, NewImage, TransformArguments, Update } from "./arguments.js";
import {
  holdsImage,
  imageKind,
  newId,
  prepare,
  release,
  row,
  setLabel,
  type Added,
  type Opened,
} from "./board.js";
import * as core from "./core.js";
import type { Alignment, Axis, Editor, Kind, Point, Rect, Restack, Size } from "./core.js";
import { FONT_SIZE, NOTE_WIDTH, PLACED_SIZE, STICKY_SIZE } from "./edit.js";
import { message } from "./errors.js";
import { LONGEST_SIDE } from "./raster.js";
import { restyled, settings, TEXT, type Style } from "./style.js";
import { fitted, holdsText, isBlank } from "./text.js";

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
export async function write(
  tool: string,
  args: Args,
  page: Writing,
  deadline: number,
): Promise<unknown> {
  const clock = { started: performance.now(), deadline };
  const target = page.opened()!;
  switch (tool) {
    case "add_images":
      return addImages(page, target, clock, args.images as ReadImage[]);
    case "add":
      return add(page, target, clock, args.elements as NewElement[], args.stick !== false);
    case "update":
      return update(page, target, clock, args.updates as Update[]);
    case "transform":
      return transform(page, target, clock, args as unknown as TransformArguments);
    case "restack": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      return {
        touched: page.apply((editor, touched) =>
          touched.push(...editor.restack(ids, args.to as Restack)),
        ),
      };
    }
    case "align": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      return {
        touched: page.apply((editor, touched) =>
          touched.push(...editor.align(ids, args.to as Alignment)),
        ),
      };
    }
    case "distribute": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      return {
        touched: page.apply((editor, touched) =>
          touched.push(...editor.distribute(ids, args.axis as Axis)),
        ),
      };
    }
    case "group": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      const group = newId();
      return {
        group,
        touched: page.apply((editor, touched) => touched.push(...editor.group(group, ids))),
      };
    }
    case "ungroup": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      return {
        touched: page.apply((editor, touched) =>
          ids.forEach((id) => touched.push(...editor.ungroup(id))),
        ),
      };
    }
    case "remove": {
      await ready(page, target, clock);
      const ids = known(target, args.ids);
      const changed = page.apply((editor, touched) => touched.push(...editor.remove(ids)));
      return {
        touched: changed,
        removed: changed.filter((id) => !Object.hasOwn(target.board.elements, id)),
      };
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
    const waited =
      left > 0 &&
      (await Promise.race([page.idle().then(() => true), delay(left).then(() => false)]));
    if (!waited) {
      throw new Error(
        "The user is editing in Planche, dragging, writing a text, or cropping an image, so nothing changed: try again",
      );
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

/** As the shell passes it on, its file read. */
type ReadImage = NewImage & { data: string };

async function addImages(page: Writing, target: Opened, clock: Clock, images: ReadImage[]) {
  const added: Added[] = [];
  let frames: Rect[];
  try {
    for (const [at, image] of images.entries()) {
      const name = image.filename ?? `image ${at + 1}`;
      try {
        added.push({
          ...(await prepare(fromBase64(image.data), LONGEST_SIDE)),
          filename: image.filename,
        });
      } catch (error) {
        throw new Error(`${name} cannot be opened here (${message(error)}), so nothing changed`, {
          cause: error,
        });
      }
    }
    frames = placed(page, images, added);
    await ready(page, target, clock);
    // The images would stay kept otherwise, though none showed them.
    for (const { group } of images) {
      const kind =
        group !== undefined && Object.hasOwn(target.board.elements, group)
          ? target.board.elements[group]!.kind
          : undefined;
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
  const changed = page.apply((editor, touched) =>
    added.forEach(({ asset, natural, filename }, at) => {
      const { source, caption, group } = images[at]!;
      const kind = imageKind(asset, natural, frames[at]!, {
        filename,
        source: filled(source),
        caption: filled(caption),
      });
      touched.push(...editor.add(ids[at]!, group, JSON.stringify(kind)));
    }),
  );
  return {
    touched: changed,
    added: ids.map((id, at) => ({ id, filename: added[at]!.filename, frame: frames[at] })),
  };
}

function placed(page: Writing, images: NewImage[], added: Added[]): Rect[] {
  const sizes = added.map(({ natural }, at): Size => {
    const { width } = images[at]!;
    const scale = width === undefined ? 1 : positive(width, "width") / natural.width;
    return { width: natural.width * scale, height: natural.height * scale };
  });
  const unplaced = sizes.filter(
    (_, at) => images[at]!.x === undefined || images[at]!.y === undefined,
  );
  const lined = row(unplaced, page.centre() ?? { x: 0, y: 0 });
  return sizes.map((size, at) => {
    const { x, y } = images[at]!;
    return x === undefined || y === undefined ? lined.shift()! : { x, y, ...size };
  });
}

function filled(text: string | undefined): string | undefined {
  return text?.trim() ? text : undefined;
}

/** What agents set of a style, a colour in either case. */
type Styling = Omit<Style, "size" | "colour"> & { colour?: string };

const SETTABLE = [
  "colour",
  "paper",
  "weight",
  "dash",
  "heads",
  "fill",
  "bold",
  "italic",
  "strike",
  "align",
  "opacity",
] as const;

/** In what `given` sets of its style, each where the style card would offer it, or `refuse` throws. */
function styled(
  kind: Kind,
  given: Styling,
  refuse: (field: string, blank: boolean) => Error,
): Kind {
  const style: Style = {};
  for (const field of SETTABLE) {
    const value = given[field];
    if (value === undefined) {
      continue;
    }
    if (!settings(kind).includes(field)) {
      throw refuse(field, holdsText(kind) && isBlank(kind) && TEXT.includes(field));
    }
    if (field === "colour") {
      const written = String(value).toLowerCase();
      const colour = core.colour(written);
      if (colour === undefined) {
        throw new Error(
          `\`${written}\` is not a colour, which is ink, red, orange, green, blue, violet, or #rrggbb`,
        );
      }
      style.colour = colour;
    } else if (field === "opacity") {
      if (core.checked({ opacity: value }) === undefined) {
        throw new Error(`\`opacity\` is a percent from 1 to 100, not ${String(value)}`);
      }
      style.opacity = value as number;
    } else {
      Object.assign(style, { [field]: value });
    }
  }
  // The zoom only sets a size, which agents give in font sizes instead.
  return restyled(kind, style, 1);
}

/** As refusals name it, a cross apart, as it takes no fill. */
function named(kind: Kind): string {
  return kind.type === "shape" && kind.shape === "cross" ? "cross" : kind.type;
}

async function add(
  page: Writing,
  target: Opened,
  clock: Clock,
  elements: NewElement[],
  stick: boolean,
) {
  await ready(page, target, clock);
  // The size a click places, which reads as well as the board around it in the view.
  const zoom = page.zoom() ?? 1;
  const ids = elements.map(() => newId());
  const changed = page.apply((editor, touched) =>
    elements.forEach((element, at) => {
      const id = ids[at]!;
      touched.push(
        ...editor.add(id, element.group, JSON.stringify(kindOf(editor, element, zoom, stick))),
        ...core.transform(editor, [id], {
          rotate: "rotation" in element ? element.rotation : undefined,
          sticking: stick ? "land" : "free",
        }),
      );
    }),
  );
  const bounds = (id: string) => core.extent(target.editor, [id]) ?? null;
  return {
    touched: changed,
    added: ids.map((id, at) => ({ id, type: elements[at]!.type, bounds: bounds(id) })),
  };
}

function kindOf(editor: Editor, element: NewElement, zoom: number, stick: boolean): Kind {
  switch (element.type) {
    case "note":
    case "sticky":
    case "shape": {
      const text = element.text ?? "";
      if (element.type === "note" && !text.trim()) {
        throw new Error("A note needs some text");
      }
      const side = element.type === "sticky" ? STICKY_SIZE : PLACED_SIZE;
      const width = positive(
        element.width ?? (element.type === "note" ? NOTE_WIDTH : side) / zoom,
        "width",
      );
      const height =
        "height" in element && element.height !== undefined
          ? positive(element.height, "height")
          : side / zoom;
      const font_size = positive(element.font_size ?? FONT_SIZE / zoom, "font_size");
      const frame = { x: element.x, y: element.y, width, height };
      const content = { content: text, font_size };
      const kind: Kind =
        element.type === "shape"
          ? {
              type: "shape",
              frame,
              rotation: 0,
              shape: element.shape ?? "rectangle",
              text: content,
            }
          : { type: element.type, frame, rotation: 0, text: content };
      const dressed = styled(
        kind,
        element,
        (field, blank) =>
          new Error(
            `A new ${named(kind)} ${blank ? `needs some text before its ${field}` : `takes no ${field}`}`,
          ),
      );
      return holdsText(dressed) ? fitted(dressed) : dressed;
    }
    case "arrow":
    case "line": {
      if (element.from.x === element.to.x && element.from.y === element.to.y) {
        throw new Error(`An ${element.type === "arrow" ? "arrow" : "line"} needs two ends apart`);
      }
      const end = (point: Point) => core.landEnd(editor, point, { reach: stick ? 0 : undefined });
      const [from, to] = [end(element.from), end(element.to)];
      const kind: Kind = {
        type: element.type,
        from: from.at,
        to: to.at,
        ...(from.target !== undefined && { from_target: from.target }),
        ...(to.target !== undefined && { to_target: to.target }),
      };
      return styled(kind, element, (field) => new Error(`A new ${element.type} takes no ${field}`));
    }
    case "comment":
      if (!element.text.trim()) {
        throw new Error("A comment needs some text");
      }
      return { type: "comment", at: element.at, text: element.text };
  }
}

async function update(page: Writing, target: Opened, clock: Clock, changes: Update[]) {
  await ready(page, target, clock);
  known(
    target,
    changes.map(({ id }) => id),
  );
  const changed = page.apply((editor, touched) =>
    changes.forEach((change) => {
      touched.push(...editor.update(change.id, JSON.stringify(patched(editor, change))));
      const { crop } = change;
      if (crop !== undefined) {
        touched.push(...editor.crop(change.id, crop.x, crop.y, crop.width, crop.height));
      }
    }),
  );
  return { touched: changed };
}

/** From the core, as earlier changes of the call left it, but for the crop, which the core makes. */
function patched(editor: Editor, change: Update): Kind {
  const { id, text, font_size, shape, caption, source, greyscale, crop, crop_shape } = change;
  const kind = core.element(editor, id)!.kind;
  const refuse = (field: string, blank = false) =>
    new Error(
      blank
        ? `${id} needs some text before its ${field}`
        : named(kind) === "cross"
          ? `${id} is a cross, which takes no ${field}`
          : `${id} has type ${kind.type}, which takes no ${field}`,
    );
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
    crop_shape !== undefined && "crop_shape",
  ].find((field) => field);
  if (imageField) {
    if (kind.type !== "image") {
      throw refuse(imageField);
    }
    if (caption !== undefined) {
      setLabel(kind, "caption", caption);
    }
    if (source !== undefined) {
      setLabel(kind, "source", source);
    }
    if (greyscale !== undefined) {
      kind.edits.greyscale = greyscale;
    }
    if (crop_shape !== undefined) {
      kind.edits.crop_shape = crop_shape;
    }
  }
  // After its shape, which tells whether it takes a fill.
  const dressed = styled(kind, change, refuse);
  return holdsText(dressed) ? fitted(dressed) : dressed;
}

async function transform(page: Writing, target: Opened, clock: Clock, given: TransformArguments) {
  if (given.scale !== undefined && given.width !== undefined) {
    throw new Error("Give scale or width, not both");
  }
  if (given.translate !== undefined && given.move_to !== undefined) {
    throw new Error("Give translate or move_to, not both");
  }
  await ready(page, target, clock);
  const ids = known(target, given.ids);
  if (given.flip !== undefined && !holdsImage(target.board, ids)) {
    throw new Error("Only images flip, and these hold none");
  }
  const scale =
    given.width === undefined
      ? given.scale === undefined
        ? undefined
        : { by: positive(given.scale, "scale") }
      : { to_width: positive(given.width, "width") };
  const place =
    given.translate === undefined
      ? given.move_to && { to: given.move_to }
      : { by: given.translate };
  const changed = page.apply((editor, touched) =>
    touched.push(
      ...core.transform(editor, ids, {
        flip: given.flip,
        scale,
        rotate: given.rotate,
        about: given.about,
        place,
        sticking: given.stick === undefined ? undefined : given.stick ? "land" : "free",
      }),
    ),
  );
  return { touched: changed };
}
