// Elements copied, cut, and pasted, within a board, between boards, and between windows. The
// clipboard holds them as text, which a paste anywhere reads, and the window they were copied in
// keeps, until the next copy, what reads the bytes of their images, which another board may lack.
// Anything else pasted comes in as images. A lone image copied goes with a PNG of it, for other
// apps.

import { fromClipboard, pasted as pastedImages, type Incoming } from "./add.js";
import { newId, type Reader } from "./board.js";
import { typing } from "./commands.js";
import type { Copied, Point } from "./core.js";
import type { View } from "./view.js";

/** Elements to paste, and the bytes of their images' assets where this window can read them. */
export interface Pasted {
  copied: Copied;
  assets: Reader;
}

export interface Host {
  /** The selection's copy, `undefined` when nothing is selected, or when a cut cannot remove it now. */
  copy(cut: boolean): Copied | undefined;
  /** Whether something is selected to copy, which tells cheaply that `copy` would give it. */
  copyable(): boolean;
  /** What reads the copy's images from their board, which may lose them before a paste. */
  bytes(copied: Copied): Reader;
  /** Removes the selection, which `copy` just copied. */
  cut(): void;
  /** Of the selection as it shows, when it is one image, not a video, this window can read. */
  png(): Promise<Blob> | undefined;
  /** Once a copy went without its PNG, and without its elements too unless `copied`. */
  failed(error: unknown, copied: boolean): void;
  pasted(pasted: Pasted, at: Point): void;
  received(incoming: Promise<Incoming[]>, at: Point): void;
}

export interface Clipboard {
  /** As the menus copy, right after a click, which lets the page write to the clipboard. */
  copy(cut: boolean): void;
  /**
   * The PNG alone, right after a click or a key, which lets the page write it while it is still
   * being made. Whether it was written, as a copy after it cancels it. Rejects with why it was not.
   */
  copyImage(png: Promise<Blob>): Promise<boolean>;
  /**
   * As the menus paste, reading the clipboard, which the browser may first ask the user to allow.
   * Rejects when it does not let the page read it.
   */
  paste(at: Point): Promise<void>;
}

/** As the clipboard holds a copy. `copy` names it, so that a paste tells whether this window holds its images. */
interface Held {
  planche: "elements";
  copy: string;
  copied: Copied;
}

const KIND = "elements";

export function clipboard(view: View, host: Host): Clipboard {
  let held: { copy: string; assets: Reader } | undefined;
  let copies = 0;
  const write = (transfer: DataTransfer, cut: boolean): boolean => {
    const copied = host.copy(cut);
    if (copied === undefined) {
      return false;
    }
    const copy = newId();
    const text = JSON.stringify({ planche: KIND, copy, copied } satisfies Held);
    // Not for a cut, whose image a board saved elsewhere may have dropped by the time it is read.
    const png = !cut && imageable() ? host.png() : undefined;
    // With a write to follow, the event's text too in Chromium, which keeps the copy where its
    // permission, policy, or focus refuses that write.
    const written = !png || chromium();
    if (written) {
      transfer.setData("text/plain", text);
    }
    if (png) {
      withImage(text, png, copies, written);
    }
    held = { copy, assets: host.bytes(copied) };
    if (cut) {
      host.cut();
    }
    return true;
  };
  /** Refused once another copy came, as Chromium would write it over that one. */
  const latest = (png: Promise<Blob>, copy: number) =>
    png.then((made) => {
      if (copy !== copies) {
        throw new Error("Another copy came since");
      }
      return made;
    });
  /**
   * A copy event that wrote anything itself would have WebKit refuse the image's write, as the
   * pasteboard changed since it began, and Firefox cancel the text's, as the event's data replaces
   * a pending write.
   */
  const withImage = (text: string, png: Promise<Blob>, copy: number, written: boolean) => {
    const current = latest(png, copy);
    // Handled at once, as Safari and Firefox tell its failure only as one of their own.
    const failed = current.then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    const plain = new Blob([text], { type: "text/plain" });
    // Once the text is written, as Firefox cancels a write still pending for the next one. WebKit,
    // whose writeText settles at once, still runs this while the key or click that copied lets it.
    const then = (copied: boolean) => {
      if (copy !== copies) {
        return;
      }
      navigator.clipboard
        .write([new ClipboardItem({ "text/plain": plain, "image/png": current })])
        .catch(async (error: unknown) => {
          const made = await failed;
          if (copy !== copies) {
            return;
          }
          if (!copied) {
            host.failed(new Error("The browser did not let Planche write to the clipboard"), false);
          } else {
            host.failed(made ? made.error : refused(error), true);
          }
        });
    };
    navigator.clipboard.writeText(text).then(
      () => then(true),
      () => then(written),
    );
  };
  const hand = (found: Held, at: Point) =>
    host.pasted(
      {
        copied: found.copied,
        assets: held?.copy === found.copy ? held.assets : async () => new Map(),
      },
      at,
    );
  const read = async (at: Point) => {
    const items = await navigator.clipboard.read();
    const text = items.find((item) => item.types.includes("text/plain"));
    const written = await text
      ?.getType("text/plain")
      .then((blob) => blob.text())
      .catch(() => undefined);
    const found = written === undefined ? undefined : copyIn(written);
    if (found) {
      hand(found, at);
    } else {
      host.received(fromClipboard(items), at);
    }
  };
  for (const type of ["copy", "cut"] as const) {
    document.addEventListener(type, (event) => {
      // A field's too, whose text a PNG still being made would write over.
      copies += 1;
      if (
        event.clipboardData &&
        !typing(event.target) &&
        write(event.clipboardData, type === "cut")
      ) {
        event.preventDefault();
      }
    });
    // WebKit enables its Copy, Cut, and Paste menu items, which ⌘C, ⌘X, and ⌘V go through, only
    // for selected or editable text, unless these are cancelled.
    document.addEventListener(
      `before${type}`,
      (event) => typing(event.target) || !host.copyable() || event.preventDefault(),
    );
  }
  document.addEventListener(
    "beforepaste",
    (event) => typing(event.target) || event.preventDefault(),
  );
  document.addEventListener("paste", (event) => {
    const transfer = event.clipboardData;
    if (!transfer) {
      return;
    }
    const found = copyIn(transfer.getData("text/plain"));
    if (typing(event.target)) {
      // Their text would only be a field's worth of code.
      if (found) {
        event.preventDefault();
      }
      return;
    }
    const at = view.centre();
    if (!at) {
      return;
    }
    event.preventDefault();
    if (found) {
      hand(found, at);
    } else if (transfer.types.length === 0) {
      // WebKitGTK hands a paste nothing, though the clipboard may hold something.
      read(at).catch(() => undefined);
    } else {
      host.received(pastedImages(transfer), at);
    }
  });
  return {
    copy(cut) {
      // Through the page's own event, which the browser lets a click fire.
      document.execCommand(cut ? "cut" : "copy");
    },
    // Writing before any wait, while the click or the key lets it.
    async copyImage(png) {
      copies += 1;
      const copy = copies;
      const current = latest(png, copy);
      // Handled at once, as Safari and Firefox tell its failure only as one of their own.
      const failed = current.then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      if (!imageable()) {
        throw new Error("This browser cannot copy images");
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": current })]);
        return true;
      } catch (error) {
        if (copy !== copies) {
          return false;
        }
        const made = await failed;
        throw made ? made.error : refused(error);
      }
    },
    paste: read,
  };
}

function imageable(): boolean {
  return navigator.clipboard?.write !== undefined && typeof ClipboardItem !== "undefined";
}

/** Chromium alone has `userAgentData`, and alone keeps a write that follows a copy event's own. */
function chromium(): boolean {
  return "userAgentData" in navigator;
}

function refused(error: unknown): unknown {
  return error instanceof DOMException && error.name === "NotAllowedError"
    ? new Error("The browser did not let Planche copy the image")
    : error;
}

function copyIn(text: string): Held | undefined {
  // Before parsing, which a long text would take a while to.
  if (!text.startsWith(`{"planche":"${KIND}"`)) {
    return undefined;
  }
  try {
    const found = JSON.parse(text) as Partial<Held>;
    const elements = found.copied?.elements;
    return typeof found.copy === "string" && typeof elements === "object" && elements !== null
      ? (found as Held)
      : undefined;
  } catch {
    return undefined;
  }
}
