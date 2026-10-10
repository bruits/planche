import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bugReport } from "./bugreport.js";

const AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("bugReport", () => {
  it("opens the repository's bug report form", () => {
    const address = new URL(bugReport({ platform: "browser", userAgent: AGENT }));
    expect(`${address.origin}${address.pathname}`).toBe(
      "https://github.com/bruits/planche/issues/new",
    );
    expect(address.searchParams.get("template")).toBe("01-bug-report.yml");
  });

  it("fills in the environment, one fact a line", () => {
    const address = new URL(
      bugReport({
        platform: "desktop",
        version: "0.2.0",
        renderer: "wgpu Metal, Apple M1 & co",
        userAgent: AGENT,
      }),
    );
    expect(address.searchParams.get("environment-info")).toBe(
      [
        "Platform: desktop",
        "Version: 0.2.0",
        "Renderer: wgpu Metal, Apple M1 & co",
        `User agent: ${AGENT}`,
      ].join("\n"),
    );
  });

  it("leaves out what the app cannot tell", () => {
    const address = new URL(bugReport({ platform: "browser", userAgent: AGENT }));
    expect(address.searchParams.get("environment-info")).toBe(
      `Platform: browser\nUser agent: ${AGENT}`,
    );
  });

  it("names a form that exists, and the fields it declares", () => {
    const address = new URL(bugReport({ platform: "browser", userAgent: AGENT }));
    const form = address.searchParams.get("template")!;
    const yaml = readFileSync(
      join(import.meta.dirname, "../../.github/ISSUE_TEMPLATE", form),
      "utf8",
    );
    const filled = [...address.searchParams.keys()].filter((name) => name !== "template");
    expect(filled).not.toEqual([]);
    for (const id of filled) {
      expect(yaml).toMatch(new RegExp(`^\\s+id: ${id}$`, "m"));
    }
  });
});
