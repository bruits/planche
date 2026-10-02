// Measurements the app shows, taken the same way on every platform.

export interface Rate {
  count(): void;
  /** While on, calls `show` about once a second with how many counts that second held. */
  watch(on: boolean): void;
}

/** Of something counted, such as draws. Unwatched, it keeps nothing running, so that an idle page sleeps. */
export function rate(show: (perSecond: number) => void): Rate {
  let counted = 0;
  let since = 0;
  let ticking: ReturnType<typeof setInterval> | undefined;
  return {
    count() {
      counted += 1;
    },
    watch(on) {
      clearInterval(ticking);
      ticking = undefined;
      if (!on) {
        return;
      }
      counted = 0;
      since = performance.now();
      ticking = setInterval(() => {
        const now = performance.now();
        show((counted * 1000) / (now - since));
        counted = 0;
        since = now;
      }, 1000);
    },
  };
}

/** The smallest of `values`, which must not be empty, with at least `share` of them at or below it. */
export function percentile(values: number[], share: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * share) - 1))]!;
}

/** In bytes, Chromium only. */
export function heapInUse(): number | undefined {
  return (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
}

/** The result of `work`, and how long it took in milliseconds. */
export async function timed<T>(work: () => Promise<T> | T): Promise<[T, number]> {
  const start = performance.now();
  const result = await work();
  return [result, performance.now() - start];
}

export function megabytes(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} MB`;
}

export function milliseconds(duration: number): string {
  return `${duration.toFixed(1)} ms`;
}
