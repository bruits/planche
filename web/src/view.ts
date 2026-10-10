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
   * the drawing until this task ends, in the board's own colours, and never mirrored. `undefined`
   * when nothing is shown.
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
  /** Whether it shows the board in greys, which only the window does. */
  grey(on: boolean): void;
  greyed(): boolean;
  /**
   * Whether it shows the board mirrored left to right, about its centre, which only the window
   * does. The pointer acts on what shows under it.
   */
  mirror(on: boolean): void;
  mirrored(): boolean;
  pans(event: MouseEvent): boolean;
  /** Whether two fingers pan and zoom it, `pointer` one of them. */
  pinches(pointer: number): boolean;
  /** Whether a pointer pans it, or two fingers do. */
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
  /** Once nothing pans it any more. */
  panned(): void;
}

/**
 * How much a CSS pixel of scrolling zooms, so that a pinch, which browsers report as scrolling,
 * follows the fingers.
 */
const ZOOM_SPEED = 0.01;
/**
 * The most CSS pixels one wheel event zooms by, so that a mouse wheel's notch, or each event of a
 * quick trackpad scroll, zooms by a step.
 */
const LARGEST_ZOOM_STEP = 10;
/** CSS pixels per line, which some browsers count scrolling in. */
const LINE = 16;

/**
 * Scrolling pans, and zooms with Ctrl or ⌘ held, which is how browsers report pinching a
 * trackpad. The middle button pans, and so does the main one with the hand tool.
 */
export function view(
  host: HTMLElement,
  { advance, frame, painted, failed, panned }: Drawing,
): View {
  let shown: { renderer: Renderer; camera: Camera } | undefined;
  let pending = false;
  /** Whether the next frame draws, which a step alone does not ask for. */
  let drawing = false;
  let panning: { pointer: number; clientX: number; clientY: number } | undefined;
  let hand = false;
  let greyed = false;
  let mirrored = false;
  /** Safari's pinch, as the scale it has reached, `undefined` when none is under way. */
  let pinching: number | undefined;
  /** The fingers on the viewport, two at most. */
  const fingers = new Map<number, { clientX: number; clientY: number }>();
  const twoFingers = () => fingers.size === 2;
  const moving = () => panning !== undefined || twoFingers();
  const spread = () => {
    const [a, b] = fingers.values();
    return {
      clientX: (a!.clientX + b!.clientX) / 2,
      clientY: (a!.clientY + b!.clientY) / 2,
      apart: Math.hypot(b!.clientX - a!.clientX, b!.clientY - a!.clientY),
    };
  };
  const size = () => ({ width: host.clientWidth, height: host.clientHeight });
  const paint = (grey: boolean) => {
    if (!shown) {
      return undefined;
    }
    frame(shown.camera, size());
    shown.renderer.draw(shown.camera, grey);
    painted();
    return shown.renderer.canvas;
  };
  const draw = () => {
    try {
      paint(greyed);
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
  /** Where on the page the board shows what `clientX` is over. */
  const across = (clientX: number) => {
    if (!mirrored) {
      return clientX;
    }
    const box = host.getBoundingClientRect();
    return box.left + box.right - clientX;
  };
  /** Which way a move across the page goes across the board. */
  const sideways = () => (mirrored ? -1 : 1);
  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    if (shown) {
      const box = host.getBoundingClientRect();
      shown.camera = zoomAbout(shown.camera, factor, across(clientX) - box.left, clientY - box.top);
      redraw();
    }
  };
  const drag = (dx: number, dy: number) => {
    if (shown) {
      const { x, y, zoom } = shown.camera;
      shown.camera = { x: x - (sideways() * dx) / zoom, y: y - dy / zoom, zoom };
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
          const notch = Math.max(-LARGEST_ZOOM_STEP, Math.min(dy, LARGEST_ZOOM_STEP));
          zoomAt(Math.exp(-notch * ZOOM_SPEED), event.clientX, event.clientY);
        }
        return;
      }
      // A mouse wheel scrolls sideways with Shift on Windows and Linux, which browsers leave as is.
      if (event.shiftKey && dx === 0) {
        [dx, dy] = [dy, 0];
      }
      drag(-dx, -dy);
    },
    { passive: false },
  );
  // Pinching or Ctrl-scrolling anywhere else, over the toolbar say, would zoom the whole page.
  document.addEventListener("wheel", (event) => event.ctrlKey && event.preventDefault(), {
    passive: false,
  });
  document.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    pinching = 1;
  });
  document.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    if (pinching !== undefined) {
      // Fingers on the viewport pinch it themselves, which Safari reports as its own pinch too.
      if (fingers.size === 0) {
        zoomAt(event.scale / pinching, event.clientX, event.clientY);
      }
      pinching = event.scale;
    }
  });
  document.addEventListener("gestureend", (event) => {
    event.preventDefault();
    pinching = undefined;
  });
  const pans = (event: MouseEvent) =>
    event.button === 1 ||
    (event.button === 0 && !opensMenu(event) && hand) ||
    (twoFingers() && "pointerType" in event && event.pointerType === "touch");
  // Before anything over the board keeps a finger to itself, and before the board acts on it.
  host.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "touch" && fingers.size < 2) {
        fingers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
        if (twoFingers()) {
          stopPanning();
        }
      }
    },
    { capture: true },
  );
  // On the window, as a finger whose capture went moves over whatever lies under it.
  addEventListener(
    "pointermove",
    (event) => {
      const finger = fingers.get(event.pointerId);
      if (!finger) {
        return;
      }
      const from = twoFingers() ? spread() : undefined;
      finger.clientX = event.clientX;
      finger.clientY = event.clientY;
      if (from) {
        const to = spread();
        drag(to.clientX - from.clientX, to.clientY - from.clientY);
        // Fingers pressed together zoom nowhere.
        if (from.apart > 0 && to.apart > 0) {
          zoomAt(to.apart / from.apart, to.clientX, to.clientY);
        }
      }
    },
    { capture: true },
  );
  host.addEventListener("pointerdown", (event) => {
    if (panning === undefined && !twoFingers() && pans(event)) {
      // Middle-clicking would otherwise scroll on some platforms.
      event.preventDefault();
      panning = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY };
      host.setPointerCapture(event.pointerId);
      host.classList.add("panning");
    }
  });
  host.addEventListener("pointermove", (event) => {
    if (event.pointerId !== panning?.pointer) {
      return;
    }
    // From where the pointer last was, as not every engine counts `movementX` in CSS pixels, or for
    // each pointer apart.
    const [dx, dy] = [event.clientX - panning.clientX, event.clientY - panning.clientY];
    panning = { ...panning, clientX: event.clientX, clientY: event.clientY };
    drag(dx, dy);
  });
  const stopPanning = () => {
    panning = undefined;
    host.classList.remove("panning");
  };
  // A pan left on would follow the mouse without a button held. On the window, as for a finger's
  // moves.
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    addEventListener(
      type,
      (event) => {
        const was = moving();
        if (event.pointerId === panning?.pointer) {
          stopPanning();
        }
        if (type !== "lostpointercapture" || event.buttons === 0) {
          fingers.delete(event.pointerId);
        }
        if (was && !moving()) {
          panned();
        }
      },
      { capture: true },
    );
  }
  addEventListener("blur", () => {
    const was = moving();
    stopPanning();
    fingers.clear();
    if (was) {
      panned();
    }
  });
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
    drawNow() {
      const canvas = paint(false);
      if (greyed) {
        redraw();
      }
      return canvas;
    },
    at({ clientX, clientY }) {
      if (!shown) {
        return undefined;
      }
      const { x, y, zoom } = shown.camera;
      const box = host.getBoundingClientRect();
      return { x: x + (across(clientX) - box.left) / zoom, y: y + (clientY - box.top) / zoom };
    },
    client(point) {
      if (!shown) {
        return undefined;
      }
      const { x, y, zoom } = shown.camera;
      const box = host.getBoundingClientRect();
      return {
        clientX: across(box.left + (point.x - x) * zoom),
        clientY: box.top + (point.y - y) * zoom,
      };
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
    grey(on) {
      greyed = on;
      redraw();
    },
    greyed: () => greyed,
    mirror(on) {
      mirrored = on;
      host.classList.toggle("mirrored", on);
      // As what lies over the board follows it on each frame.
      redraw();
    },
    mirrored: () => mirrored,
    pans,
    pinches: (pointer) => twoFingers() && fingers.has(pointer),
    panning: moving,
  };
}

/** How far a wheel scrolls, in CSS pixels, as some browsers count in lines, or in pages `page` long. */
export function scrolled(event: WheelEvent, page: number): [number, number] {
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? LINE
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? page
        : 1;
  return [event.deltaX * unit, event.deltaY * unit];
}
