// Keys and pointers as a user presses them, for tests in happy-dom.

export function press(
  init: KeyboardEventInit,
  target: EventTarget = document.body,
  type: "keydown" | "keyup" = "keydown",
): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function release(
  init: KeyboardEventInit,
  target: EventTarget = document.body,
): KeyboardEvent {
  return press(init, target, "keyup");
}

export function pointer(
  target: EventTarget,
  type: string,
  init: PointerEventInit = {},
): PointerEvent {
  const event = new PointerEvent(type, { pointerId: 1, bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function captureLost(target: EventTarget, init: PointerEventInit = {}): PointerEvent {
  return pointer(target, "lostpointercapture", init);
}

export function pressAway(): void {
  pointer(document.body, "pointerdown");
}
