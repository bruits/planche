// The style of what is drawn, which the style card, the keys, and the context menu change alike.
// What a change sets for the selection becomes the style of what the same tool draws next too, as
// the browser remembers it.

import type { Align, Colour, Dash, Fill, Heads, Kind, Paper, Weight } from "./core.js";
import type { Draw } from "./edit.js";
import { recall, remember } from "./preferences.js";
import { alignment, defaultAlignment, fitted, holdsText, isBlank, type Holder } from "./text.js";

/** Where the browser remembers each tool's style, and the colours picked lately. */
const STYLES = "planche.styles";
const PICKED = "planche.picked";
/** How many colours picked lately it keeps, one row of the card. */
export const RECENT = 6;

/** In the order of the keys that set them. */
export const PALETTE: { colour: Colour; label: string }[] = [
  { colour: "ink", label: "Ink" },
  { colour: "red", label: "Red" },
  { colour: "orange", label: "Orange" },
  { colour: "green", label: "Green" },
  { colour: "blue", label: "Blue" },
  { colour: "violet", label: "Violet" },
];

export const PAPERS: { paper: Paper; label: string }[] = [
  { paper: "yellow", label: "Yellow paper" },
  { paper: "pink", label: "Pink paper" },
  { paper: "blue", label: "Blue paper" },
  { paper: "green", label: "Green paper" },
  { paper: "lilac", label: "Lilac paper" },
];

/** On screen at the zoom they are set at, in CSS pixels, as text is drawn at one size on screen whatever the zoom. */
export const SIZES: { label: string; name: string; pixels: number }[] = [
  { label: "S", name: "Small text", pixels: 16 },
  { label: "M", name: "Medium text", pixels: 20 },
  { label: "L", name: "Large text", pixels: 28 },
  { label: "XL", name: "Extra large text", pixels: 40 },
];

/** What a change sets, each where it applies. */
export interface Style {
  colour?: Colour;
  paper?: Paper;
  weight?: Weight;
  dash?: Dash;
  heads?: Heads;
  fill?: Fill;
  /** On screen, in CSS pixels, at the zoom it is set at. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  align?: Align;
}

export type Setting = keyof Style;

export const TEXT: Setting[] = ["size", "bold", "italic", "strike", "align"];

export function settings(kind: Kind): Setting[] {
  switch (kind.type) {
    case "note":
      return ["colour", ...TEXT];
    case "sticky":
      return ["paper", ...TEXT];
    case "shape": {
      // Fitting a blank shape to its text would grow it.
      const text = isBlank(kind) ? [] : TEXT;
      return kind.shape === "cross"
        ? ["colour", "weight", "dash", ...text]
        : ["colour", "weight", "dash", "fill", ...text];
    }
    case "arrow":
      return ["colour", "weight", "dash", "heads"];
    case "line":
      return ["colour", "weight", "dash"];
    default:
      return [];
  }
}

/** As `kind` is drawn, at `zoom` CSS pixels per board unit for its size. */
export function valueOf(kind: Kind, setting: Setting, zoom: number): Style[Setting] {
  const text = holdsText(kind) ? kind.text : undefined;
  switch (setting) {
    // Left out when as they come, as the core writes them.
    case "colour":
      return kind.type === "note" || stroked(kind) ? (kind.colour ?? "ink") : undefined;
    case "paper":
      return kind.type === "sticky" ? (kind.paper ?? "yellow") : undefined;
    case "weight":
      return stroked(kind) ? (kind.weight ?? "medium") : undefined;
    case "dash":
      return stroked(kind) ? (kind.dash ?? "solid") : undefined;
    case "heads":
      return kind.type === "arrow" ? (kind.heads ?? "end") : undefined;
    case "fill":
      return kind.type === "shape" ? (kind.fill ?? "hollow") : undefined;
    case "size":
      return text && text.font_size * zoom;
    case "bold":
    case "italic":
    case "strike":
      return text && (text[setting] ?? false);
    case "align":
      return holdsText(kind) ? alignment(kind) : undefined;
  }
}

function stroked(kind: Kind): kind is Extract<Kind, { type: "shape" | "arrow" | "line" }> {
  return kind.type === "shape" || kind.type === "arrow" || kind.type === "line";
}

/**
 * With `style` set where it applies, at `zoom` CSS pixels per board unit for its size, and its
 * frame grown to fit its text when that changed.
 */
export function restyled(kind: Kind, style: Style, zoom: number): Kind {
  const allowed = settings(kind);
  const set = Object.fromEntries(
    Object.entries(style).filter(
      ([setting, value]) => value !== undefined && allowed.includes(setting as Setting),
    ),
  ) as Style;
  if (Object.keys(set).length === 0) {
    return kind;
  }
  const { size, bold, italic, strike, align, ...rest } = set;
  const next = { ...kind, ...rest } as Kind;
  if (!holdsText(next) || !TEXT.some((setting) => setting in set)) {
    return next;
  }
  return fitted(textStyled(next, set, zoom));
}

/** With the text part of `style` set, at `zoom` CSS pixels per board unit for its size. */
function textStyled<T extends Holder>(
  kind: T,
  { size, bold, italic, strike, align }: Style,
  zoom: number,
): T {
  const text = { ...kind.text, ...defined({ bold, italic, strike, align }) };
  // Left out where it is as what holds it would choose, so that choosing it writes nothing.
  if (text.align === defaultAlignment(kind)) {
    delete text.align;
  }
  if (size !== undefined) {
    text.font_size = size / zoom;
  }
  return { ...kind, text };
}

/** The style `kind` has, of what applies to it, as copying it takes it. */
export function styleOf(kind: Kind, zoom: number): Style {
  return Object.fromEntries(
    settings(kind).map((setting) => [setting, valueOf(kind, setting, zoom)]),
  );
}

/** Of the next size up or down from `pixels` on screen, past the sizes when out of them. */
export function stepped(pixels: number, larger: boolean): number {
  const step = 1.25;
  if (larger) {
    return SIZES.find(({ pixels: size }) => size > pixels * 1.01)?.pixels ?? pixels * step;
  }
  return SIZES.findLast(({ pixels: size }) => size < pixels * 0.99)?.pixels ?? pixels / step;
}

export function toolOf(kind: Kind): Draw | undefined {
  switch (kind.type) {
    case "shape":
      return kind.shape;
    case "arrow":
    case "line":
    case "note":
    case "sticky":
      return kind.type;
    default:
      return undefined;
  }
}

export interface Styles {
  /** `kind` as its tool draws it now, at `zoom` CSS pixels per board unit for its size. */
  dressed(kind: Kind, zoom: number): Kind;
  /** From now on, what draws `kinds` draws in `style` too, where it applies. */
  learn(kinds: Kind[], style: Style): void;
  /** Lately first. */
  picked(): Colour[];
  /** Keeps `colour` among those picked lately, unless of the palette. */
  pick(colour: Colour): void;
}

export function styles(): Styles {
  const byTool = recalled();
  let lately = recalledColours();
  return {
    dressed(kind, zoom) {
      const tool = toolOf(kind);
      const style = tool && byTool[tool];
      if (!style) {
        return kind;
      }
      const dressed = restyled(kind, style, zoom);
      // A shape is drawn blank, which takes no text style yet, though what is written in it then will.
      if (dressed.type === "shape" && isBlank(dressed)) {
        return textStyled(dressed, style, zoom);
      }
      return dressed;
    },
    learn(kinds, style) {
      for (const kind of kinds) {
        const tool = toolOf(kind);
        if (tool !== undefined) {
          const applying = settings(kind).filter((setting) => style[setting] !== undefined);
          byTool[tool] = {
            ...byTool[tool],
            ...Object.fromEntries(applying.map((setting) => [setting, style[setting]])),
          };
        }
      }
      remember(STYLES, JSON.stringify(byTool));
    },
    picked: () => lately,
    pick(colour) {
      if (!colour.startsWith("#")) {
        return;
      }
      lately = [colour, ...lately.filter((other) => other !== colour)].slice(0, RECENT);
      remember(PICKED, JSON.stringify(lately));
    },
  };
}

/** What the browser remembers, but anything the core would refuse, as storage may hold anything. */
function recalled(): Partial<Record<Draw, Style>> {
  const tools: Draw[] = ["arrow", "line", "rectangle", "ellipse", "cross", "note", "sticky"];
  const stored = parsed(recall(STYLES)) as Partial<Record<Draw, unknown>> | undefined;
  return Object.fromEntries(
    tools.flatMap((tool) => {
      const style = stored?.[tool];
      return style && typeof style === "object"
        ? [[tool, valid(style as Record<string, unknown>)]]
        : [];
    }),
  );
}

function recalledColours(): Colour[] {
  const stored = parsed(recall(PICKED));
  return Array.isArray(stored)
    ? stored
        .filter(isColour)
        .filter((colour) => colour.startsWith("#"))
        .slice(0, RECENT)
    : [];
}

function valid(style: Record<string, unknown>): Style {
  const { colour, paper, weight, dash, heads, fill, size, bold, italic, strike, align } = style;
  return defined({
    colour: isColour(colour) ? colour : undefined,
    paper: oneOf(
      paper,
      PAPERS.map((choice) => choice.paper),
    ),
    weight: oneOf(weight, ["thin", "medium", "thick"]),
    dash: oneOf(dash, ["solid", "dashed"]),
    heads: oneOf(heads, ["end", "both"]),
    fill: oneOf(fill, ["hollow", "tint", "solid"]),
    size: typeof size === "number" && size > 0 && Number.isFinite(size) ? size : undefined,
    bold: flag(bold),
    italic: flag(italic),
    strike: flag(strike),
    align: oneOf(align, ["left", "centre", "right"]),
  });
}

function oneOf<T extends string>(value: unknown, options: T[]): T | undefined {
  return options.includes(value as T) ? (value as T) : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isColour(value: unknown): value is Colour {
  return (
    typeof value === "string" &&
    (PALETTE.some(({ colour }) => colour === value) || /^#[0-9a-f]{6}$/.test(value))
  );
}

function parsed(text: string | null): unknown {
  try {
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function defined<T extends object>(values: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
