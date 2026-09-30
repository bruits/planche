// The viewport: the renderer it shows, and the camera that pans and zooms over it.

import type { Camera, Viewport } from "./camera.js";
import type { Point } from "./core.js";
import type { Renderer } from "./renderer.js";

export interface View {
  host: HTMLElement;
  size(): Viewport;
  /** Takes `renderer` over, and destroys the one shown before. */
  show(renderer: Renderer, camera: Camera): void;
  clear(): void;
  /** On the next frame, however often it is called before. */
  redraw(): void;
  /** Where on the board the event's pointer is, `undefined` when nothing is shown. */
  at(event: MouseEvent): Point | undefined;
  /** CSS pixels per board unit, `undefined` when nothing is shown. */
  zoom(): number | undefined;
}

export interface Drawing {
  /** After the renderer draws each frame. */
  drawn(camera: Camera, viewport: Viewport): void;
  failed(error: unknown): void;
}

/** The middle button pans, and so does the main one with Alt; the wheel zooms. */
export function view(host: HTMLElement, { drawn, failed }: Drawing): View {
  let shown: { renderer: Renderer; camera: Camera } | undefined;
  let pending = false;
  let panning: number | undefined;
  const size = () => ({ width: host.clientWidth, height: host.clientHeight });
  const draw = () => {
    if (!shown) {
      return;
    }
    try {
      shown.renderer.draw(shown.camera);
      drawn(shown.camera, size());
    } catch (error) {
      failed(error);
    }
  };
  const redraw = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        draw();
      });
    }
  };
  host.addEventListener(
    "wheel",
    (event) => {
      if (!shown) {
        return;
      }
      event.preventDefault();
      const { x, y, zoom } = shown.camera;
      const box = host.getBoundingClientRect();
      const [pointerX, pointerY] = [event.clientX - box.left, event.clientY - box.top];
      const zoomed = zoom * Math.exp(-event.deltaY * 0.002);
      shown.camera = {
        x: x + pointerX / zoom - pointerX / zoomed,
        y: y + pointerY / zoom - pointerY / zoomed,
        zoom: zoomed,
      };
      redraw();
    },
    { passive: false },
  );
  host.addEventListener("pointerdown", (event) => {
    if (panning === undefined && (event.button === 1 || (event.button === 0 && event.altKey))) {
      // Middle-clicking would otherwise scroll on some platforms.
      event.preventDefault();
      panning = event.pointerId;
      host.setPointerCapture(event.pointerId);
    }
  });
  host.addEventListener("pointermove", (event) => {
    if (shown && event.pointerId === panning) {
      const { x, y, zoom } = shown.camera;
      shown.camera = { x: x - event.movementX / zoom, y: y - event.movementY / zoom, zoom };
      redraw();
    }
  });
  // A pan left on would follow the mouse without a button held.
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    host.addEventListener(type, (event) => {
      if (event.pointerId === panning) {
        panning = undefined;
      }
    });
  }
  addEventListener("blur", () => (panning = undefined));
  const resize = () => {
    if (shown) {
      shown.renderer.resize(host.clientWidth, host.clientHeight);
      redraw();
    }
  };
  new ResizeObserver(resize).observe(host);
  // Moving to a display of another density resizes nothing in CSS pixels.
  const watchDensity = () => {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        resize();
        watchDensity();
      },
      { once: true },
    );
  };
  watchDensity();
  return {
    host,
    size,
    show(renderer, camera) {
      shown?.renderer.destroy();
      shown = { renderer, camera };
      // The viewport may have changed since the renderer was created.
      renderer.resize(host.clientWidth, host.clientHeight);
      draw();
    },
    clear() {
      shown?.renderer.destroy();
      shown = undefined;
    },
    redraw,
    at(event) {
      if (!shown) {
        return undefined;
      }
      const { x, y, zoom } = shown.camera;
      const box = host.getBoundingClientRect();
      return { x: x + (event.clientX - box.left) / zoom, y: y + (event.clientY - box.top) / zoom };
    },
    zoom: () => shown?.camera.zoom,
  };
}
