/**
 * __tests__/recovery.test.ts
 * Crash recovery — the difference between a pipeline that survives its host
 * restarting and one that silently dies looking alive.
 *
 * Phase runners are fire-and-forget async functions owned by a single Node
 * process. When that process goes away the persisted state still reads
 * EXECUTION_RUNNING and modules still read EXECUTING, but nothing is running.
 * This happened repeatedly in real runs and stranded every module the fleet had
 * already finished.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

let pipelines: any[] = [];
const saved: any[] = [];

vi.mock("../src/lib/orchestrator/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/orchestrator/state")>();
  return {
    ...actual,
    listAllPipelines: vi.fn(async () => pipelines),
    getPipeline: vi.fn(async (id: string) => pipelines.find((p) => p.pipelineId === id) ?? null),
    savePipeline: vi.fn(async (s: any) => { saved.push(JSON.parse(JSON.stringify(s))); }),
  };
});

const {
  isInterrupted,
  requeueStrandedModules,
  resumePhase,
  recoverInterruptedPipelines,
  RESUMABLE_PHASES,
} = await import("../src/lib/orchestrator/recovery");

function runners() {
  return {
    research: vi.fn(), design: vi.fn(), ceoReview: vi.fn(), execution: vi.fn(),
    build: vi.fn(), dbProvisioning: vi.fn(), testing: vi.fn(), deploy: vi.fn(),
  };
}

function pipeline(over: Record<string, unknown> = {}) {
  return {
    pipelineId: "p1",
    phase: "EXECUTION_RUNNING",
    activeGate: null,
    board: { modules: [{ moduleId: "m1", status: "PASSED", attempts: 1 }] },
    lastTransitionAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => { pipelines = []; saved.length = 0; });

describe("isInterrupted", () => {
  test.each(RESUMABLE_PHASES as unknown as string[])(
    "%s with no live process is interrupted",
    (phase) => {
      expect(isInterrupted({ phase, activeGate: null } as any, false)).toBe(true);
    }
  );

  test("a live process means it is still running, not interrupted", () => {
    expect(isInterrupted({ phase: "EXECUTION_RUNNING", activeGate: null } as any, true)).toBe(false);
  });

  test("an open gate is waiting for a human, not stuck", () => {
    // Restarting it would discard the decision the human is being asked for.
    const gate = { gateId: "g1", kind: "TERMINAL_PERMISSION", exhibits: [] };
    expect(isInterrupted({ phase: "TESTING_RUNNING", activeGate: gate } as any, false)).toBe(false);
  });

  test.each(["COMPLETED", "FAILED", "ABORTED", "INIT", "GATE1_PENDING", "GATE2_PENDING", "PAUSED"])(
    "%s is never resumed",
    (phase) => {
      expect(isInterrupted({ phase, activeGate: null } as any, false)).toBe(false);
    }
  );
});

describe("requeueStrandedModules", () => {
  test("requeues an EXECUTING module and keeps what it had learned", () => {
    const modules = [{ moduleId: "m4", status: "EXECUTING", attempts: 2, failure: "tsc: TS2307" }];
    expect(requeueStrandedModules(modules)).toEqual(["m4"]);
    expect(modules[0]).toEqual({
      moduleId: "m4", status: "PENDING", attempts: 0, failure: "tsc: TS2307",
    });
  });

  test.each([["PASSED", 1], ["FAILED", 3], ["PENDING", 0], ["BLOCKED", 0]])(
    "leaves a %s module untouched",
    (status, attempts) => {
      const modules = [{ moduleId: "m1", status, attempts }];
      expect(requeueStrandedModules(modules)).toEqual([]);
      expect(modules[0]!.status).toBe(status);
      expect(modules[0]!.attempts).toBe(attempts);
    }
  );

  test("requeues every stranded module on a mixed board", () => {
    const modules = [
      { moduleId: "m1", status: "PASSED", attempts: 1 },
      { moduleId: "m2", status: "EXECUTING", attempts: 0 },
      { moduleId: "m3", status: "EXECUTING", attempts: 0 },
      { moduleId: "m4", status: "PENDING", attempts: 0 },
    ];
    expect(requeueStrandedModules(modules)).toEqual(["m2", "m3"]);
    expect(modules.map((m) => m.status)).toEqual(["PASSED", "PENDING", "PENDING", "PENDING"]);
  });

  test("handles an empty board", () => {
    expect(requeueStrandedModules([])).toEqual([]);
  });
});

describe("resumePhase", () => {
  test.each([
    ["RESEARCH_RUNNING", "research"],
    ["DESIGN_RUNNING", "design"],
    ["CEO_REVIEW_RUNNING", "ceoReview"],
    ["EXECUTION_RUNNING", "execution"],
    ["BUILD_RUNNING", "build"],
    ["DB_PROVISIONING_RUNNING", "dbProvisioning"],
    ["TESTING_RUNNING", "testing"],
    ["DEPLOY_RUNNING", "deploy"],
    ["APP_LAUNCH_RUNNING", "deploy"],
  ])("%s re-invokes the %s runner", (phase, runner) => {
    const r = runners();
    expect(resumePhase(phase, "p1", r)).toBe(true);
    expect((r as any)[runner]).toHaveBeenCalledWith("p1", ...(["research","design","ceoReview","execution"].includes(runner) ? [] : [false]));
  });

  test("terminal-permission phases resume WITHOUT permission, so the gate is re-raised", () => {
    // A command the human approved in a previous process must not run silently
    // in this one.
    const r = runners();
    resumePhase("DEPLOY_RUNNING", "p1", r);
    expect(r.deploy).toHaveBeenCalledWith("p1", false);
  });

  test.each(["COMPLETED", "FAILED", "GATE1_PENDING", "nonsense"])(
    "does nothing for %s",
    (phase) => {
      const r = runners();
      expect(resumePhase(phase, "p1", r)).toBe(false);
      expect(Object.values(r).every((fn: any) => fn.mock.calls.length === 0)).toBe(true);
    }
  );
});

describe("recoverInterruptedPipelines", () => {
  test("resumes an interrupted pipeline and requeues its stranded modules", async () => {
    pipelines = [pipeline({
      board: { modules: [
        { moduleId: "m1", status: "PASSED", attempts: 1 },
        { moduleId: "m2", status: "EXECUTING", attempts: 0 },
      ] },
    })];
    const r = runners();

    const result = await recoverInterruptedPipelines(r, () => false);

    expect(result).toEqual([{ pipelineId: "p1", phase: "EXECUTION_RUNNING", requeuedModules: ["m2"] }]);
    expect(r.execution).toHaveBeenCalledWith("p1");
    // The finished module is never rebuilt.
    expect(saved.at(-1).board.modules[0]).toMatchObject({ moduleId: "m1", status: "PASSED" });
    expect(saved.at(-1).board.modules[1]).toMatchObject({ moduleId: "m2", status: "PENDING" });
  });

  test("skips a pipeline whose process is still alive", async () => {
    pipelines = [pipeline()];
    const r = runners();
    expect(await recoverInterruptedPipelines(r, () => true)).toEqual([]);
    expect(r.execution).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  test("skips a pipeline parked at a gate", async () => {
    pipelines = [pipeline({ activeGate: { gateId: "g", kind: "DESIGN_REVIEW", exhibits: [] } })];
    const r = runners();
    expect(await recoverInterruptedPipelines(r, () => false)).toEqual([]);
    expect(r.execution).not.toHaveBeenCalled();
  });

  test.each(["COMPLETED", "FAILED", "ABORTED"])("skips a %s pipeline", async (phase) => {
    pipelines = [pipeline({ phase })];
    const r = runners();
    expect(await recoverInterruptedPipelines(r, () => false)).toEqual([]);
  });

  test("recovers several pipelines in one pass", async () => {
    pipelines = [
      pipeline({ pipelineId: "a", phase: "EXECUTION_RUNNING" }),
      pipeline({ pipelineId: "b", phase: "DESIGN_RUNNING", board: undefined }),
      pipeline({ pipelineId: "c", phase: "COMPLETED" }),
    ];
    const r = runners();
    const result = await recoverInterruptedPipelines(r, () => false);
    expect(result.map((x) => x.pipelineId)).toEqual(["a", "b"]);
    expect(r.execution).toHaveBeenCalledWith("a");
    expect(r.design).toHaveBeenCalledWith("b");
  });

  test("copes with a pipeline that has no board at all", async () => {
    pipelines = [pipeline({ phase: "RESEARCH_RUNNING", board: undefined })];
    const r = runners();
    const result = await recoverInterruptedPipelines(r, () => false);
    expect(result[0]!.requeuedModules).toEqual([]);
    expect(r.research).toHaveBeenCalledWith("p1");
  });

  test("is safe to run twice — the second pass finds nothing new to requeue", async () => {
    pipelines = [pipeline({ board: { modules: [{ moduleId: "m2", status: "EXECUTING", attempts: 0 }] } })];
    const r = runners();
    const first = await recoverInterruptedPipelines(r, () => false);
    const second = await recoverInterruptedPipelines(r, () => false);
    expect(first[0]!.requeuedModules).toEqual(["m2"]);
    expect(second[0]!.requeuedModules).toEqual([]);
  });
});
