// What stands in for the window's title bar while it hides.

import { opensMenu, type Command } from "./commands.js";
import { dress, explanation } from "./toolbar.js";

export function handle(
  host: HTMLElement,
  board: HTMLElement,
  drag: () => void,
  leave: Command,
): void {
  const button = document.createElement("button");
  button.type = "button";
  dress(button, { command: leave, icon: "window" });
  // Its own, as compact mode hides the line of hints that names the toolbar's buttons.
  button.title = explanation(leave);
  button.addEventListener("click", () => leave.run());
  host.append(button);
  host.addEventListener("pointerdown", (event) => {
    // At once, as the window only follows while the button is still down, and without selecting
    // the page's text.
    if (event.button === 0 && !opensMenu(event) && event.target === host) {
      event.preventDefault();
      drag();
    }
  });
  host.addEventListener("wheel", (event) => board.dispatchEvent(new WheelEvent(event.type, event)));
  // While the drop is under way, as its files are only readable until then.
  host.addEventListener("drop", (event) => board.dispatchEvent(new DragEvent(event.type, event)));
  host.addEventListener("contextmenu", (event) =>
    board.dispatchEvent(new MouseEvent(event.type, event)),
  );
}
