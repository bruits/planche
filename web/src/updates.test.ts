// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, tick } from "../test/waits.js";
import type { Updater } from "./platform.js";
import { updating, type UpdateHooks } from "./updates.js";

const MOVE = "Move it to Applications to update it";

/** The desktop shell's updater, whose download and install wait until the test lets them end. */
function shell() {
  let heard: ((version: string, stuck: string | undefined) => void) | undefined;
  let progress: ((done: number, total: number | undefined) => void) | undefined;
  const downloaded = deferred();
  const installed = deferred();
  const steps: string[] = [];
  const updater = {
    watch: vi.fn<Updater["watch"]>(async (found) => {
      heard = found;
    }),
    allow: vi.fn<Updater["allow"]>(async () => {}),
    download: vi.fn<Updater["download"]>(async (_version, told) => {
      steps.push("download");
      progress = told;
      await downloaded.promise;
    }),
    install: vi.fn<Updater["install"]>(async () => {
      steps.push("install");
      await installed.promise;
    }),
  };
  return {
    updater,
    steps,
    downloaded,
    installed,
    find: (version: string, stuck?: string) => heard!(version, stuck),
    progress: (done: number, total?: number) => progress!(done, total),
  };
}

function app({ safe = true, losing = true } = {}) {
  const page = document.body.appendChild(document.createElement("main"));
  const host = document.body.appendChild(document.createElement("div"));
  const { updater, ...rest } = shell();
  const hooks = {
    closing: vi.fn<UpdateHooks["closing"]>(async () => {
      rest.steps.push("closing");
      return safe;
    }),
    confirm: vi.fn<UpdateHooks["confirm"]>(async () => losing),
    report: vi.fn<UpdateHooks["report"]>((work) => {
      work.catch(() => {});
    }),
  };
  const updates = updating(host, updater, hooks);
  const shown = () => {
    const panel = host.querySelector(".notice")!;
    return panel.classList.contains("showing") ? panel.querySelector("p")!.textContent : undefined;
  };
  const buttons = () => [...host.querySelectorAll("button")].map((button) => button.textContent);
  const press = (label: string) =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
  const held = () =>
    page.inert && document.documentElement.hasAttribute("data-installing") && updates.installing();
  return { page, host, updater, hooks, updates, shown, buttons, press, held, ...rest };
}

describe("updating", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-installing");
  });

  it("checks unless the user turned it off, remembering only that", async () => {
    const first = app();
    await first.updates.serve();
    expect(first.updater.allow).toHaveBeenCalledExactlyOnceWith(true);
    expect(first.updates.allowed()).toBe(true);
    await first.updates.allow(false);
    expect(localStorage.getItem("planche.updates")).toBe("off");

    const next = app();
    await next.updates.serve();
    expect(next.updater.allow).toHaveBeenCalledExactlyOnceWith(false);
    expect(next.updates.allowed()).toBe(false);
    await next.updates.allow(true);
    expect(localStorage.getItem("planche.updates")).toBeNull();
  });

  it("stays off where the app updates as the page reloads", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const updates = updating(host, undefined, {
      closing: async () => true,
      confirm: async () => true,
      report: () => {},
    });
    await updates.serve();
    expect(updates.allowed()).toBe(false);
    expect(host.querySelector(".notice.showing")).toBeNull();
  });

  it("offers a new version until later", async () => {
    const { updates, find, shown, buttons, press } = app();
    await updates.serve();
    find("0.3.0");
    expect(shown()).toBe("Planche 0.3.0 is out");
    expect(buttons()).toEqual(["Update", "Later"]);
    press("Later");
    expect(shown()).toBeUndefined();
  });

  it("says what to do where this copy cannot replace itself", async () => {
    const { updates, find, shown, buttons } = app();
    await updates.serve();
    find("0.3.0", MOVE);
    expect(shown()).toBe(`Planche 0.3.0 is out. ${MOVE}`);
    expect(buttons()).toEqual(["Dismiss"]);
  });

  it("offers nothing once the user turned checks off, and hides what it offered", async () => {
    const { updates, find, shown } = app();
    await updates.serve();
    find("0.3.0");
    await updates.allow(false);
    expect(shown()).toBeUndefined();
    find("0.3.0");
    expect(shown()).toBeUndefined();
  });

  it("shows the download's progress, and ignores what a check finds meanwhile", async () => {
    const { updates, find, shown, buttons, press, progress } = app();
    await updates.serve();
    find("0.3.0");
    press("Update");
    await tick();
    expect(shown()).toBe("Downloading Planche 0.3.0…");
    expect(buttons()).toEqual([]);
    progress(4_200_000, 10_000_000);
    expect(shown()).toBe("Downloading Planche 0.3.0… 42%");
    find("0.4.0");
    expect(shown()).toBe("Downloading Planche 0.3.0… 42%");
  });

  it("saves the board before installing, and holds the page until the app relaunches", async () => {
    const { updates, find, shown, press, steps, downloaded, installed, held } = app();
    await updates.serve();
    find("0.3.0");
    press("Update");
    downloaded.resolve();
    await tick();
    expect(steps).toEqual(["download", "closing", "install"]);
    expect(shown()).toBe("Installing Planche 0.3.0…");
    expect(held()).toBe(true);
    installed.resolve();
    await tick();
    expect(held()).toBe(true);
  });

  it("offers the version a check found meanwhile once the download fails", async () => {
    const { updates, updater, find, shown, press, downloaded } = app();
    await updates.serve();
    find("0.3.0");
    press("Update");
    find("0.4.0");
    downloaded.reject("Planche 0.4.0 came out meanwhile");
    await tick();
    expect(updater.download).toHaveBeenCalledWith("0.3.0", expect.any(Function));
    expect(shown()).toBe("Planche 0.4.0 is out");
  });

  it("holds keys and the clipboard back from the rest of the app while installing", async () => {
    const { updates, find, press, downloaded } = app();
    const target = new EventTarget();
    updates.watch(target);
    const heard = vi.fn<(event: Event) => void>();
    for (const type of ["keydown", "paste"]) {
      target.addEventListener(type, heard);
    }
    await updates.serve();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(heard).toHaveBeenCalledOnce();
    find("0.3.0");
    press("Update");
    downloaded.resolve();
    await tick();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    target.dispatchEvent(new Event("paste"));
    const reload = new KeyboardEvent("keydown", { key: "F5", cancelable: true });
    target.dispatchEvent(reload);
    expect(heard).toHaveBeenCalledOnce();
    expect(reload.defaultPrevented).toBe(true);
  });

  it("asks before losing what could not be saved, and offers again when the user keeps it", async () => {
    const { updates, find, shown, press, hooks, updater, downloaded, page } = app({
      safe: false,
      losing: false,
    });
    await updates.serve();
    find("0.3.0");
    press("Update");
    downloaded.resolve();
    await tick();
    expect(hooks.confirm).toHaveBeenCalledExactlyOnceWith(
      "Update, and lose the changes to this board?",
    );
    expect(updater.install).not.toHaveBeenCalled();
    expect(shown()).toBe("Planche 0.3.0 is out");
    expect(updates.installing()).toBe(false);
    expect(page.inert).toBe(false);
    expect(document.documentElement.hasAttribute("data-installing")).toBe(false);
  });

  it("installs when the user lets what could not be saved go", async () => {
    const { updates, find, press, updater, downloaded } = app({ safe: false, losing: true });
    await updates.serve();
    find("0.3.0");
    press("Update");
    downloaded.resolve();
    await tick();
    expect(updater.install).toHaveBeenCalledExactlyOnceWith("0.3.0");
  });

  it("gives the page back and offers again when installing fails, which it reports", async () => {
    const { updates, find, shown, press, hooks, downloaded, installed, page } = app();
    await updates.serve();
    find("0.3.0");
    press("Update");
    downloaded.resolve();
    installed.reject("failed to create temporary directory");
    await tick();
    await expect(hooks.report.mock.calls[0]![0]).rejects.toThrow(
      /^Planche 0\.3\.0 could not be installed: failed to create temporary directory$/,
    );
    expect(shown()).toBe("Planche 0.3.0 is out");
    expect(updates.installing()).toBe(false);
    expect(page.inert).toBe(false);
    expect(document.documentElement.hasAttribute("data-installing")).toBe(false);
  });

  it("leaves the page alone and offers again when the download fails", async () => {
    const { updates, find, shown, press, hooks, updater, downloaded } = app();
    await updates.serve();
    find("0.3.0");
    press("Update");
    downloaded.reject("error decoding response body");
    await tick();
    await expect(hooks.report.mock.calls[0]![0]).rejects.toThrow(
      /^Planche 0\.3\.0 could not be downloaded: error decoding response body$/,
    );
    expect(hooks.closing).not.toHaveBeenCalled();
    expect(updater.install).not.toHaveBeenCalled();
    expect(shown()).toBe("Planche 0.3.0 is out");
  });
});
