// vitest.config.ts — the unit-test harness config (Architecture.md "Testing Strategy").
// Deliberately separate from app.config.ts: unit tests run under jsdom via plain
// @vitejs/plugin-react, never through the TanStack Start / StyleX build pipeline, so a
// test never accidentally depends on the server runtime. The empty-suite override is
// intentionally left unset — Vitest's own default already fails an empty or mis-globbed
// suite loudly rather than reporting a false green (see tests/harness.test.ts).
import { defineConfig } from "vitest/config";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.d.ts", "src/app/routes/**/*.css.ts", "src/**/__generated__/**"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
