// Edits: draw, write, select, move, scale, and rotate by pointer, and flip, turn, restack, group,
// delete, undo, and redo for the commands to run. A click selects the element under it, or the
// outermost group holding it, and a drag from where nothing is draws a rectangle that selects
// what it touches. Double-clicking a group goes into it, where clicks select its own elements
// instead, and double-clicking a note, a sticky note, a shape, or a comment writes in it. The dots
// on the selection's corners scale it around the opposite one, or around its centre while ⌥, or
// Alt elsewhere than macOS, is held once under way, as pressing with it pans. The sides of a lone
// note, sticky note, or shape stretch it, its text keeping its size, and a drag from just outside
// a corner turns the selection around its centre, by steps of 15° while ⇧ is held, and onto an
// upright or a quarter turn near it while snapping. Hovering shows what a press would take, and
// the ends of a lone arrow or line move on their own. The ends of an arrow or a line, as drawn or
// moved, stick to the image, note, sticky note, or shape they land on, onto its outline when near
// it, and follow it from then on. While ⇧ is held, the end being drawn or moved keeps to a
// multiple of 45° around the other one, the grid pulling it along its way, and it sticks only to
// what it lies on. A note, a sticky note, a shape, or a comment drawn, placed, moved, scaled, or
// turned whole onto an image, a note, a sticky note, or a shape filled or holding text sticks to
// it and follows it too. While snapping, what moves, scales, or is drawn lands on the grid's lines
// where near them otherwise. Holding ⌘, or Ctrl elsewhere than macOS, keeps things from sticking
// and the grid from pulling, but for a move only once under way, as pressing an element with it
// toggles the element instead. The eraser removes what a click would select, or all that a drag
// passes over but what it starts within, in one edit. Cropping shows an image whole, what its crop
// leaves out dimmed, and its edges and corners drag the crop, or its inside moves it, until Enter
// or a press elsewhere crops it, or Escape leaves it as it was.

import { mac, opensMenu } from "./commands.js";
import * as core from "./core.js";
import type { Background, Board, Editor, Kind, Order, Point, Rect, Side, Size } from "./core.js";
import { among, newId } from "./board.js";
import { cursor, dotted, type Crop, type Grab, type Overlay } from "./overlay.js";
import { pinned } from "./pins.js";
import { anchored, fitted, holdsText, LINE_HEIGHT, needed, type Holder } from "./text.js";
import type { View } from "./view.js";
import { writer } from "./writer.js";

/** How near the pointer counts as on an element, in CSS pixels. */
const TOLERANCE = 4;
/** How near the pointer counts as on a handle, in CSS pixels. */
const REACH = 6;
/** How far out from a corner a press turns the selection, in CSS pixels. */
const TURN_REACH = 20;
/** What a turn steps by while ⇧ is held, in degrees. */
const TURN_STEP = 15;
/** How near an upright or a quarter turn a turn snaps onto it, in degrees. */
const MAGNET = 2;
/** Stretched no narrower or shorter, so that its sides stay apart to grab, in CSS pixels. */
const SMALLEST_SIDE = 8;
/** How near an element an end sticks to it, and how near its outline it sticks onto that, in CSS pixels. */
const STICK = 12;
/** How far a press moves before it drags, in CSS pixels. */
const DRAG = 3;
/** Scaling down further would turn the selection over. */
const SMALLEST_SCALE = 0.01;
/** A shape placed by a click, in CSS pixels. */
export const PLACED_SIZE = 100;
/** A sticky note placed by a click, in CSS pixels. */
export const STICKY_SIZE = 200;
/** How wide a note placed by a click wraps, in CSS pixels. */
export const NOTE_WIDTH = 240;
/** Of the text drawn or placed, in CSS pixels. */
export const FONT_SIZE = 20;

export interface Editing {
  editor: Editor;
  board: Board;
}

export type Restack = "forward" | "backward" | "front" | "back";

/** What a press draws, while a tool to draw is in use. */
export type Draw = "arrow" | "line" | "rectangle" | "ellipse" | "cross" | "note" | "sticky" | "comment";

export interface Hooks {
  /**
   * The elements every edit, undo, and redo touches, once `current` would have them up to date,
   * as it must. The background may have changed too.
   */
  changed(touched: string[]): void;
  selectionChanged(): void;
  /** Once a press ends, whose gesture held undo and redo back. */
  settled(): void;
  snapping(): boolean;
  /** What a press draws, `undefined` when it selects. */
  drawing(): Draw | undefined;
  /** Whether a press erases, before it draws or selects. */
  erasing(): boolean;
  /** Whether a press picks a colour, which leaves the board alone. */
  sampling(): boolean;
  /** Once a press drew something, which it selects, or writes in. */
  drawn(): void;
  /** What a press draws, in the style its tool draws in, at `zoom` CSS pixels per board unit. */
  styled(kind: Kind, zoom: number): Kind;
  /** Whether a press selects, with no tool that draws, erases, pans, or picks a colour. */
  selecting(): boolean;
  /** Once what of the selection the pointer is on, or a press holds, changed. */
  hovered(): void;
  /** Once the topmost element the pointer is on changed, which a press keeps, `undefined` when none is or a finger touches. */
  pointed(id: string | undefined): void;
}

/** A size, a share of an image's own size, or an angle, as a gesture shows it. */
export interface Reading {
  text: string;
  /** Whether it snapped onto a step or a quarter turn. */
  snapped: boolean;
}

type Keys = Pick<MouseEvent, "shiftKey" | "altKey" | "metaKey" | "ctrlKey">;

type Segment = Extract<Kind, { type: "arrow" | "line" }>;
const SEGMENTS = new Set<string>(["arrow", "line"] satisfies Segment["type"][]);
type Comment = Extract<Kind, { type: "comment" }>;
/** Which edges of a crop a grip drags, in parts of its width and height, none at ½. */
const GRIPS: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
];
const CORNERS = GRIPS.filter(([x, y]) => x !== 0.5 && y !== 0.5);
/** Across, then by 45° each, clockwise as the board's y runs down, with no hair off an axis. */
const DIRECTIONS: [number, number][] = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [0, -1],
  [Math.SQRT1_2, -Math.SQRT1_2],
];

export interface Edits {
  /** Whether a gesture, some writing, or a crop is under way, which edits from elsewhere would break. */
  busy(): boolean;
  /** Once none is under way. */
  idle(): Promise<void>;
  /**
   * Runs `work`, which pushes what it touches, as one edit that undoes in one step. Throws when a
   * gesture or some writing is under way, or when `work` throws, after which none of it stays.
   */
  apply(work: (editor: Editor, touched: string[]) => void): string[];
  /** The element being written in, whose text the renderer leaves to the field. */
  writing(): string | undefined;
  /** Whether the selection is one element that holds text. */
  writable(): boolean;
  /** In the one element selected that holds text, or in `id`, within its group. */
  write(id?: string): void;
  /** Lays the field over the element being written in, as the camera moved. */
  follow(): void;
  /** Elements of the group gone into, or of the top level. */
  selection(): string[];
  /** The group gone into, `undefined` at the top level. */
  entered(): string | undefined;
  /** Selects the elements, or the groups holding them at the level of the selection. */
  select(ids: string[]): void;
  /** Selects `id` itself, going into its group. */
  choose(id: string): void;
  /** Everything in the group gone into, or on the board. */
  selectAll(): void;
  /** Selects the group gone into, which leaves it. Whether there was one. */
  up(): boolean;
  /** Into the one group selected, selecting its elements. */
  goInside(): void;
  loneSegment(): boolean;
  /**
   * Selects what a right-click at `at` is about, the element there, or `on`, unless it is
   * selected already, or nothing unless `at` is within the selection. Whether anything is.
   */
  aim(at: Point, on?: string): boolean;
  /** The selection's centre, `undefined` when nothing is selected. */
  centre(): Point | undefined;
  /** Clockwise from its top-left, the box around the selection, `undefined` when it draws nothing. */
  box(): Point[] | undefined;
  remove(): void;
  flip(horizontally: boolean): void;
  /** Clockwise around the selection's centre, as turning it from a corner does. */
  rotate(degrees: number): void;
  straighten(): void;
  greyscale(on: boolean): void;
  /** The one image selected. */
  crop(): void;
  cropping(): string | undefined;
  resetCrop(): void;
  /** The images among the selection, which stays as it is. */
  arrange(order: Order): void;
  /** The images among the selection. */
  normalize(side: Side): void;
  background(to: Background): void;
  restack(to: Restack): void;
  /** Into a new group named `id`, which it selects. */
  group(id: string): void;
  /** Selects the elements of the groups it ungroups. */
  ungroup(): void;
  undo(): void;
  redo(): void;
  /** Forgets the selection and any drag, as when another board opens. */
  reset(): void;
  /** Looks again at what the pointer rests on, as once another board shows. */
  rehover(): void;
  /** What of the selection a press holds, or else the pointer is on. */
  grab(): Grab["kind"] | undefined;
  /** What a gesture that scales, stretches, or turns the selection reads, `undefined` for none. */
  reading(): Reading | undefined;
}

type Press =
  /**
   * `through` a press on nothing but the selection's box, which a click lets go of. `bounds` as
   * they were when the drag began.
   */
  | { kind: "move"; pointer: number; start: Point; dragging: boolean; clicked?: string; through?: true; bounds?: Rect }
  | { kind: "marquee"; pointer: number; start: Point; dragging: boolean; kept: Set<string> }
  /**
   * By the dot on the corner `at` of the box `corners` it started from, pressed at `handle` so
   * that it starts at 1, `centred` while held around its centre.
   */
  | { kind: "scale"; pointer: number; corners: Point[]; at: number; handle: Point; upright: boolean; centred: boolean }
  /** By the side `at` of the lone `id`, which was `from`, pressed at `start`. */
  | { kind: "stretch"; pointer: number; corners: Point[]; at: number; start: Point; id: string; from: Holder }
  /**
   * From outside the corner `at`, `from` the pointer's angle around `pivot`, `angle` the lone
   * element's own as it was, `turned` by as many degrees so far, which `snapped`.
   */
  | {
      kind: "rotate";
      pointer: number;
      corners: Point[];
      at: number;
      pivot: Point;
      from: number;
      angle?: number;
      turned: number;
      snapped: boolean;
    }
  /** `ends` where it was last drawn from and to, once dragging. */
  | { kind: "draw"; pointer: number; start: Point; ends?: [Point, Point]; shape: Draw; id: string; dragging: boolean }
  | { kind: "end"; pointer: number; start: Point; dragging: boolean; id: string; segment: Segment; end: "from" | "to" }
  /**
   * `within` what a drag starts within, which it leaves with the groups holding it, whatever the
   * level. `selection` and `entered` as they were, which a lost press gets back with what it erased.
   */
  | {
      kind: "erase";
      pointer: number;
      start: Point;
      last: Point;
      dragging: boolean;
      clicked?: string;
      within: string[];
      selection: Set<string>;
      entered?: string;
    }
  /** A crop's `grip`, or the crop itself without one, from `start`, a pixel, and the crop it had. */
  | { kind: "crop"; pointer: number; grip?: [number, number]; start: Point; from: Rect };

export function edits(
  view: View,
  overlay: Overlay,
  current: () => Editing | undefined,
  { changed, selectionChanged, settled, snapping, drawing, erasing, sampling, drawn, styled, selecting, hovered, pointed }: Hooks,
): Edits {
  let selected = new Set<string>();
  let entered: string | undefined;
  let press: Press | undefined;
  /** What of the selection the pointer is on while nothing is pressed. */
  let over: Grab | undefined;
  /** What a click would select, but for what is selected already. */
  let previewed: string | undefined;
  /** The topmost element the pointer is on, as last told. */
  let under: string | undefined;
  /** The pointer's last event over the board, which hovering looks at again as the keys or the camera change. */
  let seen: PointerEvent | undefined;
  let keys: Keys | undefined;
  /** Where a press last was on the board, which it goes on from as the keys change. */
  let last: Point | undefined;
  /** Whether hovering waits for the next frame. */
  let hovering = false;
  /** Whether the grid pulls, as the last pointer event had its keys. */
  let pulling = false;
  /** Whether ends stick, as the last pointer event had its keys. */
  let sticking = false;
  /** Its gesture stays open until the field closes, so that writing undoes in one step. */
  let written: { id: string; fresh: boolean } | undefined;
  /** Whether the last press was a click, as browsers still send a double-click when it dragged. */
  let wasClick = false;
  /** The comment whose pin the last press was on, which the pointer's capture hides from later events. */
  let pressedPin: string | undefined;
  /**
   * The image being cropped, in pixels the part of it that will show. Its gesture stays open, the
   * image shown whole, until the crop is done, so that meanwhile the board reads as unsaved and
   * agents read the image whole.
   */
  let cropping: { id: string; area: Rect } | undefined;
  let waiting: (() => void)[] = [];
  const underway = () => press !== undefined || written !== undefined || cropping !== undefined;
  const resolve = () => {
    if (!underway()) {
      const ready = waiting;
      waiting = [];
      ready.forEach((resolve) => resolve());
    }
  };
  const settle = () => {
    press = undefined;
    resolve();
  };
  const field = writer(view.host);
  const pulled = (point: Point, zoom: number): Point =>
    pulling
      ? { x: point.x + (core.snapToGrid([point.x], zoom) ?? 0), y: point.y + (core.snapToGrid([point.y], zoom) ?? 0) }
      : point;
  const landed = (editor: Editor, point: Point, zoom: number, sticks = true, around?: Point): { at: Point; target?: string } => {
    if (around === undefined) {
      return (sticks && sticking ? core.stick(editor, point, STICK / zoom) : undefined) ?? { at: pulled(point, zoom) };
    }
    // Onto what it lies on, as moving it onto an outline would turn it off its angle.
    const lying = (at: Point) => (sticks && sticking ? core.stick(editor, at, 0)?.target : undefined);
    const at = angled(point, around);
    const target = lying(at);
    if (target !== undefined || !pulling) {
      return { at, target };
    }
    const pulledTo = pulledAlong(at, around, zoom);
    return { at: pulledTo, target: lying(pulledTo) };
  };
  const showTargets = (editor: Editor, ids: (string | undefined)[]) =>
    overlay.targets(ids.flatMap((id) => (id === undefined ? [] : [editor.outline(id)])));
  const setDown = (editor: Editor, ids: string[]) => (sticking ? editor.land(ids) : editor.unstick(ids));
  const holders = ({ board }: Editing, ids: string[]) => {
    const chosen = new Set(ids);
    return Object.entries(board.elements).flatMap(([id, { kind }]) =>
      "target" in kind && among(board, id, chosen) ? [kind.target] : [],
    );
  };
  /** As moving it would pull it. */
  const aligned = (kind: Kind, zoom: number): Kind => {
    if (!pulling || !("frame" in kind)) {
      return kind;
    }
    const { frame } = kind;
    const [x, y] = [edges(frame.x, frame.width), edges(frame.y, frame.height)].map((values) => core.snapToGrid(values, zoom) ?? 0);
    return { ...kind, frame: { ...frame, x: frame.x + x!, y: frame.y + y! } };
  };

  const lone = (editing: Editing): { id: string; segment: Segment } | undefined => {
    const [id] = selected;
    const kind = selected.size === 1 ? editing.board.elements[id!]?.kind : undefined;
    return isSegment(kind) ? { id: id!, segment: kind } : undefined;
  };
  /** The one note, sticky note, or shape selected, whose sides stretch it. */
  const stretchable = ({ board }: Editing): { id: string; kind: Holder } | undefined => {
    const [id] = selected;
    const kind = selected.size === 1 ? board.elements[id!]?.kind : undefined;
    return holdsText(kind) ? { id: id!, kind } : undefined;
  };
  /**
   * What a press at `at` takes of the selection's box `corners`, a dot before a side, a note's only
   * across as its text sets its height, and the zone outside a corner unless something else lies
   * there.
   */
  const grabbing = (editing: Editing, corners: Point[], at: Point, zoom: number, hit: string | undefined): Grab | undefined => {
    // Shrunk to a point, as around a group holding only an arrow of no length, it neither scales nor turns.
    if (distance(corners[0]!, corners[2]!) === 0) {
      return undefined;
    }
    const far = corners.map((corner) => distance(at, corner) * zoom);
    const nearest = far.indexOf(Math.min(...far));
    if (dotted(corners, zoom)) {
      if (far[nearest]! <= REACH) {
        return { kind: "corner", at: nearest };
      }
      const kind = stretchable(editing)?.kind;
      const sides = kind === undefined ? [] : kind.type === "note" ? [1, 3] : [0, 1, 2, 3];
      const off = sides.map((side) => offSegment(at, corners[side]!, corners[(side + 1) % 4]!) * zoom);
      const closest = Math.min(...off);
      if (closest <= REACH) {
        return { kind: "side", at: sides[off.indexOf(closest)]! };
      }
    }
    const elsewhere = hit !== undefined && !among(editing.board, hit, selected);
    return far[nearest]! <= TURN_REACH && !elsewhere && !within(at, corners) ? { kind: "turn", at: nearest } : undefined;
  };
  const gripped = (editing: Editing, { kind, at: index }: Grab, corners: Point[], at: Point, pointer: number): Press => {
    if (kind === "corner") {
      return { kind: "scale", pointer, corners, at: index, handle: at, upright: upright(corners), centred: false };
    }
    const holder = stretchable(editing);
    if (kind === "side" && holder) {
      return { kind: "stretch", pointer, corners, at: index, start: at, id: holder.id, from: holder.kind };
    }
    const [id] = selected;
    const own = selected.size === 1 ? editing.board.elements[id!]?.kind : undefined;
    const pivot = middle(corners);
    const from = Math.atan2(at.y - pivot.y, at.x - pivot.x);
    const angle = own && "rotation" in own ? own.rotation : undefined;
    return { kind: "rotate", pointer, corners, at: index, pivot, from, angle, turned: 0, snapped: false };
  };
  /** What of the selection's box a press holds. */
  const holding = (): Grab | undefined => {
    switch (press?.kind) {
      case "scale":
        return { kind: "corner", at: press.at };
      case "stretch":
        return { kind: "side", at: press.at };
      case "rotate":
        return { kind: "turn", at: press.at };
      default:
        return undefined;
    }
  };
  /** What a press holds, or else the pointer is on, over the selection's box `corners`, with its cursor. */
  const showGrab = (corners: Point[] | undefined) => {
    const held = holding();
    const grab = corners && (held ?? over);
    overlay.grab(grab, held !== undefined);
    const shown = grab && cursor(grab, corners!);
    view.host.classList.toggle("over-handle", shown !== undefined);
    if (shown) {
      view.host.style.setProperty("--handle-cursor", shown);
    }
  };
  const hovers = (event: PointerEvent) => event.pointerType !== "touch" && pinned(event.target) === undefined;
  const hoverable = (event: PointerEvent) =>
    hovers(event) && !keys?.altKey && selecting() && !underway() && !view.panning();
  /** What a press would take where the pointer last was, and what a click there would select. */
  const hover = () => {
    hovering = false;
    if (press) {
      return;
    }
    const editing = current();
    const at = seen && view.at(seen);
    const zoom = view.zoom();
    const was = over?.kind;
    let corners: Point[] | undefined;
    over = undefined;
    previewed = undefined;
    const hit = editing && seen && at && zoom && hovers(seen) ? editing.editor.hit(at.x, at.y, TOLERANCE / zoom) : undefined;
    if (editing && seen && at && zoom && hoverable(seen)) {
      const { editor } = editing;
      corners = selected.size > 0 && !lone(editing) ? box(editor, [...selected]) : undefined;
      over = corners && grabbing(editing, corners, at, zoom, hit);
      const top = hit === undefined || over ? undefined : (level(editor, hit) ?? editor.topLevel(hit));
      previewed = top !== undefined && !selected.has(top) ? top : undefined;
    }
    overlay.preview(editing && previewed !== undefined ? editing.editor.outline(previewed) : undefined);
    showGrab(corners);
    if (over?.kind !== was) {
      hovered();
    }
    if (hit !== under) {
      under = hit;
      pointed(hit);
    }
  };
  /** On the next frame, once however many events come before it. */
  const rehover = () => {
    if (!hovering) {
      hovering = true;
      requestAnimationFrame(hover);
    }
  };
  /** Where pixels at `parts` of `area` lie on the board, however the image is turned or flipped. */
  const lying = ({ editor }: Editing, id: string, area: Rect, parts: [number, number][]) =>
    parts.flatMap(([x, y]) => core.pointOfPixel(editor, id, { x: area.x + x * area.width, y: area.y + y * area.height }) ?? []);
  const cropShown = (editing: Editing): Crop | undefined => {
    const kind = cropping && editing.board.elements[cropping.id]?.kind;
    if (!cropping || kind?.type !== "image") {
      return undefined;
    }
    const { id, area } = cropping;
    return {
      image: lying(editing, id, whole(kind.natural_size), CORNERS),
      kept: lying(editing, id, area, CORNERS),
      grips: lying(editing, id, area, GRIPS),
    };
  };
  const show = () => {
    const editing = current();
    const ids = cropping ? [] : [...selected];
    const segment = editing && !cropping ? lone(editing)?.segment : undefined;
    const corners = editing && ids.length > 0 && !segment ? box(editing.editor, ids) : undefined;
    overlay.outline(editing ? ids.map((id) => editing.editor.outline(id)) : []);
    overlay.box(corners);
    overlay.ends(segment ? [segment.from, segment.to] : undefined);
    overlay.entered(editing && entered !== undefined ? box(editing.editor, [entered]) : undefined);
    overlay.crop(editing && cropShown(editing));
    const sized = press?.kind === "scale" || press?.kind === "stretch" ? press : undefined;
    overlay.start(sized?.corners, sized?.kind === "scale" && sized.centred ? middle(sized.corners) : undefined);
    showGrab(corners);
    rehover();
    selectionChanged();
  };
  /** The element, or its group, at the level of the selection, `undefined` outside the group gone into. */
  const level = (editor: Editor, id: string) =>
    entered === undefined ? editor.topLevel(id) : editor.memberOf(entered, id);
  /**
   * Up to the group `to`, or the top level. A selection never mixes levels, as moving a group
   * and one of its elements would move it twice.
   */
  const leave = (editor: Editor, to?: string) => {
    entered = to;
    selected = new Set([...selected].flatMap((id) => level(editor, id) ?? []));
  };
  /** What a press on `hit` is about. Pressing anything but the group's elements leaves it, unless `stays`. */
  const aimed = (editor: Editor, hit: string | undefined, stays: boolean) => {
    if (entered !== undefined && !stays && (hit === undefined || level(editor, hit) === undefined)) {
      leave(editor);
    }
    return hit === undefined ? undefined : level(editor, hit);
  };
  const select = (editing: Editing, ids: string[]) => {
    const { editor, board } = editing;
    const present = ids.filter((id) => id in board.elements);
    if (present.some((id) => level(editor, id) === undefined)) {
      leave(editor);
    }
    selected = new Set(present.flatMap((id) => level(editor, id) ?? []));
  };
  /** As a click would select it, but outside the group gone into without leaving it. */
  const erasable = (editor: Editor, id: string) => level(editor, id) ?? editor.topLevel(id);
  const erase = (editing: Editing, press: Extract<Press, { kind: "erase" }>, at: Point, pins: string[], zoom: number) => {
    const { editor, board } = editing;
    const { last, within } = press;
    const hits = [...editor.hitAlong(last.x, last.y, at.x, at.y, TOLERANCE / zoom), ...pins];
    const holds = (id: string) => within.some((kept) => among(board, kept, new Set([id])));
    const erased = new Set(hits.flatMap((id) => erasable(editor, id) ?? []).filter((id) => !holds(id)));
    if (erased.size > 0) {
      edit(editing, editor.remove([...erased]));
    }
    press.last = at;
  };
  /** The comments whose pins lie on the way on screen, which the pointer's capture hides from its events. */
  const pinsAlong = (from: Point, to: { clientX: number; clientY: number }) => {
    const start = view.client(from);
    if (!start) {
      return [];
    }
    const [dx, dy] = [to.clientX - start.clientX, to.clientY - start.clientY];
    // No more than a way across the window takes, however far the view moved meanwhile.
    const steps = Math.min(Math.ceil(Math.hypot(dx, dy) / TOLERANCE), Math.ceil((innerWidth + innerHeight) / TOLERANCE));
    const pins = new Set<string>();
    for (let step = 0; step <= steps; step++) {
      const along = steps === 0 ? 0 : step / steps;
      const pin = pinned(document.elementFromPoint(start.clientX + dx * along, start.clientY + dy * along));
      if (pin !== undefined) {
        pins.add(pin);
      }
    }
    return [...pins];
  };
  /** Undoing and redoing select what they touch, and nothing touched keeps the selection. */
  const edit = (editing: Editing, touched: string[], reselect = false) => {
    const { board } = editing;
    // Read before the edit, which may remove the group gone into, and its emptied groups too.
    const around: string[] = [];
    for (let at = entered; at !== undefined && !around.includes(at); at = board.elements[at]?.group) {
      around.push(at);
    }
    changed(touched);
    if (entered !== undefined && !(entered in board.elements)) {
      leave(editing.editor, around.find((id) => id in board.elements));
    }
    if (reselect && touched.length > 0) {
      select(editing, touched);
    }
    for (const id of selected) {
      if (!(id in editing.board.elements)) {
        selected.delete(id);
      }
    }
    show();
  };

  view.host.addEventListener("pointerdown", (event) => {
    wasClick = false;
    pressedPin = pinned(event.target);
    seen = event;
    keys = event;
    const editing = current();
    const at = view.at(event);
    const zoom = view.zoom();
    if (press || !editing || !at || !zoom || event.button !== 0 || view.pans(event) || opensMenu(event) || sampling()) {
      return;
    }
    last = at;
    over = undefined;
    previewed = undefined;
    overlay.preview(undefined);
    const { editor } = editing;
    const pointer = event.pointerId;
    if (cropping) {
      const { id, area } = cropping;
      const start = core.pixelAt(editor, id, at);
      const far = lying(editing, id, area, GRIPS).map((grip) => distance(at, grip) * zoom);
      const nearest = far.indexOf(Math.min(...far));
      if (start && far[nearest]! <= REACH) {
        press = { kind: "crop", pointer, grip: GRIPS[nearest], start, from: area };
      } else if (start && within(at, lying(editing, id, area, CORNERS))) {
        press = { kind: "crop", pointer, start, from: area };
      } else {
        finishCropping(editing, true);
        return;
      }
      view.host.setPointerCapture(pointer);
      return;
    }
    pulling = snapping() && !freed(event);
    sticking = !freed(event);
    if (erasing()) {
      const hit = pressedPin ?? editor.hit(at.x, at.y, TOLERANCE / zoom);
      press = {
        kind: "erase",
        pointer,
        start: at,
        last: at,
        dragging: false,
        clicked: hit === undefined ? undefined : erasable(editor, hit),
        within: editor.covering(at.x, at.y),
        selection: new Set(selected),
        entered,
      };
      editor.beginGesture();
      view.host.setPointerCapture(pointer);
      return;
    }
    const shape = drawing();
    if (shape) {
      press = { kind: "draw", pointer, start: at, shape, id: newId(), dragging: false };
      view.host.setPointerCapture(pointer);
      return;
    }
    // Over the selection's handles, a pin takes the press.
    const single = pressedPin === undefined ? lone(editing) : undefined;
    if (single) {
      const ends = (["from", "to"] as const).filter((end) => distance(at, single.segment[end]) * zoom <= REACH);
      // The nearest, as they may overlap on a short segment.
      const end = ends.sort((a, b) => distance(at, single.segment[a]) - distance(at, single.segment[b]))[0];
      if (end) {
        press = { kind: "end", pointer, start: at, dragging: false, ...single, end };
        editor.beginGesture();
        view.host.setPointerCapture(pointer);
        return;
      }
    }
    const corners = selected.size > 0 && !single ? box(editor, [...selected]) : undefined;
    const hit = pressedPin ?? editor.hit(at.x, at.y, TOLERANCE / zoom);
    const grab = corners && pressedPin === undefined ? grabbing(editing, corners, at, zoom, hit) : undefined;
    // Ctrl on macOS opens the context menu instead.
    const toggling = event.shiftKey || event.metaKey || (event.ctrlKey && !mac);
    // Within the selection's box, which its hollow shapes mostly let through, a press drags it.
    const onSelection = hit === undefined && !toggling && within(at, corners);
    const top = aimed(editor, hit, grab !== undefined || onSelection);
    if (corners && grab) {
      press = gripped(editing, grab, corners, at, pointer);
      editor.beginGesture();
      hovered();
    } else if (top !== undefined && toggling) {
      if (!selected.delete(top)) {
        selected.add(top);
      }
    } else if (top !== undefined) {
      // Pressing one of several selected elements drags them all, and clicking it selects it alone.
      const clicked = selected.has(top) ? top : undefined;
      if (!clicked) {
        selected = new Set([top]);
      }
      press = { kind: "move", pointer, start: at, dragging: false, clicked };
    } else if (onSelection) {
      press = { kind: "move", pointer, start: at, dragging: false, through: true };
    } else {
      press = { kind: "marquee", pointer, start: at, dragging: false, kept: toggling ? new Set(selected) : new Set() };
      selected = new Set(press.kept);
    }
    if (press) {
      view.host.setPointerCapture(pointer);
    }
    show();
  });

  view.host.addEventListener("pointermove", (event) => {
    seen = event;
    keys = event;
    if (!press) {
      rehover();
      return;
    }
    const editing = current();
    const at = view.at(event);
    const zoom = view.zoom();
    if (event.pointerId !== press.pointer || !editing || !at || !zoom) {
      return;
    }
    if (press.kind === "erase") {
      press.dragging ||= distance(at, press.start) * zoom >= DRAG;
      if (press.dragging) {
        erase(editing, press, at, pinsAlong(press.last, event), zoom);
      }
      return;
    }
    if (press.kind === "crop") {
      const kind = cropping && editing.board.elements[cropping.id]?.kind;
      const pixel = cropping && core.pixelAt(editing.editor, cropping.id, at);
      if (cropping && pixel && kind?.type === "image") {
        cropping.area = dragged(press, pixel, kind.natural_size);
        show();
      }
      return;
    }
    last = at;
    drag(editing, at, zoom, event);
  });
  // As the keys change what a press does, or what a press would take, without the pointer moving.
  for (const type of ["keydown", "keyup"] as const) {
    addEventListener(type, (event) => {
      keys = event;
      const editing = current();
      const zoom = view.zoom();
      const modifier = !event.repeat && ["Shift", "Alt", "Meta", "Control"].includes(event.key);
      const held =
        press?.kind === "scale" ||
        press?.kind === "stretch" ||
        press?.kind === "rotate" ||
        press?.kind === "end" ||
        (press?.kind === "draw" && SEGMENTS.has(press.shape));
      if (held && modifier && editing && last && zoom) {
        drag(editing, last, zoom, event);
      } else if (!press) {
        rehover();
      }
    });
  }
  view.host.addEventListener("pointerleave", () => {
    seen = undefined;
    rehover();
  });
  // The camera moves under the pointer.
  view.host.addEventListener("wheel", rehover, { passive: true });

  /** Carries the press on to `at`, with `keys` held. */
  const drag = (editing: Editing, at: Point, zoom: number, keys: Keys) => {
    if (!press) {
      return;
    }
    const { editor } = editing;
    const ids = [...selected];
    pulling = snapping() && !freed(keys);
    sticking = !freed(keys);
    // From where the gesture began, so that coming back there changes nothing.
    const again = (edited: () => string[]) => edit(editing, [...editor.rewindGesture(), ...edited()]);
    const settled = (touched: string[], snapped: boolean) => (snapped ? [...touched, ...editor.settleOnGrid(ids)] : touched);
    switch (press.kind) {
      case "marquee": {
        press.dragging ||= distance(at, press.start) * zoom >= DRAG;
        const area = rect(press.start, at);
        const touched = editor.touching(area.x, area.y, area.width, area.height);
        selected = new Set([...press.kept, ...touched.flatMap((id) => editor.topLevel(id) ?? [])]);
        overlay.marquee(area);
        show();
        return;
      }
      case "move": {
        if (!press.dragging) {
          if (distance(at, press.start) * zoom < DRAG) {
            return;
          }
          press.dragging = true;
          press.bounds = bounding(box(editor, ids));
          editor.beginGesture();
        }
        const { start, bounds } = press;
        const [dx, dy] = [at.x - start.x, at.y - start.y];
        const [nx, ny] =
          pulling && bounds
            ? [core.snapToGrid(edges(bounds.x + dx, bounds.width), zoom), core.snapToGrid(edges(bounds.y + dy, bounds.height), zoom)]
            : [];
        const snapped = nx !== undefined || ny !== undefined;
        again(() => [...settled(editor.translate(ids, dx + (nx ?? 0), dy + (ny ?? 0)), snapped), ...setDown(editor, ids)]);
        showTargets(editor, holders(editing, ids));
        return;
      }
      case "scale": {
        const { corners, at: index, handle } = press;
        press.centred = keys.altKey;
        const corner = corners[index]!;
        const origin = press.centred ? middle(corners) : corners[(index + 2) % 4]!;
        const [dx, dy] = [handle.x - origin.x, handle.y - origin.y];
        const length = dx * dx + dy * dy;
        if (length === 0) {
          return;
        }
        // Along the diagonal, so that the scale is the same both ways.
        const along = ((at.x - origin.x) * dx + (at.y - origin.y) * dy) / length;
        const factor = Math.max(along, SMALLEST_SCALE);
        const pulled = pulling && press.upright ? core.snapScaleToGrid(origin, corner, factor, zoom) : undefined;
        const snapped = pulled !== undefined && pulled >= SMALLEST_SCALE;
        again(() => [...settled(editor.scale(ids, origin.x, origin.y, snapped ? pulled : factor), snapped), ...setDown(editor, ids)]);
        showTargets(editor, holders(editing, ids));
        return;
      }
      case "stretch": {
        const { corners, at: side, start, id, from } = press;
        const [a, b] = [corners[side]!, corners[(side + 1) % 4]!];
        const length = distance(a, b);
        if (length === 0) {
          return;
        }
        // Outwards, as the box runs clockwise.
        const normal = { x: (b.y - a.y) / length, y: (a.x - b.x) / length };
        let by = (at.x - start.x) * normal.x + (at.y - start.y) * normal.y;
        let snapped = false;
        if (pulling && upright(corners)) {
          const across = Math.abs(normal.x) > Math.abs(normal.y);
          const pull = core.snapToGrid([across ? a.x + by * normal.x : a.y + by * normal.y], zoom);
          if (pull !== undefined) {
            by += pull * (across ? normal.x : normal.y);
            snapped = true;
          }
        }
        const next = extended(from, side, by, Math.max(SMALLEST_SIDE / zoom, from.text.font_size));
        again(() => [...settled(editor.stretch(id, JSON.stringify(next)), snapped), ...setDown(editor, ids)]);
        showTargets(editor, holders(editing, ids));
        return;
      }
      case "rotate": {
        const { pivot, from, angle } = press;
        const turned = ((Math.atan2(at.y - pivot.y, at.x - pivot.x) - from) * 180) / Math.PI;
        // A lone element snaps its own angle, and several the angle they turn by.
        [press.turned, press.snapped] = turning(angle ?? 0, turned, keys.shiftKey, pulling);
        const by = press.turned;
        again(() => [...editor.rotate(ids, pivot.x, pivot.y, by), ...setDown(editor, ids)]);
        showTargets(editor, holders(editing, ids));
        return;
      }
      case "draw": {
        // Pinned where it was pressed.
        if (press.shape === "comment") {
          return;
        }
        if (!press.dragging) {
          if (distance(at, press.start) * zoom < DRAG) {
            return;
          }
          press.dragging = true;
          selected = new Set();
          editor.beginGesture();
        }
        const { id, shape } = press;
        const sticks = SEGMENTS.has(shape);
        const start = landed(editor, press.start, zoom, sticks);
        const end = landed(editor, at, zoom, sticks, sticks && keys.shiftKey ? start.at : undefined);
        press.ends = [start.at, end.at];
        // A note shows nothing until written in.
        overlay.marquee(shape === "note" ? rect(start.at, end.at) : undefined);
        const kind = styled(shaped(shape, start.at, end.at, FONT_SIZE / zoom), zoom);
        if (sticks) {
          const stuck = { ...kind, from_target: start.target, to_target: end.target };
          again(() => editor.add(id, entered, JSON.stringify(stuck)));
          showTargets(editor, [start.target, end.target]);
        } else {
          again(() => [...editor.add(id, entered, JSON.stringify(kind)), ...setDown(editor, [id])]);
          showTargets(editor, holders(editing, [id]));
        }
        return;
      }
      case "end": {
        const { id, segment, end, start } = press;
        // By as much as the pointer moved, so that the end never jumps to it.
        if (!press.dragging && distance(at, start) * zoom < DRAG) {
          return;
        }
        press.dragging = true;
        const point = { x: segment[end].x + at.x - start.x, y: segment[end].y + at.y - start.y };
        const moved = landed(editor, point, zoom, true, keys.shiftKey ? segment[end === "from" ? "to" : "from"] : undefined);
        showTargets(editor, [moved.target]);
        again(() => editor.update(id, JSON.stringify({ ...segment, [end]: moved.at, [`${end}_target`]: moved.target })));
        return;
      }
    }
  };

  /** `completed` unless the press was lost, as to a blur. */
  const release = (completed: boolean) => {
    if (!press) {
      return;
    }
    wasClick = (press.kind === "move" || press.kind === "marquee") && !press.dragging;
    const held = holding() !== undefined;
    overlay.targets([]);
    if (press.kind === "marquee") {
      overlay.marquee(undefined);
    } else if (press.kind === "draw") {
      finishDrawing(press, completed);
    } else if (press.kind === "erase") {
      const editing = current();
      if (editing && !completed) {
        selected = press.selection;
        entered = press.entered;
        edit(editing, editing.editor.rewindGesture());
      } else if (editing && !press.dragging && press.clicked !== undefined) {
        edit(editing, editing.editor.remove([press.clicked]));
      }
      editing?.editor.endGesture();
    } else if (press.kind === "crop") {
      // Its gesture lasts until the crop is done.
    } else if (press.kind !== "move" || press.dragging) {
      current()?.editor.endGesture();
    } else if (press.clicked !== undefined) {
      selected = new Set([press.clicked]);
      show();
    } else if (press.through && completed) {
      // As a click on nothing does.
      entered = undefined;
      selected = new Set();
      show();
    }
    settle();
    if (held) {
      // Without what it held, nor the box it started from.
      show();
    }
    rehover();
    settled();
  };
  /**
   * A click places a shape at a size of its own, but draws no arrow or line, which has none. A
   * drag brought back to where it started, or pulled back there by the grid, counts as a click. A
   * note, a sticky note, or a comment is written in at once, within the gesture that drew it.
   */
  const finishDrawing = (press: Extract<Press, { kind: "draw" }>, completed: boolean) => {
    const editing = current();
    const zoom = view.zoom();
    overlay.marquee(undefined);
    if (!editing) {
      return;
    }
    const { editor } = editing;
    const { id, shape, start, ends, dragging } = press;
    const writes = shape === "note" || shape === "sticky" || shape === "comment";
    // Nobody would write in it.
    if (writes && !completed) {
      edit(editing, editor.rewindGesture());
      editor.endGesture();
      return;
    }
    if (ends && zoom !== undefined && distance(...ends) * zoom >= DRAG) {
      if (!writes) {
        editor.endGesture();
      }
    } else {
      const touched = dragging ? editor.rewindGesture() : [];
      const placing = !SEGMENTS.has(shape) && completed && zoom !== undefined;
      if (placing) {
        editor.beginGesture();
        touched.push(...editor.add(id, entered, JSON.stringify(aligned(styled(placed(shape, start, zoom), zoom), zoom))));
        touched.push(...setDown(editor, [id]));
      }
      if (!writes) {
        editor.endGesture();
      }
      edit(editing, touched);
      if (!placing) {
        return;
      }
    }
    selected = new Set([id]);
    show();
    drawn();
    if (writes) {
      write(editing, id, true);
    }
  };

  const follow = () => {
    const kind = written && current()?.board.elements[written.id]?.kind;
    const zoom = view.zoom();
    if (kind?.type === "comment") {
      const at = view.client(kind.at);
      if (at) {
        field.bubble(at);
      }
    } else if (holdsText(kind) && zoom !== undefined) {
      const at = view.client({ x: kind.frame.x, y: kind.frame.y });
      if (at) {
        field.follow(kind, at, zoom);
      }
    }
  };
  /**
   * Its frame grows to fit what is written, as one edit from the text it started with, `fresh`
   * when its gesture holds its adding too.
   */
  const write = (editing: Editing, id: string, fresh: boolean) => {
    const element = editing.board.elements[id];
    const kind = element?.kind;
    if (!element || !writesIn(kind)) {
      return;
    }
    const { editor } = editing;
    editor.beginGesture();
    written = { id, fresh };
    selected = new Set();
    const rewrite = (content: string) => {
      const next = JSON.stringify(rewritten(kind, content));
      const touched = editor.rewindGesture();
      touched.push(...(fresh ? editor.add(id, element.group, next) : editor.update(id, next)));
      edit(editing, touched);
      follow();
    };
    field.open(contentOf(kind), rewrite, () => finishWriting(editing, id, fresh));
    if (fresh) {
      rewrite(contentOf(kind));
    } else {
      edit(editing, [id]);
      follow();
    }
  };
  /** A note or a comment left blank goes, as one edit with its writing. */
  const finishWriting = (editing: Editing, id: string, fresh: boolean) => {
    if (written?.id !== id || current() !== editing) {
      return;
    }
    written = undefined;
    const { editor, board } = editing;
    const kind = board.elements[id]?.kind;
    const touched = [id];
    if ((kind?.type === "note" || kind?.type === "comment") && contentOf(kind).trim() === "") {
      touched.push(...editor.rewindGesture());
      if (!fresh) {
        touched.push(...editor.remove([id]));
      }
    }
    editor.endGesture();
    selected = new Set([id]);
    edit(editing, touched);
    resolve();
  };
  // A gesture left open would keep undo from ever working again.
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    view.host.addEventListener(type, (event) => {
      if (type === "pointerup") {
        seen = event;
      }
      if (event.pointerId === press?.pointer) {
        release(type === "pointerup");
      }
    });
  }
  addEventListener("blur", () => release(false));

  view.host.addEventListener("dblclick", (event) => {
    const editing = current();
    const at = view.at(event);
    const zoom = view.zoom();
    if (!wasClick || press || !editing || !at || !zoom || event.button !== 0 || view.pans(event)) {
      return;
    }
    const { editor, board } = editing;
    const hit = pressedPin ?? editor.hit(at.x, at.y, TOLERANCE / zoom);
    const top = hit === undefined ? undefined : level(editor, hit);
    if (hit !== undefined && top !== undefined && board.elements[top]?.kind.type === "group") {
      const member = editor.memberOf(top, hit);
      entered = top;
      selected = new Set(member === undefined ? [] : [member]);
      show();
      return;
    }
    if (top !== undefined && board.elements[top]?.kind.type === "image") {
      crop(editing, top);
      return;
    }
    // Within a shape, whose text fills it once written.
    const target = top ?? surrounding(editing, at);
    if (target !== undefined && writesIn(board.elements[target]?.kind)) {
      write(editing, target, false);
    }
  });

  const crop = (editing: Editing, id: string) => {
    const kind = editing.board.elements[id]?.kind;
    if (kind?.type !== "image") {
      return;
    }
    const { editor } = editing;
    editor.beginGesture();
    cropping = { id, area: kind.edits.crop ?? whole(kind.natural_size) };
    selected = new Set([id]);
    edit(editing, editor.resetCrop([id]));
  };
  /** Crops the image as shown, or leaves it as it was, as one edit with all of its cropping. */
  const finishCropping = (editing: Editing, keep: boolean) => {
    if (!cropping) {
      return;
    }
    const { id, area } = cropping;
    cropping = undefined;
    const { editor } = editing;
    const touched = editor.rewindGesture();
    try {
      if (keep) {
        touched.push(...editor.crop(id, area.x, area.y, area.width, area.height));
      }
    } finally {
      editor.endGesture();
      edit(editing, touched);
      resolve();
    }
  };
  // Captured ahead of the commands, which wait while an image is being cropped.
  addEventListener(
    "keydown",
    (event) => {
      const editing = current();
      const key = event.key === "Enter" || event.key === "Escape";
      if (cropping && editing && key && !event.repeat && !event.defaultPrevented) {
        event.preventDefault();
        finishCropping(editing, event.key === "Enter");
      }
    },
    true,
  );
  // Pressing the toolbar or a menu crops it as Enter would, before what they do.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const editing = current();
      if (cropping && editing && !view.host.contains(event.target as Node)) {
        finishCropping(editing, true);
      }
    },
    true,
  );
  /** The topmost shape at the level of the selection whose frame holds `at`. */
  const surrounding = ({ editor, board }: Editing, at: Point) =>
    board.draw_order.findLast(
      (id) => board.elements[id]!.kind.type === "shape" && level(editor, id) === id && within(at, box(editor, [id])),
    );

  /** Unless a gesture, some writing, or a crop is under way, since it would carry on over the edit. */
  const run = (edited: (editing: Editing, ids: string[]) => void) => {
    const editing = current();
    if (editing && !underway()) {
      edited(editing, [...selected]);
    }
  };
  /** Turned or straightened, with what it turns setting down where it lands. */
  const turn = (editing: Editing, turned: () => string[]) => {
    const touched: string[] = [];
    editing.editor.beginGesture();
    try {
      touched.push(...turned(), ...editing.editor.land([...selected]));
    } finally {
      editing.editor.endGesture();
      edit(editing, touched);
    }
  };
  const writable = ({ board }: Editing) => selected.size === 1 && writesIn(board.elements[[...selected][0]!]?.kind);
  const choose = ({ board }: Editing, id: string) => {
    if (id in board.elements) {
      entered = board.elements[id]!.group;
      selected = new Set([id]);
    }
  };

  return {
    busy: underway,
    idle: () => (underway() ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve()),
    apply(work) {
      const editing = current();
      if (editing === undefined || underway()) {
        throw new Error("Someone is editing in Planche");
      }
      const { editor } = editing;
      const touched: string[] = [];
      editor.beginGesture();
      try {
        work(editor, touched);
      } catch (error) {
        touched.push(...editor.rewindGesture());
        throw error;
      } finally {
        editor.endGesture();
        // Even halfway, so that the board the app keeps matches the core's.
        edit(editing, [...new Set(touched)]);
      }
      return [...new Set(touched)];
    },
    writing: () => written?.id,
    writable() {
      const editing = current();
      return editing !== undefined && writable(editing);
    },
    write: (id) =>
      run((editing) => {
        if (id !== undefined) {
          choose(editing, id);
        }
        if (writable(editing)) {
          write(editing, [...selected][0]!, false);
        }
      }),
    follow,
    selection: () => [...selected],
    entered: () => entered,
    loneSegment() {
      const editing = current();
      return editing !== undefined && lone(editing) !== undefined;
    },
    select(ids) {
      const editing = current();
      if (editing) {
        select(editing, ids);
        show();
      }
    },
    choose: (id) =>
      run((editing) => {
        choose(editing, id);
        show();
      }),
    selectAll() {
      const editing = current();
      if (editing) {
        const { editor, board } = editing;
        selected = new Set(board.draw_order.flatMap((id) => level(editor, id) ?? []));
        show();
      }
    },
    up() {
      const editing = current();
      if (!editing || entered === undefined || press) {
        return false;
      }
      selected = new Set([entered]);
      entered = editing.board.elements[entered]?.group;
      show();
      return true;
    },
    goInside: () =>
      run(({ board }, ids) => {
        const group = ids[0];
        if (ids.length !== 1 || board.elements[group!]?.kind.type !== "group") {
          return;
        }
        entered = group;
        selected = new Set(Object.keys(board.elements).filter((id) => board.elements[id]!.group === group));
        show();
      }),
    aim(at, on) {
      const editing = current();
      const zoom = view.zoom();
      if (!editing || !zoom || press) {
        return selected.size > 0;
      }
      const { editor } = editing;
      const hit = on ?? editor.hit(at.x, at.y, TOLERANCE / zoom);
      // As a left press would, with no box around a lone arrow or line.
      const onSelection = hit === undefined && !lone(editing) && within(at, box(editor, [...selected]));
      const top = aimed(editor, hit, onSelection);
      if (top !== undefined && !selected.has(top)) {
        selected = new Set([top]);
      } else if (top === undefined && !onSelection) {
        selected = new Set();
      }
      show();
      return selected.size > 0;
    },
    centre() {
      const editing = current();
      const [id] = selected;
      const kind = selected.size === 1 ? editing?.board.elements[id!]?.kind : undefined;
      if (kind?.type === "comment") {
        return kind.at;
      }
      const corners = editing && selected.size > 0 ? box(editing.editor, [...selected]) : undefined;
      return corners && middle(corners);
    },
    box() {
      const editing = current();
      return editing && selected.size > 0 ? box(editing.editor, [...selected]) : undefined;
    },
    remove: () => run((editing, ids) => edit(editing, editing.editor.remove(ids))),
    flip: (horizontally) => run((editing, ids) => edit(editing, editing.editor.flip(ids, horizontally))),
    rotate: (degrees) =>
      run((editing, ids) => {
        const corners = box(editing.editor, ids);
        if (corners) {
          const pivot = middle(corners);
          turn(editing, () => editing.editor.rotate(ids, pivot.x, pivot.y, degrees));
        }
      }),
    straighten: () => run((editing, ids) => turn(editing, () => editing.editor.straighten(ids))),
    greyscale: (on) => run((editing, ids) => edit(editing, editing.editor.setGreyscale(ids, on))),
    crop: () =>
      run((editing, ids) => {
        if (ids.length === 1) {
          crop(editing, ids[0]!);
        }
      }),
    cropping: () => cropping?.id,
    resetCrop: () => run((editing, ids) => edit(editing, editing.editor.resetCrop(ids))),
    arrange: (order) => run((editing, ids) => edit(editing, core.arrange(editing.editor, ids, order))),
    normalize: (side) => run((editing, ids) => edit(editing, editing.editor.normalize(ids, side))),
    restack: (to) => run((editing, ids) => edit(editing, editing.editor.restack(ids, to))),
    background: (to) =>
      run((editing) => {
        core.setBackground(editing.editor, to);
        edit(editing, []);
      }),
    group: (id) =>
      run((editing, ids) => {
        const touched = editing.editor.group(id, ids);
        selected = new Set([id]);
        edit(editing, touched);
      }),
    ungroup: () =>
      run((editing, ids) => {
        const { editor, board } = editing;
        const groups = new Set(ids.filter((id) => board.elements[id]?.kind.type === "group"));
        const members = Object.keys(board.elements).filter((id) => groups.has(board.elements[id]!.group ?? ""));
        const touched: string[] = [];
        editor.beginGesture();
        try {
          groups.forEach((group) => touched.push(...editor.ungroup(group)));
        } finally {
          editor.endGesture();
          // Even halfway, so that the board the app keeps matches the core's.
          selected = new Set([...ids.filter((id) => !groups.has(id)), ...members]);
          edit(editing, touched);
        }
      }),
    undo: () => run((editing) => edit(editing, editing.editor.undo(), true)),
    redo: () => run((editing) => edit(editing, editing.editor.redo(), true)),
    reset() {
      selected = new Set();
      entered = undefined;
      // Its board is gone, and its gesture with it.
      written = undefined;
      cropping = undefined;
      field.close();
      settle();
      overlay.outline([]);
      overlay.box(undefined);
      overlay.ends(undefined);
      overlay.marquee(undefined);
      overlay.entered(undefined);
      overlay.targets([]);
      overlay.crop(undefined);
      over = undefined;
      previewed = undefined;
      overlay.start(undefined);
      overlay.preview(undefined);
      showGrab(undefined);
      under = undefined;
      pointed(undefined);
      selectionChanged();
    },
    rehover,
    grab: () => (holding() ?? over)?.kind,
    reading() {
      const editing = current();
      if (!editing || (press?.kind !== "scale" && press?.kind !== "stretch" && press?.kind !== "rotate")) {
        return undefined;
      }
      const [id] = selected;
      const kind = selected.size === 1 ? editing.board.elements[id!]?.kind : undefined;
      if (press.kind === "rotate") {
        const degrees = kind && "rotation" in kind ? kind.rotation : press.turned;
        return { text: `${signed(degrees)}°`, snapped: press.snapped };
      }
      if (press.kind === "scale" && kind?.type === "image") {
        const shown = kind.edits.crop ?? kind.natural_size;
        return { text: `${Math.round((kind.frame.width / shown.width) * 100)}%`, snapped: false };
      }
      // As turned, unlike the bounds of the box.
      const corners = box(editing.editor, [...selected]);
      if (!corners) {
        return undefined;
      }
      const [width, height] = [distance(corners[0]!, corners[1]!), distance(corners[1]!, corners[2]!)];
      return { text: `${Math.round(width)} × ${Math.round(height)}`, snapped: false };
    },
  };
}

/** Whether `point` is inside the box, whichever way it is turned. */
function within(point: Point, corners: Point[] | undefined): boolean {
  if (!corners) {
    return false;
  }
  // On the same side of every edge, as the box is convex.
  const sides = corners.map((from, at) => {
    const to = corners[(at + 1) % corners.length]!;
    return Math.sign((to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x));
  });
  return sides.every((side) => side >= 0) || sides.every((side) => side <= 0);
}

/** Clockwise from its top-left: a lone element's own, turned with it, or the upright bounds of all. */
function box(editor: Editor, ids: string[]): Point[] | undefined {
  const outline = ids.length === 1 ? editor.outline(ids[0]!) : undefined;
  if (outline?.length === 8) {
    return [0, 2, 4, 6].map((at) => ({ x: outline[at]!, y: outline[at + 1]! }));
  }
  const bounds = core.bounds(editor, ids);
  if (!bounds) {
    return undefined;
  }
  const { x, y, width, height } = bounds;
  const [right, bottom] = [x + width, y + height];
  return [
    { x, y },
    { x: right, y },
    { x: right, y: bottom },
    { x, y: bottom },
  ];
}

function middle(corners: Point[]): Point {
  return { x: (corners[0]!.x + corners[2]!.x) / 2, y: (corners[0]!.y + corners[2]!.y) / 2 };
}

/** Whether the box's sides run across and down, as when turned by a quarter or none. */
function upright(corners: Point[]): boolean {
  const [a, b] = corners;
  const [dx, dy] = [b!.x - a!.x, b!.y - a!.y];
  // Turning by a quarter leaves a hair, as sines and cosines do.
  return Math.min(Math.abs(dx), Math.abs(dy)) <= 1e-9 * Math.max(Math.abs(dx), Math.abs(dy));
}

function bounding(corners: Point[] | undefined): Rect | undefined {
  if (!corners) {
    return undefined;
  }
  const [xs, ys] = [corners.map(({ x }) => x), corners.map(({ y }) => y)];
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function edges(start: number, size: number): number[] {
  return [start, start + size / 2, start + size];
}

/** ⌘ on macOS, where Ctrl opens the context menu. */
function freed(keys: Keys): boolean {
  return mac ? keys.metaKey : keys.ctrlKey;
}

/**
 * By how much to turn what is turned `from` degrees, `by` more, by steps when `steps`, or onto an
 * upright or a quarter turn when `pulled` near one, and whether it snapped.
 */
function turning(from: number, by: number, steps: boolean, pulled: boolean): [number, boolean] {
  const to = from + by;
  if (steps) {
    return [Math.round(to / TURN_STEP) * TURN_STEP - from, true];
  }
  const quarter = Math.round(to / 90) * 90;
  return pulled && Math.abs(to - quarter) <= MAGNET ? [quarter - from, true] : [by, false];
}

/** `point` turned around `around` onto the nearest multiple of 45°, as far from it. */
function angled(point: Point, around: Point): Point {
  const [dx, dy] = [point.x - around.x, point.y - around.y];
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return point;
  }
  const [x, y] = DIRECTIONS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8]!;
  return { x: around.x + x * length, y: around.y + y * length };
}

/**
 * `at`, at a multiple of 45° around `around`, moved along its way exactly onto the nearest line of
 * the grid that pulls, short of `around`'s own, and kept exactly at its angle.
 */
function pulledAlong(at: Point, around: Point, zoom: number): Point {
  const [sx, sy] = [Math.sign(at.x - around.x), Math.sign(at.y - around.y)];
  const [nx, ny] = (
    [
      [at.x, around.x, sx],
      [at.y, around.y, sy],
    ] as const
  ).map(([value, from, sign]) => {
    const nudge = sign === 0 ? undefined : core.snapToGrid([value], zoom);
    return nudge !== undefined && (value + nudge - from) * sign > 0 ? nudge : undefined;
  });
  if (nx !== undefined && (ny === undefined || Math.abs(nx) <= Math.abs(ny))) {
    const x = at.x + nx;
    return { x, y: sy === 0 ? at.y : around.y + sy * Math.abs(x - around.x) };
  }
  if (ny !== undefined) {
    const y = at.y + ny;
    return { x: sx === 0 ? at.x : around.x + sx * Math.abs(y - around.y), y };
  }
  return at;
}

/** Within half a turn either way, to the degree, with a minus sign. */
function signed(degrees: number): string {
  const within = Math.round(((((degrees + 180) % 360) + 360) % 360) - 180);
  return within < 0 ? `\u2212${-within}` : String(within);
}

/**
 * With its side `side` moved out by `by`, the opposite one staying, and no narrower or shorter
 * than `least`. Its text keeps its size, a note's height fitting it, and a sticky note's or a
 * shape's staying tall enough for it.
 */
function extended(kind: Holder, side: number, by: number, least: number): Holder {
  const { frame, rotation } = kind;
  if (side % 2 === 1) {
    const width = Math.max(frame.width + by, least);
    // Around the left side as the right one moves, and the other way round.
    return fitted({ ...kind, frame: anchored(frame, rotation, { width, height: frame.height }, [side === 1 ? 0 : 1, 0]) });
  }
  const height = Math.max(frame.height + by, least, needed(kind));
  return { ...kind, frame: anchored(frame, rotation, { width: frame.width, height }, [0, side === 2 ? 0 : 1]) };
}

/** Between two corners of its frame, from one end to the other, or pinned at `from`, with text of `size`. */
function shaped(shape: Draw, from: Point, to: Point, size: number): Kind {
  const text = { content: "", font_size: size };
  const frame = rect(from, to);
  switch (shape) {
    case "arrow":
    case "line":
      return { type: shape, from, to };
    case "note":
    case "sticky":
      return { type: shape, frame, rotation: 0, text };
    case "comment":
      return { type: "comment", at: from, text: "" };
    default:
      return { type: "shape", frame, rotation: 0, shape, text };
  }
}

/**
 * As a click at `at` places it: centred there, but a note, whose first line starts there, and a
 * comment, pinned there.
 */
function placed(shape: Draw, at: Point, zoom: number): Kind {
  const size = FONT_SIZE / zoom;
  if (shape === "comment") {
    return shaped(shape, at, at, size);
  }
  if (shape === "note") {
    const top = { x: at.x, y: at.y - (size * LINE_HEIGHT) / 2 };
    return shaped(shape, top, { x: top.x + NOTE_WIDTH / zoom, y: top.y + size * LINE_HEIGHT }, size);
  }
  const half = (shape === "sticky" ? STICKY_SIZE : PLACED_SIZE) / zoom / 2;
  return shaped(shape, { x: at.x - half, y: at.y - half }, { x: at.x + half, y: at.y + half }, size);
}

function writesIn(kind: Kind | undefined): kind is Holder | Comment {
  return holdsText(kind) || kind?.type === "comment";
}

function contentOf(kind: Holder | Comment): string {
  return kind.type === "comment" ? kind.text : kind.text.content;
}

/** With `content` written in it, and its frame grown to fit. */
function rewritten(kind: Holder | Comment, content: string): Kind {
  return kind.type === "comment" ? { ...kind, text: content } : fitted({ ...kind, text: { ...kind.text, content } });
}

function isSegment(kind: Kind | undefined): kind is Segment {
  return SEGMENTS.has(kind?.type ?? "");
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function offSegment(point: Point, from: Point, to: Point): number {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const length = dx * dx + dy * dy;
  const along = length === 0 ? 0 : Math.min(Math.max(((point.x - from.x) * dx + (point.y - from.y) * dy) / length, 0), 1);
  return distance(point, { x: from.x + along * dx, y: from.y + along * dy });
}

function whole(natural: Size): Rect {
  return { x: 0, y: 0, ...natural };
}

/** On whole pixels, within the image, and a pixel wide and tall at least. */
function dragged({ grip, start, from }: Extract<Press, { kind: "crop" }>, pixel: Point, natural: Size): Rect {
  const [dx, dy] = [pixel.x - start.x, pixel.y - start.y];
  if (grip === undefined) {
    const x = Math.min(Math.max(Math.round(from.x + dx), 0), natural.width - from.width);
    const y = Math.min(Math.max(Math.round(from.y + dy), 0), natural.height - from.height);
    return { ...from, x, y };
  }
  const [left, right] = stretched(from.x, from.width, grip[0], dx, natural.width);
  const [top, bottom] = stretched(from.y, from.height, grip[1], dy, natural.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The ends of a span, one of them moved by `by` when `side` is 0 or 1, within `0..size`. */
function stretched(start: number, length: number, side: number, by: number, size: number): [number, number] {
  const end = start + length;
  if (side === 0) {
    return [Math.min(Math.max(Math.round(start + by), 0), end - 1), end];
  }
  if (side === 1) {
    return [start, Math.max(Math.min(Math.round(end + by), size), start + 1)];
  }
  return [start, end];
}

function rect(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}
