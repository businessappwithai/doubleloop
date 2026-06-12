import { test, describe, expect, vi } from "vitest";
import { StateMachine, PipelineState } from "../src/state-machine.js";
import { SettlementTracker } from "../src/settlement.js";
import { BudgetLedger } from "../src/budget.js";
import { DoubleLoopController, EventBus } from "../src/controllers/double-loop.controller.js";
import { DagBoard, DispatchPump } from "@dlo/scheduler";
import { makeModuleId, makeRunToken, makeSnapshotRef } from "@dlo/core";
import type { EngineeringPlan } from "@dlo/plan-schema";

const mockPlan: EngineeringPlan = {
  planVersion: 1,
  generatedBy: "test-sim",
  modules: [
    {
      moduleId: "mod1",
      title: "Module 1",
      stackTarget: "rust-axum",
      prompt: "Prompt for Module 1 must be at least forty characters long for validation",
      dependsOn: [],
      estimatedComplexity: "standard",
      maxAttempts: 2,
      exitClauses: [{ clauseId: "c1", description: "check", kind: "command", argv: ["cargo", "test"], expect: { exitCode: 0 } }],
      touches: ["src/mod1.rs"]
    },
    {
      moduleId: "mod2",
      title: "Module 2",
      stackTarget: "rust-axum",
      prompt: "Prompt for Module 2 must be at least forty characters long for validation",
      dependsOn: ["mod1"],
      estimatedComplexity: "standard",
      maxAttempts: 2,
      exitClauses: [{ clauseId: "c2", description: "check", kind: "command", argv: ["cargo", "test"], expect: { exitCode: 0 } }],
      touches: ["src/mod2.rs"]
    }
  ]
};

// In-process EventBus implementation
class SimpleEventBus implements EventBus {
  subscribers: Array<{ types: string[] | "*"; handler: (e: any) => void | Promise<void> }> = [];
  published: any[] = [];

  subscribe(sub: any) {
    this.subscribers.push(sub);
  }

  async publish(event: any) {
    this.published.push(event);
    for (const sub of this.subscribers) {
      if (sub.types === "*" || sub.types.includes(event.type)) {
        await sub.handler(event);
      }
    }
  }
}

describe("Double-Loop Execution Simulation", () => {
  test("runs execution to completion and honors outer loop verification rules", async () => {
    const bus = new SimpleEventBus();
    const board = DagBoard.build(mockPlan, []);
    const journalEvents: any[] = [];
    const journal = {
      append: async (type: string, payload: any) => {
        journalEvents.push({ type, payload });
      }
    };

    const budget = new BudgetLedger({
      usd: 100,
      tokens: 1000,
      wallClockMs: 10000,
      spawnDepth: 2,
      turns: 10,
      warnAtFraction: 0.8
    }, journal as any);

    const settlement = new SettlementTracker(journal as any);
    let epochVal = 1;
    const epoch = () => epochVal;

    // Executor double
    let capacityInFlight = 0;
    let finishCallback: any = null;
    const dispatchedTasks: any[] = [];

    const executor = {
      dispatch: async (task: any) => {
        capacityInFlight++;
        dispatchedTasks.push(task);
        // Simulate execution finish asynchronously
        process.nextTick(() => {
          capacityInFlight--;
          if (finishCallback) {
            finishCallback({
              moduleId: task.module.moduleId,
              attemptId: task.attemptId,
              attempt: task.attempt,
              runToken: task.runToken,
              sessionRef: "session-123",
              summary: "Done!",
              changes: [],
              preSnapshot: task.preSnapshot,
              workspace: task.workspace,
              workspaceCtx: {},
              exitedCleanly: true
            });
          }
        });
        return "session-123";
      },
      onFinish: (cb: any) => {
        finishCallback = cb;
        return () => {};
      },
      snapshot: async () => "snap-sim",
      restore: async () => {},
      capacity: () => ({ max: 2, inFlight: capacityInFlight })
    };

    // Supervisor double: fail once on mod1, then pass
    let mod1Attempts = 0;
    const supervisor = {
      evaluate: async (req: any) => {
        if (req.module.moduleId === "mod1") {
          mod1Attempts++;
          if (mod1Attempts === 1) {
            return { kind: "FAIL", critique: "missing files" };
          }
        }
        return { kind: "PASS", critique: "" };
      }
    };

    const clauses = {
      runAll: async () => [{ clauseId: "c1", passed: true, observed: "stdout match", durationMs: 10 }]
    };

    const git = {
      promote: async () => {}
    };

    const artifacts = {
      putText: async (text: string, label: string) => ({ sha256: "hash", mediaType: "text/plain" })
    };

    const pump = new DispatchPump({
      board,
      executor: executor as any,
      settlement,
      budget,
      journal,
      epoch,
      workspace: "/dummy"
    });

    const controller = new DoubleLoopController({
      bus,
      board,
      pump,
      executor: executor as any,
      supervisor: supervisor as any,
      clauses,
      settlement,
      journal,
      artifacts,
      budget,
      epoch,
      git
    });

    controller.start();

    // Trigger first pump
    await pump.pump();

    // Wait for async execution ticks to complete
    await new Promise<void>((resolve) => {
      let interval = setInterval(() => {
        if (board.allPassed()) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(mod1Attempts).toBe(2); // First failed, second passed
    expect(board.getModuleState(makeModuleId("mod1"))?.status).toBe("PASSED");
    expect(board.getModuleState(makeModuleId("mod2"))?.status).toBe("PASSED");
    expect(board.allPassed()).toBe(true);
    expect(bus.published.some(e => e.type === "dag.allPassed")).toBe(true);
  });
});
