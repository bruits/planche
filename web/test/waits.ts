// What tests wait on: what they started themselves, never a time on the clock.

import { vi } from "vitest";

/** Once every task queued so far has run, and so every promise they settle. */
export async function tick(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await new Promise<void>((done) => setTimeout(done));
  }
}

/** `check` is not awaited, so it cannot be async. */
export async function eventually(check: () => boolean | void, turns = 1000): Promise<void> {
  for (let turn = 1; ; turn++) {
    let failure: unknown = new Error(`It did not come true within ${turns} turns`);
    try {
      if (check() !== false) {
        return;
      }
    } catch (error) {
      failure = error;
    }
    if (turn >= turns) {
      throw failure;
    }
    await tick();
  }
}

export function nextFrame(): Promise<number> {
  return new Promise((done) => requestAnimationFrame(done));
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
