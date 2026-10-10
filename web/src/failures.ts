// Failures as the user meets them: an action's, said for a moment, a fault nothing caught, which
// stays until dismissed, and one the app cannot go on from, such as the core's panic or a lost
// GPU, which stays until the page reloads. Each is kept in the error log where there is one.

import { reloads } from "./commands.js";
import { clipped, described, GpuLost, message, NoRenderer, Panic } from "./errors.js";
import type { ErrorLog } from "./platform.js";

export interface FailureHooks {
  /** Says an action's failure for a moment. */
  say(text: string): void;
  log?: ErrorLog | undefined;
  copy(text: string): Promise<void>;
  /** What a report needs besides the failure, such as the browser and the GPU, a line each. */
  about(): string[];
  /** Writes what is left before the page reloads, as closing the window does, and whether all of it is safe. */
  closing(): Promise<boolean>;
  confirm(question: string): Promise<boolean>;
  /** At once, asking nothing more. */
  reload(): void;
  /** Once the app cannot go on, to halt what would go on calling into what failed. */
  halt(): void;
}

export interface Failures {
  /** An action's, unless the app cannot go on from it. */
  fail(error: unknown): void;
  report(work: Promise<unknown>): void;
  /** A fault of the app's that nothing caught, which it may go on from once `ready`. */
  uncaught(error: unknown): void;
  stop(error: unknown): void;
  /** Whether the app stopped, which what reaches the board without a key or a pointer asks. */
  stopped(): boolean;
  /** Once `starting` resolves, and never when it rejects, which stops the app. */
  started(starting: Promise<unknown>): Promise<void>;
  /** Once the app is set up, which a fault before leaves half done, stopping it. */
  ready(): void;
  /**
   * Hears what nothing caught on `target`: its errors, and promises' rejections. Once the app
   * stops, holds its keys and clipboard back from the rest of the app, which must come after,
   * and reloads by its keys as by the panel's.
   */
  watch(target: EventTarget): void;
}

/** How much of a failure the message shows. */
const SHOWN = 300;
/** How much of a failure the log keeps, a stack's worth. */
const LOGGED = 8_000;
/** How many of the latest failures the log skips repeats of, as a few may fail on every frame. */
const RECENT = 8;
const RELOADING = "Reload, and lose the changes to this board?";
/** In milliseconds, how long a reload waits for the last saves, which a stopped app may never end. */
const RELOAD_WAIT = 5000;

/** The failures that stay show at the top of `host`, the toolbar's column. */
export function failures(host: HTMLElement, hooks: FailureHooks): Failures {
  // Always there, even empty, as screen readers only follow a live region that already shows.
  const panel = document.createElement("div");
  panel.className = "failure";
  const text = document.createElement("p");
  text.setAttribute("role", "alert");
  const actions = document.createElement("div");
  panel.append(text, actions);
  host.prepend(panel);

  let stopped = false;
  let ready = false;
  /** Whether an uncaught failure shows, which the next ones leave in place as the first is the cause. */
  let showing = false;
  /** The latest entries logged, without their time, newest first. */
  const recent: string[] = [];
  let reloadButton: HTMLButtonElement | undefined;
  let reloading: Promise<void> | undefined;

  const keep = (kind: string, error: unknown): string => {
    const told = `${kind}: ${clipped(described(error), LOGGED)}`;
    const entry = `${new Date().toISOString()} ${told}`;
    if (!recent.includes(told)) {
      recent.unshift(told);
      recent.length = Math.min(recent.length, RECENT);
      // Nowhere is left to tell of it, as the log is where failures go.
      hooks.log?.append(`${entry}\n`).catch((failed: unknown) => {
        console.warn("The error log failed:", failed);
      });
    }
    return [entry, ...hooks.about()].join("\n");
  };
  /** Returns its last button, which `closing` names. */
  const show = (said: string, details: string, closing: [string, () => void]) => {
    text.textContent = said;
    const copy = button("Copy details", () => {
      hooks.copy(details).then(
        () => (copy.textContent = "Copied"),
        () => (copy.textContent = "Not copied"),
      );
    });
    const last = button(...closing);
    actions.replaceChildren(copy, last);
    panel.classList.add("showing");
    return last;
  };
  const dismiss = () => {
    showing = false;
    text.textContent = "";
    actions.replaceChildren();
    panel.classList.remove("showing");
  };

  const reloadSafely = async () => {
    if (reloadButton) {
      reloadButton.textContent = "Saving…";
    }
    // A throw, as from what failed before it was set up, is as unsafe as a refusal.
    const saved = (async () => hooks.closing())().catch(() => false);
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<boolean>((resolve) => {
      waiting = setTimeout(resolve, RELOAD_WAIT, false);
    });
    const safe = await Promise.race([saved, waited]);
    clearTimeout(waiting);
    // A failed dialog reloads all the same, as the user asked to leave an app that cannot go on.
    if (safe || (await hooks.confirm(RELOADING).catch(() => true))) {
      hooks.reload();
    } else if (reloadButton) {
      reloadButton.textContent = "Reload";
    }
  };
  const reload = () => {
    reloading ??= reloadSafely()
      .catch((failed: unknown) => console.warn("Reloading failed:", failed))
      .finally(() => (reloading = undefined));
  };

  const stop = (error: unknown) => {
    if (stopped) {
      return;
    }
    stopped = true;
    const details = keep("Stopped", error);
    reloadButton = show(stopping(error), details, ["Reload", reload]);
    // The rest of the page takes no pointer or focus, as edits made on a board that no longer
    // shows would still be saved.
    document.documentElement.toggleAttribute("data-stopped", true);
    let kept: Element = panel;
    while (kept.parentElement && kept !== document.body) {
      for (const other of kept.parentElement.children) {
        if (other !== kept && other instanceof HTMLElement) {
          other.inert = true;
        }
      }
      kept = kept.parentElement;
    }
    hooks.halt();
  };
  const fail = (error: unknown) => {
    if (stopped) {
      return;
    }
    if (trapped(error)) {
      stop(error);
      return;
    }
    keep("Failed", error);
    hooks.say(message(error));
  };
  const uncaught = (error: unknown) => {
    if (stopped) {
      return;
    }
    if (trapped(error) || !ready) {
      stop(error);
      return;
    }
    const details = keep("Uncaught", error);
    if (!showing) {
      showing = true;
      show(`Something went wrong: ${clipped(message(error), SHOWN)}`, details, [
        "Dismiss",
        dismiss,
      ]);
    }
  };
  const held = (event: Event) => {
    if (!stopped) {
      return;
    }
    event.stopImmediatePropagation();
    if (event.type === "keydown" && event instanceof KeyboardEvent && reloads(event)) {
      event.preventDefault();
      reload();
    }
  };

  return {
    fail,
    report(work) {
      work.catch(fail);
    },
    uncaught,
    stop,
    stopped: () => stopped,
    async started(starting) {
      try {
        await starting;
      } catch (error) {
        stop(error);
        await new Promise<never>(() => {});
      }
    },
    ready() {
      ready = true;
    },
    watch(target) {
      target.addEventListener("error", (event) => {
        // One without an error is nothing of the app's, such as ResizeObserver's notice of a
        // loop, or a script from another origin.
        if (event instanceof ErrorEvent && event.error != null) {
          uncaught(event.error);
        }
      });
      target.addEventListener("unhandledrejection", (event) =>
        uncaught("reason" in event ? event.reason : event),
      );
      for (const type of ["keydown", "keyup", "cut", "copy", "paste"]) {
        target.addEventListener(type, held, { capture: true });
      }
    },
  };
}

/** What the panel says of a failure the app cannot go on from. */
function stopping(error: unknown): string {
  if (trapped(error)) {
    return "Planche hit a bug and stopped working";
  }
  if (error instanceof NoRenderer) {
    return "Planche cannot draw on this device";
  }
  if (error instanceof GpuLost) {
    return "Planche lost the GPU and stopped working";
  }
  return `Planche stopped working: ${clipped(message(error), SHOWN)}`;
}

/** Whether a WASM module stopped on a bug of its own. */
function trapped(error: unknown): boolean {
  return error instanceof Panic || error instanceof WebAssembly.RuntimeError;
}

function button(label: string, press: () => void): HTMLButtonElement {
  const made = document.createElement("button");
  made.type = "button";
  made.textContent = label;
  made.addEventListener("click", press);
  return made;
}
