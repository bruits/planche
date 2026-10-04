// The field text is written in: a native one, which handles input methods, dead keys, and its
// own undo, laid over the element as the renderer draws its text, so that nothing moves once it
// is written. Pressing anywhere else, Esc, or ⌘ or Ctrl with Enter finishes it.

import { composing } from "./commands.js";
import { css } from "./paint.js";
import { opacityOf } from "./style.js";
import { FONT, LINE_HEIGHT, face, layout, paint, type Holder } from "./text.js";

export interface Writer {
  /** Calls `input` with each change, and `done` once it closes. */
  open(content: string, input: (content: string) => void, done: () => void): void;
  /** Over `kind`, whose frame's top-left is at `at` on the page, `zoom` CSS pixels per board unit. */
  follow(kind: Holder, at: { clientX: number; clientY: number }, zoom: number): void;
  /** As the bubble of a comment pinned at `at` on the page, as tall as what it holds. */
  bubble(at: { clientX: number; clientY: number }): void;
  close(): void;
}

/** Over `board`, whose style resolves the colours of what it draws, as the renderer's does. */
export function writer(board: HTMLElement): Writer {
  const field = document.createElement("textarea");
  field.className = "writer";
  field.setAttribute("aria-label", "Text");
  field.hidden = true;
  document.body.append(field);
  const style = (properties: Record<string, string>) => {
    // A copy, as the style's list shrinks as each property goes.
    for (const name of Array.from(field.style)) {
      field.style.removeProperty(name);
    }
    for (const [name, value] of Object.entries(properties)) {
      field.style.setProperty(name, value);
    }
  };
  let writing: { input: (content: string) => void; done: () => void } | undefined;
  const close = () => {
    // An input method still composing commits as the field loses the focus, which may close it.
    if (writing && document.activeElement === field) {
      field.blur();
    }
    const closing = writing;
    writing = undefined;
    field.hidden = true;
    closing?.done();
  };
  field.addEventListener("input", () => writing?.input(field.value));
  field.addEventListener("keydown", (event) => {
    if (composing(event)) {
      return;
    }
    if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      close();
    }
  });
  // Unless the window lost the focus, which gives it back to the field on return.
  field.addEventListener("blur", () => document.hasFocus() && close());
  // Before the board hears of the press, which may edit it.
  document.addEventListener("pointerdown", (event) => event.target !== field && close(), {
    capture: true,
  });
  return {
    open(content, input, done) {
      close();
      writing = { input, done };
      field.value = content;
      field.hidden = false;
      field.focus();
      field.setSelectionRange(content.length, content.length);
    },
    follow(kind, { clientX, clientY }, zoom) {
      const { frame, rotation, text } = kind;
      const size = text.font_size * zoom;
      const { area, align, top } = layout(kind);
      const { bold, italic } = face(kind);
      style({
        // As the renderer lays its text out.
        "font-family": FONT,
        "line-height": String(LINE_HEIGHT),
        left: `${clientX}px`,
        top: `${clientY}px`,
        width: `${frame.width * zoom}px`,
        height: `${frame.height * zoom}px`,
        "padding-left": `${area.x * size}px`,
        "padding-right": `${(frame.width / text.font_size - area.x - area.width) * size}px`,
        "padding-top": `${Math.max(top, 0) * size}px`,
        "font-size": `${size}px`,
        "font-weight": bold ? "700" : "400",
        "font-style": italic ? "italic" : "normal",
        "text-decoration": text.strike ? "line-through" : "none",
        "text-align": { left: "left", centre: "center", right: "right" }[align],
        // Faded as the renderer fades it, but for the caret, which would be hard to find.
        color: `color-mix(in srgb, ${css(paint(kind), board)} ${opacityOf(kind) * 100}%, transparent)`,
        "caret-color": css(paint(kind), board),
        transform: `rotate(${rotation}deg)`,
      });
      field.classList.remove("bubble");
      field.setAttribute("aria-label", "Text");
      // Grown to fit, it may still be scrolled to where the caret was.
      field.scrollTop = 0;
    },
    bubble({ clientX, clientY }) {
      field.classList.add("bubble");
      field.setAttribute("aria-label", "Comment");
      style({ left: `${clientX}px`, top: `${clientY}px`, height: "0" });
      const borders = field.offsetHeight - field.clientHeight;
      field.style.setProperty("height", `${field.scrollHeight + borders}px`);
    },
    close,
  };
}
