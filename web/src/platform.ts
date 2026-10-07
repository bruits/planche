// What each host provides that the web app cannot do the same way everywhere. Picking a
// folder and working in it are apart, so that measurements leave the user's pace out.

import type { Incoming } from "./add.js";
import type { Bytes, Files } from "./core.js";
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
  /** The files at `paths`, failing as `read` does. */
  readAll(paths: string[]): Promise<Batch>;
}

/** Files read together, with the stamps of those its folder stamps, taken no later than their bytes. */
export interface Batch {
  files: Files;
  stamps: Map<string, string>;
}

/** A folder that a board lives in, which saves itself there. */
export interface Home extends Folder {
  /**
   * A board's file, and its stamp afterwards. A top-level dot file, such as `.gitattributes`, is
   * only ever created, since its user owns it afterwards. Other dot files are refused.
   */
  write(path: string, bytes: Bytes): Promise<string>;
  /**
   * Writes `files`, which take their places in any order, calling `wrote` with each one's stamp
   * once it has, as `write` gives it. Once one fails, it writes no more, and throws why once those
   * under way are written.
   */
  writeAll(files: [string, Bytes][], wrote: (path: string, stamp: string) => void): Promise<void>;
  /** An element's file, also when gone already. */
  remove(path: string): Promise<void>;
  /** The stamps of those of `paths` that are in the folder, which change whenever a program writes one. */
  stamps(paths: string[]): Promise<Map<string, string>>;
  /** Reopened at launch, until another board opens. Missing for the session. */
  remember?: (() => Promise<void>) | undefined;
}

/** The app's own folder for the board being edited while it has no folder of its own. */
export interface Session extends Home {
  clear(): Promise<void>;
}

/** A file read in slices, so that a large one never sits whole in memory. */
export interface Slices {
  name: string;
  size: number;
  read(start: number, end: number): Promise<Bytes>;
  /** Missing where it cannot be written over, such as in a browser. */
  home?: ZipHome;
}

/** A board's ZIP file that the board saves itself into, whole each time. */
export interface ZipHome {
  /**
   * `null`, writing nothing, when another program changed the file since the app last read or
   * wrote it, unless `over`. Its sink's close leaves the file as written, read with `written`,
   * which is `null` when another program changed it meanwhile, and the file as it left it.
   */
  rewrite(over: boolean): Promise<{ sink: Sink; written(): Slices | null } | null>;
  /** Whether another program changed the file since the app last read or wrote it. */
  changed(): Promise<boolean>;
  /** The file as another program left it, to read again, which the board only matches once `adopt`. */
  reread(): Promise<Slices>;
  /** Once the board shows the file as last read. */
  adopt(): Promise<void>;
  remember(): Promise<void>;
}

/** The board to reopen at launch. */
export type Reopening =
  | { folder: Home }
  | { zip: Slices }
  /** A browser only lets a page write to the folder again once the user clicks, after a restart. */
  | { name: string; ask(): Promise<Home | null> };

/** A board's ZIP file, or a picture of the selection. */
export type Export = "zip" | "png";

/** A file written from start to end, which only takes its place once closed. */
export interface Sink {
  name: string;
  append(bytes: Bytes): Promise<void>;
  close(): Promise<void>;
  /** Leaves no trace of what was appended. */
  discard(): Promise<void>;
}

export interface AgentCall {
  id: number;
  tool: string;
  args: unknown;
  /** When the shell gives up on it, in milliseconds since 1970, as `Date.now()` counts. */
  deadline: number;
}

/** Lets agents read and edit the open board. */
export interface Agent {
  /** Answers every call, for as long as the page lives. `answer` rejects with why it cannot. */
  serve(answer: (call: AgentCall) => Promise<unknown>): Promise<void>;
  /** Throws why it cannot, such as another Planche having it on. */
  allow(on: boolean): Promise<void>;
}

export interface TitleBar {
  /** Throws why it cannot, such as in full screen. */
  show(shown: boolean): Promise<void>;
  /** From a press of the main button, which must still be down. */
  drag(): void;
}

export interface Platform {
  name: string;
  /** Missing where agents cannot reach the app. */
  agent?: Agent;
  /** Missing where the app has no window of its own. Throws why it cannot, such as on Wayland. */
  keepOnTop?(on: boolean): Promise<void>;
  /** Missing where the app has no window of its own. */
  titleBar?: TitleBar;
  /** Why saving into a folder is impossible here, if it is. */
  cannotSave?: string | undefined;
  /** What each key types without a modifier, by `KeyboardEvent.code`. Missing where none can tell. */
  layout?: (() => Promise<ReadonlyMap<string, string>>) | undefined;
  /** A home where the board can save itself. `null` when the user cancels. */
  open(): Promise<Folder | Home | null>;
  /** `null` when the user cancels. Throws when the folder is not empty. */
  pickTarget(): Promise<Home | null>;
  /** A board's ZIP file. `null` when the user cancels. */
  openZip(): Promise<Slices | null>;
  /** Where to export a file of the type, suggested as `name`. `null` when the user cancels. */
  pickExport(name: string, type: Export): Promise<Sink | null>;
  /** `null` where it cannot be kept, or while another window or tab holds it. */
  session(): Promise<Session | null>;
  /** The board remembered, `null` when none is, or it is gone. */
  reopen(): Promise<Reopening | null>;
  /** So that the session reopens at launch instead. */
  forget(): Promise<void>;
  /** `choices` name the answers, yes then no, where the host lets them. */
  confirm(question: string, choices?: [string, string]): Promise<boolean>;
  /** In the system's browser, or a new tab, right after a click or a key, an http or https address. */
  openAddress(address: string): Promise<void>;
  /** Whether the board holds changes not yet safe on disk, so that closing the app asks first. */
  markUnsaved(unsaved: boolean): void;
  /**
   * Where closing the window waits on the page: `write` saves what is left, and resolves to
   * whether all of it is safe, otherwise the user chooses whether to lose it.
   */
  whenClosing?(write: () => Promise<boolean>): void;
  /**
   * Drops that the page cannot see itself: files, read only once `read` is called, and the
   * addresses of images from a web page, with where on the page.
   */
  watchDrops(
    dropped: (
      read: () => Promise<Incoming[]>,
      addresses: string[],
      at: { clientX: number; clientY: number },
    ) => void,
  ): void;
}

// Tauri's own name for its API.
// oxlint-disable-next-line no-underscore-dangle
export const platform: Platform = window.__TAURI__ ? tauri(window.__TAURI__) : browser;
