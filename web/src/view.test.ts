// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Point } from "./core.js";
import type { Renderer } from "./renderer.js";
import { view, type Drawing, type View } from "./view.js";

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Over a board shown from the origin at `zoom`, in a viewport 400 CSS pixels wide. */
function shown(zoom = 1) {
  const host = document.body.appendChild(document.createElement("div"));
  host.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  const panned = vi.fn<Drawing["panned"]>();
  const viewport = view(host, {
    advance() {},
    frame() {},
    painted() {},
    failed(error) {
      throw error;
    },
    panned,
  });
  const draw = vi.fn<Renderer["draw"]>();
  const renderer = {
    canvas: document.createElement("canvas"),
    resize() {},
    draw,
    destroy() {},
  };
  viewport.show(renderer as unknown as Renderer, { x: 0, y: 0, zoom });
  return { host, viewport, draw, panned };
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

function pointer(host: HTMLElement, type: string, init: PointerEventInit) {
  host.setPointerCapture = () => {};
  host.dispatchEvent(new PointerEvent(type, { pointerId: 1, ...init }));
}

describe("a pan", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("follows the finger across the page, whatever movement its moves report", () => {
    const { host, viewport } = shown(2);
    viewport.hand(true);
    const touch = { pointerType: "touch", movementX: 300, movementY: 300 };
    pointer(host, "pointerdown", { ...touch, button: 0, clientX: 100, clientY: 100 });
    pointer(host, "pointermove", { ...touch, clientX: 110, clientY: 104 });
    pointer(host, "pointermove", { ...touch, clientX: 130, clientY: 120 });
    expect(viewport.camera()).toEqual({ x: -15, y: -10, zoom: 2 });
  });

  it("follows the pen alone, whatever a finger beside it does", () => {
    const { host, viewport } = shown();
    viewport.hand(true);
    const [pen, touch] = [{ pointerType: "pen" }, { pointerType: "touch", pointerId: 2 }];
    pointer(host, "pointerdown", { ...pen, button: 0, clientX: 100 });
    pointer(host, "pointerdown", { ...touch, button: 0, clientX: 300 });
    pointer(host, "pointermove", { ...touch, clientX: 200 });
    pointer(host, "pointermove", { ...pen, clientX: 120 });
    expect(viewport.camera()).toEqual({ x: -20, y: 0, zoom: 1 });
  });

  it("starts again from where the next press is", () => {
    const { host, viewport } = shown();
    viewport.hand(true);
    pointer(host, "pointerdown", { button: 0, clientX: 100 });
    pointer(host, "pointermove", { clientX: 120 });
    pointer(host, "pointerup", { clientX: 120 });
    pointer(host, "pointerdown", { button: 0, pointerId: 2, clientX: 300 });
    pointer(host, "pointermove", { pointerId: 2, clientX: 310 });
    expect(viewport.camera()).toEqual({ x: -30, y: 0, zoom: 1 });
  });
});

function finger(
  host: HTMLElement,
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
) {
  pointer(host, type, { pointerType: "touch", button: 0, pointerId, clientX, clientY });
}

/** As some engines let a finger's capture go, while still pressed or not. */
function captureLost(host: HTMLElement, pointerId: number, buttons: number) {
  pointer(host, "lostpointercapture", { pointerType: "touch", pointerId, buttons });
}

/** Safari's own pinch, at `scale` since it started. */
function gesture(type: string, scale: number) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    scale: { value: scale },
    clientX: { value: 200 },
    clientY: { value: 150 },
  });
  document.dispatchEvent(event);
}

function keeps(viewport: View, points: [number, number][], under: Point[]) {
  points.forEach(([clientX, clientY], at) => {
    const now = viewport.at({ clientX, clientY })!;
    expect(now.x).toBeCloseTo(under[at]!.x, 9);
    expect(now.y).toBeCloseTo(under[at]!.y, 9);
  });
}

function pinch(host: HTMLElement, viewport: View) {
  const under = [100, 200].map((clientX) => viewport.at({ clientX, clientY: 100 })!);
  finger(host, "pointerdown", 1, 100, 100);
  finger(host, "pointerdown", 2, 200, 100);
  finger(host, "pointermove", 2, 300, 100);
  finger(host, "pointermove", 1, 120, 160);
  finger(host, "pointermove", 2, 170, 160);
  keeps(
    viewport,
    [
      [120, 160],
      [170, 160],
    ],
    under,
  );
}

describe("two fingers", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keep under them what they pressed, as they spread, go together, or close", () => {
    const { host, viewport } = shown();
    pinch(host, viewport);
    expect(viewport.zoom()).toBeCloseTo(0.5, 9);
  });

  it("tell once one lifts, as the hand tool's pan does once let go", () => {
    const { host, viewport, panned } = shown();
    panned.mockImplementation(() => expect(viewport.panning()).toBe(false));
    finger(host, "pointerdown", 1, 100, 100);
    finger(host, "pointerdown", 2, 200, 100);
    finger(host, "pointerup", 1, 100, 100);
    finger(host, "pointerup", 2, 200, 100);
    expect(panned).toHaveBeenCalledTimes(1);
    viewport.hand(true);
    finger(host, "pointerdown", 3, 100, 100);
    expect(panned).toHaveBeenCalledTimes(1);
    finger(host, "pointerup", 3, 100, 100);
    expect(panned).toHaveBeenCalledTimes(2);
  });

  it("pan nothing once one lifts", () => {
    const { host, viewport } = shown();
    pinch(host, viewport);
    const camera = viewport.camera();
    finger(host, "pointerup", 2, 170, 160);
    finger(host, "pointermove", 1, 200, 200);
    expect(viewport.camera()).toEqual(camera);
    expect(viewport.panning()).toBe(false);
  });

  it("take the hand tool's pan over", () => {
    const { host, viewport } = shown();
    viewport.hand(true);
    finger(host, "pointerdown", 1, 100, 100);
    finger(host, "pointermove", 1, 110, 100);
    expect(viewport.camera()).toEqual({ x: -10, y: 0, zoom: 1 });
    const under = [110, 210].map((clientX) => viewport.at({ clientX, clientY: 100 })!);
    finger(host, "pointerdown", 2, 210, 100);
    finger(host, "pointermove", 1, 60, 100);
    keeps(
      viewport,
      [
        [60, 100],
        [210, 100],
      ],
      under,
    );
  });

  it("leave Safari's own pinch to them", () => {
    const { host, viewport } = shown();
    finger(host, "pointerdown", 1, 100, 100);
    finger(host, "pointerdown", 2, 200, 100);
    gesture("gesturestart", 1);
    gesture("gesturechange", 2);
    gesture("gestureend", 2);
    expect(viewport.zoom()).toBe(1);
    finger(host, "pointerup", 1, 100, 100);
    finger(host, "pointerup", 2, 200, 100);
    gesture("gesturestart", 1);
    gesture("gesturechange", 2);
    gesture("gestureend", 2);
    expect(viewport.zoom()).toBe(2);
  });

  it("go on once a finger's capture goes while it is still held", () => {
    const { host, viewport } = shown();
    pinch(host, viewport);
    expect(viewport.zoom()).toBeCloseTo(0.5, 9);
    captureLost(host, 2, 1);
    expect(viewport.panning()).toBe(true);
    // Spread to twice as far apart as the pinch left them.
    finger(host, "pointermove", 2, 220, 160);
    expect(viewport.zoom()).toBeCloseTo(1, 9);
  });

  it("let go of a finger once its capture goes with nothing held", () => {
    const { host, viewport } = shown();
    pinch(host, viewport);
    const camera = viewport.camera();
    captureLost(host, 2, 0);
    expect(viewport.panning()).toBe(false);
    finger(host, "pointermove", 1, 200, 200);
    expect(viewport.camera()).toEqual(camera);
    // The next finger down is the second one again.
    finger(host, "pointerdown", 3, 300, 200);
    expect(viewport.panning()).toBe(true);
  });

  it("forget a finger lifted beside the viewport", () => {
    const { host, viewport } = shown();
    // As the toolbar, which a finger whose capture went lifts over.
    const beside = document.body.appendChild(document.createElement("div"));
    finger(host, "pointerdown", 1, 100, 100);
    finger(host, "pointerdown", 2, 200, 100);
    finger(host, "pointerup", 1, 100, 100);
    finger(beside, "pointerup", 2, 200, 400);
    finger(host, "pointerdown", 3, 100, 100);
    expect(viewport.panning()).toBe(false);
  });

  it("follow a finger moving beside the viewport, as the toolbar, once its capture went", () => {
    const { host, viewport } = shown();
    const beside = document.body.appendChild(document.createElement("div"));
    const under = [100, 200].map((clientX) => viewport.at({ clientX, clientY: 100 })!);
    finger(host, "pointerdown", 1, 100, 100);
    finger(host, "pointerdown", 2, 200, 100);
    captureLost(host, 2, 1);
    finger(beside, "pointermove", 2, 300, 100);
    finger(host, "pointermove", 1, 120, 160);
    finger(beside, "pointermove", 2, 170, 160);
    finger(beside, "pointerup", 2, 170, 160);
    keeps(
      viewport,
      [
        [120, 160],
        [170, 160],
      ],
      under,
    );
    expect(viewport.zoom()).toBeCloseTo(0.5, 9);
  });

  it("are all forgotten once the window loses focus", () => {
    const { host, viewport } = shown();
    finger(host, "pointerdown", 1, 100, 100);
    finger(host, "pointerdown", 2, 200, 100);
    expect(viewport.panning()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(viewport.panning()).toBe(false);
    // Two new ones pinch, as the old ones, lifted unseen, would otherwise keep their places.
    finger(host, "pointerdown", 3, 100, 100);
    finger(host, "pointerdown", 4, 200, 100);
    finger(host, "pointermove", 4, 300, 100);
    expect(viewport.zoom()).toBeCloseTo(2, 9);
  });
});

describe("a zoom", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("goes a tenth at most for each notch of a wheel, whether it counts in pixels or lines", () => {
    const { host, viewport } = shown();
    wheel(host, { deltaY: 100, ctrlKey: true });
    expect(viewport.zoom()).toBeCloseTo(Math.exp(-0.1), 9);
    wheel(host, { deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE, ctrlKey: true });
    expect(viewport.zoom()).toBeCloseTo(1, 9);
  });

  it("follows the fingers of a gentle pinch", () => {
    const { host, viewport } = shown();
    // As browsers report a pinch that spreads the fingers by 5%.
    wheel(host, { deltaY: -100 * Math.log(1.05), ctrlKey: true });
    expect(viewport.zoom()).toBeCloseTo(1.05, 9);
  });
});

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
    pointer(host, "pointerdown", { button: 1, clientX: 100 });
    pointer(host, "pointermove", { clientX: 110 });
    pointer(host, "pointerup", { clientX: 110 });
    expect(viewport.camera()).toEqual({ x: 10, y: 0, zoom: 1 });
  });

  it("pinches the way the fingers drag what shows", () => {
    const { host, viewport } = shown();
    viewport.mirror(true);
    pinch(host, viewport);
    expect(viewport.zoom()).toBeCloseTo(0.5, 9);
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
