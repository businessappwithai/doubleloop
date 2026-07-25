/**
 * __tests__/finalize-testing.test.ts
 * Phase IV test enforcement: how the pipeline decides HOW to run a generated
 * application's tests, and how it decides whether anything was actually tested.
 *
 * The behavior under test is the rule that a suite which executed zero tests is
 * a failure, never a pass — so none of these tests may rely on a real runner.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTestCommand, assessTestOutcome } from "../src/lib/orchestrator/phases/finalize";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dlo-test-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writePkg(pkg: Record<string, unknown>): Promise<void> {
  await writeFile(join(workspace, "package.json"), JSON.stringify(pkg), "utf-8");
}

describe("detectTestCommand", () => {
  test("returns null for an empty workspace", async () => {
    expect(await detectTestCommand(workspace)).toBeNull();
  });

  test("returns null when package.json has no test script and no runner", async () => {
    await writePkg({ name: "app", scripts: { build: "vite build" } });
    expect(await detectTestCommand(workspace)).toBeNull();
  });

  test("uses the package test script when one exists", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    expect(await detectTestCommand(workspace)).toEqual({
      cmd: "npm",
      args: ["test"],
      source: "package-script",
    });
  });

  test("ignores a placeholder 'echo no test' script and falls through", async () => {
    await writePkg({ name: "app", scripts: { test: "echo \"Error: no test specified\" && exit 1" } });
    expect(await detectTestCommand(workspace)).toBeNull();
  });

  test("falls back to vitest when it is a devDependency but no script exists", async () => {
    await writePkg({ name: "app", devDependencies: { vitest: "^2.1.9" } });
    expect(await detectTestCommand(workspace)).toEqual({
      cmd: "npx",
      args: ["vitest", "run"],
      source: "vitest",
    });
  });

  test("falls back to jest when it is a devDependency", async () => {
    await writePkg({ name: "app", devDependencies: { jest: "^29.0.0" } });
    expect(await detectTestCommand(workspace)).toEqual({
      cmd: "npx",
      args: ["jest"],
      source: "jest",
    });
  });

  test("prefers vitest over jest when both are present", async () => {
    await writePkg({ name: "app", devDependencies: { jest: "^29.0.0", vitest: "^2.1.9" } });
    expect((await detectTestCommand(workspace))?.source).toBe("vitest");
  });

  test("prefers the gradle wrapper over gradle for an Android project", async () => {
    await writeFile(join(workspace, "gradlew"), "#!/bin/sh\n", "utf-8");
    await writeFile(join(workspace, "build.gradle.kts"), "", "utf-8");
    expect(await detectTestCommand(workspace)).toEqual({
      cmd: "./gradlew",
      args: ["testDebugUnitTest", "--continue"],
      source: "gradle",
    });
  });

  test("uses bare gradle when there is no wrapper", async () => {
    await writeFile(join(workspace, "build.gradle"), "", "utf-8");
    expect((await detectTestCommand(workspace))?.cmd).toBe("gradle");
  });

  test("returns null for malformed package.json instead of throwing", async () => {
    await writeFile(join(workspace, "package.json"), "{ not json", "utf-8");
    expect(await detectTestCommand(workspace)).toBeNull();
  });

  test("NEVER emits a flag that lets an empty suite pass", async () => {
    // This is the whole point of the phase: --passWithNoTests turned an app
    // with zero tests into a green pipeline run.
    for (const pkg of [
      { name: "a", scripts: { test: "vitest run" } },
      { name: "b", devDependencies: { vitest: "^2.1.9" } },
      { name: "c", devDependencies: { jest: "^29.0.0" } },
    ]) {
      await writePkg(pkg);
      const cmd = await detectTestCommand(workspace);
      expect(cmd).not.toBeNull();
      expect(cmd!.args.join(" ")).not.toContain("passWithNoTests");
    }
  });
});

describe("assessTestOutcome", () => {
  test("counts a passing vitest run from its summary total", () => {
    const output = [
      " Test Files  3 passed (3)",
      "      Tests  12 passed (12)",
      "   Duration  1.20s",
    ].join("\n");
    expect(assessTestOutcome(output)).toEqual({ testsRun: 12, noTestsFound: false });
  });

  test("counts a mixed vitest run from the parenthesised total", () => {
    const output = "      Tests  2 failed | 10 passed (12)\n";
    expect(assessTestOutcome(output)).toEqual({ testsRun: 12, noTestsFound: false });
  });

  test("counts a vitest summary that omits the parenthesised total", () => {
    expect(assessTestOutcome("      Tests  4 passed\n").testsRun).toBe(4);
  });

  test("counts a jest run from its total", () => {
    const output = [
      "Test Suites: 2 passed, 2 total",
      "Tests:       3 passed, 1 failed, 4 total",
    ].join("\n");
    expect(assessTestOutcome(output)).toEqual({ testsRun: 4, noTestsFound: false });
  });

  test("counts a gradle/junit run", () => {
    expect(assessTestOutcome("> Task :app:testDebugUnitTest\n5 tests completed, 1 failed\n").testsRun).toBe(5);
  });

  test.each([
    ["vitest empty", "No test files found, exiting with code 0\n"],
    ["jest empty", "No tests found, exiting with code 0\n"],
    ["jest suites empty", "No test suites found matching pattern\n"],
    ["silent empty output", ""],
    ["build noise only", "vite v5.4.2 building for production...\n"],
  ])("flags %s as no-tests-found", (_name, output) => {
    const outcome = assessTestOutcome(output);
    expect(outcome.testsRun).toBe(0);
    expect(outcome.noTestsFound).toBe(true);
  });

  test("a zero-count summary is still no-tests-found", () => {
    expect(assessTestOutcome("      Tests  0 passed (0)\n")).toEqual({ testsRun: 0, noTestsFound: true });
  });

  test("takes the largest count when several runners' output is concatenated", () => {
    const output = ["      Tests  4 passed (4)", "Tests:       9 passed, 9 total"].join("\n");
    expect(assessTestOutcome(output).testsRun).toBe(9);
  });

  test("does not mistake a passing single test for an empty suite", () => {
    expect(assessTestOutcome("      Tests  1 passed (1)\n")).toEqual({ testsRun: 1, noTestsFound: false });
  });
});
