// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { GpuLost, NoRenderer, Panic } from "./errors.js";
import { failures, type FailureHooks } from "./failures.js";
import type { ErrorLog } from "./platform.js";

function app({ ready = true } = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const log = {
    append: vi.fn<ErrorLog["append"]>(async () => {}),
    show: vi.fn<ErrorLog["show"]>(async () => true),
  };
  const hooks = {
    say: vi.fn<FailureHooks["say"]>(),
    log,
    copy: vi.fn<FailureHooks["copy"]>(async () => {}),
    about: () => ["Safari 26", "wgpu WebGPU, Apple M5"],
    closing: vi.fn<FailureHooks["closing"]>(async () => true),
    confirm: vi.fn<FailureHooks["confirm"]>(async () => true),
    reload: vi.fn<FailureHooks["reload"]>(),
    halt: vi.fn<FailureHooks["halt"]>(),
  };
  const failing = failures(host, hooks);
  if (ready) {
    failing.ready();
  }
  const shown = () => {
    const panel = host.querySelector(".failure")!;
    return panel.classList.contains("showing") ? panel.querySelector("p")!.textContent : undefined;
  };
  const press = (label: string) =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
  const logged = () => log.append.mock.calls.map(([entry]) => entry);
  return { host, hooks, failing, shown, press, logged };
}

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("an action's failure", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-stopped");
  });

  it("is said for a moment, and kept in the log", () => {
    const { hooks, failing, shown, logged } = app();
    failing.fail(new Error("Not saved into Board: the disk is full"));
    expect(hooks.say).toHaveBeenCalledExactlyOnceWith("Not saved into Board: the disk is full");
    expect(shown()).toBeUndefined();
    expect(logged()).toEqual([
      expect.stringMatching(/^\S+ Failed: Error: Not saved into Board: the disk is full\n/),
    ]);
  });

  it("is said once the work reported fails", async () => {
    const { hooks, failing } = app();
    failing.report(Promise.reject(new Error("The folder is not empty")));
    await settled();
    expect(hooks.say).toHaveBeenCalledExactlyOnceWith("The folder is not empty");
  });

  it("goes into the log once when it fails on every frame", () => {
    const { hooks, failing, logged } = app();
    for (let frame = 0; frame < 3; frame += 1) {
      failing.fail(new Error("the canvas cannot be drawn to"));
    }
    expect(hooks.say).toHaveBeenCalledTimes(3);
    expect(logged()).toHaveLength(1);
  });

  it("goes into the log once when two fail in turn on every frame", () => {
    const { hooks, failing, logged } = app();
    for (let frame = 0; frame < 30; frame += 1) {
      failing.fail(new Error("the press could not catch up"));
      failing.fail(new Error("the canvas cannot be drawn to"));
    }
    expect(hooks.say).toHaveBeenCalledTimes(60);
    expect(logged()).toHaveLength(2);
  });

  it("goes into the log again once enough other failures came between", () => {
    const { failing, logged } = app();
    failing.fail(new Error("the disk is full"));
    for (let other = 0; other < 8; other += 1) {
      failing.fail(new Error(`the folder ${other} is gone`));
    }
    failing.fail(new Error("the disk is full"));
    expect(logged()).toHaveLength(10);
  });
});

describe("a fault nothing caught", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-stopped");
  });

  it("stays until dismissed, with its details to copy", async () => {
    const { host, hooks, failing, shown, press } = app();
    const target = new EventTarget();
    failing.watch(target);
    const fault = new TypeError("the board is undefined");
    target.dispatchEvent(new ErrorEvent("error", { error: fault, message: fault.message }));
    expect(shown()).toBe("Something went wrong: the board is undefined");
    press("Copy details");
    await settled();
    const [details] = hooks.copy.mock.calls[0]!;
    expect(details).toContain("Uncaught: TypeError: the board is undefined");
    expect(details).toMatch(/\nSafari 26\nwgpu WebGPU, Apple M5$/);
    expect(host.textContent).toContain("Copied");
    press("Dismiss");
    expect(shown()).toBeUndefined();
    expect(hooks.say).not.toHaveBeenCalled();
    expect(hooks.halt).not.toHaveBeenCalled();
  });

  it("shows a promise's rejection too", () => {
    const { failing, shown, logged } = app();
    const target = new EventTarget();
    failing.watch(target);
    const reason = new Error("the shell did not answer");
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
    expect(shown()).toBe("Something went wrong: the shell did not answer");
    expect(logged()).toEqual([
      expect.stringContaining("Uncaught: Error: the shell did not answer"),
    ]);
  });

  it("stops the app when a module traps, as wasm's async calls report it", () => {
    const { hooks, failing, shown } = app();
    const target = new EventTarget();
    failing.watch(target);
    const trap = new WebAssembly.RuntimeError("unreachable");
    target.dispatchEvent(new ErrorEvent("error", { error: trap, message: trap.message }));
    expect(shown()).toBe("Planche hit a bug and stopped working");
    expect(hooks.halt).toHaveBeenCalledOnce();
    expect(hooks.say).not.toHaveBeenCalled();
  });

  it("leaves out an error that carries nothing of the app's, such as ResizeObserver's notice", () => {
    const { failing, shown, logged } = app();
    const target = new EventTarget();
    failing.watch(target);
    const notice = "ResizeObserver loop completed with undelivered notifications.";
    target.dispatchEvent(new ErrorEvent("error", { message: notice }));
    expect(shown()).toBeUndefined();
    expect(logged()).toEqual([]);
  });

  it("leaves the first in sight and logs the next", () => {
    const { failing, shown, logged } = app();
    failing.uncaught(new Error("first"));
    failing.uncaught(new Error("second"));
    expect(shown()).toBe("Something went wrong: first");
    expect(logged()).toHaveLength(2);
  });

  it("says when the details could not be copied", async () => {
    const { host, hooks, failing, press } = app();
    hooks.copy.mockRejectedValue(new Error("denied"));
    failing.uncaught(new Error("lost"));
    press("Copy details");
    await settled();
    expect(host.textContent).toContain("Not copied");
  });
});

describe("a failure the app cannot go on from", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-stopped");
  });

  it("stops the app when it fails to start, offers to reload, and never goes on", async () => {
    const { hooks, failing, shown, press, logged } = app({ ready: false });
    let started = false;
    void failing
      .started(Promise.reject(new TypeError("Failed to fetch bindings_bg.wasm")))
      .then(() => (started = true));
    await settled();
    expect(started).toBe(false);
    expect(shown()).toBe("Planche stopped working: Failed to fetch bindings_bg.wasm");
    expect(hooks.halt).toHaveBeenCalledOnce();
    expect(logged()).toEqual([expect.stringContaining("Stopped: TypeError: Failed to fetch")]);
    press("Reload");
    await settled();
    expect(hooks.reload).toHaveBeenCalledOnce();
  });

  it("lets the app go on once it starts", async () => {
    const { failing, shown } = app({ ready: false });
    await failing.started(Promise.resolve());
    expect(shown()).toBeUndefined();
  });

  it("stops the app when a fault leaves it half set up", () => {
    const { hooks, failing, shown } = app({ ready: false });
    failing.uncaught(new TypeError("the toolbar is null"));
    expect(shown()).toBe("Planche stopped working: the toolbar is null");
    expect(hooks.halt).toHaveBeenCalledOnce();
  });

  it("says a panic plainly, keeps where it happened in the details, and leaves alone what fails after", () => {
    const { hooks, failing, shown, logged } = app();
    failing.stop(new Panic("panicked at crates/board/src/edit.rs:12:5:\na sibling"));
    // What calling into the module that panicked throws next.
    failing.fail(new WebAssembly.RuntimeError("unreachable"));
    failing.uncaught(new Error("recursive use of an object detected"));
    failing.stop("the GPU is lost");
    expect(shown()).toBe("Planche hit a bug and stopped working");
    expect(logged()).toEqual([
      expect.stringContaining("Stopped: Panic: panicked at crates/board/src/edit.rs:12:5"),
    ]);
    expect(hooks.halt).toHaveBeenCalledOnce();
    expect(hooks.say).not.toHaveBeenCalled();
  });

  it("says plainly when nothing can draw here, keeping wgpu's words in the details", () => {
    const { failing, shown, logged } = app();
    failing.stop(new NoRenderer("Failed to create surface for any enabled backend"));
    expect(shown()).toBe("Planche cannot draw on this device");
    expect(logged()).toEqual([
      expect.stringContaining("Stopped: NoRenderer: Failed to create surface"),
    ]);
  });

  it("says plainly that the GPU is lost, keeping the browser's words in the details", () => {
    const { failing, shown, logged } = app();
    failing.stop(new GpuLost("Device was lost due to an unknown reason"));
    expect(shown()).toBe("Planche lost the GPU and stopped working");
    expect(logged()).toEqual([
      expect.stringContaining("Stopped: GpuLost: Device was lost due to an unknown reason"),
    ]);
  });

  it("stops the app when an action meets a module that trapped", () => {
    const { hooks, failing, shown } = app();
    failing.fail(new WebAssembly.RuntimeError("unreachable"));
    expect(shown()).toBe("Planche hit a bug and stopped working");
    expect(hooks.halt).toHaveBeenCalledOnce();
    expect(hooks.say).not.toHaveBeenCalled();
  });

  it("leaves nothing to edit on a board that no longer shows, but the way to reload", async () => {
    const { host, hooks, failing, press } = app();
    const board = document.body.appendChild(document.createElement("div"));
    const bar = host.appendChild(document.createElement("div"));
    const target = new EventTarget();
    failing.watch(target);
    const keyed = vi.fn<(event: Event) => void>();
    target.addEventListener("keydown", keyed);
    target.addEventListener("paste", keyed);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(keyed).toHaveBeenCalledOnce();
    failing.stop("the GPU is lost");
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    target.dispatchEvent(new Event("paste"));
    expect(keyed).toHaveBeenCalledOnce();
    expect([board.inert, bar.inert, host.inert]).toEqual([true, true, false]);
    expect(document.documentElement.hasAttribute("data-stopped")).toBe(true);
    press("Reload");
    await settled();
    expect(hooks.reload).toHaveBeenCalledOnce();
  });

  it("holds back keys pressed on its own buttons, and reloads by a reload's keys as by its own", async () => {
    const { host, hooks, failing } = app();
    failing.watch(host);
    const keyed = vi.fn<(event: Event) => void>();
    host.addEventListener("keydown", keyed);
    failing.stop("the GPU is lost");
    const reload = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Reload",
    )!;
    reload.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    expect(keyed).not.toHaveBeenCalled();
    const pressed = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    reload.dispatchEvent(pressed);
    expect(pressed.defaultPrevented).toBe(true);
    await settled();
    expect(hooks.reload).toHaveBeenCalledOnce();
    expect(keyed).not.toHaveBeenCalled();
  });

  it("leaves the defaults of other keys and of copying once stopped", async () => {
    const { host, hooks, failing } = app();
    failing.watch(host);
    failing.stop("the GPU is lost");
    const reload = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Reload",
    )!;
    const others = [
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }),
      new Event("copy", { bubbles: true, cancelable: true }),
    ];
    for (const event of others) {
      reload.dispatchEvent(event);
    }
    await settled();
    expect(others.map((event) => event.defaultPrevented)).toEqual([false, false, false, false]);
    expect(hooks.closing).not.toHaveBeenCalled();
    expect(hooks.reload).not.toHaveBeenCalled();
  });

  it("takes the place of a fault that shows", () => {
    const { failing, shown } = app();
    failing.uncaught(new Error("first"));
    failing.stop("the GPU is lost");
    expect(shown()).toBe("Planche stopped working: the GPU is lost");
  });
});

describe("a reload once the app stopped", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-stopped");
  });

  it("goes at once when all is saved", async () => {
    const { hooks, failing, press } = app();
    failing.stop("the GPU is lost");
    press("Reload");
    await settled();
    expect(hooks.closing).toHaveBeenCalledOnce();
    expect(hooks.confirm).not.toHaveBeenCalled();
    expect(hooks.reload).toHaveBeenCalledOnce();
  });

  it("asks before losing what could not be saved, and stays when the user declines", async () => {
    const { host, hooks, failing, press } = app();
    hooks.closing.mockResolvedValue(false);
    hooks.confirm.mockResolvedValue(false);
    failing.stop("the GPU is lost");
    press("Reload");
    expect(host.textContent).toContain("Saving…");
    await settled();
    expect(hooks.confirm).toHaveBeenCalledExactlyOnceWith(
      "Reload, and lose the changes to this board?",
    );
    expect(hooks.reload).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Reload");
    press("Reload");
    await settled();
    expect(hooks.confirm).toHaveBeenCalledTimes(2);
  });

  it("asks when saving throws at once, as what failed before it was set up does", async () => {
    const { hooks, failing, press } = app({ ready: false });
    hooks.closing.mockImplementation(() => {
      throw new ReferenceError("Cannot access 'life' before initialization");
    });
    failing.uncaught(new TypeError("the toolbar is null"));
    press("Reload");
    await settled();
    expect(hooks.confirm).toHaveBeenCalledOnce();
    expect(hooks.reload).toHaveBeenCalledOnce();
  });

  it("asks once saving takes longer than a stopped app may", async () => {
    vi.useFakeTimers();
    const { hooks, failing, press } = app();
    hooks.closing.mockReturnValue(new Promise(() => {}));
    failing.stop("the GPU is lost");
    press("Reload");
    await vi.advanceTimersByTimeAsync(4999);
    expect(hooks.confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.confirm).toHaveBeenCalledOnce();
    expect(hooks.reload).toHaveBeenCalledOnce();
  });

  it("reloads all the same when it cannot ask", async () => {
    const { hooks, failing, press } = app();
    hooks.closing.mockResolvedValue(false);
    hooks.confirm.mockRejectedValue(new Error("the dialog is gone"));
    failing.stop("the GPU is lost");
    press("Reload");
    await settled();
    expect(hooks.reload).toHaveBeenCalledOnce();
  });

  it("saves once, however often pressed meanwhile", async () => {
    const { host, hooks, failing, press } = app();
    let save: ((safe: boolean) => void) | undefined;
    hooks.closing.mockReturnValue(new Promise((resolve) => (save = resolve)));
    failing.watch(host);
    failing.stop("the GPU is lost");
    press("Reload");
    // The same button, relabelled.
    press("Saving…");
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", repeat: true }));
    save?.(true);
    await settled();
    expect(hooks.closing).toHaveBeenCalledOnce();
    expect(hooks.reload).toHaveBeenCalledOnce();
  });
});
