// A chip under the selection, which opens a card of its style in its place, as the keys do. Once
// open, it follows the selection from one element to the next, until Esc closes it, or a press on
// nothing unless it is kept open. While a gesture scales, stretches, or turns the selection, what
// it reads shows there instead. Its buttons set what applies to every element selected, and that
// becomes the style of what their tools draw next, unless ⌥ is held. A lone animated image or
// video shows its frames, to play, step through, speed up or down, and trim to the part that
// plays, and a video's sound, to turn on or off.

import { clock, trimOf, type Playback, type Span } from "./playback.js";
import { among, loneImage, type Opened } from "./board.js";
import {
  ariaKeys,
  composing,
  describe,
  opensMenu,
  type Command,
  type Shortcut,
} from "./commands.js";
import * as core from "./core.js";
import type { Colour, CropShape, Kind, Point } from "./core.js";
import type { Reading } from "./edit.js";
import { message } from "./errors.js";
import { icon, type Icon } from "./icons.js";
import { css, type Paint } from "./paint.js";
import { defaultAlignment, holdsText } from "./text.js";
import {
  CORNERS,
  OPACITIES,
  PALETTE,
  PAPERS,
  RECENT,
  SIZES,
  highlight,
  restyled,
  settings,
  stepped,
  styleOf,
  valueOf,
  type Setting,
  type Style,
  type Styles,
} from "./style.js";

/** A button of one setting, and the command that shares its keys. */
interface Choice<S extends Setting> {
  value: Style[S];
  label: string;
  look: () => Node;
  command?: Command | undefined;
}

const STROKES: { [S in "weight" | "heads" | "dash" | "fill"]: Choice<S>[] } = {
  weight: [
    { value: "thin", label: "Thin stroke", look: () => icon("stroke", { stroke: 1.25 }) },
    { value: "medium", label: "Medium stroke", look: () => icon("stroke", { stroke: 2.5 }) },
    { value: "thick", label: "Thick stroke", look: () => icon("stroke", { stroke: 4.5 }) },
  ],
  heads: [
    { value: "end", label: "Head at the end", look: () => icon("arrow") },
    { value: "both", label: "Heads at both ends", look: () => icon("arrows") },
  ],
  dash: [
    { value: "solid", label: "Solid", look: () => icon("stroke", { stroke: 2 }) },
    { value: "dashed", label: "Dashed", look: () => icon("dashed", { stroke: 2 }) },
  ],
  fill: [
    { value: "hollow", label: "No fill", look: () => icon("disc") },
    { value: "tint", label: "Tint", look: () => icon("disc", { fill: 0.3 }) },
    { value: "solid", label: "Solid fill", look: () => icon("disc", { fill: 1 }) },
  ],
};

const ALIGNMENTS: Choice<"align">[] = [
  { value: "left", label: "Align left", look: () => icon("alignLeft") },
  { value: "centre", label: "Centre", look: () => icon("alignCentre") },
  { value: "right", label: "Align right", look: () => icon("alignRight") },
];

/** How near one of the steps a pointer snaps the opacity to it, in percent. */
const SNAP = 3;

/** From the window's edges, in CSS pixels. */
const MARGIN = 8;
/** How wide a range input's thumb is, in CSS pixels, which its value travels a thumb less than its track. */
const THUMB = 14;
/** From the selection, past the zones outside its corners that turn it, in CSS pixels. */
const GAP = 24;

export interface CardHost {
  current(): Opened | undefined;
  selection(): string[];
  /** Clockwise from its top-left, on the board. */
  box(): Point[] | undefined;
  /**
   * What the tool in use draws, in its style, while nothing is selected, whose style the card
   * then sets for what it draws next. `undefined` for a tool whose style shows on what it drew.
   */
  tool(): Kind | undefined;
  client(point: Point): { clientX: number; clientY: number } | undefined;
  zoom(): number | undefined;
  /** Whether a gesture or some writing is under way, which it hides for. */
  busy(): boolean;
  /** What a gesture reads, which shows in its place. */
  reading(): Reading | undefined;
  /** How far down the window it may show, above the toolbar, in CSS pixels. */
  floor(): number;
  /** As one edit that undoes in one step. Throws when one is under way. */
  apply(work: (editor: Opened["editor"], touched: string[]) => void): void;
  /** As `apply`, held open until `finishAdjusting`, each going on from the last, as one edit. */
  adjust(work: (editor: Opened["editor"], touched: string[]) => void): void;
  finishAdjusting(): void;
  /** Whether its edit is held open, which no other gesture is meanwhile. */
  adjusting(): boolean;
  /** Starts picking a colour from the board, until a click. */
  pick(): void;
  /** Names `button` in the hint while it is hovered or focused. */
  explain(button: HTMLElement, text: () => string): void;
  say(message: string): void;
  media: CardMedia;
  /** Once it starts trimming the lone animated image or video selected, or stops, which the hint tells. */
  trimmed(): void;
}

export interface CardMedia {
  /** `undefined` for one that does not play. */
  playback(asset: string): Playback | undefined;
  play(assets: string[], playing: boolean): void;
  seek(asset: string, at: number): void;
  /** Plays `span` of it, whatever its trim, until `undefined`. */
  preview(asset: string, span: Span | undefined): void;
}

/** Those that share its keys, for their hints. */
export interface CardCommands {
  colours: Command[];
  bold: Command;
  italic: Command;
  strike: Command;
  greyscale: Command;
  flipHorizontally: Command;
  flipVertically: Command;
  crop: Command;
  rectangularCrop: Command;
  ellipticalCrop: Command;
  play: Command;
  previousFrame: Command;
  nextFrame: Command;
  slower: Command;
  faster: Command;
  sound: Command;
  open: Command;
}

export interface Card {
  /** Over the selection as the camera now shows it, or hidden while nothing would show. */
  frame(): void;
  /** Once the selection, or what it holds, changed. */
  refresh(): void;
  isOpen(): boolean;
  /** Its first button takes the focus when `focus`. */
  open(focus: boolean): void;
  close(): void;
  /**
   * Opens it when `on`, and then nothing selected leaves it open, until it is closed or no longer
   * kept open.
   */
  keepOpen(on: boolean): void;
  /** Whether the lone animated image or video selected is being trimmed, until ↩ or Esc. */
  trimming(): boolean;
  /** What applies to every element selected. */
  common(): Setting[];
  /** Theirs, `undefined` when they differ. */
  value<S extends Setting>(setting: S): Style[S] | undefined;
  /** On every element selected it applies to, and for what their tools draw next unless `only`. */
  set(style: Style, only?: boolean): void;
  /** The text of each element selected, a size up or down from its own. */
  resize(larger: boolean): void;
  /** Whether every element selected is an image. */
  images(): boolean;
  /** Whether each element selected that takes a colour is drawn with a highlighter. */
  highlighting(): boolean;
  copy(): void;
  paste(): void;
  canPaste(): boolean;
}

export function card(host: CardHost, store: Styles, commands: CardCommands): Card {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "style-chip";
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");
  chip.append(icon("dots"));
  chip.hidden = true;
  const panel = document.createElement("div");
  panel.className = "style-card";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Style");
  panel.hidden = true;
  const readout = document.createElement("div");
  readout.className = "readout";
  readout.hidden = true;
  document.body.append(chip, panel, readout);
  const opens = commands.open.keys?.[0];
  chip.setAttribute("aria-label", "Style");
  if (opens) {
    chip.setAttribute("aria-keyshortcuts", ariaKeys(opens));
  }
  chip.title = opens ? `Style · ${describe(opens)}` : "Style";
  host.explain(chip, () => chip.title);
  chip.addEventListener("click", (event) => {
    open = true;
    show(event.detail === 0);
  });
  // Before the board's keys, as ↩ would crop and Esc close the card.
  // Not from a button the keys press, or a menu, which Esc closes.
  addEventListener(
    "keydown",
    (event) => {
      const focused = document.activeElement;
      const pressing =
        focused instanceof HTMLButtonElement && !focused.classList.contains("handle");
      if (trimming && !pressing && !event.repeat && !event.defaultPrevented && !composing(event)) {
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          leaveTrim(event.key === "Enter");
        }
      }
    },
    true,
  );

  let open = false;
  let kept = false;
  /** What the card shows, so that it only builds again once that changed, and at which zoom, as sizes go by it. */
  let built = "";
  let filledAt: number | undefined;
  /** The frames played of the lone animated image or video being trimmed, and whether it played before. */
  let trimming: { id: string; asset: string; span: Span; playing: boolean } | undefined;
  /** While a pointer moves the frame shown or an end of the trim, which the card must not build under. */
  let dragging = false;
  const letGo = () => {
    dragging = false;
  };
  /** With whether the alignment it holds is only the one its holder takes by default. */
  let copied: { style: Style; natural: boolean } | undefined;

  /**
   * The elements selected, and those of the groups selected, but the groups themselves and the
   * locked elements, or else what the tool draws, which no element holds yet.
   */
  const targets = (): { id: string; kind: Kind }[] => {
    const opened = host.current();
    if (!opened) {
      return [];
    }
    const drawn = host.tool();
    if (drawn) {
      return [{ id: "", kind: drawn }];
    }
    const { board, editor } = opened;
    const chosen = new Set(host.selection());
    return board.draw_order
      .filter(
        (id) =>
          among(board, id, chosen) &&
          board.elements[id]!.kind.type !== "group" &&
          editor.lockedBy(id) === undefined,
      )
      .map((id) => ({ id, kind: board.elements[id]!.kind }));
  };
  const alone = () => loneImage(host.current()?.board, host.selection());
  const animated = () => {
    const lone = alone();
    const playback = lone && host.media.playback(lone.image.asset);
    return lone && playback && { ...lone, playback };
  };
  /** Of the targets, those that have a style, which comments lack. */
  const styled = () => targets().filter(({ kind }) => settings(kind).length > 0);
  const highlighting = () => {
    const all = styled().filter(({ kind }) => settings(kind).includes("colour"));
    return (
      all.length > 0 &&
      all.every(({ kind }) => kind.type === "stroke" && kind.tip === "highlighter")
    );
  };
  /** Of what they take, as an image, which takes only opacity, narrows nothing. */
  const common = (): Setting[] => {
    const all = styled();
    const drawn = all.filter(({ kind }) => kind.type !== "image");
    const counted = drawn.length > 0 ? drawn : all;
    const [first] = counted;
    return first
      ? settings(first.kind).filter((setting) =>
          counted.every(({ kind }) => settings(kind).includes(setting)),
        )
      : [];
  };
  const images = () => {
    const all = targets();
    return all.length > 0 && all.every(({ kind }) => kind.type === "image");
  };
  const value = <S extends Setting>(setting: S): Style[S] | undefined => {
    const zoom = host.zoom() ?? 1;
    const values = styled()
      .filter(({ kind }) => settings(kind).includes(setting))
      .map(({ kind }) => valueOf(kind, setting, zoom));
    const [first] = values;
    // A size shows as one when within a pixel, as zooming leaves it a hair off.
    const same = (other: Style[Setting]) =>
      setting === "size" ? Math.abs(Number(other) - Number(first)) < 0.5 : other === first;
    return values.length > 0 && values.every(same) ? (first as Style[S]) : undefined;
  };
  const edit = (work: (editor: Opened["editor"], touched: string[]) => void, held = false) => {
    try {
      if (held) {
        host.adjust(work);
      } else {
        host.apply(work);
      }
    } catch (error) {
      host.say(message(error));
    }
  };
  /** Each element selected in `style`, or the style `each` gives it, as one edit. */
  const restyle = (style: Style, each: (kind: Kind) => Style = () => style, held = false) => {
    const zoom = host.zoom();
    const all = targets();
    if (zoom === undefined || all.length === 0) {
      return [];
    }
    if (host.tool() !== undefined) {
      if (style.colour !== undefined) {
        store.pick(style.colour);
      }
      return all;
    }
    edit((editor, touched) => {
      for (const { id, kind } of all) {
        const next = restyled(kind, each(kind), zoom);
        if (next !== kind) {
          touched.push(...editor.update(id, JSON.stringify(next)));
        }
      }
    }, held);
    if (style.colour !== undefined) {
      store.pick(style.colour);
    }
    return all;
  };
  const set = (style: Style, only = false) => {
    const all = restyle(style);
    if (all.length > 0 && (!only || host.tool() !== undefined)) {
      learn(
        all.map(({ kind }) => kind),
        style,
      );
    }
  };
  /** What draws `kinds` draws in `style` from now on. */
  const learn = (kinds: Kind[], style: Style) => {
    store.learn(kinds, style);
    // No edit tells it so.
    if (host.tool() !== undefined) {
      show();
    }
  };

  const button = (name: string, content: Node, press: (event: MouseEvent) => void, extra?: Extra) =>
    cardButton(panel, host.explain, name, content, press, extra);
  /** The buttons of one setting, which press each other off. */
  const options = <S extends Setting>(setting: S, choices: Choice<S>[]) => {
    const current = value(setting);
    return choices.map(({ value: chosen, label, look, command }) =>
      button(label, look(), (event) => set({ [setting]: chosen }, event.altKey), {
        pressed: current === chosen,
        shortcut: command?.keys?.[0],
      }),
    );
  };
  const opacity = () => {
    const shown = value("opacity");
    const paper = value("paper");
    const made = document.createElement("div");
    made.className = "slider";
    made.classList.toggle("mixed", shown === undefined);
    const colour = value("colour");
    const tint = highlighting()
      ? core.highlighted(colour ?? "ink")
      : (colour ?? (paper ? `paper-${paper}` : "ink"));
    made.style.setProperty("--tint", css(tint, panel));
    const track = document.createElement("div");
    track.className = "track";
    const input = document.createElement("input");
    input.type = "range";
    input.min = "1";
    input.max = "100";
    input.value = String(shown ?? 100);
    // Apart from its row's, which the focus would go back to as the card builds again.
    input.setAttribute("aria-label", "Opacity level");
    const ticks = OPACITIES.slice(0, -1).map((percent) => {
      const tick = document.createElement("span");
      tick.className = "tick";
      const at = (percent - Number(input.min)) / (Number(input.max) - Number(input.min));
      tick.style.setProperty("--at", String(at));
      return tick;
    });
    track.append(input, ...ticks);
    const amount = document.createElement("span");
    amount.className = "value";
    const show = (text: string) => {
      amount.textContent = text;
      input.setAttribute("aria-valuetext", text);
    };
    show(shown === undefined ? "Mixed" : `${shown}%`);
    /** Whether its edit is held, so that it ends once, as several events may each end it. */
    let sliding = false;
    let pointer = false;
    let held = false;
    let only = false;
    const slide = () => {
      const near = pointer
        ? OPACITIES.find((step) => Math.abs(step - Number(input.value)) <= SNAP)
        : undefined;
      if (near !== undefined) {
        input.value = String(near);
      }
      made.classList.remove("mixed");
      show(`${input.value}%`);
      sliding = true;
      restyle({ opacity: Number(input.value) }, undefined, true);
    };
    const finish = () => {
      if (!sliding) {
        return;
      }
      sliding = false;
      // Back to the board, as a button pressed gives it back.
      if (pointer) {
        input.blur();
      }
      host.finishAdjusting();
      if (!only || host.tool() !== undefined) {
        learn(
          targets().map(({ kind }) => kind),
          { opacity: Number(input.value) },
        );
      }
    };
    const release = () => {
      if (pointer) {
        finish();
        pointer = false;
      }
    };
    input.addEventListener("pointerdown", (event) => {
      // The primary button alone, as the others, and ⌃ on a Mac, open the menu.
      if (event.button === 0 && !opensMenu(event)) {
        pointer = true;
        only = event.altKey;
      }
    });
    input.addEventListener("keydown", (event) => {
      held = true;
      only = event.altKey;
    });
    input.addEventListener("input", slide);
    // Browsers send none once a pointer lets go where the value started, or on a step snapped to,
    // which its release ends instead. A key held repeats it, as one edit until the key is up.
    input.addEventListener("change", () => {
      if (!held) {
        finish();
      }
    });
    input.addEventListener("keyup", () => {
      held = false;
      finish();
    });
    // A press that moves nothing sets nothing, but from Mixed it takes the value shown.
    input.addEventListener("pointerup", () => {
      if (pointer && made.classList.contains("mixed")) {
        slide();
      }
      release();
    });
    // Never left holding its edit open, which would keep undo from working.
    input.addEventListener("lostpointercapture", release);
    input.addEventListener("pointercancel", release);
    input.addEventListener("blur", () => {
      held = false;
      finish();
    });
    host.explain(input, () => "Opacity");
    made.append(track, amount);
    return [made];
  };
  /**
   * A star's points, or a polygon's sides, which each of them selected counts one more or fewer
   * of, from its own.
   */
  const counts = () => {
    const counted = styled().filter(({ kind }) => settings(kind).includes("corners"));
    const stars = counted.filter(({ kind }) => kind.type === "shape" && kind.shape === "star");
    const noun =
      stars.length === counted.length ? "points" : stars.length === 0 ? "sides" : "corners";
    const step = (by: number, bound: number) => {
      const recounted = (kind: Kind): Style => ({
        corners: clamp(cornersOf(kind) + by, CORNERS.fewest, CORNERS.most),
      });
      const made = button(
        `${by < 0 ? "Fewer" : "More"} ${noun}`,
        icon(by < 0 ? "minus" : "plus"),
        (event) => {
          restyle({}, recounted);
          if (!event.altKey || host.tool() !== undefined) {
            counted.forEach(({ kind }) => learn([kind], recounted(kind)));
          }
        },
      );
      if (counted.every(({ kind }) => cornersOf(kind) === bound)) {
        made.setAttribute("aria-disabled", "true");
      }
      return made;
    };
    const shown = value("corners");
    const tally = letters(shown === undefined ? "Mixed" : `${shown} ${noun}`);
    tally.classList.add("tally");
    return [step(-1, CORNERS.fewest), tally, step(1, CORNERS.most)];
  };
  const toggle = (
    setting: "bold" | "italic" | "strike",
    label: string,
    name: Icon,
    command: Command,
  ) =>
    button(
      label,
      icon(name),
      (event) => set({ [setting]: value(setting) !== true }, event.altKey),
      {
        pressed: value(setting) === true,
        shortcut: command.keys?.[0],
      },
    );

  /** One row per kind of setting, of those that apply to all. */
  const build = (): HTMLElement[] => {
    const can = new Set(common());
    const rows: HTMLElement[] = [];
    if (can.has("colour")) {
      rows.push(colours());
    }
    if (can.has("paper")) {
      const papers = PAPERS.map(({ paper, label }, at) => ({
        value: paper,
        label,
        look: () => swatch(`paper-${paper}`, "paper"),
        command: commands.colours[at],
      }));
      rows.push(row("Paper", options("paper", papers)));
    }
    const strokes = (["weight", "heads", "dash", "fill"] as const).flatMap((setting) =>
      can.has(setting) ? [options(setting, STROKES[setting] as Choice<typeof setting>[])] : [],
    );
    if (strokes.length > 0) {
      rows.push(row("Strokes", ...strokes));
    }
    if (can.has("corners")) {
      rows.push(row("Corners", counts()));
    }
    if (can.has("size")) {
      const shown = value("size");
      const sizes = SIZES.map(({ label, name, pixels }) => {
        return button(name, letters(label), (event) => set({ size: pixels }, event.altKey), {
          pressed: shown !== undefined && Math.abs(shown - pixels) < 0.5,
        });
      });
      rows.push(row("Size", sizes));
    }
    const text: HTMLElement[][] = [];
    if (can.has("bold")) {
      text.push([
        toggle("bold", "Bold", "bold", commands.bold),
        toggle("italic", "Italic", "italic", commands.italic),
        toggle("strike", "Strikethrough", "strikethrough", commands.strike),
      ]);
    }
    if (can.has("align")) {
      text.push(options("align", ALIGNMENTS));
    }
    if (text.length > 0) {
      rows.push(row("Text", ...text));
    }
    const moving = animated();
    if (moving) {
      rows.push(...playing(moving.image.asset, moving.image.edits.speed ?? 1, moving.playback));
    }
    if (images()) {
      const grey = targets().every(({ kind }) => kind.type === "image" && kind.edits.greyscale);
      const shaped = (shape: CropShape) =>
        targets().every(
          ({ kind }) => kind.type === "image" && (kind.edits.crop_shape ?? "rectangle") === shape,
        );
      const crops = commands.crop.unavailable?.() === undefined;
      rows.push(
        row(
          "Image",
          [
            button("Greyscale", icon("contrast"), () => commands.greyscale.run(), {
              pressed: grey,
              shortcut: commands.greyscale.keys?.[0],
            }),
            button(
              "Flip horizontally",
              icon("flipHorizontally"),
              () => commands.flipHorizontally.run(),
              {
                shortcut: commands.flipHorizontally.keys?.[0],
              },
            ),
            button("Flip vertically", icon("flipVertically"), () => commands.flipVertically.run(), {
              shortcut: commands.flipVertically.keys?.[0],
            }),
            ...(crops
              ? [
                  button("Crop", icon("crop"), () => commands.crop.run(), {
                    shortcut: commands.crop.keys?.[0],
                  }),
                ]
              : []),
          ],
          [
            button("Rectangular crop", icon("square"), () => commands.rectangularCrop.run(), {
              pressed: shaped("rectangle"),
            }),
            button("Elliptical crop", icon("circle"), () => commands.ellipticalCrop.run(), {
              pressed: shaped("ellipse"),
              shortcut: commands.ellipticalCrop.keys?.[0],
            }),
          ],
        ),
      );
    }
    if (can.has("opacity")) {
      rows.push(row("Opacity", opacity()));
    }
    return rows;
  };
  /**
   * The frames of an animated image or a video, which its own state fills as it plays, then how it
   * plays, or its trim being set. How it plays alone for a video whose frames are not known.
   */
  const playing = (asset: string, speed: number, { count, sound }: Playback) => {
    const step = (name: string, look: Icon, command: Command) =>
      able(
        button(name, icon(look), () => command.run(), { shortcut: command.keys?.[0] }),
        command,
      );
    const play = button("Play", icon("play"), () => commands.play.run(), {
      shortcut: commands.play.keys?.[0],
    });
    const normal = button("Normal speed", letters(`${speed}×`), () => paced(1));
    normal.classList.add("speed");
    const pace = [
      step("Slower", "minus", commands.slower),
      normal,
      step("Faster", "plus", commands.faster),
    ];
    const voice =
      sound === undefined
        ? []
        : [
            button("Turn sound on", icon("muted"), () => commands.sound.run(), {
              shortcut: commands.sound.keys?.[0],
            }),
          ];
    voice[0]?.classList.add("push");
    if (count <= 1) {
      return [row("Playback", [play], [...pace, ...voice])];
    }
    const scrub = document.createElement("div");
    scrub.className = "scrub";
    // Built again for another, as its handlers go to this one.
    scrub.dataset.asset = asset;
    scrub.classList.toggle("trimming", trimming !== undefined);
    const rail = document.createElement("span");
    rail.className = "rail";
    const plays = document.createElement("span");
    plays.className = "kept";
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = String(count - 1);
    input.setAttribute("aria-label", "Frame");
    /** Whether it played before a pointer took it to another frame, as it will once let go. */
    let resume = false;
    input.addEventListener("pointerdown", (event) => {
      // The primary button alone, as the others, and ⌃ on a Mac, open the menu.
      if (event.button === 0 && !opensMenu(event)) {
        dragging = true;
        resume = host.media.playback(asset)?.playing ?? false;
        host.media.play([asset], false);
      }
    });
    input.addEventListener("input", () => host.media.seek(asset, Number(input.value)));
    const release = () => {
      if (dragging) {
        dragging = false;
        // Back to the board, as a button pressed gives it back.
        input.blur();
        host.media.play([asset], resume);
      }
    };
    // Never left held, which would keep the card from building again.
    for (const ending of ["pointerup", "lostpointercapture", "pointercancel", "change", "blur"]) {
      input.addEventListener(ending, release);
    }
    const frame = () => {
      const now = host.media.playback(asset);
      return sound === undefined || !now ? "Frame" : `Frame ${now.at + 1} of ${now.count}`;
    };
    host.explain(input, frame);
    scrub.append(rail, plays, input);
    if (trimming) {
      scrub.append(end(asset, false), end(asset, true));
    }
    const at = document.createElement("span");
    at.className = "count";
    if (sound !== undefined) {
      at.classList.add("clock");
      host.explain(at, frame);
    }
    const timeline = row("Timeline", [scrub, at]);
    if (trimming) {
      const note = document.createElement("span");
      note.className = "note";
      const reset = button("Play every frame", letters("Reset"), () => trim(asset, [0, count - 1]));
      reset.classList.add("wide");
      const done = document.createElement("span");
      done.className = "letters";
      const key = document.createElement("kbd");
      key.textContent = "↩";
      done.append("Done", key);
      const finish = button("Done", done, () => leaveTrim(true), { hint: "Done · ↩" });
      finish.classList.add("primary");
      return [timeline, row("Trim", [note, reset, finish])];
    }
    const scissors = button("Trim", icon("scissors"), enterTrim);
    scissors.classList.toggle("push", voice.length === 0);
    return [
      timeline,
      row(
        "Playback",
        [
          step("Previous frame", "previousFrame", commands.previousFrame),
          play,
          step("Next frame", "nextFrame", commands.nextFrame),
        ],
        [...pace, ...voice, scissors],
      ),
    ];
  };
  const end = (asset: string, last: boolean) => {
    const made = button(last ? "Trim end" : "Trim start", document.createTextNode(""), () => {}, {
      hint: `${last ? "Trim end" : "Trim start"} · drag, or ← →`,
    });
    made.classList.add("handle");
    made.dataset.end = last ? "last" : "first";
    const move = (at: number) => {
      if (!trimming) {
        return;
      }
      const [first, final] = trimming.span;
      trim(asset, last ? [first, Math.max(first, at)] : [Math.min(at, final), final], at);
    };
    made.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && !opensMenu(event)) {
        event.preventDefault();
        made.setPointerCapture(event.pointerId);
        dragging = true;
      }
    });
    made.addEventListener("pointermove", (event) => {
      const count = host.media.playback(asset)?.count;
      const scrub = made.parentElement;
      if (!dragging || !made.hasPointerCapture(event.pointerId) || !count || !scrub) {
        return;
      }
      const { left, width } = scrub.getBoundingClientRect();
      // Over the thumb's centre at each frame.
      const along = (event.clientX - left - THUMB / 2) / Math.max(1, width - THUMB);
      move(Math.round(clamp(along, 0, 1) * (count - 1)));
    });
    made.addEventListener("pointerup", letGo);
    made.addEventListener("lostpointercapture", letGo);
    made.addEventListener("pointercancel", letGo);
    made.addEventListener("keydown", (event) => {
      const by = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (by !== undefined && trimming) {
        // Kept from nudging the image.
        event.preventDefault();
        move(trimming.span[last ? 1 : 0] + by);
      }
    });
    return made;
  };
  const trim = (asset: string, span: Span, at = span[0]) => {
    const count = host.media.playback(asset)?.count ?? 0;
    const within: Span = [clamp(span[0], 0, count - 1), clamp(span[1], 0, count - 1)];
    if (trimming) {
      trimming.span = within;
    }
    host.media.preview(asset, within);
    host.media.seek(asset, clamp(at, within[0], within[1]));
    live();
  };
  const enterTrim = () => {
    const moving = animated();
    if (!moving) {
      return;
    }
    const { id, image, playback } = moving;
    trimming = { id, asset: image.asset, span: playback.span, playing: playback.playing };
    host.media.play([image.asset], false);
    host.media.preview(image.asset, playback.span);
    fill();
    host.trimmed();
  };
  /** As set, when `keep`, or as it was. */
  const leaveTrim = (keep: boolean) => {
    if (!trimming) {
      return;
    }
    const { id, asset, span, playing: was } = trimming;
    trimming = undefined;
    dragging = false;
    host.media.preview(asset, undefined);
    const playback = host.media.playback(asset);
    if (keep && playback) {
      const trimmed = trimOf(playback.starts, span);
      edit((editor, touched) => touched.push(...core.setTrim(editor, [id], trimmed)));
      host.media.seek(asset, span[0]);
    }
    host.media.play([asset], was);
    show();
    host.trimmed();
  };
  /** As fast as `speed` says, which every image of its asset shares. */
  const paced = (speed: number) => {
    const lone = alone();
    if (lone) {
      edit((editor, touched) => touched.push(...editor.setSpeed([lone.id], speed)));
    }
  };
  /** The palette over the colours picked lately, column by column, and the pipette over a colour of one's own. */
  const colours = () => {
    const made = document.createElement("div");
    made.className = "colours";
    made.setAttribute("role", "group");
    made.setAttribute("aria-label", "Colour");
    const current = value("colour");
    const place = (element: HTMLElement, line: number, column: number) => {
      element.style.setProperty("grid-row", String(line));
      element.style.setProperty("grid-column", String(column));
      made.append(element);
    };
    const highlights = highlighting();
    PALETTE.forEach(({ colour, label }, at) => {
      const shown = highlights ? highlight(at) : { paint: colour, label };
      place(
        button(
          shown.label,
          swatch(shown.paint, "palette"),
          (event) => set({ colour }, event.altKey),
          { pressed: current === colour, shortcut: commands.colours[at]?.keys?.[0] },
        ),
        1,
        at + 1,
      );
    });
    const own = store.picked().slice(0, RECENT);
    own.forEach((colour, at) =>
      place(
        button(colour, swatch(colour, "own"), (event) => set({ colour }, event.altKey), {
          pressed: current === colour,
        }),
        2,
        at + 1,
      ),
    );
    place(separator(), 1, 7);
    const hint = "Pick a colour from the board · hold S";
    place(
      button("Pick a colour from the board", icon("pipette"), () => host.pick(), { hint }),
      1,
      8,
    );
    // Under the pipette, or beside it while there are none of one's own to leave room for.
    if (own.length > 0) {
      place(separator(), 2, 7);
    }
    place(custom(current), own.length > 0 ? 2 : 1, own.length > 0 ? 8 : 9);
    return made;
  };
  const custom = (current: Colour | undefined) => {
    const label = document.createElement("label");
    label.className = "custom";
    label.title = "A colour of one's own";
    label.append(icon("plus"));
    const input = document.createElement("input");
    input.type = "color";
    input.setAttribute("aria-label", "A colour of one's own");
    input.value = current?.startsWith("#") ? current : "#888888";
    input.addEventListener("change", () => set({ colour: input.value.toLowerCase() as Colour }));
    host.explain(label, () => "A colour of one's own");
    label.append(input);
    return label;
  };
  /** Builds it again only once what it shows changed, keeping the focus on the same button. */
  const fill = () => {
    filledAt = host.zoom();
    const rows = build();
    const signature = rows.map((made) => made.outerHTML).join("");
    if (signature !== built && !host.adjusting() && !dragging) {
      rebuild(rows, signature);
    }
    live();
  };
  const rebuild = (rows: HTMLElement[], signature: string) => {
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const label = focused?.getAttribute("aria-label");
    // Gone without the pointer leaving them, they would leave their hint behind.
    panel
      .querySelectorAll("button, .custom, input[type=range]")
      .forEach((old) => old.dispatchEvent(new PointerEvent("pointerleave")));
    built = signature;
    panel.replaceChildren(...rows.flatMap((made, at) => (at > 0 ? [rule(), made] : [made])));
    live();
    if (label) {
      [...panel.querySelectorAll<HTMLElement>("[aria-label]")]
        .find((element) => element.getAttribute("aria-label") === label)
        ?.focus();
    }
  };
  /**
   * The frame the lone animated image or video shows, whether it plays, and whether a video's sound
   * does, as they change on their own.
   */
  const live = () => {
    const moving = animated();
    if (!moving) {
      return;
    }
    const { at, count, playing: plays, span: played, starts, sound } = moving.playback;
    const [first, last] = trimming?.span ?? played;
    const along = (frame: number) =>
      `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${frame / Math.max(1, count - 1)})`;
    // A video by the time it shows, as a player tells it, an animated image by its frame.
    const timed = sound !== undefined;
    const text = timed ? clock(starts[at] ?? 0) : `${at + 1} / ${count}`;
    const input = panel.querySelector<HTMLInputElement>(".scrub input");
    if (input && !dragging) {
      input.value = String(at);
    }
    input?.setAttribute("aria-valuetext", timed ? `${text}, frame ${at + 1} of ${count}` : text);
    const shown = panel.querySelector(".count");
    if (shown && shown.textContent !== text) {
      shown.textContent = text;
    }
    const range = panel.querySelector<HTMLElement>(".scrub .kept");
    range?.style.setProperty("left", along(first));
    range?.style.setProperty(
      "width",
      `calc((100% - ${THUMB}px) * ${(last - first) / Math.max(1, count - 1)})`,
    );
    panel.querySelector(".scrub")?.classList.toggle("trimmed", first > 0 || last < count - 1);
    panel
      .querySelectorAll<HTMLElement>(".scrub .handle")
      .forEach((handle) =>
        handle.style.setProperty("left", along(handle.dataset.end === "last" ? last : first)),
      );
    const note = panel.querySelector(".note");
    if (note) {
      note.textContent = timed
        ? `Loops ${clock(starts[first] ?? 0)}–${clock(starts[last + 1] ?? 0)}`
        : `Loops ${first + 1}–${last + 1} of ${count}`;
    }
    const play = panel.querySelector<HTMLButtonElement>(
      '[aria-label="Play"], [aria-label="Pause"]',
    );
    const name = plays ? "Pause" : "Play";
    if (play && play.getAttribute("aria-label") !== name) {
      const shortcut = commands.play.keys?.[0];
      play.setAttribute("aria-label", name);
      play.title = shortcut ? `${name} · ${describe(shortcut)}` : name;
      play.replaceChildren(icon(plays ? "pause" : "play"));
    }
    const voice = panel.querySelector<HTMLButtonElement>(
      '[aria-label="Turn sound on"], [aria-label="Turn sound off"]',
    );
    const said = sound ? "Turn sound off" : "Turn sound on";
    if (voice && voice.getAttribute("aria-label") !== said) {
      const shortcut = commands.sound.keys?.[0];
      voice.setAttribute("aria-label", said);
      voice.title = shortcut ? `${said} · ${describe(shortcut)}` : said;
      voice.replaceChildren(icon(sound ? "sound" : "muted"));
    }
  };
  // Not hidden by the edit its opacity holds open as it slides.
  const visible = () =>
    targets().length > 0 && (common().length > 0 || images()) && (host.adjusting() || !host.busy());
  const show = (focus = false) => {
    const reading = host.reading();
    readout.hidden = reading === undefined;
    if (reading) {
      readout.textContent = reading.text;
      readout.classList.toggle("snapped", reading.snapped);
      hide();
      place(readout);
      return;
    }
    if (!visible()) {
      hide();
      return;
    }
    chip.setAttribute("aria-expanded", String(open));
    chip.hidden = open;
    panel.hidden = !open;
    if (open) {
      fill();
      if (focus) {
        panel.querySelector("button")?.focus();
      }
    }
    place(open ? panel : chip);
  };
  /** Still open, so that it shows again once the selection has a style again. */
  const hide = () => {
    chip.hidden = true;
    panel.hidden = true;
  };
  /** Under the selection, or above the toolbar for the tool's style. */
  const place = (shown: HTMLElement) => {
    if (host.tool() !== undefined) {
      const { width, height } = shown.getBoundingClientRect();
      const floor = Math.min(innerHeight, host.floor());
      const left = clamp(innerWidth / 2 - width / 2, MARGIN, innerWidth - width - MARGIN);
      shown.style.setProperty("left", `${left}px`);
      shown.style.setProperty("top", `${Math.max(MARGIN, floor - height - MARGIN)}px`);
      return;
    }
    const corners = host.box()?.map((corner) => host.client(corner));
    if (corners?.every((corner) => corner !== undefined)) {
      beneath(shown, corners, host.floor());
    }
  };
  const refresh = () => {
    if (!kept && !host.busy() && targets().length === 0) {
      open = false;
    }
    if (trimming && animated()?.id !== trimming.id) {
      leaveTrim(false);
    }
    show();
  };

  return {
    frame() {
      if (!panel.hidden && host.zoom() !== filledAt) {
        fill();
      } else if (!panel.hidden) {
        live();
      }
      const shown = [readout, chip, panel].find((element) => !element.hidden);
      if (shown) {
        place(shown);
      }
    },
    refresh,
    isOpen: () => open && !panel.hidden,
    open(focus) {
      open = true;
      show(focus);
    },
    close() {
      const had = panel.contains(document.activeElement);
      leaveTrim(false);
      open = false;
      show();
      if (had) {
        chip.focus();
      }
    },
    keepOpen(on) {
      kept = on;
      open ||= on;
      refresh();
    },
    trimming: () => trimming !== undefined,
    common,
    value,
    highlighting,
    set,
    resize(larger) {
      const zoom = host.zoom();
      const all = targets().filter(({ kind }) => settings(kind).includes("size"));
      if (zoom === undefined || all.length === 0) {
        return;
      }
      const sized = all.map(({ id, kind }) => ({
        id,
        kind,
        size: stepped(Number(valueOf(kind, "size", zoom)), larger),
      }));
      edit((editor, touched) => {
        for (const { id, kind, size } of sized) {
          touched.push(...editor.update(id, JSON.stringify(restyled(kind, { size }, zoom))));
        }
      });
      store.learn(
        all.map(({ kind }) => kind),
        { size: sized[0]!.size },
      );
    },
    images,
    copy() {
      const all = styled();
      const first = all.find(({ kind }) => kind.type !== "image") ?? all[0];
      const zoom = host.zoom();
      if (first && zoom !== undefined && settings(first.kind).length > 0) {
        const { kind } = first;
        const style = styleOf(kind, zoom);
        copied = {
          style,
          natural: style.align !== undefined && holdsText(kind) && kind.text.align === undefined,
        };
      }
    },
    paste() {
      if (copied) {
        const { style, natural } = copied;
        // Each takes the alignment its own holder chooses, as a note's is not a shape's.
        restyle(style, (kind) =>
          natural && holdsText(kind) ? { ...style, align: defaultAlignment(kind) } : style,
        );
      }
    },
    canPaste: () => copied !== undefined,
  };
}

export interface Extra {
  pressed?: boolean;
  shortcut?: Shortcut | undefined;
  hint?: string;
}

/** A button of `panel`, which gives the focus back to the board once clicked. */
export function cardButton(
  panel: HTMLElement,
  explain: CardHost["explain"],
  name: string,
  content: Node,
  press: (event: MouseEvent) => void,
  { pressed, shortcut, hint }: Extra = {},
): HTMLButtonElement {
  const made = document.createElement("button");
  made.type = "button";
  made.setAttribute("aria-label", name);
  const explained = shortcut ? `${name} · ${describe(shortcut)}` : (hint ?? name);
  made.title = explained;
  if (shortcut) {
    made.setAttribute("aria-keyshortcuts", ariaKeys(shortcut));
  }
  made.append(content);
  // Chosen, a colour shows in itself, which its button takes from its swatch.
  if (content instanceof HTMLElement && content.classList.contains("swatch")) {
    made.style.setProperty("--swatch", content.style.getPropertyValue("--swatch"));
  }
  if (pressed !== undefined) {
    made.setAttribute("aria-pressed", String(pressed));
  }
  // As the title stands then, which Play and Pause change in place.
  explain(made, () => made.title);
  made.addEventListener("click", (event) => {
    press(event);
    // Back to the board, as the toolbar's buttons give it back, unless the keys pressed it, even
    // from the button built again in its place, which took its focus over.
    if (
      event.detail > 0 &&
      document.activeElement instanceof HTMLElement &&
      panel.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
  });
  return made;
}

/** Where `beneath` placed something, and the bounds of the corners it placed it by. */
export interface Placement {
  under: boolean;
  centre: number;
  top: number;
  bottom: number;
}

/**
 * Under `corners`, or above them where the toolbar, from `floor` down, leaves no room under them,
 * centred across them, and within the window.
 */
export function beneath(
  shown: HTMLElement,
  corners: { clientX: number; clientY: number }[],
  floor: number,
): Placement {
  const { width, height } = shown.getBoundingClientRect();
  const bottom = Math.min(innerHeight, floor);
  const xs = corners.map((corner) => corner.clientX);
  const ys = corners.map((corner) => corner.clientY);
  const around = {
    centre: (Math.min(...xs) + Math.max(...xs)) / 2,
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
  const left = clamp(around.centre - width / 2, MARGIN, innerWidth - width - MARGIN);
  const below = around.bottom + GAP;
  const under = below + height <= bottom - MARGIN;
  const top = under ? below : around.top - GAP - height;
  shown.style.setProperty("left", `${left}px`);
  shown.style.setProperty("top", `${clamp(top, MARGIN, bottom - height - MARGIN)}px`);
  return { under, ...around };
}

export function letters(text: string): HTMLSpanElement {
  const made = document.createElement("span");
  made.className = "letters";
  made.textContent = text;
  return made;
}

function swatch(paint: Paint, kind: "palette" | "own" | "paper"): HTMLSpanElement {
  const made = document.createElement("span");
  made.className = `swatch ${kind}`;
  made.style.setProperty("--swatch", css(paint, made));
  return made;
}

function cornersOf(kind: Kind): number {
  return Number(valueOf(kind, "corners", 1));
}

/** Dimmed while `command` cannot run, as the toolbar's buttons are. */
function able(made: HTMLButtonElement, command: Command): HTMLButtonElement {
  if (command.unavailable?.() !== undefined) {
    made.setAttribute("aria-disabled", "true");
  }
  return made;
}

export function row(label: string, ...groups: HTMLElement[][]): HTMLDivElement {
  const made = document.createElement("div");
  made.className = "row";
  made.setAttribute("role", "group");
  made.setAttribute("aria-label", label);
  groups.forEach((group, at) => {
    if (at > 0) {
      made.append(separator());
    }
    made.append(...group);
  });
  return made;
}

function separator(): HTMLElement {
  const line = document.createElement("span");
  line.className = "separator";
  line.setAttribute("role", "separator");
  line.setAttribute("aria-orientation", "vertical");
  return line;
}

export function rule(): HTMLElement {
  const line = document.createElement("div");
  line.className = "rule";
  line.setAttribute("role", "separator");
  return line;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}
