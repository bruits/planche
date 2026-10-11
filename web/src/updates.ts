// New versions of the desktop app, which it checks for unless the user turned that off, and
// offers above the toolbar. Installing one relaunches the app, so the board is saved first, and
// takes no edit after, as none would be saved.

import { reloads } from "./commands.js";
import { message } from "./errors.js";
import { button, HELD, isolate } from "./failures.js";
import type { Updater } from "./platform.js";
import { recall, remember } from "./preferences.js";

export interface UpdateHooks {
  /** Writes what is left, as closing the window does, and whether all of it is safe. */
  closing(): Promise<boolean>;
  confirm(question: string): Promise<boolean>;
  report(work: Promise<unknown>): void;
}

/** Whether the app checks for new versions, which only the user changes. */
export interface Updating {
  /** Ready to hear of a new version, then checking unless the user turned it off. */
  serve(): Promise<void>;
  allow(on: boolean): Promise<void>;
  allowed(): boolean;
  /** Whether a new version is going in place, after which no edit may land, as the app quits. */
  installing(): boolean;
  /**
   * Holds the keys and the clipboard of `target` back from the rest of the app while a new version
   * goes in place, which must come after.
   */
  watch(target: EventTarget): void;
}

/** Where the browser remembers that checks are off, as they are on until the user says. */
const CHECKS = "planche.updates";
const LOSING = "Update, and lose the changes to this board?";

/** A new version shows at the top of `host`, the toolbar's column. */
export function updating(
  host: HTMLElement,
  updater: Updater | undefined,
  hooks: UpdateHooks,
): Updating {
  // Always there, even empty, as screen readers only follow a live region that already shows.
  const panel = document.createElement("div");
  panel.className = "notice";
  const text = document.createElement("p");
  text.setAttribute("role", "status");
  const actions = document.createElement("div");
  panel.append(text, actions);
  host.prepend(panel);

  let allowed = false;
  /** The newest version found, which a check may tell of while another one downloads. */
  let newest: string | undefined;
  /** Whether a new version is downloading or going in place. */
  let busy = false;
  let installing = false;

  const hide = () => {
    text.textContent = "";
    actions.replaceChildren();
    panel.classList.remove("showing");
  };
  const show = (said: string, ...buttons: [string, () => void][]) => {
    text.textContent = said;
    actions.replaceChildren(...buttons.map(([label, press]) => button(label, press)));
    panel.classList.add("showing");
  };
  const offer = (version: string) => {
    show(
      `Planche ${version} is out`,
      ["Update", () => hooks.report(update(version))],
      ["Later", hide],
    );
  };

  const install = async (version: string, installer: Updater) => {
    installing = true;
    show(`Installing Planche ${version}…`);
    document.documentElement.toggleAttribute("data-installing", true);
    const release = isolate(panel);
    const resume = () => {
      release();
      document.documentElement.toggleAttribute("data-installing", false);
      installing = false;
    };
    // A throw, as from a save that failed, is as unsafe as a refusal.
    const safe = await hooks.closing().catch(() => false);
    if (!safe && !(await hooks.confirm(LOSING).catch(() => false))) {
      resume();
      return;
    }
    try {
      await installer.install(version);
    } catch (error) {
      resume();
      throw failed(`Planche ${version} could not be installed`, error);
    }
    // Held as it is until the app relaunches, which may come after the shell answered.
  };
  const update = async (version: string) => {
    if (updater === undefined || busy) {
      return;
    }
    busy = true;
    try {
      show(`Downloading Planche ${version}…`);
      await updater
        .download(version, (done, total) => {
          const share = total === undefined ? "" : ` ${Math.floor((done / total) * 100)}%`;
          text.textContent = `Downloading Planche ${version}…${share}`;
        })
        .catch((error: unknown) => {
          throw failed(`Planche ${version} could not be downloaded`, error);
        });
      await install(version, updater);
    } finally {
      // Still busy once the new version went in place, until the app relaunches.
      busy = installing;
      if (!busy) {
        offer(newest ?? version);
      }
    }
  };

  const held = (event: Event) => {
    if (!installing) {
      return;
    }
    event.stopImmediatePropagation();
    // A reload would leave the page without the notice until the app relaunches.
    if (event.type === "keydown" && event instanceof KeyboardEvent && reloads(event)) {
      event.preventDefault();
    }
  };

  const found = (version: string, stuck: string | undefined) => {
    newest = version;
    // A check that was under way may still answer once the user turned checks off.
    if (!allowed || busy) {
      return;
    }
    if (stuck === undefined) {
      offer(version);
    } else {
      show(`Planche ${version} is out. ${stuck}`, ["Dismiss", hide]);
    }
  };
  const allow = async (on: boolean) => {
    await updater?.allow(on);
    allowed = on;
    remember(CHECKS, on ? undefined : "off");
    if (!on && !busy) {
      hide();
    }
  };

  return {
    async serve() {
      if (updater === undefined) {
        return;
      }
      await updater.watch(found);
      await allow(recall(CHECKS) !== "off");
    },
    allow,
    allowed: () => allowed,
    installing: () => installing,
    watch(target) {
      for (const type of HELD) {
        target.addEventListener(type, held, { capture: true });
      }
    },
  };
}

/** What failed, with why, as the shell's own words never tell it is the update's. */
function failed(what: string, error: unknown): Error {
  return new Error(`${what}: ${message(error)}`, { cause: error });
}
