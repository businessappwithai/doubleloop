import { test, describe, expect, vi } from "vitest";
import { StateMachine, PipelineState } from "../src/state-machine.js";
import { SettlementTracker } from "../src/settlement.js";
import { BudgetLedger } from "../src/budget.js";
import { makeRunToken } from "@dlo/core";

// Mock JournalAppender
class MockJournalAppender {
  events: Array<{ type: string; payload: unknown }> = [];
  async append(type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload });
  }
}

describe("Kernel", () => {
  describe("State Machine Reducer", () => {
    const sm = new StateMachine();

    test("INIT::pipeline.started -> RESEARCH_RUNNING", () => {
      const state: PipelineState = sm.initialState();
      const mockEvent: any = { seq: 1, type: "pipeline.started", payload: {} };

      const { next, intents } = sm.reduce(state, mockEvent);

      expect(next.phase).toBe("RESEARCH_RUNNING");
      expect(next.sessionEpoch).toBe(1);
      expect(intents).toHaveLength(1);
      expect(intents[0]?.kind).toBe("intent.research.start");
    });

    test("illegal transition throws IllegalStateTransitionError", () => {
      const state: PipelineState = sm.initialState();
      // research.completed is not valid in INIT state
      const mockEvent: any = { seq: 1, type: "research.completed", payload: {} };

      expect(() => sm.reduce(state, mockEvent)).toThrow();
    });

    test("global abortRequested transitions to ABORTED", () => {
      const state: PipelineState = {
        phase: "RESEARCH_RUNNING",
        sessionEpoch: 1,
        activeGateId: null,
        domainDocument: null,
        planArtifacts: null,
      };
      const mockEvent: any = { seq: 2, type: "pipeline.abortRequested", payload: {} };

      const { next, intents } = sm.reduce(state, mockEvent);

      expect(next.phase).toBe("ABORTED");
      expect(intents).toHaveLength(1);
      expect(intents[0]?.kind).toBe("intent.wrapup.flush");
    });
  });

  describe("Settlement Tracker", () => {
    test("registers and settles correctly", async () => {
      const journal = new MockJournalAppender();
      const tracker = new SettlementTracker(journal);
      const token = makeRunToken();
      const intent: any = { kind: "intent.planning.start" };

      tracker.register(token, 1, intent);

      const result = await tracker.trySettle(token, 1);
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.intent).toEqual(intent);
      }
      expect(journal.events).toHaveLength(0); // No discard events
    });

    test("discards stale epoch settlements", async () => {
      const journal = new MockJournalAppender();
      const tracker = new SettlementTracker(journal);
      const token = makeRunToken();
      const intent: any = { kind: "intent.planning.start" };

      tracker.register(token, 1, intent);

      // Try to settle with epoch 2 (stale epoch)
      const result = await tracker.trySettle(token, 2);
      expect(result.accepted).toBe(false);
      expect(journal.events).toHaveLength(1);
      expect(journal.events[0]?.type).toBe("settlement.discarded");
      expect((journal.events[0]?.payload as any).reason).toBe("epoch-mismatch");
    });

    test("discards unknown tokens", async () => {
      const journal = new MockJournalAppender();
      const tracker = new SettlementTracker(journal);
      const token = makeRunToken();

      const result = await tracker.trySettle(token, 1);
      expect(result.accepted).toBe(false);
      expect(journal.events).toHaveLength(1);
      expect(journal.events[0]?.type).toBe("settlement.discarded");
      expect((journal.events[0]?.payload as any).reason).toBe("unknown-token");
    });
  });

  describe("Budget Ledger", () => {
    test("charges budget and issues warning at threshold", async () => {
      const journal = new MockJournalAppender();
      const config = {
        usd: 100,
        tokens: 1000,
        wallClockMs: 10000,
        spawnDepth: 2,
        turns: 10,
        warnAtFraction: 0.8,
      };

      const ledger = new BudgetLedger(config, journal);

      // Charge under warning threshold
      await ledger.charge("usd", 50, "gemini-research");
      expect(journal.events).toHaveLength(1);
      expect(journal.events[0]?.type).toBe("budget.charged");

      // Charge over warning threshold (80%)
      await ledger.charge("usd", 35, "gemini-followup"); // Total spent = 85 (85%)
      expect(journal.events).toHaveLength(3); // 2 charges + 1 warning
      expect(journal.events[1]?.type).toBe("budget.charged");
      expect(journal.events[2]?.type).toBe("budget.warningThreshold");
      expect((journal.events[2]?.payload as any).fraction).toBe(0.85);
    });

    test("throws when budget is exhausted", async () => {
      const journal = new MockJournalAppender();
      const config = {
        usd: 10,
        tokens: 1000,
        wallClockMs: 10000,
        spawnDepth: 2,
        turns: 10,
        warnAtFraction: 0.8,
      };

      const ledger = new BudgetLedger(config, journal);

      await expect(ledger.charge("usd", 15, "large-spend")).rejects.toThrow();
      expect(journal.events).toHaveLength(3); // 1 charge + 1 warning + 1 exhausted
      expect(journal.events[0]?.type).toBe("budget.charged");
      expect(journal.events[1]?.type).toBe("budget.warningThreshold");
      expect(journal.events[2]?.type).toBe("budget.exhausted");
    });
  });
});
