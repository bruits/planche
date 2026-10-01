// Picks a colour from the board as it shows, under the pointer. A loupe follows the pointer with
// the pixels around it, read back from the renderer, so that it works in every webview, which a
// page's eyedropper does not.

/** Pixels across the loupe reads, an odd number so that one sits in the middle. */
export const ACROSS = 11;
/** How wide each pixel shows in the loupe, in CSS pixels. */
const ZOOMED = 7;
/** From the pointer, in CSS pixels. */
const OFFSET = 18;

export interface SamplerHost {
  /** The `ACROSS` pixels square around the device pixel under `at`, as the board shows them. */
  read(at: { clientX: number; clientY: number }): Promise<ImageData | undefined>;
  /** Once a colour is picked. */
  picked(colour: `#${string}`): void;
  /** Once it starts or ends. */
  changed(): void;
}

export interface Sampler {
  /** Until S is let go when `holding`, otherwise until a click. */
  start(holding: boolean): void;
  /** With the colour under the pointer, unless `cancel`. */
  end(cancel?: boolean): void;
  sampling(): "holding" | "clicking" | undefined;
}

export function sampler(host: SamplerHost, board: HTMLElement): Sampler {
  const loupe = document.createElement("div");
  loupe.className = "loupe";
  loupe.setAttribute("aria-hidden", "true");
  const pixels = Object.assign(document.createElement("canvas"), { width: ACROSS, height: ACROSS });
  pixels.style.setProperty("width", `${ACROSS * ZOOMED}px`);
  pixels.style.setProperty("height", `${ACROSS * ZOOMED}px`);
  // Around the canvas, which draws nothing over itself, for the mark on the middle pixel.
  const lens = document.createElement("div");
  lens.className = "lens";
  lens.append(pixels);
  const hex = document.createElement("span");
  loupe.append(lens, hex);
  loupe.hidden = true;
  document.body.append(loupe);
  const context = pixels.getContext("2d")!;

  let mode: "holding" | "clicking" | undefined;
  let pointer: { clientX: number; clientY: number } | undefined;
  let colour: `#${string}` | undefined;
  /** One read at a time, then one for wherever the pointer went meanwhile. */
  let reading = false;
  let again = false;
  addEventListener("pointermove", (event) => {
    pointer = { clientX: event.clientX, clientY: event.clientY };
    if (mode) {
      follow();
      read();
    }
  });
  // Picks before the board hears of the click, which leaves it alone while picking.
  board.addEventListener(
    "pointerdown",
    (event) => {
      if (mode === "clicking" && event.button === 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pointer = { clientX: event.clientX, clientY: event.clientY };
        end();
      }
    },
    { capture: true },
  );
  addEventListener("blur", () => end(true));

  const follow = () => {
    if (!pointer) {
      return;
    }
    const { width, height } = loupe.getBoundingClientRect();
    const right = pointer.clientX + OFFSET + width <= innerWidth;
    const above = pointer.clientY - OFFSET - height >= 0;
    loupe.style.setProperty("left", `${right ? pointer.clientX + OFFSET : pointer.clientX - OFFSET - width}px`);
    loupe.style.setProperty("top", `${above ? pointer.clientY - OFFSET - height : pointer.clientY + OFFSET}px`);
  };
  const read = () => {
    if (reading) {
      again = true;
      return;
    }
    const at = pointer;
    if (!at) {
      return;
    }
    reading = true;
    host
      .read(at)
      .then((image) => {
        if (image && mode) {
          context.putImageData(image, 0, 0);
          const middle = (Math.floor(ACROSS / 2) * ACROSS + Math.floor(ACROSS / 2)) * 4;
          const [red, green, blue] = image.data.slice(middle, middle + 3);
          colour = `#${[red!, green!, blue!].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
          hex.textContent = colour;
          loupe.style.setProperty("--picked", colour);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        reading = false;
        if (again && mode) {
          again = false;
          read();
        }
      });
  };
  const end = (cancel = false) => {
    if (!mode) {
      return;
    }
    mode = undefined;
    loupe.hidden = true;
    board.classList.remove("sampling");
    const picked = colour;
    colour = undefined;
    host.changed();
    if (!cancel && picked) {
      host.picked(picked);
    }
  };

  return {
    start(holding) {
      if (mode) {
        return;
      }
      mode = holding ? "holding" : "clicking";
      colour = undefined;
      hex.textContent = "";
      loupe.hidden = false;
      board.classList.add("sampling");
      follow();
      read();
      host.changed();
    },
    end,
    sampling: () => mode,
  };
}
