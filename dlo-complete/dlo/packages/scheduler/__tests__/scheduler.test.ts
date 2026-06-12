import { test, describe, expect, vi } from "vitest";
import { DagBoard } from "../src/board.js";
import { DispatchPump } from "../src/pump.js";
import { makeRunToken, makeModuleId } from "@dlo/core";
import type { EngineeringPlan } from "@dlo/plan-schema";

const mockPlan: EngineeringPlan = {
  planVersion: 1,
  generatedBy: "test",
  modules: [
    {
      moduleId: "module-c",
      title: "Module C (Leaf)",
      stackTarget: "rust-axum",
      prompt: "Prompt for Module C must be at least forty characters long for validation",
      dependsOn: ["module-b"],
      estimatedComplexity: "standard",
      maxAttempts: 3,
      exitClauses: [
        { clauseId: "c1", description: "check", kind: "command", argv: ["cargo", "test"], expect: { exitCode: 0 } }
      ],
      touches: ["src/c.rs"]
    },
    {
      moduleId: "module-b",
      title: "Module B (Middle)",
      stackTarget: "rust-axum",
      prompt: "Prompt for Module B must be at least forty characters long for validation",
      dependsOn: ["module-a"],
      estimatedComplexity: "standard",
      maxAttempts: 3,
      exitClauses: [
        { clauseId: "b1", description: "check", kind: "command", argv: ["cargo", "test"], expect: { exitCode: 0 } }
      ],
      touches: ["src/b.rs"]
    },
    {
      moduleId: "module-a",
      title: "Module A (Root)",
      stackTarget: "rust-axum",
      prompt: "Prompt for Module A must be at least forty characters long for validation",
      dependsOn: [],
      estimatedComplexity: "standard",
      maxAttempts: 3,
      exitClauses: [
        { clauseId: "a1", description: "check", kind: "command", argv: ["cargo", "test"], expect: { exitCode: 0 } }
      ],
      touches: ["src/a.rs"]
    }
  ]
};

describe("Scheduler - DagBoard", () => {
  test("initializes board correctly with default READY and BLOCKED states", () => {
    const board = DagBoard.build(mockPlan, []);
    
    expect(board.getModuleState(makeModuleId("module-a"))?.status).toBe("READY");
    expect(board.getModuleState(makeModuleId("module-b"))?.status).toBe("BLOCKED");
    expect(board.getModuleState(makeModuleId("module-c"))?.status).toBe("BLOCKED");

    const ready = board.ready();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.moduleId).toBe("module-a");
  });

  test("calculates criticality sorting correctly", () => {
    // Both module-a and another root module-d (no deps) exist, but module-a starts a longer chain.
    const planWithTwoRoots: EngineeringPlan = {
      planVersion: 1,
      generatedBy: "test",
      modules: [
        ...mockPlan.modules,
        {
          moduleId: "module-d",
          title: "Module D (Short Root)",
          stackTarget: "rust-axum",
          prompt: "Prompt for Module D must be at least forty characters long for validation",
          dependsOn: [],
          estimatedComplexity: "trivial",
          maxAttempts: 3,
          exitClauses: [
            { clauseId: "d1", description: "check", kind: "command", argv: ["cargo", "test"], expect: { exitCode: 0 } }
          ],
          touches: ["src/d.rs"]
        }
      ]
    };

    const board = DagBoard.build(planWithTwoRoots, []);
    const ready = board.ready();
    expect(ready).toHaveLength(2);
    // module-a should be first because it has height 3 (a -> b -> c) whereas module-d has height 1 (d)
    expect(ready[0]?.moduleId).toBe("module-a");
    expect(ready[1]?.moduleId).toBe("module-d");
  });

  test("applies module lifecycle events and propagates ready states", () => {
    const board = DagBoard.build(mockPlan, []);
    
    // 1. Dispatch A
    board.apply({
      seq: 1,
      pipelineId: "p1",
      epoch: 1,
      ts: new Date().toISOString(),
      type: "module.dispatched",
      payload: { moduleId: "module-a", attemptId: "att-1" },
      integrity: ""
    });
    expect(board.getModuleState(makeModuleId("module-a"))?.status).toBe("EXECUTING");

    // 2. Executor finished A
    board.apply({
      seq: 2,
      pipelineId: "p1",
      epoch: 1,
      ts: new Date().toISOString(),
      type: "module.executorFinished",
      payload: { moduleId: "module-a" },
      integrity: ""
    });
    expect(board.getModuleState(makeModuleId("module-a"))?.status).toBe("VERIFYING");

    // 3. Pass A
    board.apply({
      seq: 3,
      pipelineId: "p1",
      epoch: 1,
      ts: new Date().toISOString(),
      type: "module.passed",
      payload: { moduleId: "module-a" },
      integrity: ""
    });
    expect(board.getModuleState(makeModuleId("module-a"))?.status).toBe("PASSED");
    
    // module-b should now be READY
    expect(board.getModuleState(makeModuleId("module-b"))?.status).toBe("READY");
    expect(board.ready()[0]?.moduleId).toBe("module-b");
  });

  test("throws IllegalStateTransitionError on invalid transition", () => {
    const board = DagBoard.build(mockPlan, []);
    
    expect(() => {
      board.apply({
        seq: 1,
        pipelineId: "p1",
        epoch: 1,
        ts: new Date().toISOString(),
        type: "module.passed", // Cannot pass a BLOCKED module
        payload: { moduleId: "module-b" },
        integrity: ""
      });
    }).toThrow();
  });
});

describe("Scheduler - DispatchPump", () => {
  test("honors capacity ceiling and asserts budget headroom", async () => {
    const board = DagBoard.build(mockPlan, []);
    
    // Mock executor
    let dispatched = 0;
    const mockExecutor = {
      dispatch: async (task: any) => {
        dispatched++;
        return "session-1";
      },
      onFinish: () => () => {},
      snapshot: async () => "snap-1",
      restore: async () => {},
      capacity: () => ({ max: 2, inFlight: 1 }) // only 1 capacity remaining
    };

    // Mock budget ledger
    let headroomAsserted = false;
    const mockBudget = {
      assertHeadroom: (dim: string, op: string) => {
        if (dim === "usd" && op === "moduleDispatch") {
          headroomAsserted = true;
        }
      }
    };

    // Mock journal and epoch
    const mockJournal = {
      append: async () => {}
    };

    const pump = new DispatchPump({
      board,
      executor: mockExecutor as any,
      settlement: { register: () => {} } as any,
      budget: mockBudget as any,
      journal: mockJournal,
      epoch: () => 1,
      workspace: "/dummy"
    });

    await pump.pump();

    // Capacity allows 1 dispatch (max 2, inFlight 1)
    expect(dispatched).toBe(1);
    expect(headroomAsserted).toBe(true);
    expect(board.getModuleState(makeModuleId("module-a"))?.status).toBe("EXECUTING");
  });
});
