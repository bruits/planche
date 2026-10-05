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
        const answers: Record<string, unknown> = {
          confirm: answer,
          keyboard_layout: [["KeyQ", "a"]],
        };
        return answers[command] as never;
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
  it("reads what each key types alone from the shell, by where it sits", async () => {
    const { api } = shell(true);
    expect(await tauri(api).layout!()).toEqual(new Map([["KeyQ", "a"]]));
  });

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
