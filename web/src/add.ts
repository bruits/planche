// Images brought in by dropping them on the viewport or pasting them: files, or images from a
// web page, which may give only their address.

import type { Point } from "./core.js";
import { platform } from "./platform.js";
import type { View } from "./view.js";

/** An image to add, still encoded, or why it cannot be. */
export type Incoming = { name: string; bytes: Blob } | { name: string; failure: string };

/** Hands each drop or paste over with where it goes: under the pointer, or at the view's centre. */
export function receive(view: View, received: (incoming: Promise<Incoming[]>, at: Point) => void): void {
  // A drop anywhere else would leave the app for the file.
  for (const type of ["dragover", "drop"] as const) {
    addEventListener(type, (event) => event.preventDefault());
  }
  view.host.addEventListener("drop", (event) => {
    const at = view.at(event);
    if (at && event.dataTransfer) {
      received(gather(event.dataTransfer), at);
    }
  });
  platform.watchDrops((read, addresses, point) => {
    // As the page's own drops, only those on the viewport count.
    const { left, top, right, bottom } = view.host.getBoundingClientRect();
    const { clientX: x, clientY: y } = point;
    const at = left <= x && x < right && top <= y && y < bottom ? view.at(point) : undefined;
    if (at) {
      const downloads = addresses.map(async (address) => [await download(address)]);
      received(Promise.all([read(), ...downloads]).then((lists) => lists.flat()), at);
    }
  });
  document.addEventListener("paste", (event) => {
    const at = view.centre();
    if (!at || !event.clipboardData) {
      return;
    }
    event.preventDefault();
    // WebKitGTK hands a paste nothing, though the clipboard may hold an image.
    const empty = event.clipboardData.types.length === 0;
    received(empty ? readClipboard() : gather(event.clipboardData), at);
  });
  // WebKit enables its Paste menu item, which Cmd+V goes through, only for editable content,
  // unless this is cancelled.
  document.addEventListener("beforepaste", (event) => event.preventDefault());
}

/** Reads what it needs before its first `await`, as the transfer empties once its event ends. */
async function gather(transfer: DataTransfer): Promise<Incoming[]> {
  const files = [...transfer.files];
  if (files.length > 0) {
    return files.map((file) => ({ name: file.name, bytes: file }));
  }
  const address = source(transfer);
  return address === undefined ? [] : [await download(address)];
}

/** The `<img>` of a page's HTML, which keeps it when the image is a link, or else its URL. */
function source(transfer: DataTransfer): string | undefined {
  const html = transfer.getData("text/html");
  const image = html && new DOMParser().parseFromString(html, "text/html").querySelector("img[src]");
  if (image) {
    return image.getAttribute("src")!;
  }
  const lines = [...transfer.getData("text/uri-list").split(/\r?\n/), transfer.getData("text/plain").trim()];
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
    return { name, bytes: await response.blob() };
  } catch {
    return { name, failure: "it could not be downloaded: save the image, or copy it instead" };
  }
}

/** By hand, since the desktop app's policy lets it fetch nothing but its own files. */
function decodeData(address: string): Blob {
  const comma = address.indexOf(",");
  if (comma < 0 || !address.slice(0, comma).endsWith(";base64")) {
    throw new Error("not an image in base64");
  }
  const text = atob(decodeURIComponent(address.slice(comma + 1)));
  return new Blob([Uint8Array.from(text, (char) => char.charCodeAt(0))]);
}

async function readClipboard(): Promise<Incoming[]> {
  const items = await navigator.clipboard.read().catch(() => []);
  const images = items.flatMap((item) => {
    const type = item.types.find((type) => type.startsWith("image/"));
    return type ? [item.getType(type)] : [];
  });
  return Promise.all(images.map(async (bytes) => ({ name: "the pasted image", bytes: await bytes })));
}
