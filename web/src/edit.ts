// Edits: draw, write, select, move, scale, and rotate by pointer, and flip, turn, restack, group,
// delete, undo, and redo for the commands to run. A click selects the element under it, or the
// outermost group holding it, and a drag from where nothing is draws a rectangle that selects what
// it touches, and the comments pinned in it. Double-clicking a group goes into it, where clicks
// select its own elements instead, and double-clicking a note, a sticky note, a shape, or a
// comment writes in it. Double-clicking an image, a stroke, an arrow, or a line zooms to it, and
// double-clicking it again, or on nothing, goes back to the view it left, unless the view has
// changed meanwhile. Clicks and rectangles go through what is locked, which shows dashed while
// hovered and nothing selectable lies there, and a right-click on it offers to unlock it. While the
// annotations are hidden, clicks, rectangles, and selections go through them too, until an edit
// adds one on its own, an undo or a redo would otherwise select nothing, or a selection asks for
// one, which shows them again. A drag begun with ⌥, or Alt elsewhere than macOS, held moves a copy
// of the selection instead, which it selects. The dots on the selection's corners scale it around
// the opposite one, or around its centre while ⌥ is held. The sides of a lone note, sticky note, or
// shape stretch it, its text keeping its size, and a drag from just outside a corner turns the
// selection around its centre, by steps of 15° while ⇧ is held, and onto an upright or a quarter
// turn near it while snapping. Hovering shows what a press would take, and the ends of a lone
// arrow or line move on their own. The ends of an arrow or a line, as drawn or moved, stick to the
// image, note, sticky note, or shape they land on, onto its outline when near it, and follow it
// from then on. While ⇧ is held, the end being drawn or moved keeps to a multiple of 45° around
// the other one, the grid pulling it along its way, and it sticks only to what it lies on. A note,
// a sticky note, a shape, a stroke, or a comment drawn, placed, moved, scaled, or turned whole onto
// an image, a note, a sticky note, or a shape filled or holding text sticks to it and follows it
// too. While snapping, what moves, scales, or is drawn lands on the grid's lines where near them
// otherwise. While snapping to neighbours, what moves, the sides that scaling or stretching an
// upright box moves, and the corners of a shape, a note, or a sticky note drawn or placed, line up,
// where near, with a side or a middle of what the window shows beside them, or a gap away from one
// as others already stand apart, and what moves halfway between two of those too, which wins over
// the grid, and shows what it lined up with until let go. Holding ⌘, or Ctrl elsewhere than macOS,
// keeps things from sticking, and the grid and what is beside them from pulling, but for a move
// only once under way, as pressing an element with it toggles the element instead. The eraser
// removes what a click would select, or all that a drag passes over but what it starts within, in
// one edit. The pen and the highlighter draw where the pointer goes, smoothed, or a dot for a
// click, or a straight line from where it was pressed while ⇧ is held, as one edit once let go, and
// stay the tool. The arrow keys move the selection by a pixel, or ten while ⇧ is held, or by the
// grid's step while snapping to the grid shown, as one edit until let go.
// Cropping shows an image whole, what its crop leaves out dimmed, and its edges and corners drag
// the crop, or its inside moves it, until Enter or a press elsewhere crops it, or Escape leaves it
// as it was. Holding ⇧ keeps the crop's proportions as its edges and corners drag it, X turns it
// between portrait and landscape, and O shows each composition's guides over it in turn.
// Resetting the crop meanwhile starts it over from the whole image, and its shape changes as
// asked.

import { fit, onScreen, sameCamera, type Camera } from "./camera.js";
import { composing, mac, opensMenu, typed, typing } from "./commands.js";
import * as core from "./core.js";
import type {
  Alignment,
  Axis,
  Background,
  Board,
  Copied,
  CropShape,
  Editor,
  Item,
  Kind,
  Order,
  Point,
  Rect,
  Restack,
  Scale,
  Side,
  Size,
  Tip,
} from "./core.js";
import { among, anchors, isAnnotation, newId, nudge, renamed } from "./board.js";
import { cursor, dotted, type Crop, type Grab, type Overlay } from "./overlay.js";
import { pinned } from "./pins.js";
import { toolOf } from "./style.js";
import { onTitle, titledGroup } from "./titles.js";
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
/**
 * A shape placed by a click, in CSS pixels. A whole number of the grid's cells at a zoom of 1, so
 * that both its sides land on lines.
 */
export const PLACED_SIZE = 120;
/** A sticky note placed by a click, in CSS pixels. */
export const STICKY_SIZE = 200;
/** How wide a note placed by a click wraps, in CSS pixels. */
export const NOTE_WIDTH = 240;
/** Of the text drawn or placed, in CSS pixels. */
export const FONT_SIZE = 20;
/** How far apart the pointer's positions are for the pen to take them, in CSS pixels. */
const PEN_SPACING = 1;
/** How far each point of the pen's line goes toward the pointer, the rest smoothing it. */
const PEN_FOLLOW = 0.5;
/**
 * How far a point of the pen's line may stray from the line through the others and be dropped, in
 * CSS pixels, past the whole pixels a mouse moves by, which the curve through those kept would wave
 * along.
 */
const PEN_TOLERANCE = 0.6;

export interface Editing {
  editor: Editor;
  board: Board;
}

/** What a press draws, while a tool to draw is in use. */
export type Draw =
  | Tip
  | "arrow"
  | "line"
  | "rectangle"
  | "ellipse"
  | "cross"
  | "triangle"
  | "diamond"
  | "star"
  | "polygon"
  | "note"
  | "sticky"
  | "comment";

export interface Hooks {
  /**
   * The elements every edit, undo, and redo touches, once `current` would have them up to date,
   * as it must. The background may have changed too.
   */
  changed(touched: string[]): void;
  selectionChanged(): void;
  /** Once a press or an adjustment ends, whose gesture held undo and redo back. */
  settled(): void;
  snapping(): boolean;
  /** Whether what moves, scales, stretches, or is drawn lines up with what is beside it. */
  aligning(): boolean;
  /** Whether the annotations show, which presses and selections otherwise go through. */
  showsAnnotations(): boolean;
  /** Shows the annotations hidden, once an edit or a selection needs them. */
  reveal(): void;
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
  /** What the pen draws while pressed, `undefined` once let go. */
  inked(stroke: Pen | undefined): void;
  /** Whether a press selects, with no tool that draws, erases, pans, or picks a colour. */
  selecting(): boolean;
  /** Once what of the selection the pointer is on, or a press holds, changed. */
  hovered(): void;
  /** Once the topmost element the pointer is on changed, which a press keeps, `undefined` when none is or a finger touches. */
  pointed(id: string | undefined): void;
  /**
   * Once a press that moved ends, how many milliseconds each of its steps took to handle, and how
   * many moves of the pointer those steps caught up with.
   */
  stepped(steps: number[], moves: number): void;
  /** Once a double-click lands on the title of group `id`, to write it. */
  retitle(id: string): void;
}

export type Pen = Extract<Item, { kind: "stroke" }>;

/** A size, a share of an image's own size, or an angle, as a gesture shows it. */
export interface Reading {
  text: string;
  /** Whether it snapped onto a step or a quarter turn. */
  snapped: boolean;
}

type Keys = Pick<MouseEvent, "shiftKey" | "altKey" | "metaKey" | "ctrlKey">;

/** What a press draws by its two ends. */
type Shaped = Exclude<Draw, Tip>;

type Segment = Extract<Kind, { type: "arrow" | "line" }>;
const SEGMENTS = new Set<string>(["arrow", "line"] satisfies Segment["type"][]);
/** Keyed by each tip, so that one left out fails to compile. */
const TIPS = { pen: true, highlighter: true } satisfies Record<Tip, true>;
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
const CROP_KEYS = { turn: "x", guides: "o" } as const;
const NUDGES: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};
const GOLDEN = (Math.sqrt(5) - 1) / 2;
/** Over a crop in turn, as segments between parts of its width and height. */
const GUIDES: [[number, number], [number, number]][][] = [
  [],
  lines([1 / 3, 2 / 3]),
  lines([1 - GOLDEN, GOLDEN]),
  [
    [
      [0, 0],
      [1, 1],
    ],
    [
      [1, 0],
      [0, 1],
    ],
  ],
];
/** Around the ellipse that fills a crop, in parts of its width and height, close enough to draw it. */
const CURVE: [number, number][] = Array.from({ length: 128 }, (_, at) => {
  const angle = (at / 128) * 2 * Math.PI;
  return [0.5 + Math.cos(angle) / 2, 0.5 + Math.sin(angle) / 2];
});

export interface Edits {
  /** Carries a press on to where the pointer last moved, before the frame that shows it. */
  catchUp(): void;
  /** Whether a gesture, some writing, or a crop is under way, which edits from elsewhere would break. */
  busy(): boolean;
  /** Once none is under way. */
  idle(): Promise<void>;
  /**
   * Runs `work`, which pushes what it touches, as one edit that undoes in one step. Throws when a
   * gesture or some writing is under way, or when `work` throws, after which none of it stays.
   */
  apply(work: (editor: Editor, touched: string[]) => void): string[];
  /**
   * As `apply`, but held open until `finishAdjusting`, each one going on from the last, so that a
   * value slid to shows on the board as it goes and undoes in one step.
   */
  adjust(work: (editor: Editor, touched: string[]) => void): string[];
  finishAdjusting(): void;
  /** Whether `adjust` holds its edit open, until it is finished, its work throws, or the board goes. */
  adjusting(): boolean;
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
  /**
   * Selects the elements, or the groups holding them at the level of the selection, showing the
   * annotations hidden first when any of them is one.
   */
  select(ids: string[]): void;
  /** Selects `id` itself, going into its group. */
  choose(id: string): void;
  /** Everything in the group gone into, or on the board. */
  selectAll(): void;
  /** What the group gone into, or the board, holds but the selection. */
  invertSelection(): void;
  /** Everything in the group gone into, or on the board, like an element selected, a shape by its outline and a stroke by its tip. */
  selectSameType(): void;
  /** Selects the group gone into, which leaves it. Whether there was one. */
  up(): boolean;
  /** Into the one group selected, selecting its elements. */
  goInside(): void;
  loneSegment(): boolean;
  /**
   * Selects what a right-click at `at` is about, the element topmost there, or `on`, unless it is
   * selected already or locked, or nothing unless `at` is within the selection. Whether anything is.
   */
  aim(at: Point, on?: string): boolean;
  /**
   * The locked element, or its outermost locked group, that the pointer rests on with nothing
   * over it, the first to unlock.
   */
  lockedUnder(): string | undefined;
  /** As `lockedUnder`, where a right-click at `at` lands, or on the comment `on`. */
  lockedAt(at: Point, on?: string): string | undefined;
  /** The selection, which it lets go of. */
  lock(): void;
  /** Selects what it unlocks. */
  unlock(ids: string[]): void;
  /** The selection's centre, `undefined` when nothing is selected. */
  centre(): Point | undefined;
  /** Clockwise from its top-left, the box around the selection, `undefined` when it draws nothing. */
  box(): Point[] | undefined;
  remove(): void;
  flip(horizontally: boolean): void;
  /** Clockwise around the selection's centre, as turning it from a corner does. */
  rotate(degrees: number): void;
  straighten(): void;
  /** The images among the selection. */
  actualSize(): void;
  greyscale(on: boolean): void;
  /** The one image selected. */
  crop(): void;
  cropping(): string | undefined;
  /** The shape of the crop under way. */
  croppedAs(): CropShape | undefined;
  /** Of the images among the selection, or of the one being cropped, which it starts over. */
  resetCrop(): void;
  /** Of the images among the selection, or of the crop under way. */
  cropShape(shape: CropShape): void;
  /** The images among the selection, which stays as it is. */
  arrange(order: Order): void;
  /** The images among the selection. */
  normalize(side: Side): void;
  align(to: Alignment): void;
  distribute(axis: Axis): void;
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
   * they were when the drag began, and `neighbours` what they line up with, as the core gives
   * them. `copy` what it moves instead of the selection, when the drag began with ⌥ held, `pasted`
   * its outermost elements, the same at every step.
   */
  | {
      kind: "move";
      pointer: number;
      start: Point;
      dragging: boolean;
      clicked?: string | undefined;
      through?: true;
      bounds?: Rect | undefined;
      neighbours?: Float64Array;
      copy?: {
        copied: Copied;
        ids: Record<string, string>;
        group: string | undefined;
        pasted?: string[];
      };
    }
  | { kind: "marquee"; pointer: number; start: Point; dragging: boolean; kept: Set<string> }
  /**
   * By the dot on the corner `at` of the box `corners` it started from, pressed at `handle` so
   * that it starts at 1, `centred` while held around its centre. `neighbours` what it lines up
   * with, as the core gives them.
   */
  | {
      kind: "scale";
      pointer: number;
      corners: Point[];
      at: number;
      handle: Point;
      upright: boolean;
      centred: boolean;
      neighbours?: Float64Array;
    }
  /**
   * By the side `at` of the lone `id`, which was `from`, pressed at `start`. `neighbours` what it
   * lines up with, as the core gives them.
   */
  | {
      kind: "stretch";
      pointer: number;
      corners: Point[];
      at: number;
      start: Point;
      id: string;
      from: Holder;
      neighbours?: Float64Array;
    }
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
      angle?: number | undefined;
      turned: number;
      snapped: boolean;
    }
  /**
   * `ends` where it was last drawn from and to, once dragging, `neighbours` what it lines up with,
   * as the core gives them.
   */
  | {
      kind: "draw";
      pointer: number;
      start: Point;
      ends?: [Point, Point];
      shape: Shaped;
      id: string;
      dragging: boolean;
      neighbours?: Float64Array;
    }
  /** `line` the pointer's way so far, smoothed, `at` where it went last. */
  | {
      kind: "pen";
      pointer: number;
      start: Point;
      line: Point[];
      at: Point;
      dragging: boolean;
      tip: Tip;
      shown?: string;
    }
  | {
      kind: "end";
      pointer: number;
      start: Point;
      dragging: boolean;
      id: string;
      segment: Segment;
      end: "from" | "to";
    }
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
      clicked?: string | undefined;
      within: string[];
      selection: Set<string>;
      entered?: string | undefined;
    }
  /** A crop's `grip`, or the crop itself without one, from `start`, a pixel, and the crop it had. */
  | {
      kind: "crop";
      pointer: number;
      grip?: [number, number] | undefined;
      start: Point;
      from: Rect;
    };

export function edits(
  view: View,
  overlay: Overlay,
  current: () => Editing | undefined,
  {
    changed,
    selectionChanged,
    settled,
    snapping,
    aligning,
    showsAnnotations,
    reveal,
    drawing,
    erasing,
    sampling,
    drawn,
    styled,
    selecting,
    hovered,
    pointed,
    stepped,
    inked,
    retitle,
  }: Hooks,
): Edits {
  let selected = new Set<string>();
  let entered: string | undefined;
  let press: Press | undefined;
  /** How long each of the press's steps took to handle, in milliseconds. */
  let handled: number[] = [];
  /** The pointer's last move during the press, which waits for the next frame. */
  let moved: PointerEvent | undefined;
  let movesBehind = 0;
  /** How many moves of the pointer the press's steps caught up with. */
  let moves = 0;
  /** What of the selection the pointer is on while nothing is pressed. */
  let over: Grab | undefined;
  /** What a click would select, but for what is selected already. */
  let previewed: string | undefined;
  /** The topmost element the pointer is on, as last told. */
  let under: string | undefined;
  /** The first to unlock of what the pointer rests on, while it selects. */
  let lockedUnder: string | undefined;
  /** The pointer's last event over the board, which hovering looks at again as the keys or the camera change. */
  let seen: PointerEvent | undefined;
  let keys: Keys | undefined;
  /** Where a press last was on the board, which it goes on from as the keys change. */
  let last: Point | undefined;
  /** Whether hovering waits for the next frame. */
  let hovering = false;
  /** Whether the grid pulls, as the last pointer event had its keys. */
  let pulling = false;
  /**
   * Whether what is beside what moves, scales, stretches, or is drawn pulls it, as the last
   * pointer event had its keys.
   */
  let lining = false;
  /** Whether ends stick, as the last pointer event had its keys. */
  let sticking = false;
  const heed = (held: Keys) => {
    pulling = snapping() && !freed(held);
    lining = aligning() && !freed(held);
    sticking = !freed(held);
  };
  /** Its gesture stays open until the field closes, so that writing undoes in one step. */
  let written: { id: string; fresh: boolean } | undefined;
  /** Whether the last press was a click, as browsers still send a double-click when it dragged. */
  let wasClick = false;
  /** The comment whose pin the last press was on, which the pointer's capture hides from later events. */
  let pressedPin: string | undefined;
  /** As `pressedPin`, the group whose title the last press was on. */
  let pressedTitle: string | undefined;
  /** The element a double-click zoomed to, the view it left, and the one it showed. */
  let focused: { id: string; from: Camera; to: Camera } | undefined;
  /**
   * The image being cropped, in pixels the part of it that will show. Its gesture stays open, the
   * image shown whole, until the crop is done, so that meanwhile the board reads as unsaved and
   * agents read the image whole.
   */
  let cropping: { id: string; area: Rect; shape: CropShape } | undefined;
  /** Kept from one crop to the next. */
  let guides = 0;
  let adjusting = false;
  let waiting: (() => void)[] = [];
  const underway = () =>
    press !== undefined || written !== undefined || cropping !== undefined || adjusting;
  const resolve = () => {
    if (!underway()) {
      const ready = waiting;
      waiting = [];
      ready.forEach((wake) => wake());
    }
  };
  const settle = () => {
    press = undefined;
    handled = [];
    moved = undefined;
    movesBehind = 0;
    moves = 0;
    resolve();
  };
  const field = writer(view.host);
  const landed = (editor: Editor, point: Point, zoom: number, sticks = true, around?: Point) =>
    core.landEnd(editor, point, {
      around,
      reach: sticks && sticking ? STICK / zoom : undefined,
      pull: pulling ? zoom : undefined,
    });
  const showTargets = (editor: Editor, ids: (string | undefined)[]) =>
    overlay.targets(ids.flatMap((id) => (id === undefined ? [] : [editor.outline(id)])));
  /** With what it moves setting down where it lands, or coming free when freed. */
  const setDown = (editor: Editor, ids: string[], how: Omit<core.Transform, "sticking"> = {}) =>
    core.transform(editor, ids, { ...how, sticking: sticking ? "land" : "free" });
  /**
   * What the box `scale` has scales by instead to line up with what `beside` gives, showing what
   * it lines up with, `undefined` when nothing beside it pulls.
   */
  const scaledOnto = (
    scale: Scale,
    beside: () => Float64Array,
    zoom: number,
  ): number | undefined => {
    const camera = view.camera();
    const scaled =
      lining && camera
        ? core.snapScaleToNeighbours(scale, beside(), onScreen(camera, view.size()), zoom)
        : undefined;
    overlay.lineup(scaled?.bridges ?? [], scaled?.gaps ?? []);
    return scaled?.factor;
  };
  /** As moving it among what `editor` holds would pull it. */
  const aligned = (editor: Editor, kind: Kind, zoom: number): Kind => {
    const camera = view.camera();
    if (!(pulling || lining) || !camera || !("frame" in kind)) {
      return kind;
    }
    const { frame } = kind;
    const beside = lining ? editor.neighbours([], entered, showsAnnotations()) : new Float64Array();
    const shown = onScreen(camera, view.size());
    const { x = 0, y = 0 } = core.snapToNeighbours(frame, beside, shown, zoom, pulling);
    return { ...kind, frame: { ...frame, x: frame.x + x, y: frame.y + y } };
  };
  /**
   * Where a box drawn `from` one corner `to` the other lands, pulled by the grid and by what
   * `beside` gives, showing what it lines up with.
   */
  const drawnOnto = (
    from: Point,
    to: Point,
    beside: () => Float64Array,
    zoom: number,
  ): [Point, Point] => {
    const camera = view.camera();
    const landing =
      (pulling || lining) && camera
        ? core.snapDrawnToNeighbours(
            from,
            to,
            lining ? beside() : new Float64Array(),
            onScreen(camera, view.size()),
            zoom,
            pulling,
          )
        : undefined;
    overlay.lineup(landing?.bridges ?? [], landing?.gaps ?? []);
    return landing ? [landing.from, landing.to] : [from, to];
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
   * across as its text sets its height, and the zone outside a corner unless `hit`, under the
   * pointer, lies above or beside the selection.
   */
  const grabbing = (
    editing: Editing,
    corners: Point[],
    at: Point,
    zoom: number,
    hit: string | undefined,
  ): Grab | undefined => {
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
      const off = sides.map(
        (side) => offSegment(at, corners[side]!, corners[(side + 1) % 4]!) * zoom,
      );
      const closest = Math.min(...off);
      if (closest <= REACH) {
        return { kind: "side", at: sides[off.indexOf(closest)]! };
      }
    }
    if (far[nearest]! > TURN_REACH || within(at, corners)) {
      return undefined;
    }
    // A side shared or a pixel's overlap counts as beside.
    const taken =
      hit !== undefined &&
      !among(editing.board, hit, selected) &&
      !(
        beneath(editing.board, hit, selected) &&
        core.drawsWithin(editing.editor, hit, inset(corners, 1 / zoom))
      );
    return taken ? undefined : { kind: "turn", at: nearest };
  };
  const gripped = (
    editing: Editing,
    { kind, at: index }: Grab,
    corners: Point[],
    at: Point,
    pointer: number,
  ): Press => {
    if (kind === "corner") {
      return {
        kind: "scale",
        pointer,
        corners,
        at: index,
        handle: at,
        upright: upright(corners),
        centred: false,
      };
    }
    const holder = stretchable(editing);
    if (kind === "side" && holder) {
      return {
        kind: "stretch",
        pointer,
        corners,
        at: index,
        start: at,
        id: holder.id,
        from: holder.kind,
      };
    }
    const [id] = selected;
    const own = selected.size === 1 ? editing.board.elements[id!]?.kind : undefined;
    const pivot = middle(corners);
    const from = Math.atan2(at.y - pivot.y, at.x - pivot.x);
    const angle = own && "frame" in own ? core.rotationOf(own) : undefined;
    return {
      kind: "rotate",
      pointer,
      corners,
      at: index,
      pivot,
      from,
      angle,
      turned: 0,
      snapped: false,
    };
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
    const shown = grab && cursor(grab, corners, view.mirrored());
    view.host.classList.toggle("over-handle", shown !== undefined);
    if (shown) {
      view.host.style.setProperty("--handle-cursor", shown);
    }
  };
  const hoverable = (event: PointerEvent) =>
    hovers(event) && selecting() && !underway() && !view.panning();
  /** What a press would take where the pointer last was, and what a click there would select. */
  const hover = () => {
    hovering = false;
    if (press) {
      return;
    }
    const editing = current();
    const at = seen && view.at(seen);
    const zoom = view.zoom();
    const [was, wasLocked] = [over?.kind, lockedUnder];
    let corners: Point[] | undefined;
    over = undefined;
    previewed = undefined;
    lockedUnder = undefined;
    let topmost: string | undefined;
    let hit: string | undefined;
    let locked: string | undefined;
    if (editing && seen && at && zoom && hovers(seen)) {
      const { editor } = editing;
      topmost =
        titledGroup(seen.target) ?? editor.hit(at.x, at.y, TOLERANCE / zoom, showsAnnotations());
      locked = topmost === undefined ? undefined : editor.lockedBy(topmost);
      hit = inside(
        editor,
        locked === undefined
          ? topmost
          : editor.hitUnlocked(at.x, at.y, TOLERANCE / zoom, showsAnnotations()),
      );
    }
    if (editing && seen && at && zoom && hoverable(seen)) {
      const { editor } = editing;
      corners = selected.size > 0 && !lone(editing) ? box(editor, [...selected]) : undefined;
      // A title takes the press over a grip it covers.
      over =
        corners && !onTitle(seen.target) ? grabbing(editing, corners, at, zoom, hit) : undefined;
      const top =
        hit === undefined || over ? undefined : (level(editor, hit) ?? editor.topLevel(hit));
      previewed = top !== undefined && !selected.has(top) ? top : undefined;
      lockedUnder = locked;
    }
    const shownLocked = over || hit !== undefined ? undefined : lockedUnder;
    const shown = previewed ?? shownLocked;
    overlay.preview(
      editing && shown !== undefined ? editing.editor.outline(shown) : undefined,
      shownLocked !== undefined,
    );
    showGrab(corners);
    if (over?.kind !== was || lockedUnder !== wasLocked) {
      hovered();
    }
    if (topmost !== under) {
      under = topmost;
      pointed(topmost);
    }
  };
  /** On the next frame, once however many events come before it. */
  const rehover = () => {
    if (!hovering) {
      hovering = true;
      requestAnimationFrame(hover);
    }
  };
  const cropShown = (editing: Editing): Crop | undefined => {
    const kind = cropping && editing.board.elements[cropping.id]?.kind;
    if (!cropping || kind?.type !== "image") {
      return undefined;
    }
    const { id, area, shape } = cropping;
    return {
      image: lying(editing, id, whole(kind.natural_size), CORNERS),
      kept: lying(editing, id, area, shape === "ellipse" ? CURVE : CORNERS),
      grips: lying(editing, id, area, GRIPS),
      guides: GUIDES[guides]!.flatMap((ends) => {
        const [from, to] = lying(editing, id, area, ends);
        return from && to ? [[from, to] satisfies [Point, Point]] : [];
      }),
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
    overlay.start(
      sized?.corners,
      sized?.kind === "scale" && sized.centred ? middle(sized.corners) : undefined,
    );
    showGrab(corners);
    rehover();
    selectionChanged();
  };
  /** The element, or its group, at the level of the selection, `undefined` outside the group gone into. */
  const level = (editor: Editor, id: string) =>
    entered === undefined ? editor.topLevel(id) : editor.memberOf(entered, id);
  /** `hit`, but nothing for the panel of the group gone into, or of one holding it, which stands behind. */
  const inside = (editor: Editor, hit: string | undefined) =>
    hit !== undefined &&
    entered !== undefined &&
    (hit === entered || editor.memberOf(hit, entered) !== undefined)
      ? undefined
      : hit;
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
    if (
      entered !== undefined &&
      !stays &&
      (hit === undefined || level(editor, hit) === undefined)
    ) {
      leave(editor);
    }
    return hit === undefined ? undefined : level(editor, hit);
  };
  const selectable = ({ editor, board }: Editing, id: string) =>
    editor.lockedBy(id) === undefined &&
    (showsAnnotations() || !isAnnotation(board.elements[id]!.kind));
  const atLevel = (editing: Editing) =>
    editing.board.draw_order.filter(
      (id) => editing.board.elements[id]!.group === entered && selectable(editing, id),
    );
  const select = (editing: Editing, ids: string[]) => {
    const { editor, board } = editing;
    const present = ids.filter((id) => id in board.elements);
    if (present.some((id) => level(editor, id) === undefined)) {
      leave(editor);
    }
    selected = new Set(
      present.flatMap((id) => level(editor, id) ?? []).filter((id) => selectable(editing, id)),
    );
  };
  /**
   * Whether the selection holds what a click would select of each of `ids` there, or but for those
   * brought `back`, what each sticks to, which carried it along.
   */
  const holdsAll = ({ editor, board }: Editing, ids: string[], back: Set<string>) => {
    const held = (id: string, visited: Set<string>): boolean => {
      if (visited.has(id)) {
        return false;
      }
      visited.add(id);
      const at = level(editor, id);
      const kind = board.elements[id]?.kind;
      return (
        (at !== undefined && selected.has(at)) ||
        (!back.has(id) &&
          kind !== undefined &&
          anchors(kind).some((anchor) => held(anchor, visited)))
      );
    };
    return ids.filter((id) => id in board.elements).every((id) => held(id, new Set()));
  };
  /** As a click would select it, but outside the group gone into without leaving it. */
  const erasable = (editor: Editor, id: string) => level(editor, id) ?? editor.topLevel(id);
  const erase = (
    editing: Editing,
    stroke: Extract<Press, { kind: "erase" }>,
    at: Point,
    pins: string[],
    zoom: number,
  ) => {
    const { editor, board } = editing;
    const { last: from, within: starts } = stroke;
    const hits = [
      ...editor.hitAlong(from.x, from.y, at.x, at.y, TOLERANCE / zoom, showsAnnotations()),
      ...pins,
    ];
    const holds = (id: string) => starts.some((kept) => among(board, kept, new Set([id])));
    const erased = new Set(
      hits.flatMap((id) => erasable(editor, id) ?? []).filter((id) => !holds(id)),
    );
    if (erased.size > 0) {
      edit(editing, editor.remove([...erased]));
    }
    stroke.last = at;
  };
  /** The comments whose pins lie on the way on screen, which the pointer's capture hides from its events. */
  const pinsAlong = (from: Point, to: { clientX: number; clientY: number }) => {
    const start = view.client(from);
    if (!start) {
      return [];
    }
    const [dx, dy] = [to.clientX - start.clientX, to.clientY - start.clientY];
    // No more than a way across the window takes, however far the view moved meanwhile.
    const steps = Math.min(
      Math.ceil(Math.hypot(dx, dy) / TOLERANCE),
      Math.ceil((innerWidth + innerHeight) / TOLERANCE),
    );
    const pins = new Set<string>();
    for (let step = 0; step <= steps; step++) {
      const along = steps === 0 ? 0 : step / steps;
      const pin = pinned(
        document.elementFromPoint(start.clientX + dx * along, start.clientY + dy * along),
      );
      if (pin !== undefined) {
        pins.add(pin);
      }
    }
    return [...pins];
  };
  /**
   * Undoing and redoing select what they touch, but keep the selection when it holds all of it
   * already, or when none of it is left.
   */
  const edit = (editing: Editing, touched: string[], reselect = false) => {
    const { board, editor } = editing;
    const back = new Set(touched.filter((id) => !(id in board.elements)));
    const imaged = (id: string) => board.elements[id]?.kind.type === "image";
    // Read before the edit too, which may remove them.
    const images = touched.some(imaged);
    const unselectable = (id: string) => !(id in board.elements) || !selectable(editing, id);
    // Read before the edit, which may remove the group gone into, and its emptied groups too.
    const around: string[] = [];
    for (
      let at = entered;
      at !== undefined && !around.includes(at);
      at = board.elements[at]?.group
    ) {
      around.push(at);
    }
    changed(touched);
    // What it adds would go unseen, but for what comes along with its group.
    const alone = (id: string) => {
      const group = board.elements[id]?.group;
      return back.has(id) && (group === undefined || !back.has(group));
    };
    if (!showsAnnotations() && touched.some((id) => alone(id) && annotation(editing, id))) {
      reveal();
    }
    if (entered !== undefined && unselectable(entered)) {
      leave(
        editor,
        around.find((id) => !unselectable(id)),
      );
    }
    if (reselect && !holdsAll(editing, touched, back)) {
      select(editing, touched);
      // An undo or a redo that touched hidden annotations and no image would select nothing.
      if (
        selected.size === 0 &&
        !showsAnnotations() &&
        !images &&
        !touched.some(imaged) &&
        touched.some((id) => annotation(editing, id) && editor.lockedBy(id) === undefined)
      ) {
        reveal();
        select(editing, touched);
      }
    }
    for (const id of selected) {
      if (unselectable(id)) {
        selected.delete(id);
      }
    }
    show();
  };

  view.host.addEventListener("pointerdown", (event) => {
    wasClick = false;
    pressedTitle = titledGroup(event.target);
    pressedPin = pinned(event.target) ?? pressedTitle;
    seen = event;
    keys = event;
    const editing = current();
    const at = view.at(event);
    const zoom = view.zoom();
    if (
      press ||
      adjusting ||
      !editing ||
      !at ||
      !zoom ||
      event.button !== 0 ||
      view.pans(event) ||
      opensMenu(event) ||
      sampling()
    ) {
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
    heed(event);
    if (erasing()) {
      // As the eraser's way goes, which a group's panel leaves whole.
      const hit =
        pressedPin ??
        editor.hitAlong(at.x, at.y, at.x, at.y, TOLERANCE / zoom, showsAnnotations()).at(-1);
      press = {
        kind: "erase",
        pointer,
        start: at,
        last: at,
        dragging: false,
        clicked: hit === undefined ? undefined : erasable(editor, hit),
        within: editor.covering(at.x, at.y, showsAnnotations()),
        selection: new Set(selected),
        entered,
      };
      editor.beginGesture();
      view.host.setPointerCapture(pointer);
      return;
    }
    const shape = drawing();
    if (isTip(shape)) {
      press = { kind: "pen", pointer, start: at, line: [at], at, dragging: false, tip: shape };
      selected = new Set();
      show();
      inked(drawnStroke(stroked([at], shape, zoom)));
      view.host.setPointerCapture(pointer);
      return;
    }
    if (shape) {
      press = { kind: "draw", pointer, start: at, shape, id: newId(), dragging: false };
      view.host.setPointerCapture(pointer);
      return;
    }
    // Over the selection's handles, a pin takes the press.
    const single = pressedPin === undefined ? lone(editing) : undefined;
    if (single) {
      const ends = (["from", "to"] as const).filter(
        (end) => distance(at, single.segment[end]) * zoom <= REACH,
      );
      // The nearest, as they may overlap on a short segment.
      const end = ends.toSorted(
        (a, b) => distance(at, single.segment[a]) - distance(at, single.segment[b]),
      )[0];
      if (end) {
        press = { kind: "end", pointer, start: at, dragging: false, ...single, end };
        editor.beginGesture();
        view.host.setPointerCapture(pointer);
        return;
      }
    }
    const corners = selected.size > 0 && !single ? box(editor, [...selected]) : undefined;
    const hit =
      pressedPin ??
      inside(editor, editor.hitUnlocked(at.x, at.y, TOLERANCE / zoom, showsAnnotations()));
    const grab =
      corners && pressedPin === undefined ? grabbing(editing, corners, at, zoom, hit) : undefined;
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
      press = {
        kind: "marquee",
        pointer,
        start: at,
        dragging: false,
        kept: toggling ? new Set(selected) : new Set(),
      };
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
    if (event.pointerId !== press.pointer) {
      return;
    }
    if (press.kind === "pen") {
      // Each position since the last move, which the engine may have merged into it.
      const passed = "getCoalescedEvents" in event ? event.getCoalescedEvents() : [];
      for (const each of passed.length > 0 ? passed : [event]) {
        ink(press, each);
      }
    }
    // Once a frame, as some engines send several moves a frame, each as costly to carry.
    moved = event;
    movesBehind += 1;
    view.step();
  });
  const catchUp = () => {
    const event = moved;
    const caught = movesBehind;
    moved = undefined;
    movesBehind = 0;
    const editing = current();
    const at = event && view.at(event);
    const zoom = view.zoom();
    if (!press || !event || !editing || !at || !zoom) {
      return;
    }
    const pressed = press;
    const start = performance.now();
    carry(editing, at, zoom, event);
    // A move short of a drag only tells it from a click.
    if (!("dragging" in pressed) || pressed.dragging) {
      handled.push(performance.now() - start);
      moves += caught;
    }
  };
  /** Carries the press on to the pointer's last move before it ends, which still ends when that fails. */
  const flush = () => {
    try {
      catchUp();
    } catch (error) {
      reportError(error);
    }
  };
  /** Carries any press on to `at`, erasing and cropping too, which `drag` leaves to it. */
  const carry = (editing: Editing, at: Point, zoom: number, event: PointerEvent) => {
    if (!press) {
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
      last = at;
      dragCrop(editing, at, (keys ?? event).shiftKey);
      return;
    }
    last = at;
    // With the keys held now, which may have changed since the move.
    drag(editing, at, zoom, keys ?? event);
  };
  const ink = (pen: Extract<Press, { kind: "pen" }>, event: PointerEvent) => {
    const at = view.at(event);
    const zoom = view.zoom();
    if (!at || !zoom || distance(at, pen.at) * zoom < PEN_SPACING) {
      return;
    }
    const previous = pen.line.at(-1)!;
    pen.line.push({
      x: previous.x + (at.x - previous.x) * PEN_FOLLOW,
      y: previous.y + (at.y - previous.y) * PEN_FOLLOW,
    });
    pen.at = at;
    pen.dragging ||= distance(at, pen.start) * zoom >= DRAG;
  };
  const inkLine = (editor: Editor, pen: Extract<Press, { kind: "pen" }>, straight: boolean) => {
    if (!pen.dragging) {
      return [pen.start];
    }
    return straight
      ? [pen.start, core.landEnd(editor, pen.at, { around: pen.start }).at]
      : [...pen.line, pen.at];
  };
  /** To `at`, as wide for its height as it was when pressed while `keep`. */
  const dragCrop = (editing: Editing, at: Point, keep: boolean) => {
    const kind = cropping && editing.board.elements[cropping.id]?.kind;
    const pixel = cropping && core.pixelAt(editing.editor, cropping.id, at);
    if (press?.kind === "crop" && cropping && pixel && kind?.type === "image") {
      cropping.area = dragged(press, pixel, kind.natural_size, keep);
      show();
    }
  };
  // As the keys change what a press does, or what a press would take, without the pointer moving.
  for (const type of ["keydown", "keyup"] as const) {
    addEventListener(type, (event) => {
      keys = event;
      const editing = current();
      const zoom = view.zoom();
      const modifier = !event.repeat && ["Shift", "Alt", "Meta", "Control"].includes(event.key);
      const held =
        (press?.kind === "move" && press.dragging) ||
        press?.kind === "scale" ||
        press?.kind === "stretch" ||
        press?.kind === "rotate" ||
        press?.kind === "end" ||
        press?.kind === "pen" ||
        (press?.kind === "draw" && (SEGMENTS.has(press.shape) || press.dragging));
      // Unless a move waits for the frame, which takes the keys then.
      if (held && modifier && editing && last && zoom && !moved) {
        drag(editing, last, zoom, event);
      } else if (press?.kind === "crop" && modifier && editing && last && !moved) {
        dragCrop(editing, last, event.shiftKey);
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

  /** Carries the press on to `at`, with the keys `held`. */
  const drag = (editing: Editing, at: Point, zoom: number, held: Keys) => {
    if (!press) {
      return;
    }
    const { editor } = editing;
    const ids = [...selected];
    heed(held);
    // From where the gesture began, so that coming back there changes nothing.
    const again = (edited: () => string[]) =>
      edit(editing, [...editor.rewindGesture(), ...edited()]);
    switch (press.kind) {
      case "marquee": {
        press.dragging ||= distance(at, press.start) * zoom >= DRAG;
        const area = rect(press.start, at);
        const touched = editor.touchingTopLevel(
          area.x,
          area.y,
          area.width,
          area.height,
          showsAnnotations(),
        );
        selected = new Set([...press.kept, ...touched]);
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
          if (held.altKey) {
            const copied = core.copy(editor, ids);
            press.copy = { copied, ids: renamed(copied), group: entered };
          }
          // Before a copy is pasted, as its original stays put.
          press.neighbours = editor.neighbours(press.copy ? [] : ids, entered, showsAnnotations());
          editor.beginGesture();
        }
        const { start, bounds, neighbours, copy } = press;
        const [dx, dy] = [at.x - start.x, at.y - start.y];
        const moving = bounds && { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
        const camera = view.camera();
        const shown = camera && onScreen(camera, view.size());
        const beside = lining && neighbours ? neighbours : new Float64Array();
        const pull =
          (lining || pulling) && moving && shown
            ? core.snapToNeighbours(moving, beside, shown, zoom, pulling)
            : undefined;
        const snapped = pull?.x !== undefined || pull?.y !== undefined;
        const by = { x: dx + (pull?.x ?? 0), y: dy + (pull?.y ?? 0) };
        overlay.lineup(pull?.bridges ?? [], pull?.gaps ?? []);
        again(() => {
          if (copy === undefined) {
            return setDown(editor, ids, { place: { by }, settle: snapped });
          }
          // Anew at each step, which starts from before the copy.
          const touched = core.paste(editor, copy.copied, copy.ids, copy.group);
          copy.pasted ??= core.outermost(editor, copy.ids, copy.group);
          selected = new Set(copy.pasted);
          return [...touched, ...setDown(editor, copy.pasted, { place: { by }, settle: snapped })];
        });
        showTargets(editor, editor.targetsOf([...selected]));
        return;
      }
      case "scale": {
        const { corners, at: index, handle } = press;
        press.centred = held.altKey;
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
        let lined: number | undefined;
        if (press.upright) {
          const scaling = press;
          lined = scaledOnto(
            { area: bounding(corners)!, origin, factor, least: SMALLEST_SCALE },
            () => (scaling.neighbours ??= editor.neighbours(ids, entered, showsAnnotations())),
            zoom,
          );
        }
        const gridded =
          lined === undefined && pulling && press.upright
            ? core.snapScaleToGrid(origin, corner, factor, zoom)
            : undefined;
        const by =
          lined ?? (gridded !== undefined && gridded >= SMALLEST_SCALE ? gridded : undefined);
        const scale = { by: by ?? factor };
        again(() => setDown(editor, ids, { scale, about: origin, settle: by !== undefined }));
        showTargets(editor, editor.targetsOf(ids));
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
        const by = (at.x - start.x) * normal.x + (at.y - start.y) * normal.y;
        const least = Math.max(SMALLEST_SIDE / zoom, from.text.font_size);
        const across = Math.abs(normal.x) > Math.abs(normal.y);
        const along: Axis = across ? "horizontal" : "vertical";
        // The side opposite, which stays put.
        const origin = corners[(side + 2) % 4]!;
        const [outwards, moving, staying] = across
          ? [normal.x, a.x, origin.x]
          : [normal.y, a.y, origin.y];
        const span = moving - staying;
        const stretching = press;
        const beside = () =>
          (stretching.neighbours ??= editor.neighbours(ids, entered, showsAnnotations()));
        const stretchBy = (further: number, snapped: boolean) => {
          const next = extended(from, side, further, least);
          again(() => [
            ...editor.stretch(id, JSON.stringify(next)),
            ...setDown(editor, ids, { settle: snapped }),
          ]);
        };
        const straight = upright(corners);
        if (straight) {
          // As the frame's own side, which its text may need longer still.
          const shortest = side % 2 === 1 ? least : Math.max(least, needed(from));
          const factor = (moving + by * outwards - staying) / span;
          const scale = { area: bounding(corners)!, origin, factor, along };
          const lined = scaledOnto({ ...scale, least: shortest / Math.abs(span) }, beside, zoom);
          if (lined !== undefined) {
            stretchBy((staying + span * lined - moving) * outwards, true);
            // From where it landed, as a note fits its text again, which may change its height.
            // It lands where it was aimed, as nothing pulls it then, unless what it lined up with
            // no longer faces it, which leaves it to go on as nothing beside it pulled.
            const reached = { area: bounding(box(editor, ids))!, origin, factor: 1, along };
            const kept = scaledOnto({ ...reached, least: 0 }, beside, zoom);
            if (kept !== undefined && Math.abs(kept - 1) <= 1e-9) {
              showTargets(editor, editor.targetsOf(ids));
              return;
            }
            overlay.lineup([], []);
          }
        }
        const pull =
          straight && pulling ? core.snapToGrid([moving + by * outwards], zoom) : undefined;
        stretchBy(by + (pull ?? 0) * outwards, pull !== undefined);
        showTargets(editor, editor.targetsOf(ids));
        return;
      }
      case "rotate": {
        const { pivot, from, angle } = press;
        const turned = ((Math.atan2(at.y - pivot.y, at.x - pivot.x) - from) * 180) / Math.PI;
        // A lone element snaps its own angle, and several the angle they turn by.
        [press.turned, press.snapped] = turning(angle ?? 0, turned, held.shiftKey, pulling);
        const by = press.turned;
        again(() => setDown(editor, ids, { rotate: by, about: pivot }));
        showTargets(editor, editor.targetsOf(ids));
        return;
      }
      case "pen": {
        // Only a new point of the line, the drag starting, or ⇧ changes what shows.
        const shown = `${press.line.length} ${press.dragging} ${held.shiftKey}`;
        if (shown !== press.shown) {
          press.shown = shown;
          inked(drawnStroke(stroked(inkLine(editor, press, held.shiftKey), press.tip, zoom)));
        }
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
        if (SEGMENTS.has(shape)) {
          const start = landed(editor, press.start, zoom);
          const end = landed(editor, at, zoom, true, held.shiftKey ? start.at : undefined);
          press.ends = [start.at, end.at];
          const kind = styled(shaped(shape, start.at, end.at, FONT_SIZE / zoom), zoom);
          const stuck = { ...kind, from_target: start.target, to_target: end.target };
          again(() => editor.add(id, entered, JSON.stringify(stuck)));
          showTargets(editor, [start.target, end.target]);
          return;
        }
        // Without what it draws, which a step before added.
        const sketch = press;
        const beside = () =>
          (sketch.neighbours ??= editor.neighbours([id], entered, showsAnnotations()));
        const [start, end] = drawnOnto(press.start, at, beside, zoom);
        press.ends = [start, end];
        // A note shows nothing until written in.
        overlay.marquee(shape === "note" ? rect(start, end) : undefined);
        const kind = styled(shaped(shape, start, end, FONT_SIZE / zoom), zoom);
        again(() => [...editor.add(id, entered, JSON.stringify(kind)), ...setDown(editor, [id])]);
        showTargets(editor, editor.targetsOf([id]));
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
        const landing = landed(
          editor,
          point,
          zoom,
          true,
          held.shiftKey ? segment[end === "from" ? "to" : "from"] : undefined,
        );
        showTargets(editor, [landing.target]);
        again(() =>
          editor.update(
            id,
            JSON.stringify({ ...segment, [end]: landing.at, [`${end}_target`]: landing.target }),
          ),
        );
        return;
      }
    }
  };

  /** `completed` unless the press was lost, as to a blur. */
  const release = (completed: boolean) => {
    if (!press) {
      return;
    }
    flush();
    if (handled.length > 0) {
      stepped(handled, moves);
    }
    wasClick = (press.kind === "move" || press.kind === "marquee") && !press.dragging;
    const held = holding() !== undefined;
    overlay.targets([]);
    overlay.lineup([], []);
    if (press.kind === "marquee") {
      overlay.marquee(undefined);
    } else if (press.kind === "draw") {
      finishDrawing(press, completed);
    } else if (press.kind === "pen") {
      finishInking(press, completed);
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
  const finishDrawing = (sketch: Extract<Press, { kind: "draw" }>, completed: boolean) => {
    const editing = current();
    const zoom = view.zoom();
    overlay.marquee(undefined);
    if (!editing) {
      return;
    }
    const { editor } = editing;
    const { id, shape, start, ends, dragging } = sketch;
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
        touched.push(
          ...editor.add(
            id,
            entered,
            JSON.stringify(aligned(editor, styled(placed(shape, start, zoom), zoom), zoom)),
          ),
        );
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

  /** What the pen draws through `line`, at `zoom` CSS pixels per board unit, as the board keeps it. */
  const stroked = (line: Point[], tip: Tip, zoom: number) =>
    styled(core.strokeKind(line, PEN_TOLERANCE / zoom, tip), zoom);

  /** Adds what the pen drew unless the press was lost, leaving it unselected to draw on. */
  const finishInking = (pen: Extract<Press, { kind: "pen" }>, completed: boolean) => {
    // Before the stroke draws, which would otherwise show twice for a frame.
    inked(undefined);
    const editing = current();
    const zoom = view.zoom();
    if (!editing || !zoom || !completed) {
      return;
    }
    const { editor } = editing;
    const line = inkLine(editor, pen, keys?.shiftKey ?? false);
    const kind = stroked(line, pen.tip, zoom);
    const id = newId();
    editor.beginGesture();
    const touched = [...editor.add(id, entered, JSON.stringify(kind)), ...setDown(editor, [id])];
    editor.endGesture();
    edit(editing, touched);
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
      // From its left as it shows.
      const left = view.mirrored() ? kind.frame.x + kind.frame.width : kind.frame.x;
      const at = view.client({ x: left, y: kind.frame.y });
      if (at) {
        field.follow(kind, at, zoom, { mirrored: view.mirrored(), grey: view.greyed() });
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
        // Some engines let the capture go just before `pointerup`, once no button is held.
        const released =
          type === "pointerup" || (type === "lostpointercapture" && event.buttons === 0);
        if (released && press.kind === "pen") {
          ink(press, event);
        }
        release(released);
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
    if (pressedTitle !== undefined) {
      retitle(pressedTitle);
      return;
    }
    const { editor, board } = editing;
    const hit = pressedPin ?? editor.hitUnlocked(at.x, at.y, TOLERANCE / zoom, showsAnnotations());
    const top = hit === undefined ? undefined : level(editor, hit);
    if (hit !== undefined && top !== undefined && board.elements[top]?.kind.type === "group") {
      const member = editor.memberOf(top, hit);
      entered = top;
      selected = new Set(member === undefined ? [] : [member]);
      show();
      return;
    }
    // Within a shape, whose text fills it once written.
    const target = top ?? surrounding(editing, at);
    if (target !== undefined && writesIn(board.elements[target]?.kind)) {
      write(editing, target, false);
    } else if (top !== undefined) {
      focus(editing, top);
    } else {
      back();
    }
  });

  const focus = (editing: Editing, id: string) => {
    const from = view.camera();
    const area = core.extent(editing.editor, [id]);
    if (!from || !area || (focused?.id === id && back())) {
      return;
    }
    const still = focused && sameCamera(from, focused.to) ? focused : undefined;
    const to = fit(area, view.size());
    focused = { id, from: still?.from ?? from, to };
    view.look(to);
  };
  const back = (): boolean => {
    const now = view.camera();
    if (!focused || !now || !sameCamera(now, focused.to)) {
      return false;
    }
    view.look(focused.from);
    focused = undefined;
    return true;
  };

  const crop = (editing: Editing, id: string) => {
    const kind = editing.board.elements[id]?.kind;
    if (kind?.type !== "image") {
      return;
    }
    const { editor } = editing;
    editor.beginGesture();
    const { crop: kept, crop_shape: shape = "rectangle" } = core.editsOf(kind);
    cropping = { id, area: kept ?? whole(kind.natural_size), shape };
    selected = new Set([id]);
    edit(editing, editor.resetCrop([id]));
  };
  /** Crops the image as shown, or leaves it as it was, as one edit with all of its cropping. */
  const finishCropping = (editing: Editing, keep: boolean) => {
    flush();
    if (!cropping) {
      return;
    }
    const { id, area, shape } = cropping;
    cropping = undefined;
    const { editor } = editing;
    const touched = editor.rewindGesture();
    try {
      if (keep) {
        touched.push(...editor.crop(id, area.x, area.y, area.width, area.height));
        touched.push(...core.setCropShape(editor, [id], shape));
      }
    } finally {
      editor.endGesture();
      edit(editing, touched);
      resolve();
    }
  };
  /** Between portrait and landscape, unless dragged, which would carry on from where it started. */
  const turnCrop = (editing: Editing) => {
    const kind = cropping && editing.board.elements[cropping.id]?.kind;
    if (cropping && press === undefined && kind?.type === "image") {
      cropping.area = swapped(cropping.area, kind.natural_size);
      show();
    }
  };
  // Captured ahead of the commands, which wait while an image is being cropped, on Enter and
  // Escape, and on X and O, whose tools they would otherwise pick then.
  addEventListener(
    "keydown",
    (event) => {
      const editing = current();
      if (!cropping || !editing || event.repeat || event.defaultPrevented) {
        return;
      }
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        finishCropping(editing, event.key === "Enter");
        return;
      }
      const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      const key = typed(event);
      const { turn, guides: guide } = CROP_KEYS;
      if (!plain || (key !== turn && key !== guide) || composing(event) || typing(event.target)) {
        return;
      }
      event.preventDefault();
      if (key === turn) {
        turnCrop(editing);
      } else {
        guides = (guides + 1) % GUIDES.length;
        show();
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
  const surrounding = (editing: Editing, at: Point) =>
    editing.board.draw_order.findLast(
      (id) =>
        editing.board.elements[id]!.kind.type === "shape" &&
        level(editing.editor, id) === id &&
        selectable(editing, id) &&
        within(at, box(editing.editor, [id])),
    );

  /** Unless a gesture, some writing, or a crop is under way, since it would carry on over the edit. */
  const run = (edited: (editing: Editing, ids: string[]) => void) => {
    const editing = current();
    if (editing && !underway()) {
      edited(editing, [...selected]);
    }
  };
  /** Straightened, with what it turns setting down where it lands. */
  const straighten = (editing: Editing, ids: string[]) => {
    const touched: string[] = [];
    editing.editor.beginGesture();
    try {
      touched.push(...editing.editor.straighten(ids), ...editing.editor.land(ids));
    } finally {
      editing.editor.endGesture();
      edit(editing, touched);
    }
  };
  const writable = ({ board }: Editing) =>
    selected.size === 1 && writesIn(board.elements[[...selected][0]!]?.kind);
  /** Whether it could, as what is locked takes no selection. */
  const choose = (editing: Editing, id: string) => {
    const { board } = editing;
    if (!(id in board.elements) || !selectable(editing, id)) {
      return false;
    }
    entered = board.elements[id]!.group;
    selected = new Set([id]);
    return true;
  };

  const adjust = (work: (editor: Editor, touched: string[]) => void): string[] => {
    const editing = current();
    if (editing === undefined || (underway() && !adjusting)) {
      throw new Error("Someone is editing in Planche");
    }
    const { editor } = editing;
    if (!adjusting) {
      editor.beginGesture();
      adjusting = true;
    }
    const touched: string[] = [];
    try {
      work(editor, touched);
    } catch (error) {
      touched.push(...editor.rewindGesture());
      editor.endGesture();
      adjusting = false;
      throw error;
    } finally {
      edit(editing, [...new Set(touched)]);
      resolve();
    }
    return [...new Set(touched)];
  };
  const finishAdjusting = () => {
    if (!adjusting) {
      return;
    }
    adjusting = false;
    current()?.editor.endGesture();
    resolve();
    settled();
  };
  /** The arrow keys held that move the selection, as one edit until the last comes up. */
  const nudging = new Set<string>();
  const stopNudging = () => {
    if (nudging.size > 0) {
      nudging.clear();
      finishAdjusting();
    }
  };
  // After the toolbar, the menus, and the pins, which take arrow keys to move between their own.
  addEventListener("keydown", (event) => {
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    // As macOS sends no keyup for a key held with ⌘ down.
    if (modified) {
      stopNudging();
    }
    const towards = NUDGES[event.key];
    const editing = current();
    const zoom = view.zoom();
    const target = event.target;
    if (
      towards === undefined ||
      modified ||
      event.defaultPrevented ||
      composing(event) ||
      typing(target) ||
      (target instanceof HTMLInputElement && target.type === "range") ||
      !editing ||
      !zoom ||
      selected.size === 0 ||
      (underway() && nudging.size === 0)
    ) {
      return;
    }
    event.preventDefault();
    const grid = editing.board.background !== "plain" && snapping();
    const step = nudge(zoom, event.shiftKey, grid);
    const ids = [...selected];
    nudging.add(event.key);
    try {
      adjust((editor, touched) => {
        // Along the arrow as the board shows.
        const by = { x: (view.mirrored() ? -towards.x : towards.x) * step, y: towards.y * step };
        touched.push(...core.transform(editor, ids, { place: { by }, settle: grid }));
      });
    } catch (error) {
      nudging.clear();
      reportError(error);
    }
  });
  addEventListener("keyup", (event) => {
    if (nudging.delete(event.key) && nudging.size === 0) {
      finishAdjusting();
    }
  });
  addEventListener("blur", stopNudging);
  view.host.addEventListener("pointerdown", stopNudging, true);
  return {
    catchUp,
    busy: underway,
    idle: () => (underway() ? new Promise((wake) => waiting.push(wake)) : Promise.resolve()),
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
    adjust,
    finishAdjusting,
    adjusting: () => adjusting,
    writing: () => written?.id,
    writable() {
      const editing = current();
      return editing !== undefined && writable(editing);
    },
    write: (id) =>
      run((editing) => {
        if (id !== undefined && !choose(editing, id)) {
          return;
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
        if (!showsAnnotations() && ids.some((id) => annotation(editing, id))) {
          reveal();
        }
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
        selected = new Set(atLevel(editing));
        show();
      }
    },
    invertSelection: () =>
      run((editing) => {
        selected = new Set(atLevel(editing).filter((id) => !selected.has(id)));
        show();
      }),
    selectSameType: () =>
      run((editing, ids) => {
        const type = (id: string) => {
          const kind = editing.board.elements[id]?.kind;
          return kind && (toolOf(kind) ?? kind.type);
        };
        const types = new Set(ids.map(type));
        selected = new Set(atLevel(editing).filter((id) => types.has(type(id))));
        show();
      }),
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
      run((editing, ids) => {
        const { board } = editing;
        const group = ids[0];
        if (ids.length !== 1 || board.elements[group!]?.kind.type !== "group") {
          return;
        }
        entered = group;
        selected = new Set(atLevel(editing));
        show();
      }),
    aim(at, on) {
      const editing = current();
      const zoom = view.zoom();
      if (!editing || !zoom || press) {
        return selected.size > 0;
      }
      const { editor } = editing;
      const topmost = on ?? editor.hit(at.x, at.y, TOLERANCE / zoom, showsAnnotations());
      // Unlike a left press, which goes through it, so that the menu offers to unlock it.
      const hit = inside(
        editor,
        topmost === undefined || editor.lockedBy(topmost) !== undefined ? undefined : topmost,
      );
      // As a left press would, with no box around a lone arrow or line.
      const onSelection =
        hit === undefined && !lone(editing) && within(at, box(editor, [...selected]));
      const top = aimed(editor, hit, onSelection);
      if (top !== undefined && !selected.has(top)) {
        selected = new Set([top]);
      } else if (top === undefined && !onSelection) {
        selected = new Set();
      }
      show();
      return selected.size > 0;
    },
    lockedUnder: () => lockedUnder,
    lockedAt(at, on) {
      const editing = current();
      const zoom = view.zoom();
      if (!editing || !zoom) {
        return undefined;
      }
      const { editor } = editing;
      const topmost = on ?? editor.hit(at.x, at.y, TOLERANCE / zoom, showsAnnotations());
      return topmost === undefined ? undefined : editor.lockedBy(topmost);
    },
    lock: () => run((editing, ids) => edit(editing, editing.editor.setLocked(ids, true))),
    unlock: (ids) => run((editing) => edit(editing, editing.editor.setLocked(ids, false), true)),
    centre() {
      const editing = current();
      const area = editing && core.extent(editing.editor, [...selected]);
      return area && { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    },
    box() {
      const editing = current();
      return editing && selected.size > 0 ? box(editing.editor, [...selected]) : undefined;
    },
    remove: () => run((editing, ids) => edit(editing, editing.editor.remove(ids))),
    flip: (horizontally) =>
      run((editing, ids) => edit(editing, editing.editor.flip(ids, horizontally))),
    rotate: (degrees) =>
      run((editing, ids) => {
        const corners = box(editing.editor, ids);
        if (corners) {
          const how = { rotate: degrees, about: middle(corners), sticking: "land" } as const;
          edit(editing, core.transform(editing.editor, ids, how));
        }
      }),
    straighten: () => run(straighten),
    actualSize: () => run((editing, ids) => edit(editing, editing.editor.actualSize(ids))),
    greyscale: (on) => run((editing, ids) => edit(editing, editing.editor.setGreyscale(ids, on))),
    crop: () =>
      run((editing, ids) => {
        if (ids.length === 1) {
          crop(editing, ids[0]!);
        }
      }),
    cropping: () => cropping?.id,
    croppedAs: () => cropping?.shape,
    resetCrop() {
      const kind = cropping && current()?.board.elements[cropping.id]?.kind;
      if (cropping && kind?.type === "image") {
        // Not while dragging the crop, which would carry on from where the drag started.
        if (press === undefined) {
          cropping.area = whole(kind.natural_size);
          cropping.shape = "rectangle";
          show();
        }
        return;
      }
      run((editing, ids) => edit(editing, editing.editor.resetCrop(ids)));
    },
    cropShape(shape) {
      if (cropping) {
        cropping.shape = shape;
        show();
        return;
      }
      run((editing, ids) => edit(editing, core.setCropShape(editing.editor, ids, shape)));
    },
    arrange: (order) =>
      run((editing, ids) => edit(editing, core.arrange(editing.editor, ids, order))),
    normalize: (side) => run((editing, ids) => edit(editing, editing.editor.normalize(ids, side))),
    align: (to) => run((editing, ids) => edit(editing, editing.editor.align(ids, to))),
    distribute: (axis) =>
      run((editing, ids) => edit(editing, editing.editor.distribute(ids, axis))),
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
        const members = Object.keys(board.elements).filter((id) =>
          groups.has(board.elements[id]!.group ?? ""),
        );
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
      inked(undefined);
      selected = new Set();
      entered = undefined;
      // Its board is gone, and its gesture with it.
      written = undefined;
      cropping = undefined;
      adjusting = false;
      nudging.clear();
      field.close();
      settle();
      overlay.outline([]);
      overlay.box(undefined);
      overlay.ends(undefined);
      overlay.marquee(undefined);
      overlay.entered(undefined);
      overlay.targets([]);
      overlay.lineup([], []);
      overlay.crop(undefined);
      over = undefined;
      previewed = undefined;
      overlay.start(undefined);
      overlay.preview(undefined);
      showGrab(undefined);
      under = undefined;
      lockedUnder = undefined;
      pointed(undefined);
      selectionChanged();
    },
    rehover,
    grab: () => (holding() ?? over)?.kind,
    reading() {
      const editing = current();
      if (
        !editing ||
        (press?.kind !== "scale" && press?.kind !== "stretch" && press?.kind !== "rotate")
      ) {
        return undefined;
      }
      const [id] = selected;
      const kind = selected.size === 1 ? editing.board.elements[id!]?.kind : undefined;
      if (press.kind === "rotate") {
        const degrees = kind && "frame" in kind ? core.rotationOf(kind) : press.turned;
        return { text: `${signed(degrees)}°`, snapped: press.snapped };
      }
      if (press.kind === "scale" && kind?.type === "image") {
        const shown = core.editsOf(kind).crop ?? kind.natural_size;
        return { text: `${Math.round((kind.frame.width / shown.width) * 100)}%`, snapped: false };
      }
      // As turned, unlike the bounds of the box.
      const corners = box(editing.editor, [...selected]);
      if (!corners) {
        return undefined;
      }
      const [width, height] = [
        distance(corners[0]!, corners[1]!),
        distance(corners[1]!, corners[2]!),
      ];
      return { text: `${Math.round(width)} × ${Math.round(height)}`, snapped: false };
    },
  };
}

function hovers(event: PointerEvent): boolean {
  return event.pointerType !== "touch" && pinned(event.target) === undefined;
}

/** Where pixels at `parts` of `area` lie on the board, however the image is turned or flipped. */
function lying({ editor }: Editing, id: string, area: Rect, parts: [number, number][]): Point[] {
  return parts.flatMap(
    ([x, y]) =>
      core.pointOfPixel(editor, id, {
        x: area.x + x * area.width,
        y: area.y + y * area.height,
      }) ?? [],
  );
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

/** Within half a turn either way, to the degree, with a minus sign. */
function signed(degrees: number): string {
  const turned = Math.round(((((degrees + 180) % 360) + 360) % 360) - 180);
  return turned < 0 ? `\u2212${-turned}` : String(turned);
}

/**
 * With its side `side` moved out by `by`, the opposite one staying, and no narrower or shorter
 * than `least`. Its text keeps its size, a note's height fitting it, and a sticky note's or a
 * shape's staying tall enough for it.
 */
function extended(kind: Holder, side: number, by: number, least: number): Holder {
  const { frame } = kind;
  const rotation = core.rotationOf(kind);
  if (side % 2 === 1) {
    const width = Math.max(frame.width + by, least);
    // Around the left side as the right one moves, and the other way round.
    return fitted({
      ...kind,
      frame: anchored(frame, rotation, { width, height: frame.height }, [side === 1 ? 0 : 1, 0]),
    });
  }
  const height = Math.max(frame.height + by, least, needed(kind));
  return {
    ...kind,
    frame: anchored(frame, rotation, { width: frame.width, height }, [0, side === 2 ? 0 : 1]),
  };
}

/** As the board draws `kind`, which shows while the pen is pressed. */
function drawnStroke(kind: Kind): Pen | undefined {
  const [drawn] = core.drawnKind(kind);
  return drawn?.kind === "stroke" ? drawn : undefined;
}

/** Between two corners of its frame, from one end to the other, or pinned at `from`, with text of `size`. */
function shaped(shape: Shaped, from: Point, to: Point, size: number): Kind {
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

function annotation({ board }: Editing, id: string): boolean {
  const kind = board.elements[id]?.kind;
  return kind !== undefined && isAnnotation(kind);
}

/**
 * As a click at `at` places it: centred there, but a note, whose first line starts there, and a
 * comment, pinned there.
 */
function placed(shape: Shaped, at: Point, zoom: number): Kind {
  const size = FONT_SIZE / zoom;
  if (shape === "comment") {
    return shaped(shape, at, at, size);
  }
  if (shape === "note") {
    const top = { x: at.x, y: at.y - (size * LINE_HEIGHT) / 2 };
    return shaped(
      shape,
      top,
      { x: top.x + NOTE_WIDTH / zoom, y: top.y + size * LINE_HEIGHT },
      size,
    );
  }
  const half = (shape === "sticky" ? STICKY_SIZE : PLACED_SIZE) / zoom / 2;
  return shaped(
    shape,
    { x: at.x - half, y: at.y - half },
    { x: at.x + half, y: at.y + half },
    size,
  );
}

function writesIn(kind: Kind | undefined): kind is Holder | Comment {
  return holdsText(kind) || kind?.type === "comment";
}

function contentOf(kind: Holder | Comment): string {
  return kind.type === "comment" ? kind.text : kind.text.content;
}

/** With `content` written in it, and its frame grown to fit. */
function rewritten(kind: Holder | Comment, content: string): Kind {
  return kind.type === "comment"
    ? { ...kind, text: content }
    : fitted({ ...kind, text: { ...kind.text, content } });
}

function isSegment(kind: Kind | undefined): kind is Segment {
  return SEGMENTS.has(kind?.type ?? "");
}

export function isTip(tool: string | undefined): tool is Tip {
  return tool !== undefined && Object.hasOwn(TIPS, tool);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Whether `id` draws before, so under, every one of the `chosen` and what they hold. */
function beneath({ draw_order }: Board, id: string, chosen: Set<string>): boolean {
  for (const drawn of draw_order) {
    if (drawn === id) {
      return true;
    }
    if (chosen.has(drawn)) {
      return false;
    }
  }
  return false;
}

/**
 * A box's `corners`, clockwise from its top-left, moved `by` inwards from each side, as far as its
 * middle.
 */
function inset(corners: Point[], by: number): Point[] {
  const [a, b, d] = [corners[0]!, corners[1]!, corners[3]!];
  const towards = (to: Point) => {
    const length = distance(a, to);
    const step = Math.min(by, length / 2) / (length || 1);
    return { x: (to.x - a.x) * step, y: (to.y - a.y) * step };
  };
  const [across, down] = [towards(b), towards(d)];
  return corners.map(({ x, y }, at) => {
    const [right, below] = [at === 0 || at === 3 ? 1 : -1, at < 2 ? 1 : -1];
    return { x: x + right * across.x + below * down.x, y: y + right * across.y + below * down.y };
  });
}

function offSegment(point: Point, from: Point, to: Point): number {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const length = dx * dx + dy * dy;
  const along =
    length === 0
      ? 0
      : Math.min(Math.max(((point.x - from.x) * dx + (point.y - from.y) * dy) / length, 0), 1);
  return distance(point, { x: from.x + along * dx, y: from.y + along * dy });
}

function whole(natural: Size): Rect {
  return { x: 0, y: 0, ...natural };
}

/**
 * On whole pixels, within the image, and a pixel wide and tall at least, as wide for its height
 * as it was, to a pixel, while `keep`.
 */
function dragged(
  { grip, start, from }: Extract<Press, { kind: "crop" }>,
  pixel: Point,
  natural: Size,
  keep: boolean,
): Rect {
  const [dx, dy] = [pixel.x - start.x, pixel.y - start.y];
  if (grip === undefined) {
    const x = Math.min(Math.max(Math.round(from.x + dx), 0), natural.width - from.width);
    const y = Math.min(Math.max(Math.round(from.y + dy), 0), natural.height - from.height);
    return { ...from, x, y };
  }
  if (keep) {
    return proportioned(grip, from, dx, dy, natural);
  }
  const [left, right] = stretched(from.x, from.width, grip[0], dx, natural.width);
  const [top, bottom] = stretched(from.y, from.height, grip[1], dy, natural.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A span of a crop, which a grip drags at `side`, 0 or 1, or keeps centred on at ½. */
interface Span {
  start: number;
  length: number;
  side: number;
  by: number;
  size: number;
}

/**
 * Scaled from its opposite corner along its diagonal, or from its opposite side and around its
 * centre line, as far as the image lets it.
 */
function proportioned(
  grip: [number, number],
  from: Rect,
  dx: number,
  dy: number,
  natural: Size,
): Rect {
  const spans: Span[] = [
    { start: from.x, length: from.width, side: grip[0], by: dx, size: natural.width },
    { start: from.y, length: from.height, side: grip[1], by: dy, size: natural.height },
  ];
  const dragging = spans.filter(({ side }) => side !== 0.5);
  const grown = ({ length, side, by }: Span) => length + (side === 1 ? by : -by);
  const scale =
    dragging.reduce((sum, span) => sum + grown(span) * span.length, 0) /
    dragging.reduce((sum, { length }) => sum + length ** 2, 0);
  const least = Math.max(...spans.map(({ length }) => 1 / length));
  const most = Math.min(...spans.map((span) => room(span) / span.length));
  const by = Math.min(Math.max(scale, least), most);
  const [[left, right], [top, bottom]] = spans.map((span) =>
    resized(span, Math.round(span.length * by)),
  ) as [[number, number], [number, number]];
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** How long the image lets a span grow, from its side kept, or around its centre. */
function room({ start, length, side, size }: Span): number {
  if (side === 0.5) {
    const centre = start + length / 2;
    return 2 * Math.min(centre, size - centre);
  }
  return side === 1 ? size - start : start + length;
}

/** The ends of a span made `length` long, from its side kept, or around its centre within the image. */
function resized(span: Span, length: number): [number, number] {
  const { start, side, size } = span;
  if (side === 0.5) {
    const at = Math.min(
      Math.max(Math.round(start + span.length / 2 - length / 2), 0),
      size - length,
    );
    return [at, at + length];
  }
  const kept = side === 1 ? start : start + span.length;
  return side === 1 ? [kept, kept + length] : [kept - length, kept];
}

/** Turned between portrait and landscape around its centre, as large as the image lets it. */
function swapped(area: Rect, natural: Size): Rect {
  const scale = Math.min(1, natural.width / area.height, natural.height / area.width);
  const width = Math.max(Math.round(area.height * scale), 1);
  const height = Math.max(Math.round(area.width * scale), 1);
  const x = Math.round(area.x + area.width / 2 - width / 2);
  const y = Math.round(area.y + area.height / 2 - height / 2);
  return {
    x: Math.min(Math.max(x, 0), natural.width - width),
    y: Math.min(Math.max(y, 0), natural.height - height),
    width,
    height,
  };
}

/** Lines across a crop at `parts` of its width, and of its height. */
function lines(parts: number[]): [[number, number], [number, number]][] {
  return parts.flatMap((part) => [
    [
      [part, 0],
      [part, 1],
    ],
    [
      [0, part],
      [1, part],
    ],
  ]);
}

/** The ends of a span, one of them moved by `by` when `side` is 0 or 1, within `0..size`. */
function stretched(
  start: number,
  length: number,
  side: number,
  by: number,
  size: number,
): [number, number] {
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
