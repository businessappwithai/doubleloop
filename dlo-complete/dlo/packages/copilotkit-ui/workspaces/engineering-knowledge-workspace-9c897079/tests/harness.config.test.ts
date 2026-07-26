// @vitest-environment node
//
// tests/harness.config.test.ts — asserts the Vitest config itself, in the NODE environment.
//
// These assertions must not live in a jsdom test file. Importing vitest.config.ts pulls in
// @vitejs/plugin-react and therefore esbuild, whose module-load invariant is
// `new TextEncoder().encode("") instanceof Uint8Array`. Under jsdom that is false — jsdom's
// TextEncoder returns a Uint8Array from a different realm than the global Uint8Array — so
// esbuild throws "your JavaScript environment is broken" before a single test runs. No
// TextEncoder/TextDecoder polyfill fixes it, because the mismatched global is Uint8Array.
// Running these in the node environment sidesteps the realm split entirely.
import { describe, test, expect } from "vitest";
import vitestConfig from "../vitest.config";

describe("vitest.config.ts", () => {
  test("does not enable passWithNoTests — an empty suite must fail", () => {
    expect(vitestConfig.test?.passWithNoTests).not.toBe(true);
  });

  test("runs under jsdom with globals and the setup file wired in", () => {
    // Either the built-in "jsdom" environment, or the local wrapper around it
    // (vitest.environment.ts) that re-pins Uint8Array/ArrayBuffer to the outer
    // realm so esbuild's startup invariant survives test collection.
    expect(vitestConfig.test?.environment).toMatch(/^(?:jsdom|\.\/vitest\.environment\.ts)$/);
    expect(vitestConfig.test?.globals).toBe(true);
    expect(vitestConfig.test?.setupFiles).toContain("./vitest.setup.ts");
  });

  test("collects tests from the tests/ directory", () => {
    expect(vitestConfig.test?.include).toContain("tests/**/*.test.ts");
  });
});
