// The viewport: the renderer it shows, and the camera that pans and zooms over it.

import { zoomAbout, type Camera, type Viewport } from "./camera.js";
import { opensMenu } from "./commands.js";
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
  /** Advances on the next frame as `redraw` does, but draws only if a redraw asks for it by then. */
  step(): void;
  /**
   * Draws at once, without waiting for a frame, which a hidden window never gets. The canvas holds
   * the drawing until this task ends. `undefined` when nothing is shown.
   */
  drawNow(): HTMLCanvasElement | undefined;
  /** Where on the board a point of the page is, `undefined` when nothing is shown. */
  at(point: { clientX: number; clientY: number }): Point | undefined;
  /** Where on the page a point of the board is, `undefined` when nothing is shown. */
  client(point: Point): { clientX: number; clientY: number } | undefined;
  /** Where on the board the viewport's centre is, `undefined` when nothing is shown. */
  centre(): Point | undefined;
  /** CSS pixels per board unit, `undefined` when nothing is shown. */
  zoom(): number | undefined;
  /** `undefined` when nothing is shown. */
  camera(): Camera | undefined;
  /** Moves the camera, when something is shown. */
  look(camera: Camera): void;
  /** Around the viewport's centre, when something is shown. */
  zoomBy(factor: number): void;
  /** Whether the main button pans, as the hand tool makes it. */
  hand(on: boolean): void;
  pans(event: MouseEvent): boolean;
  panning(): boolean;
}

export interface Drawing {
  /** Before each frame a redraw or a step asked for, so that what waited for it shows in it. */
  advance(): void;
  /** Before the renderer draws each frame. */
  frame(camera: Camera, viewport: Viewport): void;
  /** Once it drew one, which the GPU may not have finished yet. */
  painted(): void;
  failed(error: unknown): void;
}

/** How much a CSS pixel of scrolling zooms. */
const ZOOM_SPEED = 0.01;
/** The most CSS pixels of scrolling that zoom at once, so that a mouse wheel's notch zooms by a step. */
const LARGEST_ZOOM_STEP = 25;
/** CSS pixels per line, which some browsers count scrolling in. */
const LINE = 16;

/**
 * Scrolling pans, and zooms with Ctrl or ⌘ held, which is how browsers report pinching a
 * trackpad. The middle button pans, and so does the main one with Alt or the hand tool.
 */
export function view(host: HTMLElement, { advance, frame, painted, failed }: Drawing): View {
  let shown: { renderer: Renderer; camera: Camera } | undefined;
  let pending = false;
  /** Whether the next frame draws, which a step alone does not ask for. */
  let drawing = false;
  let panning: number | undefined;
  let hand = false;
  /** Safari's pinch, as the scale it has reached, `undefined` when none is under way. */
  let pinching: number | undefined;
  const size = () => ({ width: host.clientWidth, height: host.clientHeight });
  const paint = () => {
    if (!shown) {
      return undefined;
    }
    frame(shown.camera, size());
    shown.renderer.draw(shown.camera);
    painted();
    return shown.renderer.canvas;
  };
  const draw = () => {
    try {
      paint();
    } catch (error) {
      failed(error);
    }
  };
  const step = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => {
        // The redraws it asks for are this frame's.
        try {
          advance();
        } finally {
          pending = false;
          // Before drawing, as what the draw shows may ask for the next frame's.
          if (drawing) {
            drawing = false;
            draw();
          }
        }
      });
    }
  };
  const redraw = () => {
    drawing = true;
    step();
  };
  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    if (shown) {
      const box = host.getBoundingClientRect();
      shown.camera = zoomAbout(shown.camera, factor, clientX - box.left, clientY - box.top);
      redraw();
    }
  };
  host.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (!shown) {
        return;
      }
      let [dx, dy] = scrolled(event, host.clientHeight);
      if (event.ctrlKey || event.metaKey) {
        // Safari may report its pinch both ways.
        if (pinching === undefined) {
          const step = Math.max(-LARGEST_ZOOM_STEP, Math.min(dy, LARGEST_ZOOM_STEP));
          zoomAt(Math.exp(-step * ZOOM_SPEED), event.clientX, event.clientY);
        }
        return;
      }
      // A mouse wheel scrolls sideways with Shift on Windows and Linux, which browsers leave as is.
      if (event.shiftKey && dx === 0) {
        [dx, dy] = [dy, 0];
      }
      const { x, y, zoom } = shown.camera;
      shown.camera = { x: x + dx / zoom, y: y + dy / zoom, zoom };
      redraw();
    },
    { passive: false },
  );
  // Pinching or Ctrl-scrolling anywhere else, over the toolbar say, would zoom the whole page.
  document.addEventListener("wheel", (event) => event.ctrlKey && event.preventDefault(), { passive: false });
  document.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    pinching = 1;
  });
  document.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    if (pinching !== undefined) {
      zoomAt(event.scale / pinching, event.clientX, event.clientY);
      pinching = event.scale;
    }
  });
  document.addEventListener("gestureend", (event) => {
    event.preventDefault();
    pinching = undefined;
  });
  const pans = (event: MouseEvent) =>
    event.button === 1 || (event.button === 0 && !opensMenu(event) && (event.altKey || hand));
  host.addEventListener("pointerdown", (event) => {
    if (panning === undefined && pans(event)) {
      // Middle-clicking would otherwise scroll on some platforms.
      event.preventDefault();
      panning = event.pointerId;
      host.setPointerCapture(event.pointerId);
      host.classList.add("panning");
    }
  });
  host.addEventListener("pointermove", (event) => {
    if (shown && event.pointerId === panning) {
      const { x, y, zoom } = shown.camera;
      shown.camera = { x: x - event.movementX / zoom, y: y - event.movementY / zoom, zoom };
      redraw();
    }
  });
  const stopPanning = () => {
    panning = undefined;
    host.classList.remove("panning");
  };
  // A pan left on would follow the mouse without a button held.
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    host.addEventListener(type, (event) => {
      if (event.pointerId === panning) {
        stopPanning();
      }
    });
  }
  addEventListener("blur", stopPanning);
  const resize = () => {
    if (shown) {
      shown.renderer.resize(host.clientWidth, host.clientHeight);
      // At once, as resizing clears the canvas, and the next frame's draw comes after this one shows.
      draw();
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
    step,
    drawNow: paint,
    at({ clientX, clientY }) {
      if (!shown) {
        return undefined;
      }
      const { x, y, zoom } = shown.camera;
      const box = host.getBoundingClientRect();
      return { x: x + (clientX - box.left) / zoom, y: y + (clientY - box.top) / zoom };
    },
    client(point) {
      if (!shown) {
        return undefined;
      }
      const { x, y, zoom } = shown.camera;
      const box = host.getBoundingClientRect();
      return { clientX: box.left + (point.x - x) * zoom, clientY: box.top + (point.y - y) * zoom };
    },
    centre() {
      if (!shown) {
        return undefined;
      }
      const { x, y, zoom } = shown.camera;
      return { x: x + host.clientWidth / 2 / zoom, y: y + host.clientHeight / 2 / zoom };
    },
    zoom: () => shown?.camera.zoom,
    camera: () => shown?.camera,
    look(camera) {
      if (shown) {
        shown.camera = camera;
        redraw();
      }
    },
    zoomBy(factor) {
      const box = host.getBoundingClientRect();
      zoomAt(factor, box.left + box.width / 2, box.top + box.height / 2);
    },
    hand(on) {
      hand = on;
      host.classList.toggle("hand", on);
    },
    pans,
    panning: () => panning !== undefined,
  };
}

/** How far a wheel scrolls, in CSS pixels, as some browsers count in lines, or in pages `page` long. */
export function scrolled(event: WheelEvent, page: number): [number, number] {
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? page : 1;
  return [event.deltaX * unit, event.deltaY * unit];
}
