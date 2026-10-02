// A chip under the selection, which opens a card of its style in its place, as the keys do. Once
// open, it follows the selection from one element to the next, until Esc or a press on nothing
// closes it. While a gesture scales, stretches, or turns the selection, what it reads shows there
// instead. Its buttons set what applies to every element selected, and that becomes the style of
// what their tools draw next, unless ⌥ is held.

import { among, type Opened } from "./board.js";
import { ariaKeys, describe, type Command, type Shortcut } from "./commands.js";
import type { Colour, CropShape, Kind, Point } from "./core.js";
import type { Reading } from "./edit.js";
import { icon, type Icon } from "./icons.js";
import { css, type Paint } from "./paint.js";
import { defaultAlignment, holdsText } from "./text.js";
import {
  PALETTE,
  PAPERS,
  RECENT,
  SIZES,
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
  command?: Command;
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

/** From the window's edges, in CSS pixels. */
const MARGIN = 8;
/** From the selection, past the zones outside its corners that turn it, in CSS pixels. */
const GAP = 24;

export interface CardHost {
  current(): Opened | undefined;
  selection(): string[];
  /** Clockwise from its top-left, on the board. */
  box(): Point[] | undefined;
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
  /** Starts picking a colour from the board, until a click. */
  pick(): void;
  /** Names `button` in the hint while it is hovered or focused. */
  explain(button: HTMLElement, text: () => string): void;
  say(message: string): void;
}

/** Those that share its keys, for their hints. */
export interface CardCommands {
  colours: Command[];
  bold: Command;
  italic: Command;
  strike: Command;
  flipHorizontally: Command;
  flipVertically: Command;
  crop: Command;
  rectangularCrop: Command;
  ellipticalCrop: Command;
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
  greyscale(): void;
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

  let open = false;
  /** What the card shows, so that it only builds again once that changed, and at which zoom, as sizes go by it. */
  let shown = "";
  let filledAt: number | undefined;
  /** With whether the alignment it holds is only the one its holder takes by default. */
  let copied: { style: Style; natural: boolean } | undefined;

  /** The elements selected, and those of the groups selected, but the groups themselves. */
  const targets = (): { id: string; kind: Kind }[] => {
    const opened = host.current();
    if (!opened) {
      return [];
    }
    const { board } = opened;
    const chosen = new Set(host.selection());
    return board.draw_order
      .filter((id) => among(board, id, chosen) && board.elements[id]!.kind.type !== "group")
      .map((id) => ({ id, kind: board.elements[id]!.kind }));
  };
  /** Of the targets, those that have a style, which images and comments lack. */
  const styled = () => targets().filter(({ kind }) => settings(kind).length > 0);
  const common = (): Setting[] => {
    const all = styled();
    const [first] = all;
    return first ? settings(first.kind).filter((setting) => all.every(({ kind }) => settings(kind).includes(setting))) : [];
  };
  const images = () => {
    const all = targets();
    return all.length > 0 && all.every(({ kind }) => kind.type === "image");
  };
  const value = <S extends Setting>(setting: S): Style[S] | undefined => {
    const zoom = host.zoom() ?? 1;
    const values = styled().map(({ kind }) => valueOf(kind, setting, zoom));
    const [first] = values;
    // A size shows as one when within a pixel, as zooming leaves it a hair off.
    const same = (other: Style[Setting]) =>
      setting === "size" ? Math.abs(Number(other) - Number(first)) < 0.5 : other === first;
    return values.length > 0 && values.every(same) ? (first as Style[S]) : undefined;
  };
  const edit = (work: (editor: Opened["editor"], touched: string[]) => void) => {
    try {
      host.apply(work);
    } catch (error) {
      host.say(String(error instanceof Error ? error.message : error));
    }
  };
  /** Each element selected in `style`, or the style `each` gives it, as one edit. */
  const restyle = (style: Style, each: (kind: Kind) => Style = () => style) => {
    const zoom = host.zoom();
    const all = targets();
    if (zoom === undefined || all.length === 0) {
      return [];
    }
    edit((editor, touched) => {
      for (const { id, kind } of all) {
        const next = restyled(kind, each(kind), zoom);
        if (next !== kind) {
          touched.push(...editor.update(id, JSON.stringify(next)));
        }
      }
    });
    if (style.colour !== undefined) {
      store.pick(style.colour);
    }
    return all;
  };
  const set = (style: Style, only = false) => {
    const all = restyle(style);
    if (all.length > 0 && !only) {
      store.learn(
        all.map(({ kind }) => kind),
        style,
      );
    }
  };

  /** Named by `name`, and explained with its `shortcut`, or `hint` for keys no shortcut says. */
  const button = (
    name: string,
    content: Node,
    press: (event: MouseEvent) => void,
    { pressed, shortcut, hint }: { pressed?: boolean; shortcut?: Shortcut; hint?: string } = {},
  ) => {
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
    host.explain(made, () => explained);
    made.addEventListener("click", (event) => {
      press(event);
      // Back to the board, as the toolbar's buttons give it back, unless the keys pressed it, even
      // from the button built again in its place, which took its focus over.
      if (event.detail > 0 && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    });
    return made;
  };
  const swatch = (paint: Paint, kind: "palette" | "own" | "paper") => {
    const made = document.createElement("span");
    made.className = `swatch ${kind}`;
    made.style.setProperty("--swatch", css(paint, made));
    return made;
  };
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
  const toggle = (setting: "bold" | "italic" | "strike", label: string, name: Icon, command: Command) =>
    button(label, icon(name), (event) => set({ [setting]: value(setting) !== true }, event.altKey), {
      pressed: value(setting) === true,
      shortcut: command.keys?.[0],
    });
  const row = (label: string, ...groups: HTMLElement[][]) => {
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
  };

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
    if (can.has("size")) {
      const shown = value("size");
      const sizes = SIZES.map(({ label, name, pixels }) => {
        const letters = document.createElement("span");
        letters.className = "letters";
        letters.textContent = label;
        return button(name, letters, (event) => set({ size: pixels }, event.altKey), {
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
    if (images()) {
      const grey = targets().every(({ kind }) => kind.type === "image" && kind.edits.greyscale);
      const shaped = (shape: CropShape) =>
        targets().every(({ kind }) => kind.type === "image" && (kind.edits.crop_shape ?? "rectangle") === shape);
      const crops = commands.crop.unavailable?.() === undefined;
      rows.push(
        row(
          "Image",
          [
            button("Greyscale", icon("contrast"), () => greyscale(), { pressed: grey }),
            button("Flip horizontally", icon("flipHorizontally"), () => commands.flipHorizontally.run(), {
              shortcut: commands.flipHorizontally.keys?.[0],
            }),
            button("Flip vertically", icon("flipVertically"), () => commands.flipVertically.run(), {
              shortcut: commands.flipVertically.keys?.[0],
            }),
            ...(crops ? [button("Crop", icon("crop"), () => commands.crop.run(), { shortcut: commands.crop.keys?.[0] })] : []),
          ],
          [
            button("Rectangular crop", icon("square"), () => commands.rectangularCrop.run(), {
              pressed: shaped("rectangle"),
            }),
            button("Elliptical crop", icon("circle"), () => commands.ellipticalCrop.run(), { pressed: shaped("ellipse") }),
          ],
        ),
      );
    }
    return rows;
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
    PALETTE.forEach(({ colour, label }, at) =>
      place(
        button(label, swatch(colour, "palette"), (event) => set({ colour }, event.altKey), {
          pressed: current === colour,
          shortcut: commands.colours[at]?.keys?.[0],
        }),
        1,
        at + 1,
      ),
    );
    const own = store.picked().slice(0, RECENT);
    own.forEach((colour, at) =>
      place(
        button(colour, swatch(colour, "own"), (event) => set({ colour }, event.altKey), { pressed: current === colour }),
        2,
        at + 1,
      ),
    );
    place(separator(), 1, 7);
    const hint = "Pick a colour from the board · hold S";
    place(button("Pick a colour from the board", icon("pipette"), () => host.pick(), { hint }), 1, 8);
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
  const greyscale = () => {
    const all = targets();
    const grey = !all.every(({ kind }) => kind.type === "image" && kind.edits.greyscale);
    edit((editor, touched) => {
      for (const { id, kind } of all) {
        if (kind.type === "image") {
          touched.push(...editor.update(id, JSON.stringify({ ...kind, edits: { ...kind.edits, greyscale: grey } })));
        }
      }
    });
  };

  /** Builds it again only once what it shows changed, keeping the focus on the same button. */
  const fill = () => {
    filledAt = host.zoom();
    const rows = build();
    const signature = rows.map((made) => made.outerHTML).join("");
    if (signature === shown) {
      return;
    }
    const focused = panel.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : null;
    // Gone without the pointer leaving them, they would leave their hint behind.
    panel.querySelectorAll("button, .custom").forEach((old) => old.dispatchEvent(new PointerEvent("pointerleave")));
    shown = signature;
    panel.replaceChildren(...rows.flatMap((made, at) => (at > 0 ? [rule(), made] : [made])));
    if (focused) {
      const again = [...panel.querySelectorAll<HTMLElement>("[aria-label]")];
      again.find((element) => element.getAttribute("aria-label") === focused)?.focus();
    }
  };
  const visible = () => targets().length > 0 && (common().length > 0 || images()) && !host.busy();
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
  /** Under the selection, or above it where the toolbar leaves no room under it. */
  const place = (shown: HTMLElement) => {
    const corners = host.box()?.map((corner) => host.client(corner));
    if (!corners || corners.some((corner) => corner === undefined)) {
      return;
    }
    const xs = corners.map((corner) => corner!.clientX);
    const ys = corners.map((corner) => corner!.clientY);
    const { width, height } = shown.getBoundingClientRect();
    const floor = Math.min(innerHeight, host.floor());
    const left = clamp((Math.min(...xs) + Math.max(...xs)) / 2 - width / 2, MARGIN, innerWidth - width - MARGIN);
    const below = Math.max(...ys) + GAP;
    const top = below + height <= floor - MARGIN ? below : Math.min(...ys) - GAP - height;
    shown.style.setProperty("left", `${left}px`);
    shown.style.setProperty("top", `${clamp(top, MARGIN, floor - height - MARGIN)}px`);
  };

  return {
    frame() {
      if (!panel.hidden && host.zoom() !== filledAt) {
        fill();
      }
      const shown = [readout, chip, panel].find((element) => !element.hidden);
      if (shown) {
        place(shown);
      }
    },
    refresh() {
      if (!host.busy() && targets().length === 0) {
        open = false;
      }
      show();
    },
    isOpen: () => open && !panel.hidden,
    open(focus) {
      open = true;
      show(focus);
    },
    close() {
      const had = panel.contains(document.activeElement);
      open = false;
      show();
      if (had) {
        chip.focus();
      }
    },
    common,
    value,
    set,
    resize(larger) {
      const zoom = host.zoom();
      const all = targets().filter(({ kind }) => settings(kind).includes("size"));
      if (zoom === undefined || all.length === 0) {
        return;
      }
      const sizes = all.map(({ kind }) => stepped(Number(valueOf(kind, "size", zoom)), larger));
      edit((editor, touched) => {
        all.forEach(({ id, kind }, at) => {
          touched.push(...editor.update(id, JSON.stringify(restyled(kind, { size: sizes[at] }, zoom))));
        });
      });
      store.learn(
        all.map(({ kind }) => kind),
        { size: sizes[0] },
      );
    },
    images,
    greyscale,
    copy() {
      const [first] = styled();
      const zoom = host.zoom();
      if (first && zoom !== undefined && settings(first.kind).length > 0) {
        const { kind } = first;
        const style = styleOf(kind, zoom);
        copied = { style, natural: style.align !== undefined && holdsText(kind) && kind.text.align === undefined };
      }
    },
    paste() {
      if (copied) {
        const { style, natural } = copied;
        // Each takes the alignment its own holder chooses, as a note's is not a shape's.
        restyle(style, (kind) => (natural && holdsText(kind) ? { ...style, align: defaultAlignment(kind) } : style));
      }
    },
    canPaste: () => copied !== undefined,
  };
}

function separator(): HTMLElement {
  const line = document.createElement("span");
  line.className = "separator";
  line.setAttribute("role", "separator");
  line.setAttribute("aria-orientation", "vertical");
  return line;
}

function rule(): HTMLElement {
  const line = document.createElement("div");
  line.className = "rule";
  line.setAttribute("role", "separator");
  return line;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}
