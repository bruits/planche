import { defineConfig } from "vitest/config";

export default defineConfig({
  // Finds the core's bindings in public/js/wasm as tsc does, through the rootDirs of tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["vitest.setup.ts"],
  },
});
