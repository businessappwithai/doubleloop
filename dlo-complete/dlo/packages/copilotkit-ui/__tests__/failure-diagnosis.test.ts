/**
 * __tests__/failure-diagnosis.test.ts
 * What the fleet's diagnostic step actually sees when a module fails.
 *
 * From a real run: `npx tsc --noEmit` failed with TS2769 "No overload matches
 * this call" because vitest 2.x pins Vite 5 while the project used Vite 8, so
 * two copies of `vite` supplied two incompatible `Plugin` types. The parser kept
 * only the headline, so the diagnostic agent saw nothing about the duplication
 * and prescribed edits to vitest.config.ts — a file that was not at fault. The
 * module burned every attempt on that guess.
 */

import { describe, test, expect } from "vitest";
import { parseTsErrors, detectDuplicatePackageConflict } from "../src/lib/orchestrator/phases/build";

const DUPLICATE_VITE_OUTPUT = `vitest.config.ts(10,13): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Plugin<any>[]' is not assignable to type 'PluginOption'.
      Type 'import("/app/node_modules/vite/dist/node/index").Plugin<any>' is not assignable to type 'import("/app/node_modules/vitest/node_modules/vite/dist/node/index").Plugin<any>'.
        Types of property 'apply' are incompatible.
src/router.tsx(4,10): error TS2307: Cannot find module './routeTree.gen'.
`;

describe("parseTsErrors", () => {
  test("parses a single-line error", () => {
    const errors = parseTsErrors("src/a.ts(12,5): error TS2307: Cannot find module './b'.");
    expect(errors).toEqual([
      { file: "src/a.ts", line: 12, col: 5, code: "TS2307", message: "Cannot find module './b'.", detail: "" },
    ]);
  });

  test("captures the indented explanation beneath the headline", () => {
    const errors = parseTsErrors(DUPLICATE_VITE_OUTPUT);
    expect(errors[0]!.code).toBe("TS2769");
    expect(errors[0]!.message).toBe("No overload matches this call.");
    // Without this detail the error says nothing actionable at all.
    expect(errors[0]!.detail).toContain("The last overload gave the following error.");
    expect(errors[0]!.detail).toContain("vitest/node_modules/vite");
  });

  test("stops the detail at the next unindented error", () => {
    const errors = parseTsErrors(DUPLICATE_VITE_OUTPUT);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.detail).not.toContain("TS2307");
    expect(errors[1]!.file).toBe("src/router.tsx");
    expect(errors[1]!.detail).toBe("");
  });

  test("parses every error in a multi-error run", () => {
    const output = [
      "src/a.ts(1,1): error TS1000: first.",
      "src/b.ts(2,2): error TS1001: second.",
      "src/c.ts(3,3): error TS1002: third.",
    ].join("\n");
    expect(parseTsErrors(output).map((e) => e.code)).toEqual(["TS1000", "TS1001", "TS1002"]);
  });

  test("handles absolute paths with parentheses-free directories", () => {
    const errors = parseTsErrors("/app/src/deep/file.tsx(120,33): error TS2345: Argument of type 'X'.");
    expect(errors[0]!.file).toBe("/app/src/deep/file.tsx");
    expect(errors[0]!.line).toBe(120);
    expect(errors[0]!.col).toBe(33);
  });

  test.each([
    ["empty output", ""],
    ["a clean run", "\n"],
    ["npm noise with no TS errors", "npm error code ELIFECYCLE\nexit status 1"],
    ["a warning rather than an error", "src/a.ts(1,1): warning TS6133: unused."],
  ])("returns nothing for %s", (_name, output) => {
    expect(parseTsErrors(output)).toEqual([]);
  });
});

describe("detectDuplicatePackageConflict", () => {
  test("names a package resolved from two different node_modules paths", () => {
    const hint = detectDuplicatePackageConflict(DUPLICATE_VITE_OUTPUT);
    expect(hint).toContain("DUPLICATE DEPENDENCY");
    expect(hint).toContain('"vite"');
  });

  test("tells the builder to fix package.json, not the source file", () => {
    const hint = detectDuplicatePackageConflict(DUPLICATE_VITE_OUTPUT);
    expect(hint).toMatch(/Fix this in package\.json/);
    expect(hint).toMatch(/[Dd]o not attempt to work around it with casts/);
  });

  test("explains that the source file is not at fault", () => {
    expect(detectDuplicatePackageConflict(DUPLICATE_VITE_OUTPUT)).toMatch(/the\s+source file is fine/);
  });

  test("says nothing when a package appears at one path only", () => {
    const output = [
      "src/a.ts(1,1): error TS2345: Argument of type X.",
      "  Type from '/app/node_modules/react/index.d.ts' is not assignable.",
    ].join("\n");
    expect(detectDuplicatePackageConflict(output)).toBe("");
  });

  test("says nothing when the same path is mentioned repeatedly", () => {
    const output = [
      "  '/app/node_modules/vite/dist/node/index'",
      "  '/app/node_modules/vite/dist/node/index'",
      "  '/app/node_modules/vite/dist/node/index'",
    ].join("\n");
    expect(detectDuplicatePackageConflict(output)).toBe("");
  });

  test("handles a scoped package duplicated under another package", () => {
    const output = [
      "Type from '/app/node_modules/@types/react/index.d.ts' is not assignable to",
      "type from '/app/node_modules/react-relay/node_modules/@types/react/index.d.ts'.",
    ].join("\n");
    const hint = detectDuplicatePackageConflict(output);
    expect(hint).toContain('"@types/react"');
  });

  test.each([
    ["empty output", ""],
    ["output with no paths at all", "error TS2769: No overload matches this call."],
    ["output mentioning no node_modules", "src/a.ts(1,1): error TS2307: Cannot find module './b'."],
  ])("says nothing for %s", (_name, output) => {
    expect(detectDuplicatePackageConflict(output)).toBe("");
  });

  test("reports several duplicated packages together", () => {
    const output = [
      "'/app/node_modules/vite/x' vs '/app/node_modules/vitest/node_modules/vite/x'",
      "'/app/node_modules/graphql/y' vs '/app/node_modules/relay-runtime/node_modules/graphql/y'",
    ].join("\n");
    const hint = detectDuplicatePackageConflict(output);
    expect(hint).toContain('"vite"');
    expect(hint).toContain('"graphql"');
  });
});
