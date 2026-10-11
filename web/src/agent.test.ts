// @vitest-environment happy-dom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { access, answer, type Reading } from "./agent.js";
import type { Writing } from "./author.js";
import { open, type Opened } from "./board.js";
import type { Bytes } from "./core.js";
import type { AgentCall } from "./platform.js";
import { memoryHome, sample } from "../test/folders.js";

const MISSING = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png";
const STICKY = "b7d4e1f05a2c4c8e9f3a6d2b1c0e5f74";

async function page(
  change: (files: Map<string, Bytes>) => void,
  { halfDrawn = false, stopped = (): boolean => false } = {},
) {
  const files = sample("demo");
  change(files);
  const opened = (await open(async () => memoryHome("demo", files).home, new Map()))!.opened;
  return {
    opened: () => opened as Opened | undefined,
    unsaved: () => false,
    shown: () => undefined,
    halfDrawn: () => halfDrawn,
    stopped,
    crossedOut: (asset: string) => (asset === MISSING ? "its file is missing" : undefined),
  } as unknown as Reading & Writing;
}

interface Outline {
  images_read: boolean;
  left_out: { path: string; reason: string }[];
  elements: { image?: { crossed_out?: { path: string; reason: string } } }[];
}

async function outline(reading: Reading & Writing): Promise<Outline> {
  const call = { id: 1, tool: "board", args: {}, deadline: Date.now() + 60_000 };
  return (await answer(call, reading)) as Outline;
}

describe("answer", () => {
  it("tells which files the board left out, and which images show crossed out, with why", async () => {
    const read = await outline(
      await page((files) => {
        files.delete(`assets/${MISSING}`);
        files.set(`elements/${STICKY}.json`, new TextEncoder().encode("<<<<<<< ours\n"));
      }),
    );
    expect(read.images_read).toBe(true);
    expect(read.left_out).toEqual([
      {
        path: `elements/${STICKY}.json`,
        reason: expect.stringContaining("unresolved Git conflict"),
      },
    ]);
    const crossed = read.elements.flatMap(({ image }) => image?.crossed_out ?? []);
    expect(crossed).toEqual([{ path: `assets/${MISSING}`, reason: "its file is missing" }]);
  });

  it("says when the images are not all read yet", async () => {
    const read = await outline(await page(() => {}, { halfDrawn: true }));
    expect(read.images_read).toBe(false);
    expect(read.left_out).toEqual([]);
  });

  it("tells an agent that Planche stopped, whatever it asks", async () => {
    const reading = await page(() => {}, { halfDrawn: true, stopped: () => true });
    for (const tool of ["board", "elements", "add", "screenshot"]) {
      const call = { id: 1, tool, args: {}, deadline: Date.now() + 60_000 };
      await expect(answer(call, reading)).rejects.toThrow(
        "Planche stopped working, so ask the user to reload it",
      );
    }
  });

  it("tells the agent whose call stopped Planche so", async () => {
    let stopped = false;
    const reading = await page(() => {}, { stopped: () => stopped });
    // A call that panics the core, which a throw from within stands for.
    reading.opened = () => {
      stopped = true;
      throw new WebAssembly.RuntimeError("unreachable");
    };
    const call = { id: 1, tool: "board", args: {}, deadline: Date.now() + 60_000 };
    await expect(answer(call, reading)).rejects.toThrow(
      "Planche stopped working, so ask the user to reload it",
    );
  });
});

function bridge(refusal?: string) {
  return {
    serve: vi.fn<(answer: (call: AgentCall) => Promise<unknown>) => Promise<void>>(async () => {}),
    allow: vi.fn<(on: boolean) => Promise<void>>(async () => {
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
    }),
  };
}

describe("access", () => {
  beforeEach(() => localStorage.clear());

  it("answers agents' calls with the open board, then lets them in as the user left it", async () => {
    const agent = bridge();
    const reading = await page(() => {});
    await access(agent, reading).allow(true);
    const next = access(agent, reading);
    await next.serve();
    expect(next.allowed()).toBe(true);
    expect(agent.allow).toHaveBeenLastCalledWith(true);
    const answered = agent.serve.mock.calls[0]![0];
    const told = (await answered({
      id: 1,
      tool: "board",
      args: {},
      deadline: Date.now() + 1000,
    })) as {
      board: { name: string };
    };
    expect(told.board.name).toBe("demo");
  });

  it("stays off and says why when the shell refuses, remembering nothing", async () => {
    const reading = await page(() => {});
    const refused = access(bridge("another Planche has it on"), reading);
    await expect(refused.allow(true)).rejects.toThrow(
      "Agent access stays off, as Error: another Planche has it on",
    );
    expect(refused.allowed()).toBe(false);
    const next = access(bridge(), reading);
    await next.serve();
    expect(next.allowed()).toBe(false);
  });

  it("serves nothing where no agent can reach the app", async () => {
    const served = access(undefined, await page(() => {}));
    await served.serve();
    expect(served.allowed()).toBe(false);
  });
});
