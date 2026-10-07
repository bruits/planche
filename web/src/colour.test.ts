import { describe, expect, it } from "vitest";
import { open } from "./board.js";
import { meanColours } from "./colour.js";
import { memoryHome, sample } from "../test/folders.js";

/** Two of the demo's images. */
const [LARGEST, MIDDLE] = [
  "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png",
  "fabec7ea4f16a728b547c12f25158c75f6b48cf14db92745f92e5e9edcd36d93.jpg",
];

describe("meanColours", () => {
  it("leaves out the images whose files are missing or unlike their digests", async () => {
    const files = sample("demo");
    files.delete(`assets/${LARGEST}`);
    files.get(`assets/${MIDDLE}`)![100]! ^= 0xff;
    const { opened } = (await open(async () => memoryHome("demo", files).home, new Map()))!;
    const ids = Object.entries(opened.board.elements)
      .filter(([, { kind }]) => kind.type === "image" && [LARGEST, MIDDLE].includes(kind.asset))
      .map(([id]) => id);
    expect(ids).toHaveLength(2);
    expect(await meanColours(opened, ids)).toEqual({});
  });
});
