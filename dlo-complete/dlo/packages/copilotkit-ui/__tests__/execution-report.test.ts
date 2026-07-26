/**
 * __tests__/execution-report.test.ts
 * The /report projection.
 *
 * The elapsed-time cases are the reason this module exists: the report used to
 * measure `lastTransitionAt - createdAt`, which is the time it took to ENTER
 * the current phase, not how long the run has taken. A pipeline sixteen minutes
 * into DESIGN_RUNNING reported 16 seconds.
 */

import { describe, test, expect } from "vitest";
import {
  buildExecutionReport,
  computeWallClockSeconds,
  isTerminalPhase,
} from "../src/lib/orchestrator/report";

const CREATED = "2026-07-25T10:00:00.000Z";
const CREATED_MS = Date.parse(CREATED);

function state(overrides: Record<string, unknown> = {}): any {
  return {
    pipelineId: "p1",
    projectName: "NoteFlow Workspace",
    objectivesMarkdown: "objectives",
    phase: "DESIGN_RUNNING",
    createdAt: CREATED,
    lastTransitionAt: "2026-07-25T10:00:16.000Z",
    phaseHistory: [],
    ...overrides,
  };
}

describe("isTerminalPhase", () => {
  test.each([
    ["COMPLETED", true],
    ["FAILED", true],
    ["ABORTED", true],
    ["DESIGN_RUNNING", false],
    ["EXECUTION_RUNNING", false],
    ["GATE2_PENDING", false],
    ["PAUSED", false],
  ])("%s → %s", (phase, expected) => {
    expect(isTerminalPhase(phase)).toBe(expected);
  });
});

describe("computeWallClockSeconds", () => {
  test("a running pipeline is measured to now, not to its last transition", () => {
    // 16 minutes in, 16 seconds after the last phase change.
    const now = CREATED_MS + 16 * 60_000;
    expect(computeWallClockSeconds(state(), now)).toBe(960);
  });

  test("a completed pipeline freezes at its last transition", () => {
    const s = state({ phase: "COMPLETED", lastTransitionAt: "2026-07-25T10:05:00.000Z" });
    const now = CREATED_MS + 60 * 60_000;
    expect(computeWallClockSeconds(s, now)).toBe(300);
  });

  test.each(["FAILED", "ABORTED"])("a %s pipeline also freezes", (phase) => {
    const s = state({ phase, lastTransitionAt: "2026-07-25T10:02:30.000Z" });
    expect(computeWallClockSeconds(s, CREATED_MS + 60 * 60_000)).toBe(150);
  });

  test("is 0 at the instant the pipeline is created", () => {
    expect(computeWallClockSeconds(state(), CREATED_MS)).toBe(0);
  });

  test("truncates sub-second elapsed time to 0 rather than rounding up", () => {
    expect(computeWallClockSeconds(state(), CREATED_MS + 999)).toBe(0);
  });

  test("never reports negative time when the clock disagrees", () => {
    expect(computeWallClockSeconds(state(), CREATED_MS - 5_000)).toBe(0);
  });

  test("an unparseable createdAt yields 0 instead of NaN", () => {
    expect(computeWallClockSeconds(state({ createdAt: "not a date" }), CREATED_MS)).toBe(0);
  });

  test("an unparseable lastTransitionAt on a terminal pipeline falls back to now", () => {
    const s = state({ phase: "COMPLETED", lastTransitionAt: "not a date" });
    expect(computeWallClockSeconds(s, CREATED_MS + 10_000)).toBe(10);
  });
});

describe("buildExecutionReport", () => {
  test("counts passed modules and total attempts across the board", () => {
    const s = state({
      board: {
        modules: [
          { moduleId: "m1", status: "PASSED", attempts: 1 },
          { moduleId: "m2", status: "PASSED", attempts: 3 },
          { moduleId: "m3", status: "FAILED", attempts: 3 },
          { moduleId: "m4", status: "PENDING", attempts: 0 },
        ],
      },
    });
    const report = buildExecutionReport(s, CREATED_MS);
    expect(report.modulesCompleted).toBe(2);
    expect(report.totalAttempts).toBe(7);
  });

  test("an empty board reports zeros, not NaN", () => {
    const report = buildExecutionReport(state({ board: { modules: [] } }), CREATED_MS);
    expect(report.modulesCompleted).toBe(0);
    expect(report.totalAttempts).toBe(0);
  });

  test("a pipeline with no board at all reports zeros", () => {
    const report = buildExecutionReport(state(), CREATED_MS);
    expect(report.modulesCompleted).toBe(0);
    expect(report.totalAttempts).toBe(0);
  });

  test("a module missing its attempts count does not poison the total", () => {
    const s = state({ board: { modules: [{ moduleId: "m1", status: "PASSED" }] } });
    expect(buildExecutionReport(s, CREATED_MS).totalAttempts).toBe(0);
  });

  test("titles the report after the project", () => {
    expect(buildExecutionReport(state(), CREATED_MS).title).toBe("NoteFlow Workspace Execution Report");
  });

  test("cost is null until a budget has been spent", () => {
    expect(buildExecutionReport(state(), CREATED_MS).costUsd).toBeNull();
  });

  test("cost is reported when the budget ledger has a figure", () => {
    const s = state({ budget: { spent: { usd: 4.25 } } });
    expect(buildExecutionReport(s, CREATED_MS).costUsd).toBe(4.25);
  });

  test("a zero spend is reported as 0, not as unknown", () => {
    const s = state({ budget: { spent: { usd: 0 } } });
    expect(buildExecutionReport(s, CREATED_MS).costUsd).toBe(0);
  });

  test.each([
    ["COMPLETED", "Completed execution pipeline"],
    ["FAILED", "failed"],
    ["ABORTED", "was aborted"],
    ["EXECUTION_RUNNING", "is in phase EXECUTION_RUNNING"],
  ])("summarises a %s pipeline", (phase, fragment) => {
    const report = buildExecutionReport(state({ phase }), CREATED_MS);
    expect(report.summary).toContain(fragment);
  });

  test("the completed summary carries the module and attempt counts", () => {
    const s = state({
      phase: "COMPLETED",
      board: { modules: [{ moduleId: "m1", status: "PASSED", attempts: 2 }] },
    });
    expect(buildExecutionReport(s, CREATED_MS).summary).toBe(
      "Completed execution pipeline for NoteFlow Workspace. 1 module(s) generated and validated across 2 attempt(s)."
    );
  });
});
