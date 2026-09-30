// Each image in its own element, moved by CSS transforms, which the browser composites.

import type { Quad, Renderer } from "./renderer.js";

export async function create(host: HTMLElement): Promise<Renderer> {
  const world = document.createElement("div");
  world.className = "dom-world";
  host.append(world);
  return {
    backend: "the browser's compositor",
    async load(quads: Quad[]) {
      for (const { bitmap, frame, rotation } of quads) {
        const image = document.createElement("canvas");
        image.width = bitmap.width;
        image.height = bitmap.height;
        image.getContext("bitmaprenderer")!.transferFromImageBitmap(bitmap);
        image.style.width = `${frame.width}px`;
        image.style.height = `${frame.height}px`;
        image.style.transform = `translate(${frame.x}px, ${frame.y}px) rotate(${rotation}deg)`;
        world.append(image);
      }
    },
    draw({ x, y, zoom }) {
      world.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    },
    resize() {},
    destroy() {
      world.remove();
    },
  };
}
