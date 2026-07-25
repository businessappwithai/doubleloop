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
import {
  parseTsErrors,
  detectDuplicatePackageConflict,
  detectMissingRouteTree,
} from "../src/lib/orchestrator/phases/build";

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

/**
 * From the NoteFlow run: the scaffold module wrote a perfectly correct
 * `createFileRoute('/')`, but no routeTree.gen.ts existed yet, so tsc called the
 * path argument "not assignable to parameter of type 'undefined'". The
 * diagnostic agent prescribed removing the argument. Nine attempts across three
 * fleet retries chased that, all 21 other modules were BLOCKED behind it, and
 * the pipeline finished FAILED with nothing built. Generating the route tree
 * makes the same source typecheck.
 */
describe("detectMissingRouteTree", () => {
  const MISSING_TREE_OUTPUT =
    `src/routes/index.tsx(3,38): error TS2345: Argument of type '"/"' is not assignable to parameter of type 'undefined'.`;
  const missingTree = { hasRoutesDirectory: true, hasGeneratedRouteTree: false };

  test("names the generated file as the cause", () => {
    const hint = detectMissingRouteTree(MISSING_TREE_OUTPUT, missingTree);
    expect(hint).toContain("MISSING GENERATED ROUTE TREE");
    expect(hint).toContain("routeTree.gen.ts");
  });

  test("forbids the wrong fix the agent kept prescribing", () => {
    const hint = detectMissingRouteTree(MISSING_TREE_OUTPUT, missingTree);
    expect(hint).toMatch(/do NOT remove the path argument/i);
    expect(hint).toMatch(/do NOT hand-write routeTree\.gen\.ts/i);
  });

  test("tells the builder to generate the tree before typechecking", () => {
    const hint = detectMissingRouteTree(MISSING_TREE_OUTPUT, missingTree);
    expect(hint).toMatch(/router-plugin|generator/i);
    expect(hint).toMatch(/before typechecking/i);
  });

  test("also fires on an unresolvable routeTree.gen import", () => {
    const output = `src/router.tsx(2,30): error TS2307: Cannot find module './routeTree.gen' or its corresponding type declarations.`;
    expect(detectMissingRouteTree(output, missingTree)).toContain("MISSING GENERATED ROUTE TREE");
  });

  test("stays silent once the tree has been generated", () => {
    expect(
      detectMissingRouteTree(MISSING_TREE_OUTPUT, { hasRoutesDirectory: true, hasGeneratedRouteTree: true })
    ).toBe("");
  });

  test("stays silent for a project with no routes directory at all", () => {
    expect(
      detectMissingRouteTree(MISSING_TREE_OUTPUT, { hasRoutesDirectory: false, hasGeneratedRouteTree: false })
    ).toBe("");
  });

  test("stays silent on an undefined-parameter error outside the routes directory", () => {
    // The same message from ordinary application code is a real type error.
    const output = `src/lib/format.ts(9,12): error TS2345: Argument of type '"/"' is not assignable to parameter of type 'undefined'.`;
    expect(detectMissingRouteTree(output, missingTree)).toBe("");
  });

  test("stays silent on unrelated route-file errors", () => {
    const output = `src/routes/index.tsx(5,3): error TS2304: Cannot find name 'useSate'.`;
    expect(detectMissingRouteTree(output, missingTree)).toBe("");
  });

  test("handles Windows-style route paths", () => {
    const output = `src\\routes\\index.tsx(3,38): error TS2345: Argument of type '"/"' is not assignable to parameter of type 'undefined'.`;
    expect(detectMissingRouteTree(output, missingTree)).toContain("MISSING GENERATED ROUTE TREE");
  });

  test("returns nothing for empty output", () => {
    expect(detectMissingRouteTree("", missingTree)).toBe("");
  });
});
