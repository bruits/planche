// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { writer } from "./writer.js";

function opened() {
  const done = vi.fn<() => void>();
  writer(document.body).open("Hello", () => {}, done);
  const field = document.querySelector<HTMLTextAreaElement>("textarea.writer")!;
  return { done, field };
}

function press(field: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  field.dispatchEvent(event);
  return event;
}

describe("the writer", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    ["Esc", { key: "Escape" }],
    ["⌘ Enter", { key: "Enter", metaKey: true }],
    ["Ctrl Enter", { key: "Enter", ctrlKey: true }],
  ])("closes on %s", (_, init) => {
    const { done, field } = opened();
    expect(press(field, init).defaultPrevented).toBe(true);
    expect(done).toHaveBeenCalledOnce();
    expect(field.hidden).toBe(true);
  });

  it.each([
    ["Esc while composing", { key: "Escape", isComposing: true }],
    ["Esc ending a composition", { key: "Escape", keyCode: 229 }],
    ["⌘ Enter ending a composition", { key: "Enter", metaKey: true, keyCode: 229 }],
  ])("stays open on %s, leaving the key to the input method", (_, init) => {
    const { done, field } = opened();
    expect(press(field, init).defaultPrevented).toBe(false);
    expect(done).not.toHaveBeenCalled();
    expect(field.hidden).toBe(false);
  });
});
