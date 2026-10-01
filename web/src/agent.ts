// What agents read of the open board, as the desktop shell passes their tools' calls on. The
// board is read as it stands, since a call is answered between two events.

import type { Opened } from "./board.js";
import * as core from "./core.js";
import type { Element, Kind, Rect } from "./core.js";
import type { AgentCall } from "./platform.js";

/** The page's state that agents read. */
export interface Reading {
  opened(): Opened | undefined;
  unsaved(): boolean;
  selection(): string[];
  entered(): string | undefined;
  writing(): string | undefined;
  /** The part of the board the window shows, `undefined` when nothing is shown. */
  shown(): Rect | undefined;
}

/** Longer texts are cut in the outline, and read whole by id. */
const MOST_TEXT = 280;

/** Throws what the agent reads when there is no answer. */
export function answer({ tool, args }: AgentCall, reading: Reading): unknown {
  const opened = reading.opened();
  if (opened === undefined) {
    throw new Error("No board is open in Planche yet");
  }
  const board = { name: opened.folder.name, unsaved: reading.unsaved() };
  const given = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "board":
      return { board, view: reading.shown() ?? null, ...outline(opened, given) };
    case "elements":
      return { board, elements: elements(opened, given.ids) };
    case "selection":
      return {
        board,
        selected: reading.selection(),
        entered: reading.entered() ?? null,
        writing: reading.writing() ?? null,
      };
    default:
      throw new Error(`Planche has no tool called ${tool}`);
  }
}

function outline(opened: Opened, { offset, limit, area }: Record<string, unknown>) {
  const ids = area == null ? opened.board.draw_order : within(opened, area as Rect);
  const from = typeof offset === "number" ? offset : 0;
  // The shell bounds it.
  const count = typeof limit === "number" ? limit : ids.length;
  const next = from + count < ids.length ? from + count : null;
  const page = ids.slice(from, from + count);
  return { total: ids.length, offset: from, next, elements: page.map((id) => entry(opened, id)) };
}

function within(opened: Opened, { x, y, width, height }: Rect): string[] {
  const touching = new Set(opened.editor.touching(x, y, width, height));
  return opened.board.draw_order.filter((id) => {
    const { kind } = opened.board.elements[id]!;
    if (kind.type !== "comment") {
      return touching.has(id);
    }
    const { at } = kind;
    return x <= at.x && at.x <= x + width && y <= at.y && at.y <= y + height;
  });
}

function entry(opened: Opened, id: string) {
  const { group, kind } = opened.board.elements[id]!;
  return {
    id,
    type: kind.type,
    group,
    // A comment covers nothing, so it is where it is pinned.
    bounds: kind.type === "comment" ? { ...kind.at, width: 0, height: 0 } : core.bounds(opened.editor, [id]),
    rotation: "rotation" in kind ? kind.rotation : undefined,
    text: cut(text(kind)),
    targets: targets(kind),
    image:
      kind.type === "image"
        ? { filename: kind.filename, source: kind.source, caption: kind.caption, natural_size: kind.natural_size }
        : undefined,
  };
}

function text(kind: Kind): string | undefined {
  if (kind.type === "comment") {
    return kind.text;
  }
  return "text" in kind ? kind.text.content : undefined;
}

function cut(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= MOST_TEXT) {
    return text;
  }
  // Never between the halves of a character, which the shell could not read back.
  const last = text.charCodeAt(MOST_TEXT - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MOST_TEXT - 1 : MOST_TEXT;
  return `${text.slice(0, end)}…`;
}

function targets(kind: Kind): string[] | undefined {
  const found = [
    "target" in kind ? kind.target : undefined,
    "from_target" in kind ? kind.from_target : undefined,
    "to_target" in kind ? kind.to_target : undefined,
  ].filter((id) => id !== undefined);
  return found.length > 0 ? found : undefined;
}

function elements(opened: Opened, ids: unknown): Record<string, Element> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error("ids must be a list of element ids");
  }
  const unknown = ids.filter((id) => !Object.hasOwn(opened.board.elements, id));
  if (unknown.length > 0) {
    throw new Error(`${opened.folder.name} has no element ${unknown.join(", ")}`);
  }
  return Object.fromEntries(ids.map((id) => [id, opened.board.elements[id]!]));
}
