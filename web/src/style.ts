// The style of what is drawn, which the style card, the keys, and the context menu change alike.
// What a change sets for the selection becomes the style of what the same tool draws next too, as
// the browser remembers it.

import * as core from "./core.js";
import type { Align, Colour, Dash, Fill, Heads, Kind, Paper, Weight } from "./core.js";
import type { Draw } from "./edit.js";
import { recall, remember } from "./preferences.js";
import { fitted, holdsText, isBlank } from "./text.js";

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

/** In percent, the steps the card marks on its opacity, and snaps to. */
export const OPACITIES = [25, 50, 75, 100];

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
  /** In percent. */
  opacity?: number;
}

export type Setting = keyof Style;

export const TEXT: Setting[] = ["size", "bold", "italic", "strike", "align"];

/** As the core takes them, but for the text of a blank shape, which fitting to its text would grow. */
export function settings(kind: Kind): Setting[] {
  const taken = core.settings(kind).map((setting) => (setting === "font_size" ? "size" : setting));
  return kind.type === "shape" && isBlank(kind)
    ? taken.filter((setting) => !TEXT.includes(setting))
    : taken;
}

/**
 * As `kind` is drawn, at `zoom` CSS pixels per board unit for its size, `undefined` where it takes
 * no such part.
 */
export function valueOf(kind: Kind, setting: Setting, zoom: number): Style[Setting] {
  const plain = core.plain(kind);
  const text = holdsText(kind) ? kind.text : undefined;
  switch (setting) {
    case "colour":
      return drawn(plain.colour, "colour" in kind ? kind.colour : undefined);
    case "paper":
      return drawn(plain.paper, "paper" in kind ? kind.paper : undefined);
    case "weight":
      return drawn(plain.weight, "weight" in kind ? kind.weight : undefined);
    case "dash":
      return drawn(plain.dash, "dash" in kind ? kind.dash : undefined);
    case "heads":
      return drawn(plain.heads, "heads" in kind ? kind.heads : undefined);
    case "fill":
      return drawn(plain.fill, "fill" in kind ? kind.fill : undefined);
    case "opacity":
      return drawn(plain.opacity, "opacity" in kind ? kind.opacity : undefined);
    case "size":
      return text && text.font_size * zoom;
    case "bold":
    case "italic":
    case "strike":
    case "align":
      return drawn(plain[setting], text?.[setting]);
  }
}

/** How much of it shows, from 0 to 1. */
export function opacityOf(kind: Kind): number {
  return Number(valueOf(kind, "opacity", 1) ?? 100) / 100;
}

/** None where the plain style leaves the part out, which the element then takes none of. */
function drawn<T>(plain: T | undefined, own: T | undefined): T | undefined {
  return plain === undefined ? undefined : (own ?? plain);
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
  const next = core.withStyle(kind, inBoard(set, zoom));
  return holdsText(next) && TEXT.some((setting) => setting in set) ? fitted(next) : next;
}

/** As the core takes it, at `zoom` CSS pixels per board unit for its size. */
function inBoard({ size, ...style }: Style, zoom: number): core.Style {
  return size === undefined ? style : { ...style, font_size: size / zoom };
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
      // A shape is drawn blank, which takes no text style yet, though what is written in it then will.
      return kind.type === "shape" && isBlank(kind)
        ? core.withStyle(kind, inBoard(style, zoom))
        : restyled(kind, style, zoom);
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
      const style = valid(stored?.[tool]);
      return style ? [[tool, style]] : [];
    }),
  );
}

function recalledColours(): Colour[] {
  const stored = parsed(recall(PICKED));
  return Array.isArray(stored)
    ? stored
        .flatMap((colour) => core.colour(colour) ?? [])
        .filter((colour) => colour.startsWith("#"))
        .slice(0, RECENT)
    : [];
}

/** A size on screen, and parts of a style as the core spells them, but none in board units. */
function valid(stored: unknown): Style | undefined {
  if (typeof stored !== "object" || stored === null || "font_size" in stored) {
    return undefined;
  }
  const { size, ...parts } = stored as Record<string, unknown>;
  const style = core.checked(parts);
  if (size === undefined || style === undefined) {
    return style;
  }
  return typeof size === "number" && size > 0 && Number.isFinite(size)
    ? { ...style, size }
    : undefined;
}

function parsed(text: string | null): unknown {
  try {
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
