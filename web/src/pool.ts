// Work on many items, a few at a time.

import type { Bytes, Files } from "./core.js";

/** How many images are read, decoded, or prepared at once, which bounds the memory in flight. */
export const AT_ONCE = 4;

/** How many small files are read or written at once, past which a browser reads no faster. */
export const FILES_AT_ONCE = 16;

/**
 * Runs `work` on each item `next` hands out, `limit` at a time, until it hands out none. Once
 * one throws, it hands out no more, and throws that once the items under way are done.
 */
export async function pool<T>(
  next: () => T | undefined,
  work: (item: T) => Promise<void>,
  limit = AT_ONCE,
): Promise<void> {
  let failure: { reason: unknown } | undefined;
  const worker = async () => {
    while (failure === undefined) {
      try {
        const item = next();
        if (item === undefined) {
          return;
        }
        await work(item);
      } catch (reason) {
        failure ??= { reason };
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  if (failure !== undefined) {
    throw failure.reason;
  }
}

/** The bytes `read` gives for each of `paths`, by path in their order. */
export async function readEach(
  paths: string[],
  read: (path: string) => Promise<Bytes>,
): Promise<Files> {
  const got: Bytes[] = [];
  const pending = paths.entries();
  await pool(
    () => pending.next().value,
    async ([at, path]) => void (got[at] = await read(path)),
    FILES_AT_ONCE,
  );
  return new Map(paths.map((path, at) => [path, got[at]!]));
}
