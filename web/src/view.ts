// The viewport: the renderer it shows, and the camera that pans and zooms over it.

import type { Camera, Viewport } from "./camera.js";
import type { Renderer } from "./renderer.js";

export interface View {
  host: HTMLElement;
  size(): Viewport;
  /** Takes `renderer` over, and destroys the one shown before. */
  show(renderer: Renderer, camera: Camera): void;
  clear(): void;
  /** On the next frame, however often it is called before. */
  redraw(): void;
}

export function view(host: HTMLElement): View {
  let shown: { renderer: Renderer; camera: Camera } | undefined;
  let pending = false;
  const size = () => ({ width: host.clientWidth, height: host.clientHeight });
  const redraw = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        shown?.renderer.draw(shown.camera);
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
  host.addEventListener("pointerdown", (event) => host.setPointerCapture(event.pointerId));
  host.addEventListener("pointermove", (event) => {
    if (shown && host.hasPointerCapture(event.pointerId)) {
      const { x, y, zoom } = shown.camera;
      shown.camera = { x: x - event.movementX / zoom, y: y - event.movementY / zoom, zoom };
      redraw();
    }
  });
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
      renderer.draw(camera);
    },
    clear() {
      shown?.renderer.destroy();
      shown = undefined;
    },
    redraw,
  };
}
