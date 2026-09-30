// What each host provides that the web app cannot do the same way everywhere. Picking a
// folder and working in it are apart, so that measurements leave the user's pace out.

import type { Bytes } from "./core.js";
import { browser } from "./browser.js";
import { tauri } from "./tauri.js";

/** A folder opened as a board. */
export interface Folder {
  name: string;
  /**
   * Its files down to `depth` segments, relative to it with `/` between segments. Dot files
   * are left out.
   */
  list(depth: number): Promise<string[]>;
  read(path: string): Promise<Bytes>;
}

/** A folder to save a board into, empty but for dot files. */
export interface Target {
  name: string;
  /**
   * A top-level dot file, such as `.gitattributes`, is only ever created, since its user owns
   * it afterwards. Other dot files are refused.
   */
  write(path: string, bytes: Bytes): Promise<void>;
}

/** A file read in slices, so that a large one never sits whole in memory. */
export interface Slices {
  name: string;
  size: number;
  read(start: number, end: number): Promise<Bytes>;
}

/** A file written from start to end, which only takes its place once closed. */
export interface Sink {
  name: string;
  append(bytes: Bytes): Promise<void>;
  close(): Promise<void>;
  /** Leaves no trace of what was appended. */
  discard(): Promise<void>;
}

export interface Platform {
  name: string;
  /** Why saving is impossible here, if it is. */
  cannotSave?: string;
  /** `null` when the user cancels. */
  open(): Promise<Folder | null>;
  /** `null` when the user cancels. Throws when the folder is not empty. */
  pickTarget(): Promise<Target | null>;
  /** A board's ZIP file. `null` when the user cancels. */
  openZip(): Promise<Slices | null>;
  /** Where to export a ZIP file, suggested as `name`. `null` when the user cancels. */
  pickZip(name: string): Promise<Sink | null>;
}

export const platform: Platform = window.__TAURI__ ? tauri(window.__TAURI__) : browser;
