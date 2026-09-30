// The 2D canvas API, as Excalidraw draws.

import { canvas, size, type Quad, type Renderer } from "./renderer.js";

export async function create(host: HTMLElement, width: number, height: number): Promise<Renderer> {
  const output = canvas(host, width, height);
  const context = output.getContext("2d")!;
  let quads: Quad[] = [];
  return {
    backend: "the browser's 2D canvas",
    async load(loaded) {
      quads = loaded;
    },
    draw({ x, y, zoom }) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, output.width, output.height);
      // Mipmapped, like the GPU candidates. Resizing resets it.
      context.imageSmoothingQuality = "medium";
      const scale = zoom * devicePixelRatio;
      for (const { bitmap, frame, rotation } of quads) {
        const [centreX, centreY] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
        context.setTransform(scale, 0, 0, scale, (centreX - x) * scale, (centreY - y) * scale);
        context.rotate((rotation * Math.PI) / 180);
        context.drawImage(bitmap, -frame.width / 2, -frame.height / 2, frame.width, frame.height);
      }
    },
    resize(width, height) {
      size(output, width, height);
    },
    destroy() {
      quads.forEach(({ bitmap }) => bitmap.close());
      output.remove();
    },
  };
}
