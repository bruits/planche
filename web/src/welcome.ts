// The welcome over an empty board, until the first edit on this browser.

import type { Board } from "./core.js";
import { recall, remember } from "./preferences.js";

/** Where the browser remembers that the welcome is done with. */
const WELCOME = "planche.welcome";
/** The least room between the arrow's tip and the toolbar, in CSS pixels. */
const CLEARANCE = 24;
const SVG = "http://www.w3.org/2000/svg";
const TILT = "rotate(-6 32 36)";
/** The logo without its highlight, each tint laid over the board's colour. */
const LOGO: [string, Record<string, string>][] = [
  [
    "rect",
    {
      class: "frame",
      x: "12.75",
      y: "20.75",
      width: "38.5",
      height: "30.5",
      rx: "5",
      "stroke-width": "2.5",
      transform: TILT,
    },
  ],
  [
    "path",
    {
      class: "frame",
      d: "M18 45L26 37C27.6 35.5 29.4 35.5 31 37L37 43M35 41L37.5 38.5C39 37 40.8 37 42.4 38.5L46 42",
      "stroke-width": "2.2",
      transform: TILT,
    },
  ],
  ["circle", { class: "under", cx: "32", cy: "21.2", r: "6" }],
  ["circle", { class: "rim", cx: "32", cy: "21.2", r: "6" }],
  ["circle", { class: "under", cx: "32", cy: "20.2", r: "6" }],
  ["circle", { class: "head", cx: "32", cy: "20.2", r: "6" }],
];
const ARROW: [string, Record<string, string>][] = [
  ["path", { d: "M12 4C46 9 46 41 4 71M12.9 69.8L4 71L8 62.9" }],
];

export interface Welcome {
  follow(board: Board): void;
  end(): void;
  quietsHint(): boolean;
  fit(): void;
}

/** `floor` gives the toolbar's top edge, in CSS pixels from the window's top. */
export function welcome(host: HTMLElement, floor: () => number): Welcome {
  const layer = document.createElement("div");
  layer.className = "welcome";
  const start = document.createElement("p");
  start.textContent = "Drop or paste images anywhere";
  const tools = document.createElement("p");
  tools.className = "tools";
  tools.textContent = "Or pick a tool below";
  const arrow = drawing("arrow", "0 0 52 76", ARROW);
  tools.append(arrow);
  layer.append(drawing("logo", "8 10 48 48", LOGO), start, tools);
  host.append(layer);

  let ended = recall(WELCOME) === "done";
  /** `undefined` until a board shows. */
  let empty: boolean | undefined;
  const shows = () => !ended && empty === true;
  const fit = () => {
    if (shows()) {
      arrow.classList.toggle("cramped", arrow.getBoundingClientRect().bottom + CLEARANCE > floor());
    }
  };
  const show = () => {
    layer.classList.toggle("shown", shows());
    fit();
  };
  addEventListener("resize", fit);
  return {
    follow(board) {
      // Another window of this browser may have ended it since.
      ended ||= recall(WELCOME) === "done";
      empty = board.draw_order.length === 0;
      show();
    },
    end() {
      if (!ended) {
        ended = true;
        remember(WELCOME, "done");
        show();
      }
    },
    quietsHint: () => !ended && empty !== false,
    fit,
  };
}

/** Hidden from assistive technologies, as the text says it all. */
function drawing(
  className: string,
  viewBox: string,
  shapes: [string, Record<string, string>][],
): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(SVG, tag);
    for (const [attribute, value] of Object.entries(attributes)) {
      shape.setAttribute(attribute, value);
    }
    svg.append(shape);
  }
  return svg;
}
