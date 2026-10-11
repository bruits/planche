// The viewport as the app mounts it, for tests in happy-dom.

import { vi } from "vitest";
import type { Renderer } from "../src/renderer.js";
import { view, type Drawing } from "../src/view.js";
import { fakeRenderer } from "./renderers.js";

export function mounted({
  zoom = 1,
  drawing = {},
  renderer = fakeRenderer(),
}: { zoom?: number; drawing?: Partial<Drawing>; renderer?: Renderer } = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  sized(host, 400, 300);
  const panned = vi.fn<Drawing["panned"]>();
  const viewport = view(host, {
    advance() {},
    frame() {},
    painted() {},
    failed(error) {
      throw error;
    },
    panned,
    ...drawing,
  });
  viewport.show(renderer, { x: 0, y: 0, zoom });
  return { host, viewport, panned };
}

/** As the page lays `host` out at its corner, which happy-dom does not. */
export function sized(host: HTMLElement, width: number, height: number): void {
  host.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
  Object.defineProperties(host, {
    clientWidth: { value: width, configurable: true },
    clientHeight: { value: height, configurable: true },
  });
}
