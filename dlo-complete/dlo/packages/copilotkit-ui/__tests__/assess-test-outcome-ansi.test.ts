/**
 * __tests__/assess-test-outcome-ansi.test.ts — `assessTestOutcome` / `stripAnsi`.
 *
 * A real pipeline run produced this bug and it is the worst kind: the guard fired on the healthy
 * case. The generated app's suite ran 77 files and 1396 tests, all passing, exit 0 — and the
 * testing phase concluded the suite was empty and spawned the Test Author subagent to write tests
 * for an application that already had 1396 of them.
 *
 * The cause is that runners colour their output whenever they think a terminal is watching, and
 * vitest counts the `CI=true` this phase sets as such an environment. `Tests  1396 passed (1396)`
 * therefore arrives with escape codes sitting between the very words every summary pattern anchors
 * on, and every one of them fails to match.
 *
 * `__tests__/fixtures/vitest-ansi-summary.txt` is the genuine tail of that run, escape codes
 * intact — not a hand-written approximation, because a hand-written one would have encoded the
 * same wrong assumption that caused the bug.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assessTestOutcome, stripAnsi } from "../src/lib/orchestrator/phases/finalize";

const ESC = String.fromCharCode(27);
const REAL_VITEST_TAIL = readFileSync(
  join(__dirname, "fixtures", "vitest-ansi-summary.txt"),
  "utf-8",
);

/** Wraps `text` in a dim/colour pair the way vitest's reporter does. */
function coloured(text: string): string {
  return `${ESC}[2m${text}${ESC}[22m`;
}

describe("stripAnsi", () => {
  test("removes CSI colour sequences", () => {
    expect(stripAnsi(`${ESC}[32mpassed${ESC}[39m`)).toBe("passed");
  });

  test("removes dim/reset pairs around whitespace, which is how vitest pads its summary", () => {
    expect(stripAnsi(`${ESC}[2m      Tests ${ESC}[22m`)).toBe("      Tests ");
  });

  test("removes erase-line and cursor-move sequences", () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gdone`)).toBe("done");
  });

  test("removes two-character ESC forms", () => {
    expect(stripAnsi(`${ESC}Mabc`)).toBe("abc");
  });

  test("leaves plain text untouched", () => {
    expect(stripAnsi("Tests  3 passed (3)")).toBe("Tests  3 passed (3)");
  });

  test("leaves an empty string empty", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("preserves newlines, so line-anchored patterns still work afterwards", () => {
    expect(stripAnsi(`${ESC}[2ma${ESC}[22m\n${ESC}[2mb${ESC}[22m`)).toBe("a\nb");
  });

  test("preserves square brackets that are not part of an escape sequence", () => {
    expect(stripAnsi("Tests [suite] 3 passed (3)")).toBe("Tests [suite] 3 passed (3)");
  });
});

describe("assessTestOutcome — real coloured vitest output", () => {
  test("counts the tests in a genuine coloured run instead of reading it as empty", () => {
    // The exact regression: 1396 passing tests previously assessed as zero.
    const outcome = assessTestOutcome(REAL_VITEST_TAIL);

    expect(outcome.testsRun).toBe(1396);
    expect(outcome.noTestsFound).toBe(false);
  });

  test("the fixture really does contain escape codes — otherwise it proves nothing", () => {
    expect(REAL_VITEST_TAIL).toContain(ESC);
  });

  test("the fixture's summary is unreadable to a pattern that does not strip them", () => {
    // Pins WHY the bug happened: the naive pattern the code used to apply finds nothing here.
    expect(/^\s*Tests\s+(.+?)\((\d+)\)\s*$/m.test(REAL_VITEST_TAIL)).toBe(false);
    expect(/^\s*Tests\s+(.+?)\((\d+)\)\s*$/m.test(stripAnsi(REAL_VITEST_TAIL))).toBe(true);
  });
});

describe("assessTestOutcome — coloured summaries by runner", () => {
  test("vitest, all passing", () => {
    const output = `${coloured("      Tests ")} ${ESC}[1m${ESC}[32m12 passed${ESC}[39m${ESC}[22m${ESC}[90m (12)${ESC}[39m`;
    expect(assessTestOutcome(output)).toEqual({ testsRun: 12, noTestsFound: false });
  });

  test("vitest, mixed pass and fail — the total is what executed", () => {
    const output = `${coloured("      Tests ")} ${ESC}[31m1 failed${ESC}[39m | ${ESC}[32m11 passed${ESC}[39m${ESC}[90m (12)${ESC}[39m`;
    expect(assessTestOutcome(output).testsRun).toBe(12);
  });

  test("vitest without a trailing total", () => {
    const output = `${coloured("      Tests ")} ${ESC}[32m4 passed${ESC}[39m`;
    expect(assessTestOutcome(output).testsRun).toBe(4);
  });

  test("jest", () => {
    const output = `${ESC}[1mTests:${ESC}[22m       ${ESC}[32m3 passed${ESC}[39m, 4 total`;
    expect(assessTestOutcome(output).testsRun).toBe(4);
  });

  test("gradle", () => {
    const output = `${ESC}[33m5 tests completed${ESC}[39m, 1 failed`;
    expect(assessTestOutcome(output).testsRun).toBe(5);
  });
});

describe("assessTestOutcome — genuinely empty suites still fail", () => {
  test("a coloured 'No test files found' is still recognised as empty", () => {
    // The guard must keep working; stripping colour must not make everything look healthy.
    const output = `${ESC}[31mNo test files found, exiting with code 1${ESC}[39m`;
    expect(assessTestOutcome(output)).toEqual({ testsRun: 0, noTestsFound: true });
  });

  test("an uncoloured 'No test files found' is still recognised as empty", () => {
    expect(assessTestOutcome("No test files found, exiting with code 1").noTestsFound).toBe(true);
  });

  test("output with no summary at all counts as empty", () => {
    expect(assessTestOutcome("some unrelated build noise")).toEqual({
      testsRun: 0,
      noTestsFound: true,
    });
  });

  test("empty output counts as empty", () => {
    expect(assessTestOutcome("")).toEqual({ testsRun: 0, noTestsFound: true });
  });

  test("an explicit zero-test vitest summary counts as empty", () => {
    const output = `${coloured("      Tests ")} ${ESC}[90mno tests${ESC}[39m${ESC}[90m (0)${ESC}[39m`;
    expect(assessTestOutcome(output).noTestsFound).toBe(true);
  });

  test("a run that reports both a count and 'no test files found' is still empty", () => {
    // reportedEmpty is authoritative: a runner that says it found nothing found nothing.
    const output = `Tests  3 passed (3)\nNo test files found`;
    expect(assessTestOutcome(output).noTestsFound).toBe(true);
  });
});
