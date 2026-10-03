// Images brought in by picking them, dropping them on the viewport, or pasting them: files, or
// images from a web page, which may give only their address.

import { MOST_LABEL, webAddress } from "./board.js";
import { choose } from "./browser.js";
import type { Point } from "./core.js";
import { platform } from "./platform.js";
import type { View } from "./view.js";

/**
 * An image to add, still encoded, or why it cannot be. `name` tells the user which one failed,
 * `filename` names the file it was picked or dropped as, and `source` the web address it came from.
 */
export type Incoming =
  | { name: string; filename?: string | undefined; source?: string | undefined; bytes: Blob }
  | { name: string; failure: string };

/**
 * Image and video files the user picks, none when they cancel. The macOS webview offers every file,
 * whatever the input accepts, so that others fail to decode as any unknown format does.
 */
export async function pick(): Promise<Incoming[]> {
  const files = await choose((input) => {
    input.accept = "image/*,video/*";
    input.multiple = true;
  });
  return (files ?? []).map(fromFile);
}

/** Hands each drop over with where it goes, under the pointer. */
export function receive(
  view: View,
  received: (incoming: Promise<Incoming[]>, at: Point) => void,
): void {
  // A drop anywhere else would leave the app for the file.
  for (const type of ["dragover", "drop"] as const) {
    addEventListener(type, (event) => event.preventDefault());
  }
  view.host.addEventListener("drop", (event) => {
    const at = view.at(event);
    if (at && event.dataTransfer) {
      received(gather(event.dataTransfer, true), at);
    }
  });
  platform.watchDrops((read, addresses, point) => {
    // As the page's own drops, only those on the viewport count.
    const { left, top, right, bottom } = view.host.getBoundingClientRect();
    const { clientX: x, clientY: y } = point;
    const at = left <= x && x < right && top <= y && y < bottom ? view.at(point) : undefined;
    if (at) {
      const downloads = addresses.map(async (address) => [await download(address)]);
      received(
        Promise.all([read(), ...downloads]).then((lists) => lists.flat()),
        at,
      );
    }
  });
}

/** The images that a paste brings. Reads what it needs before returning. */
export function pasted(transfer: DataTransfer): Promise<Incoming[]> {
  return gather(transfer, false);
}

/**
 * Reads what it needs before its first `await`, as the transfer empties once its event ends.
 * Engines name images pasted or brought from a page themselves, `image.png` and the like, so
 * only files dropped from the disk keep their name.
 */
async function gather(transfer: DataTransfer, dropped: boolean): Promise<Incoming[]> {
  const files = [...transfer.files];
  const address = source(transfer);
  if (files.length > 0) {
    const named = dropped && address === undefined;
    const from = recorded(address);
    return files.map((file) =>
      named ? fromFile(file) : { name: file.name, source: from, bytes: file },
    );
  }
  return address === undefined ? [] : [await download(address)];
}

function fromFile(file: File): Incoming {
  return { name: file.name, filename: file.name || undefined, bytes: file };
}

/** The `<img>` of a page's HTML, which keeps it when the image is a link, or else its URL. */
function source(transfer: DataTransfer): string | undefined {
  const html = transfer.getData("text/html");
  const image =
    html && new DOMParser().parseFromString(html, "text/html").querySelector("img[src]");
  if (image) {
    return image.getAttribute("src")!;
  }
  const lines = [
    ...transfer.getData("text/uri-list").split(/\r?\n/),
    transfer.getData("text/plain").trim(),
  ];
  return lines.find((line) => /^(https?|data):/i.test(line));
}

async function download(address: string): Promise<Incoming> {
  const name = address.startsWith("data:") ? "the image" : address;
  try {
    if (address.startsWith("data:")) {
      return { name, bytes: decodeData(address) };
    }
    const response = await fetch(address);
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return { name, source: recorded(address), bytes: await response.blob() };
  } catch {
    return { name, failure: "it could not be downloaded: save the image, or copy it instead" };
  }
}

/**
 * As a web address an image came from is kept, without the credentials it may hold, which say too
 * much as a path would of a disk.
 */
function recorded(address: string | undefined): string | undefined {
  const href = webAddress(address);
  if (href === undefined) {
    return undefined;
  }
  const url = new URL(href);
  url.username = "";
  url.password = "";
  return url.href.length > MOST_LABEL ? undefined : url.href;
}

/** By hand, since the desktop app's policy lets it fetch nothing but its own files. */
function decodeData(address: string): Blob {
  const comma = address.indexOf(",");
  if (comma < 0 || !address.slice(0, comma).endsWith(";base64")) {
    throw new Error("not an image in base64");
  }
  return fromBase64(decodeURIComponent(address.slice(comma + 1)));
}

/** Throws when it is not base64. */
export function fromBase64(text: string): Blob {
  const bytes = atob(text);
  return new Blob([Uint8Array.from(bytes, (char) => char.charCodeAt(0))]);
}

export function fromClipboard(items: ClipboardItem[]): Promise<Incoming[]> {
  const images = items.flatMap((item) => {
    const type = item.types.find((listed) => listed.startsWith("image/"));
    return type ? [item.getType(type)] : [];
  });
  return Promise.all(
    images.map(async (bytes) => ({ name: "the pasted image", bytes: await bytes })),
  );
}
