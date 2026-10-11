// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { measurements } from "./metrics.js";

function panel() {
  const shown = document.createElement("aside");
  shown.hidden = true;
  const list = shown.appendChild(document.createElement("dl"));
  const meter = measurements(shown, list, (draws) => [
    ["platform", "browser"],
    ["draws", draws],
  ]);
  const listed = () =>
    Object.fromEntries(
      [...list.querySelectorAll("dt")].map((name) => [
        name.textContent,
        name.nextElementSibling?.textContent,
      ]),
    );
  return { shown, meter, listed };
}

describe("the measurements", () => {
  afterEach(() => vi.useRealTimers());

  it("list nothing while hidden, then what they are given once shown", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const { shown, meter, listed } = panel();
    meter.drew();
    vi.advanceTimersByTime(2000);
    expect(listed()).toEqual({});
    meter.toggle();
    expect(meter.shown()).toBe(true);
    expect(shown.hidden).toBe(false);
    expect(listed()).toEqual({ platform: "browser", draws: "…" });
    meter.toggle();
    expect(shown.hidden).toBe(true);
  });

  it("count the draws of each second while they show", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const { meter, listed } = panel();
    meter.toggle();
    for (let draw = 0; draw < 30; draw += 1) {
      meter.drew();
    }
    vi.advanceTimersByTime(1000);
    expect(listed().draws).toBe("30 a second");
    meter.toggle();
    meter.toggle();
    expect(listed().draws).toBe("…");
  });
});
