// The field text is written in: a native one, which handles input methods, dead keys, and its
// own undo, laid over the element as the renderer draws its text, so that nothing moves once it
// is written. Pressing anywhere else, Esc, or ⌘ or Ctrl with Enter finishes it.

import { FONT, LINE_HEIGHT, layout, type Holder } from "./text.js";

export interface Writer {
  /** Calls `input` with each change, and `done` once it closes. */
  open(content: string, input: (content: string) => void, done: () => void): void;
  /** Over `kind`, whose frame's top-left is at `at` on the page, `zoom` CSS pixels per board unit. */
  follow(kind: Holder, at: { clientX: number; clientY: number }, zoom: number): void;
  close(): void;
}

export function writer(): Writer {
  const field = document.createElement("textarea");
  field.className = "writer";
  field.setAttribute("aria-label", "Text");
  field.hidden = true;
  // As the renderer lays its text out.
  field.style.setProperty("font-family", FONT);
  field.style.setProperty("line-height", String(LINE_HEIGHT));
  document.body.append(field);
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
    if (event.isComposing) {
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
  document.addEventListener("pointerdown", (event) => event.target !== field && close(), { capture: true });
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
      const { area, centred, top } = layout(kind);
      const properties = {
        left: `${clientX}px`,
        top: `${clientY}px`,
        width: `${frame.width * zoom}px`,
        height: `${frame.height * zoom}px`,
        "padding-left": `${area.x * size}px`,
        "padding-right": `${(frame.width / text.font_size - area.x - area.width) * size}px`,
        "padding-top": `${Math.max(top, 0) * size}px`,
        "font-size": `${size}px`,
        "text-align": centred ? "center" : "left",
        transform: `rotate(${rotation}deg)`,
      };
      for (const [name, value] of Object.entries(properties)) {
        field.style.setProperty(name, value);
      }
      field.classList.toggle("sticky", kind.type === "sticky");
      // Grown to fit, it may still be scrolled to where the caret was.
      field.scrollTop = 0;
    },
    close,
  };
}
