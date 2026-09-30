// Measurements the app shows, taken the same way on every platform.

/** Calls `show` about once a second with the frames per second over that second. */
export function watchFrameRate(show: (fps: number) => void): void {
  let frames = 0;
  let since = performance.now();
  const count = (now: number) => {
    frames += 1;
    if (now - since >= 1000) {
      show((frames * 1000) / (now - since));
      frames = 0;
      since = now;
    }
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
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
