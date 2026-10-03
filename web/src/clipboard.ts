// Elements copied, cut, and pasted, within a board, between boards, and between windows. The
// clipboard holds them as text, which a paste anywhere reads, and the window they were copied in
// keeps, until the next copy, what reads the bytes of their images, which another board may lack.
// Anything else pasted comes in as images.

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
  pasted(pasted: Pasted, at: Point): void;
  received(incoming: Promise<Incoming[]>, at: Point): void;
}

export interface Clipboard {
  /** As the menus copy, right after a click, which lets the page write to the clipboard. */
  copy(cut: boolean): void;
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
  const write = (transfer: DataTransfer, cut: boolean): boolean => {
    const copied = host.copy(cut);
    if (copied === undefined) {
      return false;
    }
    const copy = newId();
    transfer.setData("text/plain", JSON.stringify({ planche: KIND, copy, copied } satisfies Held));
    held = { copy, assets: host.bytes(copied) };
    if (cut) {
      host.cut();
    }
    return true;
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
    paste: read,
  };
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
