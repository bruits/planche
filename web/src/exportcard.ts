// A card that exports or copies the selection as a PNG, which opens in the style card's place,
// while the board shows what the picture covers, shaded around it, with its size over it. It
// follows the selection as it changes, until Esc, a press on nothing, or a save closes it, and
// hides while a gesture or some writing is under way. Its choices last from one picture to the next.

import { beneath, cardButton, clamp, letters, row, rule, type CardHost } from "./card.js";
import { composing, describe, typed, typing, type Shortcut } from "./commands.js";
import { finderOpen } from "./finder.js";
import { icon } from "./icons.js";
import { menuOpen } from "./menu.js";
import { rectangle } from "./overlay.js";
import type { Backing, Options, Plan } from "./render.js";

/** The longest sides it offers besides all its images show, in pixels. */
export const SIDES = [4096, 2048, 1024];

const BACKINGS: { value: Backing; label: string; hint: string }[] = [
  { value: "board", label: "Board", hint: "On the board's colour" },
  { value: "white", label: "White", hint: "On white, in the light theme's colours" },
  { value: "transparent", label: "Transparent", hint: "On nothing" },
];

/** Between the picture's edge and its size, in CSS pixels. */
const READOUT_GAP = 8;

const REMEMBERED = {
  size: "planche.picture.size",
  background: "planche.picture.background",
  margin: "planche.picture.margin",
};

export function recalled(read: (key: string) => string | null): Options {
  const longest = Number(read(REMEMBERED.size));
  const background = BACKINGS.find(({ value }) => value === read(REMEMBERED.background));
  return {
    longest: SIDES.includes(longest) ? longest : undefined,
    background: background?.value ?? "board",
    margin: read(REMEMBERED.margin) === "on",
  };
}

/** Each key with what to remember there, `undefined` for a default, which nothing needs to hold. */
export function remembered({
  longest,
  background,
  margin,
}: Options): [string, string | undefined][] {
  return [
    [REMEMBERED.size, longest === undefined ? undefined : String(longest)],
    [REMEMBERED.background, background === "board" ? undefined : background],
    [REMEMBERED.margin, margin ? "on" : undefined],
  ];
}

export interface ExportHost extends Pick<CardHost, "client" | "busy" | "floor" | "explain"> {
  /** What a picture of the selection covers with `options`, `undefined` when it draws nothing. */
  planned(options: Options): Plan | undefined;
  /** Once what it frames changed as it opened, closed, or changed its options. */
  changed(): void;
  /** Once its options changed, which it keeps. */
  chose(options: Options): void;
  save(options: Options): void;
  copy(options: Options): void;
}

export interface ExportCard {
  /** Over the picture as the camera now shows it. */
  frame(): void;
  /** Once the selection, or what it holds, changed, which closes it once nothing draws. */
  refresh(): void;
  isOpen(): boolean;
  /** Save takes the focus when `focus`. Opens nothing while nothing would draw. */
  open(focus: boolean): void;
  close(): void;
  options(): Options;
  /** What its picture covers while it is open. */
  plan(): Plan | undefined;
}

export function exportCard(
  host: ExportHost,
  chosen: Options,
  keys: { save: Shortcut; copy: Shortcut },
): ExportCard {
  const panel = document.createElement("div");
  panel.className = "style-card export-card";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Export");
  panel.hidden = true;
  const readout = document.createElement("div");
  readout.className = "readout";
  readout.hidden = true;
  document.body.append(panel, readout);

  let options = chosen;
  let open = false;
  let plan: Plan | undefined;

  const button = (name: string, content: Node, press: () => void, hint?: string) =>
    cardButton(panel, host.explain, name, content, press, hint === undefined ? {} : { hint });
  const choose = (next: Partial<Options>) => {
    options = { ...options, ...next };
    host.chose(options);
    plan = host.planned(options);
    show();
    host.changed();
  };
  const sizes = [
    button(
      "Full size",
      letters("Full"),
      () => choose({ longest: undefined }),
      "As sharp as its sharpest image",
    ),
    ...SIDES.map((side) =>
      button(
        `${side} pixels`,
        letters(String(side)),
        () => choose({ longest: side }),
        `${side} pixels along its longest side`,
      ),
    ),
  ];
  const backings = BACKINGS.map(({ value, label, hint }) =>
    button(label, labelled(swatch(value), label), () => choose({ background: value }), hint),
  );
  const margin = button(
    "Margin",
    labelled(icon("margin"), "Margin"),
    () => choose({ margin: !options.margin }),
    "Room around it",
  );
  const facts = document.createElement("p");
  facts.className = "facts";
  const copy = cardButton(
    panel,
    host.explain,
    "Copy as PNG",
    keyed("Copy", keys.copy),
    () => host.copy(options),
    {
      shortcut: keys.copy,
    },
  );
  const save = cardButton(
    panel,
    host.explain,
    "Save as PNG…",
    keyed("Save…", keys.save),
    () => host.save(options),
    {
      shortcut: keys.save,
    },
  );
  save.classList.add("primary");
  const actions = row("Export", [copy, save]);
  actions.classList.add("actions");
  panel.append(
    row("Size", sizes),
    rule(),
    row("Background", backings),
    rule(),
    row("Margin", [margin, facts]),
    rule(),
    actions,
  );

  // Before the page's own copy, which would copy the elements instead.
  addEventListener(
    "keydown",
    (event) => {
      if (
        !open ||
        event.defaultPrevented ||
        composing(event) ||
        typing(event.target) ||
        menuOpen() ||
        finderOpen() ||
        host.busy() ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        typed(event) !== keys.copy.key
      ) {
        return;
      }
      event.preventDefault();
      // Once while held, as each copy renders the picture anew.
      if (!event.repeat) {
        host.copy(options);
      }
    },
    true,
  );

  const show = () => {
    sizes.forEach((made, at) =>
      made.setAttribute(
        "aria-pressed",
        String(options.longest === (at === 0 ? undefined : SIDES[at - 1])),
      ),
    );
    backings.forEach((made, at) =>
      made.setAttribute("aria-pressed", String(options.background === BACKINGS[at]!.value)),
    );
    margin.setAttribute("aria-pressed", String(options.margin));
    const size = plan && `${plan.size.width} × ${plan.size.height}`;
    facts.textContent = size ?? "";
    facts.title = plan
      ? `${plan.size.width} by ${plan.size.height} pixels${plan.capped ? ", scaled down to fit" : ""}`
      : "";
    readout.textContent = size ?? "";
    const shown = open && plan !== undefined && !host.busy();
    panel.hidden = !shown;
    readout.hidden = !shown;
    if (shown) {
      place();
    }
  };
  /** Under the picture, with its size on the other side. */
  const place = () => {
    const corners = plan && rectangle(plan.area).map((corner) => host.client(corner));
    if (!corners?.every((corner) => corner !== undefined)) {
      return;
    }
    const { under, centre, top: high, bottom: low } = beneath(panel, corners, host.floor());
    const size = readout.getBoundingClientRect();
    const left = centre - size.width / 2;
    const top = under ? high - READOUT_GAP - size.height : low + READOUT_GAP;
    const floor = Math.min(innerHeight, host.floor());
    readout.style.setProperty(
      "left",
      `${clamp(left, READOUT_GAP, innerWidth - size.width - READOUT_GAP)}px`,
    );
    readout.style.setProperty(
      "top",
      `${clamp(top, READOUT_GAP, floor - size.height - READOUT_GAP)}px`,
    );
  };
  const close = () => {
    if (!open) {
      return;
    }
    const had = panel.contains(document.activeElement);
    open = false;
    plan = undefined;
    show();
    host.changed();
    // Back to the board, which takes the keys again.
    if (had && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  return {
    frame() {
      if (!panel.hidden) {
        place();
      }
    },
    refresh() {
      if (!open) {
        return;
      }
      plan = host.planned(options);
      if (plan === undefined && !host.busy()) {
        close();
        return;
      }
      show();
    },
    isOpen: () => open,
    open(focus) {
      plan = host.planned(options);
      if (plan === undefined) {
        return;
      }
      open = true;
      show();
      host.changed();
      if (focus) {
        save.focus();
      }
    },
    close,
    options: () => options,
    plan: () => plan,
  };
}

function labelled(content: Node, text: string): HTMLSpanElement {
  const made = letters(text);
  made.prepend(content);
  return made;
}

function keyed(text: string, shortcut: Shortcut): HTMLSpanElement {
  const made = letters(text);
  const key = document.createElement("kbd");
  key.textContent = describe(shortcut);
  made.append(key);
  return made;
}

function swatch(backing: Backing): HTMLSpanElement {
  const made = document.createElement("span");
  made.className = `swatch ${backing}`;
  return made;
}
