/**
 * packages/copilotkit-ui/vitest.config.ts
 * Unit-test configuration for the orchestrator.
 *
 * Node environment only: these tests exercise the pipeline library, never the
 * Next.js runtime. No --passWithNoTests anywhere — an empty run must fail here
 * for the same reason it must fail for the applications this pipeline builds.
 */

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
