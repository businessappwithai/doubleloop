// vitest.config.ts — the unit-test harness config (Architecture.md "Testing Strategy").
// Mirrors app.config.ts's plugin stack including @astryxdesign/build/vite's StyleX
// compilation, so components using stylex.create / stylex.defineVars compile correctly
// under jsdom. Plain @vitejs/plugin-react alone is not sufficient — StyleX requires the
// Astryx plugin to run first. Deliberately still omits tanstackStart(): unit tests run
// under jsdom, never through the server runtime, so only the StyleX half of the app
// config's plugin stack is needed here. The empty-suite override is intentionally left
// unset — Vitest's own default already fails an empty or mis-globbed suite loudly rather
// than reporting a false green (see tests/harness.test.ts).
// `viteReact`'s `babel.plugins: ["relay"]` mirrors app.config.ts (m21) — component tests that
// render a `graphql`-tagged component need the same compile step the real build gets, or the
// tagged template stays react-relay's throwing runtime stub instead of a compiled query reference.
import { defineConfig } from "vitest/config";
import viteReact from "@vitejs/plugin-react";
import { astryxStylex } from "@astryxdesign/build/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [...astryxStylex(), viteReact({ babel: { plugins: ["relay"] } })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // See vitest.environment.ts for why this wraps "jsdom" instead of naming it
    // directly: the plain "jsdom" environment leaves Uint8Array/ArrayBuffer shadowed
    // by jsdom's own realm, which breaks esbuild's startup invariant check.
    environment: "./vitest.environment.ts",
    globals: true,
    globalSetup: ["./vitest.global-setup.ts"],
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
