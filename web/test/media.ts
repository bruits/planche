// Media as little as they come, for tests that need bytes the core takes for one.

import type { Bytes } from "../src/core.js";

/** 1 by 1, with no colour table. */
const HEADER = "GIF89a\x01\x00\x01\x00\x00\x00\x00";
/** A frame shown for a tenth of a second. */
const FRAME =
  "\x21\xF9\x04\x00\x0A\x00\x00\x00\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x4C\x01\x00";
/** A comment sub-block holding 255 bytes, 256 with its size. */
const COMMENTED = `\xFF${"\x00".repeat(255)}`;

export function gifOf(frames: number, { comment = 0 } = {}): Bytes {
  const first = comment > 0 ? `\x21\xFE${COMMENTED.repeat(Math.ceil(comment / 256))}\x00` : "";
  return Uint8Array.from(`${HEADER}${first}${FRAME.repeat(frames)};`, (c) => c.charCodeAt(0));
}

/** A movie: its type box, then an empty data box. */
export const MOVIE: Bytes = Uint8Array.from(
  "\x00\x00\x00\x10ftypisom\x00\x00\x02\x00\x00\x00\x00\x08mdat",
  (c) => c.charCodeAt(0),
);
