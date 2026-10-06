// A chip under the selection, which opens a card of its style in its place, as the keys do. Once
// open, it follows the selection from one element to the next, until Esc or a press on nothing
// closes it. While a gesture scales, stretches, or turns the selection, what it reads shows there
// instead. Its buttons set what applies to every element selected, and that becomes the style of
// what their tools draw next, unless ⌥ is held. A lone image shows what it is, and its caption and
// source to write in.

import {
  among,
  loneImage,
  MOST_LABEL,
  setLabel,
  webAddress,
  type Image,
  type Opened,
} from "./board.js";
import {
  ariaKeys,
  composing,
  describe,
  opensMenu,
  type Command,
  type Shortcut,
} from "./commands.js";
import type { Colour, CropShape, Kind, Point } from "./core.js";
import type { Reading } from "./edit.js";
import { message } from "./errors.js";
import { icon, type Icon } from "./icons.js";
import { css, type Paint } from "./paint.js";
import { unitsPerPixel } from "./vector.js";
import { defaultAlignment, holdsText } from "./text.js";
import {
  OPACITIES,
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
  openSource: Command;
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
  panel.addEventListener("focusout", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.closest(".info")) {
      // Once the focus has landed where it goes, which a task waits for and a microtask does not,
      // as what the field held back may build the card again.
      setTimeout(() => {
        if (!panel.hidden) {
          fill();
        }
      });
    }
  });
  // Written before a press elsewhere starts a gesture, which the edit would cut across.
  addEventListener(
    "pointerdown",
    (event) => {
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement &&
        panel.contains(active) &&
        !(event.target instanceof Node && panel.contains(event.target))
      ) {
        active.blur();
      }
    },
    true,
  );

  let open = false;
  /** What the card shows, so that it only builds again once that changed, and at which zoom, as sizes go by it. */
  let built = "";
  let filledAt: number | undefined;
  /** While a field's text is saved, as the focus moves on, under which the card must not build again. */
  let saving = false;
  /** With whether the alignment it holds is only the one its holder takes by default. */
  let copied: { style: Style; natural: boolean } | undefined;

  /**
   * The elements selected, and those of the groups selected, but the groups themselves, or else
   * what the tool draws, which no element holds yet.
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
    const { board } = opened;
    const chosen = new Set(host.selection());
    return board.draw_order
      .filter((id) => among(board, id, chosen) && board.elements[id]!.kind.type !== "group")
      .map((id) => ({ id, kind: board.elements[id]!.kind }));
  };
  const alone = () => loneImage(host.current()?.board, host.selection());
  /** Of the targets, those that have a style, which comments lack. */
  const styled = () => targets().filter(({ kind }) => settings(kind).length > 0);
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

  /** Named by `name`, and explained with its `shortcut`, or `hint` for keys no shortcut says. */
  const button = (
    name: string,
    content: Node,
    press: (event: MouseEvent) => void,
    {
      pressed,
      shortcut,
      hint,
    }: { pressed?: boolean; shortcut?: Shortcut | undefined; hint?: string } = {},
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
    // As the title stands then, which an Open button's address changes in place.
    host.explain(made, () => made.title);
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
  const opacity = () => {
    const shown = value("opacity");
    const paper = value("paper");
    const made = document.createElement("div");
    made.className = "slider";
    made.classList.toggle("mixed", shown === undefined);
    const tint = value("colour") ?? (paper ? `paper-${paper}` : "ink");
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
    const lone = alone();
    if (lone) {
      rows.push(info(lone.id, lone.image));
    }
    return rows;
  };
  const info = (id: string, image: Image) => {
    const made = document.createElement("div");
    made.className = "info";
    made.setAttribute("role", "group");
    made.setAttribute("aria-label", "Info");
    // So that another image builds the card again, whose fields are its own.
    made.dataset.element = id;
    const { width, height } = image.natural_size;
    const shown = Math.round(unitsPerPixel(image) * 100);
    const facts = document.createElement("p");
    facts.className = "facts";
    facts.textContent = [image.filename, `${width} × ${height}`, `${shown}%`]
      .filter(Boolean)
      .join(" · ");
    facts.title = `${width} by ${height} pixels, laid out at ${shown}% of their size`;
    const source = field(id, "source", "Source");
    const opener = button("Open source", icon("external"), () => commands.openSource.run(), {
      shortcut: commands.openSource.keys?.[0],
    });
    opener.classList.add("opens");
    source.append(opener);
    made.append(facts, field(id, "caption", "Caption"), source);
    return made;
  };
  /** Its text is set in place, which leaves a field being written in, or pressed out of, alone. */
  const field = (id: string, name: "caption" | "source", placeholder: string) => {
    const line = document.createElement("div");
    line.className = "field";
    const input = document.createElement("input");
    input.type = "text";
    input.name = name;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", placeholder);
    input.maxLength = MOST_LABEL;
    const written = () => {
      const kind = host.current()?.board.elements[id]?.kind;
      return kind?.type === "image" ? (kind[name] ?? "") : "";
    };
    input.addEventListener("keydown", (event) => {
      if (composing(event)) {
        return;
      }
      if (event.key === "Escape") {
        input.value = written();
      }
      if (event.key === "Enter" || event.key === "Escape") {
        input.blur();
      }
    });
    input.addEventListener("change", () => {
      const kind = host.current()?.board.elements[id]?.kind;
      if (kind?.type !== "image" || input.value === written()) {
        return;
      }
      const next = { ...kind };
      setLabel(next, name, input.value);
      saving = true;
      try {
        edit((editor, touched) => touched.push(...editor.update(id, JSON.stringify(next))));
      } finally {
        saving = false;
      }
    });
    line.append(input);
    return line;
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
    // Not under a field being written in, which would lose what it holds, until it is left.
    const active = document.activeElement;
    const writing = active instanceof HTMLInputElement && panel.contains(active.closest(".info"));
    if (signature !== built && !writing && !saving && !host.adjusting()) {
      rebuild(rows, signature);
    }
    sync();
  };
  const rebuild = (rows: HTMLElement[], signature: string) => {
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const label = focused?.getAttribute("aria-label");
    const holder = focused?.closest<HTMLElement>(".info")?.dataset.element;
    // Gone without the pointer leaving them, they would leave their hint behind.
    panel
      .querySelectorAll("button, .custom, input[type=range]")
      .forEach((old) => old.dispatchEvent(new PointerEvent("pointerleave")));
    built = signature;
    panel.replaceChildren(...rows.flatMap((made, at) => (at > 0 ? [rule(), made] : [made])));
    sync();
    const again = [...panel.querySelectorAll<HTMLElement>("[aria-label]")].find(
      (element) => element.getAttribute("aria-label") === label,
    );
    // Not into another image's field, which would take what was being written for this one.
    if (label && again?.closest<HTMLElement>(".info")?.dataset.element === holder) {
      again?.focus();
    }
  };
  /** The lone image's fields and its Open button, as the board now has them. */
  const sync = () => {
    // The image its fields are for, which a field written in holds while the selection moves on.
    const id = panel.querySelector<HTMLElement>(".info")?.dataset.element;
    const kind = id === undefined ? undefined : host.current()?.board.elements[id]?.kind;
    const image = kind?.type === "image" ? kind : undefined;
    panel.querySelectorAll<HTMLInputElement>(".info input").forEach((input) => {
      if (input !== document.activeElement && image) {
        input.value = image[input.name as "caption" | "source"] ?? "";
      }
    });
    const opener = panel.querySelector<HTMLButtonElement>(".info .opens");
    const address = webAddress(image?.source);
    if (opener) {
      opener.hidden = address === undefined;
      const shortcut = commands.openSource.keys?.[0];
      const name = address ? `Open ${new URL(address).host}` : "Open source";
      opener.setAttribute("aria-label", name);
      opener.title = shortcut ? `${name} · ${describe(shortcut)}` : name;
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
  /**
   * Under the selection, or above it where the toolbar leaves no room under it, or above the
   * toolbar for the tool's style.
   */
  const place = (shown: HTMLElement) => {
    const { width, height } = shown.getBoundingClientRect();
    const floor = Math.min(innerHeight, host.floor());
    if (host.tool() !== undefined) {
      const left = clamp(innerWidth / 2 - width / 2, MARGIN, innerWidth - width - MARGIN);
      shown.style.setProperty("left", `${left}px`);
      shown.style.setProperty("top", `${Math.max(MARGIN, floor - height - MARGIN)}px`);
      return;
    }
    const corners = host.box()?.map((corner) => host.client(corner));
    if (!corners || corners.some((corner) => corner === undefined)) {
      return;
    }
    const xs = corners.map((corner) => corner!.clientX);
    const ys = corners.map((corner) => corner!.clientY);
    const left = clamp(
      (Math.min(...xs) + Math.max(...xs)) / 2 - width / 2,
      MARGIN,
      innerWidth - width - MARGIN,
    );
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

function letters(text: string): HTMLSpanElement {
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

function row(label: string, ...groups: HTMLElement[][]): HTMLDivElement {
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

function rule(): HTMLElement {
  const line = document.createElement("div");
  line.className = "rule";
  line.setAttribute("role", "separator");
  return line;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}
