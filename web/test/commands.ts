// Commands as the app lists them, for tests of what offers and runs them.

import { vi } from "vitest";
import type { Listed } from "../src/finder.js";

export function command(label: string, more: Partial<Listed> = {}): Listed {
  return { label, run: vi.fn<() => void>(), ...more };
}
