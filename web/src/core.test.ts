import { describe, it, expect } from "vitest";
import * as core from "./core.js";
import type { Background, Colour, CropShape, Kind, Text } from "./core.js";

/** One of samples/demo's, which an image needs to name. */
const ASSET = "5e352e848cf1aacc7aca97973322210c9c22b09de57d51546a5f9d7926bcb04f.png";
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
const stroke = (more: Partial<Extract<Kind, { type: "stroke" }>> = {}): Kind => ({
  type: "stroke",
  frame,
  points: [0, 1, 0.5, 0, 1, 0.75],
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
  ["a pen stroke", stroke()],
  ["a dot", stroke({ points: [0, 0] })],
  ["a comment", { type: "comment", at: { x: 5, y: 6 }, text: "Why?" }],
  ...(["bold", "italic", "strike"] as const).map((style): [string, Kind] => [
    `${style} text`,
    note({ text: { ...text, [style]: true } }),
  ]),
  ...(["centre", "right"] as const).map((align): [string, Kind] => [
    `text aligned ${align}`,
    note({ text: { ...text, align } }),
  ]),
  ["a shape's text aligned left", shape({ text: { ...text, align: "left" } })],
  ...colours.flatMap((colour): [string, Kind][] => [
    [`a ${colour} note`, note({ colour })],
    [`a ${colour} shape`, shape({ colour })],
    [`a ${colour} arrow`, arrow({ colour })],
    [`a ${colour} line`, line({ colour })],
    [`a ${colour} pen stroke`, stroke({ colour })],
  ]),
  ...(["pink", "orange", "green", "blue", "lilac"] as const).map((paper): [string, Kind] => [
    `${paper} paper`,
    sticky({ paper }),
  ]),
  ...(["rectangle", "ellipse", "cross", "triangle", "diamond", "star", "polygon"] as const).map(
    (form): [string, Kind] => [`a ${form}`, shape({ shape: form })],
  ),
  ["a seven-pointed star", shape({ shape: "star", corners: 7 })],
  ["a dodecagon", shape({ shape: "polygon", corners: 12 })],
  ...(["thin", "thick"] as const).flatMap((weight): [string, Kind][] => [
    [`a ${weight} shape`, shape({ weight })],
    [`a ${weight} arrow`, arrow({ weight })],
    [`a ${weight} line`, line({ weight })],
    [`a ${weight} pen stroke`, stroke({ weight })],
  ]),
  ["a highlighter stroke", stroke({ tip: "highlighter" })],
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

const unedited = image() as Extract<Kind, { type: "image" }>;
delete unedited.edits;

/** Each default as sent, then as it reads back, left out. */
const defaults: [string, Kind, Kind][] = [
  ["an ink note", note({ colour: "ink" }), note()],
  ["an ink shape", shape({ colour: "ink" }), shape()],
  ["an ink arrow", arrow({ colour: "ink" }), arrow()],
  ["yellow paper", sticky({ paper: "yellow" }), sticky()],
  ["a medium shape", shape({ weight: "medium" }), shape()],
  ["a medium line", line({ weight: "medium" }), line()],
  ["an ink pen stroke", stroke({ tip: "pen", colour: "ink", weight: "medium" }), stroke()],
  [
    "a pen stroke's points kept to a hundred thousandth of its frame",
    stroke({ points: [0.123456789, 1, 0.123457, 1, 1, 0.5] }),
    stroke({ points: [0.12346, 1, 1, 0.5] }),
  ],
  ["a solid arrow", arrow({ dash: "solid" }), arrow()],
  ["an arrow headed at its end", arrow({ heads: "end" }), arrow()],
  ["a hollow shape", shape({ fill: "hollow" }), shape()],
  ["a note's text aligned left", note({ text: { ...text, align: "left" } }), note()],
  ["a shape's text centred", shape({ text: { ...text, align: "centre" } }), shape()],
  ["a cross filled", shape({ shape: "cross", fill: "solid" }), shape({ shape: "cross" })],
  ["an unturned note", note({ rotation: 0 }), note()],
  ["an unturned pen stroke", stroke({ rotation: 0 }), stroke()],
  [
    "an image cropped to a rectangle",
    image({ edits: { ...core.editsOf(unedited), crop_shape: "rectangle" } }),
    unedited,
  ],
  [
    "an image played at its own speed",
    image({ edits: { ...core.editsOf(unedited), speed: 1 } }),
    unedited,
  ],
  [
    "an image neither cropped, flipped nor greyed",
    image({
      edits: { crop: null, flip_horizontal: false, flip_vertical: false, greyscale: false },
    }),
    unedited,
  ],
];

describe("the core", () => {
  it("tells how each part of a style comes, by the type of what takes it", () => {
    const parts = { colour: "ink", weight: "medium", dash: "solid", opacity: 100 };
    const written = { bold: false, italic: false, strike: false, opacity: 100 };
    expect(core.plain(note())).toEqual({
      colour: "ink",
      ...written,
      align: "left",
    });
    expect(core.plain(sticky())).toEqual({ paper: "yellow", ...written, align: "left" });
    expect(core.plain(shape())).toEqual({ ...parts, fill: "hollow", ...written, align: "centre" });
    expect(core.plain(shape({ shape: "cross" }))).toEqual({
      ...parts,
      ...written,
      align: "centre",
    });
    expect(core.plain(arrow())).toEqual({ ...parts, heads: "end" });
    expect(core.plain(line())).toEqual(parts);
    expect(core.plain(stroke())).toEqual({ colour: "ink", weight: "medium", opacity: 100 });
    expect(core.plain(image())).toEqual({ opacity: 100 });
  });

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

  it("a paste lays out the outermost of its copy where it goes, under new ids", () => {
    const editor = new core.Editor();
    try {
      editor.add(A, undefined, JSON.stringify(note()));
      editor.add(B, undefined, JSON.stringify(arrow()));
      editor.group(G, [A, B]);
      const copied = core.copy(editor, [G]);
      const atTop = { [A]: "d".repeat(32), [B]: "e".repeat(32), [G]: "f".repeat(32) };
      core.paste(editor, copied, atTop, undefined);
      expect(core.outermost(editor, atTop, undefined)).toEqual([atTop[G]]);
      const inside = { [A]: "1".repeat(32) };
      core.paste(editor, core.copy(editor, [A]), inside, G);
      expect(core.outermost(editor, inside, G)).toEqual([inside[A]]);
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

  it("plays the trim set of an image, and the whole of it once none is", () => {
    const editor = new core.Editor();
    try {
      editor.add(A, undefined, JSON.stringify(image()));
      const trim = { start: 0.25, end: 1.5 };
      core.setTrim(editor, [A], trim);
      const trimmed = core.element(editor, A)?.kind;
      expect(trimmed?.type === "image" && trimmed.edits?.trim).toEqual(trim);
      core.setTrim(editor, [A], undefined);
      const whole = core.element(editor, A)?.kind;
      expect(whole?.type === "image" && core.editsOf(whole)).not.toHaveProperty("trim");
      expect(() => editor.setSpeed([A], 40)).toThrow("no browser plays 40 times as fast");
    } finally {
      editor.free();
    }
  });

  it.each(["rectangle", "ellipse"] satisfies CropShape[])(
    "an image's crop set to a %s reads back as set",
    (crop_shape) => {
      const editor = new core.Editor();
      try {
        editor.add(A, undefined, JSON.stringify(image()));
        core.setCropShape(editor, [A], crop_shape);
        const kind = core.element(editor, A)?.kind;
        expect(kind?.type === "image" && (core.editsOf(kind).crop_shape ?? "rectangle")).toBe(
          crop_shape,
        );
      } finally {
        editor.free();
      }
    },
  );
});
