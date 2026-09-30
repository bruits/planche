// The icons of the toolbar and its menus, from Tabler Icons (https://tabler.io/icons), outline,
// on a 24 grid.
//
// Tabler Icons, MIT License. Copyright (c) 2020-2026 Paweł Kuna. Permission is hereby granted,
// free of charge, to any person obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without restriction, including without
// limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions: The above copyright notice and this permission notice
// shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS
// PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
// TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

const SVG = "http://www.w3.org/2000/svg";

const paths = {
  pointer: [
    "M7.904 17.563a1.2 1.2 0 0 0 2.228 .308l2.09 -3.093l4.907 4.907a1.067 1.067 0 0 0 1.509 0l1.047 -1.047a1.067 1.067 0 0 0 0 -1.509l-4.907 -4.907l3.113 -2.09a1.2 1.2 0 0 0 -.309 -2.228l-13.582 -3.904l3.904 13.563",
  ],
  hand: [
    "M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5",
    "M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5",
    "M14 5.5a1.5 1.5 0 0 1 3 0v6.5",
    "M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47",
  ],
  arrow: ["M5 12l14 0", "M15 16l4 -4", "M15 8l4 4"],
  line: ["M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M16 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M7.5 16.5l9 -9"],
  square: ["M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14"],
  circle: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"],
  cross: ["M18 6l-12 12", "M6 6l12 12"],
  typography: ["M4 20l3 0", "M14 20l7 0", "M6.9 15l6.9 0", "M10.2 6.3l5.8 13.7", "M5 20l6 -16l2 0l7 16"],
  note: ["M13 20l7 -7", "M13 20v-6a1 1 0 0 1 1 -1h6v-7a2 2 0 0 0 -2 -2h-12a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7"],
  photo: [
    "M15 8h.01",
    "M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12",
    "M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5",
    "M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3",
  ],
  chevron: ["M6 9l6 6l6 -6"],
  menu: [
    "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  ],
};

export type Icon = keyof typeof paths;

/** Hidden from assistive technologies, which read its button's label. */
export function icon(name: Icon): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  const attributes = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [name, value] of Object.entries(attributes)) {
    svg.setAttribute(name, value);
  }
  for (const d of paths[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
