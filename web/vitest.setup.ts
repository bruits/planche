import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initSync } from "./public/js/wasm/bindings.js";

// The core from its bytes, as Node has no file for `core.start` to fetch.
initSync({ module: readFileSync(join(import.meta.dirname, "public/js/wasm/bindings_bg.wasm")) });
