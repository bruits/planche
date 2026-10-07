import { expectTypeOf, it } from "vitest";

import type * as mcp from "./arguments.js";
import type { SETTABLE } from "./author.js";
import type * as board from "./core.js";

// Each side is generated from its own crate, so only here do they meet. A pair that differs fails
// `tsc`, naming the strings one side lacks. Change `crates/mcp/src/changes.rs` to match, then run
// `PLANCHE_DECLARE=1 cargo test -p mcp`.
it("takes what agents change as the board has it", () => {
  expectTypeOf<mcp.Align>().toEqualTypeOf<board.Align>();
  expectTypeOf<mcp.Alignment>().toEqualTypeOf<board.Alignment>();
  expectTypeOf<mcp.Axis>().toEqualTypeOf<board.Axis>();
  expectTypeOf<mcp.Colour>().toEqualTypeOf<board.Colour>();
  expectTypeOf<mcp.CropShape>().toEqualTypeOf<board.CropShape>();
  expectTypeOf<mcp.Dash>().toEqualTypeOf<board.Dash>();
  expectTypeOf<mcp.Fill>().toEqualTypeOf<board.Fill>();
  expectTypeOf<mcp.Heads>().toEqualTypeOf<board.Heads>();
  expectTypeOf<mcp.Paper>().toEqualTypeOf<board.Paper>();
  expectTypeOf<mcp.Restack>().toEqualTypeOf<board.Restack>();
  expectTypeOf<mcp.ShapeKind>().toEqualTypeOf<board.Shape>();
  expectTypeOf<mcp.Tip>().toEqualTypeOf<board.Tip>();
  expectTypeOf<mcp.Weight>().toEqualTypeOf<board.Weight>();
  expectTypeOf<Pick<mcp.Update, board.Setting>>().toEqualTypeOf<board.Style>();
  expectTypeOf<(typeof SETTABLE)[number] | "font_size">().toEqualTypeOf<board.Setting>();
});
