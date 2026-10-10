import { describe, expect, it } from "vitest";
import { described } from "./errors.js";

describe("a failure described for a report", () => {
  it("opens with its name and message, which WebKit's stack leaves out", () => {
    const error = new TypeError("the board is undefined");
    error.stack = "draw@http://localhost/js/view.js:12:3";
    expect(described(error)).toBe(
      "TypeError: the board is undefined\ndraw@http://localhost/js/view.js:12:3",
    );
  });

  it("is the stack alone where it opens with them, as V8's does", () => {
    const error = new Error("the disk is full");
    expect(described(error)).toBe(error.stack);
  });

  it("is what was thrown as it is, such as a panic's message", () => {
    expect(described("panicked at crates/board/src/edit.rs:12:5")).toBe(
      "panicked at crates/board/src/edit.rs:12:5",
    );
  });
});
