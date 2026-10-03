// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { tauri } from "./tauri.js";

/** The desktop shell, which answers its confirm dialog with `answer`. */
function shell(answer: boolean) {
  let closing: (() => Promise<void>) | undefined;
  const sent: string[] = [];
  const api: TauriApi = {
    core: {
      Channel: class {
        onmessage() {}
      },
      async invoke(command: string) {
        sent.push(command);
        // Only the confirm dialog answers anything that matters here.
        return (command === "confirm" ? answer : undefined) as never;
      },
    },
    event: {
      async listen(name: string, handler: (event: { payload: never }) => void) {
        if (name === "closing") {
          // The page's handler is async, though typed as returning nothing.
          closing = async () => handler({ payload: undefined as never });
        }
        return () => {};
      },
    },
  };
  const close = () => closing!();
  return { api, sent, close };
}

describe("tauri", () => {
  it("closing an unsaved board asks first, and keeps the window when the user declines", async () => {
    const { api, sent, close } = shell(false);
    tauri(api).whenClosing!(async () => false);
    await close();
    expect(sent).toEqual(["confirm", "keep_window"]);
  });

  it("closing an unsaved board asks first, and closes the window when the user agrees", async () => {
    const { api, sent, close } = shell(true);
    tauri(api).whenClosing!(async () => false);
    await close();
    expect(sent).toEqual(["confirm", "close_window"]);
  });

  it("closing a board whose save fails asks first", async () => {
    const { api, sent, close } = shell(false);
    tauri(api).whenClosing!(async () => {
      throw new Error("disk full");
    });
    await close();
    expect(sent).toEqual(["confirm", "keep_window"]);
  });

  it("closing a saved board closes without asking", async () => {
    const { api, sent, close } = shell(false);
    tauri(api).whenClosing!(async () => true);
    await close();
    expect(sent).toEqual(["close_window"]);
  });
});
