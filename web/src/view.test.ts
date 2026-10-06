// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Renderer } from "./renderer.js";
import { view } from "./view.js";

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Over a board shown from the origin at `zoom`, in a viewport 400 CSS pixels wide. */
function shown(zoom = 1) {
  const host = document.body.appendChild(document.createElement("div"));
  host.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  const viewport = view(host, {
    advance() {},
    frame() {},
    painted() {},
    failed(error) {
      throw error;
    },
  });
  const draw = vi.fn<Renderer["draw"]>();
  const renderer = {
    canvas: document.createElement("canvas"),
    resize() {},
    draw,
    destroy() {},
  };
  viewport.show(renderer as unknown as Renderer, { x: 0, y: 0, zoom });
  return { host, viewport, draw };
}

function wheel(host: HTMLElement, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { cancelable: true, ...init });
  // What happy-dom leaves out of a wheel event.
  const { ctrlKey = false, clientX = 0, clientY = 0 } = init;
  Object.defineProperties(event, {
    ctrlKey: { value: ctrlKey },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  host.dispatchEvent(event);
}

describe("a mirrored view", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows the board's left on the right, and finds under the pointer what shows there", () => {
    const { host, viewport } = shown(2);
    viewport.mirror(true);
    expect(host.classList.contains("mirrored")).toBe(true);
    expect(viewport.client({ x: 10, y: 20 })).toEqual({ clientX: 380, clientY: 40 });
    expect(viewport.at({ clientX: 380, clientY: 40 })).toEqual({ x: 10, y: 20 });
    viewport.mirror(false);
    expect(viewport.client({ x: 10, y: 20 })).toEqual({ clientX: 20, clientY: 40 });
  });

  it("scrolls the way the board shows", () => {
    const { host, viewport } = shown();
    viewport.mirror(true);
    wheel(host, { deltaX: 10 });
    expect(viewport.camera()).toEqual({ x: -10, y: 0, zoom: 1 });
  });

  it("pans the way the pointer drags what shows", () => {
    const { host, viewport } = shown();
    viewport.mirror(true);
    host.setPointerCapture = () => {};
    const press = (type: string, movementX = 0) => {
      const event = new PointerEvent(type, { button: 1, pointerId: 1 });
      // What happy-dom leaves out of a pointer event.
      Object.defineProperty(event, "movementX", { value: movementX });
      host.dispatchEvent(event);
    };
    press("pointerdown");
    press("pointermove", 10);
    press("pointerup");
    expect(viewport.camera()).toEqual({ x: 10, y: 0, zoom: 1 });
  });

  it("zooms around what the pointer is over", () => {
    const { host, viewport } = shown();
    viewport.mirror(true);
    const under = viewport.at({ clientX: 300, clientY: 100 });
    wheel(host, { deltaY: -10, ctrlKey: true, clientX: 300, clientY: 100 });
    expect(viewport.zoom()).toBeGreaterThan(1);
    const now = viewport.at({ clientX: 300, clientY: 100 })!;
    expect(now.x).toBeCloseTo(under!.x, 9);
    expect(now.y).toBeCloseTo(under!.y, 9);
  });
});

describe("a greyed view", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("draws in greys on each frame, but in the board's own colours when drawn at once", async () => {
    const { viewport, draw } = shown();
    viewport.grey(true);
    await nextFrame();
    expect(draw).toHaveBeenLastCalledWith(expect.anything(), true);
    viewport.drawNow();
    expect(draw).toHaveBeenLastCalledWith(expect.anything(), false);
    await nextFrame();
    expect(draw).toHaveBeenLastCalledWith(expect.anything(), true);
  });
});
