import { describe, it, expect } from "vitest";
import { pool, readEach } from "./pool.js";

function later() {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  return { settled, settle };
}

async function slowerForC(path: string) {
  await new Promise((resolve) => setTimeout(resolve, path === "c" ? 5 : 0));
  return new TextEncoder().encode(path);
}

describe("pool", () => {
  it("works on every item, never more than its limit at once", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7].values();
    const [done, most] = [[] as number[], { now: 0, at: 0 }];
    await pool(
      () => items.next().value,
      async (item) => {
        most.now++;
        most.at = Math.max(most.at, most.now);
        await new Promise((resolve) => setTimeout(resolve, 8 - item));
        done.push(item);
        most.now--;
      },
      3,
    );
    expect(done.toSorted((one, other) => one - other)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(most.at).toBe(3);
  });

  it("starts no item once one fails, and throws that failure once those under way end", async () => {
    const items = ["slow", "failing", "never"].values();
    const slow = later();
    const started: string[] = [];
    let ended = false;
    const run = pool(
      () => items.next().value,
      async (item) => {
        started.push(item);
        if (item === "failing") {
          throw new Error("disk full");
        }
        await slow.settled;
        ended = true;
      },
      2,
    );
    await Promise.resolve();
    slow.settle();
    await expect(run).rejects.toThrow("disk full");
    expect(started).toEqual(["slow", "failing"]);
    expect(ended).toBe(true);
  });

  it("gives each file read by path in the order asked, though reads end in any order", async () => {
    const paths = ["c", "a", "b"];
    const files = await readEach(paths, slowerForC);
    expect([...files.keys()]).toEqual(paths);
    expect(new TextDecoder().decode(files.get("c"))).toBe("c");
  });
});
