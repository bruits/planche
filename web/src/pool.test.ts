import { describe, it, expect } from "vitest";
import { deferred, tick } from "../test/waits.js";
import type { Bytes } from "./core.js";
import { pool, readEach } from "./pool.js";

describe("pool", () => {
  it("works on every item, never more than its limit at once", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7].values();
    const working = new Map(Array.from({ length: 7 }, (_, at) => [at + 1, deferred()]));
    const [done, most] = [[] as number[], { now: 0, at: 0 }];
    const run = pool(
      () => items.next().value,
      async (item) => {
        most.now++;
        most.at = Math.max(most.at, most.now);
        await working.get(item)!.promise;
        done.push(item);
        most.now--;
      },
      3,
    );
    // They end out of the order they began in, so the slots free up in any order.
    for (const item of [3, 1, 2, 7, 6, 5, 4]) {
      await tick();
      working.get(item)!.resolve();
    }
    await run;
    expect(done.toSorted((one, other) => one - other)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(most.at).toBe(3);
  });

  it("starts no item once one fails, and throws that failure once those under way end", async () => {
    const items = ["slow", "failing", "never"].values();
    const slow = deferred();
    const started: string[] = [];
    let ended = false;
    const run = pool(
      () => items.next().value,
      async (item) => {
        started.push(item);
        if (item === "failing") {
          throw new Error("disk full");
        }
        await slow.promise;
        ended = true;
      },
      2,
    );
    await Promise.resolve();
    slow.resolve();
    await expect(run).rejects.toThrow("disk full");
    expect(started).toEqual(["slow", "failing"]);
    expect(ended).toBe(true);
  });

  it("gives each file read by path in the order asked, though reads end in any order", async () => {
    const paths = ["c", "a", "b"];
    const reads = new Map(paths.map((path) => [path, deferred<Bytes>()]));
    const reading = readEach(paths, (path) => reads.get(path)!.promise);
    for (const path of ["a", "b", "c"]) {
      await tick();
      reads.get(path)!.resolve(new TextEncoder().encode(path));
    }
    const files = await reading;
    expect([...files.keys()]).toEqual(paths);
    expect(new TextDecoder().decode(files.get("c"))).toBe("c");
  });
});
