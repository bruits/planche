import { describe, it, expect } from "vitest";
import * as core from "./core.js";
import type { Background, Colour, CropShape, Kind, Text } from "./core.js";

/** One of samples/demo's, which an image needs to name. */
const ASSET = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f";
/** Ids as the core takes them. */
const [A, B, G] = ["a", "b", "c"].map((digit) => digit.repeat(32)) as [string, string, string];
const frame = { x: 10, y: 20, width: 120, height: 80 };
const text: Text = { content: "Hello", font_size: 20 };

const image = (more: Partial<Extract<Kind, { type: "image" }>> = {}): Kind => ({
  type: "image",
  asset: ASSET,
  natural_size: { width: 320, height: 240 },
  frame,
  rotation: 15,
  edits: {
    crop: { x: 0, y: 0, width: 160, height: 120 },
    flip_horizontal: true,
    flip_vertical: false,
    greyscale: true,
  },
  ...more,
});
const note = (more: Partial<Extract<Kind, { type: "note" }>> = {}): Kind => ({
  type: "note",
  frame,
  rotation: 0,
  text,
  ...more,
});
const sticky = (more: Partial<Extract<Kind, { type: "sticky" }>> = {}): Kind => ({
  type: "sticky",
  frame,
  rotation: 3,
  text,
  ...more,
});
const shape = (more: Partial<Extract<Kind, { type: "shape" }>> = {}): Kind => ({
  type: "shape",
  frame,
  rotation: 0,
  shape: "rectangle",
  text,
  ...more,
});
const arrow = (more: Partial<Extract<Kind, { type: "arrow" }>> = {}): Kind => ({
  type: "arrow",
  from: { x: 0, y: 0 },
  to: { x: 100, y: 50 },
  ...more,
});
const line = (more: Partial<Extract<Kind, { type: "line" }>> = {}): Kind => ({
  type: "line",
  from: { x: 0, y: 0 },
  to: { x: 100, y: 50 },
  ...more,
});

const colours: Colour[] = ["red", "orange", "green", "blue", "violet", "#12ab9f"];

/** Each value but the defaults, which `defaults` covers. */
const kinds: [string, Kind][] = [
  ["an image", image()],
  [
    "an image with its source, filename, and caption",
    image({ source: "https://example.com/a.png", filename: "a.png", caption: "A" }),
  ],
  ["a note", note()],
  ["a sticky note", sticky()],
  ["a shape", shape()],
  ["an arrow", arrow()],
  ["a line", line()],
  ["a comment", { type: "comment", at: { x: 5, y: 6 }, text: "Why?" }],
  ...(["bold", "italic", "strike"] as const).map((style): [string, Kind] => [
    `${style} text`,
    note({ text: { ...text, [style]: true } }),
  ]),
  ...(["left", "centre", "right"] as const).map((align): [string, Kind] => [
    `text aligned ${align}`,
    note({ text: { ...text, align } }),
  ]),
  ...colours.flatMap((colour): [string, Kind][] => [
    [`a ${colour} note`, note({ colour })],
    [`a ${colour} shape`, shape({ colour })],
    [`a ${colour} arrow`, arrow({ colour })],
    [`a ${colour} line`, line({ colour })],
  ]),
  ...(["pink", "blue", "green", "lilac"] as const).map((paper): [string, Kind] => [
    `${paper} paper`,
    sticky({ paper }),
  ]),
  ...(["rectangle", "ellipse", "cross"] as const).map((form): [string, Kind] => [
    `a ${form}`,
    shape({ shape: form }),
  ]),
  ...(["thin", "thick"] as const).flatMap((weight): [string, Kind][] => [
    [`a ${weight} shape`, shape({ weight })],
    [`a ${weight} arrow`, arrow({ weight })],
    [`a ${weight} line`, line({ weight })],
  ]),
  ["a dashed shape", shape({ dash: "dashed" })],
  ["a dashed arrow", arrow({ dash: "dashed" })],
  ["a dashed line", line({ dash: "dashed" })],
  ["an arrow headed at both ends", arrow({ heads: "both" })],
  ...(["tint", "solid"] as const).map((fill): [string, Kind] => [
    `a ${fill} shape`,
    shape({ fill }),
  ]),
  [
    "an image cropped to an ellipse",
    image({
      edits: {
        crop: null,
        flip_horizontal: false,
        flip_vertical: true,
        greyscale: false,
        crop_shape: "ellipse",
      },
    }),
  ],
];

/** Each default as sent, then as it reads back, left out. */
const defaults: [string, Kind, Kind][] = [
  ["an ink note", note({ colour: "ink" }), note()],
  ["an ink shape", shape({ colour: "ink" }), shape()],
  ["an ink arrow", arrow({ colour: "ink" }), arrow()],
  ["yellow paper", sticky({ paper: "yellow" }), sticky()],
  ["a medium shape", shape({ weight: "medium" }), shape()],
  ["a medium line", line({ weight: "medium" }), line()],
  ["a solid arrow", arrow({ dash: "solid" }), arrow()],
  ["an arrow headed at its end", arrow({ heads: "end" }), arrow()],
  ["a hollow shape", shape({ fill: "hollow" }), shape()],
  [
    "an image cropped to a rectangle",
    image({
      edits: {
        crop: null,
        flip_horizontal: false,
        flip_vertical: false,
        greyscale: false,
        crop_shape: "rectangle",
      },
    }),
    image({
      edits: { crop: null, flip_horizontal: false, flip_vertical: false, greyscale: false },
    }),
  ],
];

describe("the core", () => {
  it.each(kinds)("%s reads back as the shells sent it", (_, kind) => {
    const editor = new core.Editor();
    try {
      editor.add(A, undefined, JSON.stringify(kind));
      expect(core.element(editor, A)?.kind).toEqual(kind);
    } finally {
      editor.free();
    }
  });

  it.each(defaults)("%s reads back with the default left out", (_, kind, read) => {
    const editor = new core.Editor();
    try {
      editor.add(A, undefined, JSON.stringify(kind));
      expect(core.element(editor, A)?.kind).toEqual(read);
    } finally {
      editor.free();
    }
  });

  it("a group reads back as the shells name it", () => {
    const editor = new core.Editor();
    try {
      editor.add(A, undefined, JSON.stringify(note()));
      editor.add(B, undefined, JSON.stringify(arrow()));
      editor.group(G, [A, B]);
      expect(core.element(editor, G)?.kind).toEqual({ type: "group" } satisfies Kind);
      expect(core.element(editor, A)?.group).toBe(G);
    } finally {
      editor.free();
    }
  });

  it.each(["plain", "grid", "dots"] satisfies Background[])(
    "the %s background reads back as set",
    (background) => {
      const editor = new core.Editor();
      try {
        core.setBackground(editor, background);
        expect(core.background(editor)).toBe(background);
        expect(core.board(editor).background).toBe(background);
      } finally {
        editor.free();
      }
    },
  );

  it.each(["rectangle", "ellipse"] satisfies CropShape[])(
    "an image's crop set to a %s reads back as set",
    (crop_shape) => {
      const editor = new core.Editor();
      try {
        editor.add(A, undefined, JSON.stringify(image()));
        core.setCropShape(editor, [A], crop_shape);
        const kind = core.element(editor, A)?.kind;
        expect(kind?.type === "image" && (kind.edits.crop_shape ?? "rectangle")).toBe(crop_shape);
      } finally {
        editor.free();
      }
    },
  );
});
