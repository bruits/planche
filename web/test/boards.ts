// Boards built through the core, as the app opens and edits them.

import { imageKind, newId, open, refresh, untitled, type Opened } from "../src/board.js";
import * as core from "../src/core.js";
import type { Bytes, Kind, Size, Trim } from "../src/core.js";
import type { Folder } from "../src/platform.js";
import { memoryHome, sample } from "./folders.js";

export function boardOf(
  elements: [string, Kind][] | Record<string, Kind> = [],
  { groups = {}, locked = [] }: { groups?: Record<string, string[]>; locked?: string[] } = {},
): Opened {
  const opened = untitled();
  for (const [id, kind] of Array.isArray(elements) ? elements : Object.entries(elements)) {
    refresh(opened, opened.editor.add(id, undefined, JSON.stringify(kind)));
  }
  for (const [group, members] of Object.entries(groups)) {
    refresh(opened, opened.editor.group(group, members));
  }
  refresh(opened, opened.editor.setLocked(locked, true));
  return opened;
}

export function holding(kinds: Kind[]): { opened: Opened; ids: string[] } {
  const ids = kinds.map(() => newId());
  return { opened: boardOf(ids.map((id, at) => [id, kinds[at]!])), ids };
}

export interface Played {
  asset: string;
  x?: number;
  trim?: Trim;
  speed?: number;
}

export function animated(images: Played[], natural: Size): { opened: Opened; ids: string[] } {
  const { opened, ids } = holding(
    images.map(({ asset, x = 0 }) => imageKind(asset, natural, { x, y: 0, ...natural })),
  );
  images.forEach(({ trim, speed }, at) => {
    const id = ids[at]!;
    if (trim) {
      refresh(opened, core.setTrim(opened.editor, [id], trim));
    }
    if (speed) {
      refresh(opened, opened.editor.setSpeed([id], speed));
    }
  });
  return { opened, ids };
}

export async function openedFrom(folder: Folder) {
  return (await open(async () => folder, new Map()))!;
}

export async function openDemo(change?: (files: Map<string, Bytes>) => void): Promise<Opened> {
  const files = sample("demo");
  change?.(files);
  return (await openedFrom(memoryHome("demo", files).home)).opened;
}
