// A renderer that draws nothing, for tests of what surrounds the real one, which needs a GPU.

import type { Renderer } from "../src/renderer.js";
import { unfakedBy } from "./fakes.js";

const unfaked = unfakedBy("Renderer");

export function fakeRenderer(given: Partial<Renderer> = {}): Renderer {
  // Made once asked for, as tests in Node have no document.
  let canvas = given.canvas;
  return {
    backend: "fake",
    maxTextureSide: 16_384,
    textureBytes: 0,
    load: unfaked("load"),
    setImage: unfaked("setImage"),
    holds: () => false,
    release: unfaked("release"),
    animate: unfaked("animate"),
    show: unfaked("show"),
    copyVideo: unfaked("copyVideo"),
    setText: unfaked("setText"),
    dropText: unfaked("dropText"),
    place: unfaked("place"),
    backdrop: unfaked("backdrop"),
    restyle: unfaked("restyle"),
    draw() {},
    render: unfaked("render"),
    resize() {},
    destroy() {},
    ...given,
    get canvas() {
      return (canvas ??= document.createElement("canvas"));
    },
  };
}
