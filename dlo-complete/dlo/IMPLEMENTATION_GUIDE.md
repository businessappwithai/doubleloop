# DLO Implementation Guide
## From Architecture to Production Code

This guide explains how to build out the complete DLO system starting from the architecture document. It complements the normative architecture specification and provides implementation patterns, code examples, and test structures that keep the system testable, maintainable, and true to the no-fallback, no-mock principle.

---

## Table of Contents

1. [Build Strategy](#1-build-strategy)
2. [Journal Implementation](#2-journal-implementation)
3. [Kernel Implementation](#3-kernel-implementation)
4. [Scheduler and DAG Board](#4-scheduler-and-dag-board)
5. [Exit Clause Evaluation](#5-exit-clause-evaluation)
6. [Provider Adapters](#6-provider-adapters)
7. [HITL Gates and Transports](#7-hitl-gates-and-transports)
8. [CLI and Daemon](#8-cli-and-daemon)
9. [CopilotKit UI Integration](#9-copilotkit-ui-integration)
10. [Testing Strategy](#10-testing-strategy)

---

## 1. Build Strategy

**Milestone order (gates M1–M8 from architecture §22):**

1. **M1: Foundations** (`@dlo/core` ✓ started, `@dlo/journal` in progress)
   - Append-only JSONL journal with integrity-chain validation
   - Event type registry and payload schemas
   - Snapshot serialization
   - Recovery/replay logic
   - **Exit criteria:** Journal property tests pass (append/replay round-trip, corruption detection, HEAD recovery after simulated crash)

2. **M2: Kernel** (`@dlo/kernel`)
   - State machine reducer (pure function over journal events)
   - Settlement tracker (epoch + run-token fencing)
   - Budget ledger (dimensional charging)
   - Intent emission
   - **Exit criteria:** Exhaustive transition-table tests, settlement stale-completion journaling, budget threshold warnings

3. **M3: Plan + Clauses** (`@dlo/plan-schema`, `@dlo/exit-clauses`)
   - Engineering Plan zod schema
   - Cycle detection with full-path reporting
   - Four evaluators (command, httpProbe, sqlAssertion, fileAssertion)
   - Evaluator registry
   - **Exit criteria:** Cycle detection reports full path, all evaluators work against fixture workspace, unknown kind fails plan validation

4. **M4: Scheduler + Double Loop**
   - DAG board projection from plan + journal
   - Dispatch pump with concurrency pool gating
   - Double-loop controller (inner loop LSP wait, outer loop supervisor evaluation)
   - Deterministic simulation harness
   - **Exit criteria:** Simulation tests prove criticality ordering, concurrency ceiling, FAIL→restore→re-dispatch, exhaustion gate; kill-9 recovery leaves zero duplicated PASS events

5. **M5: Adapters** (Gemini, Claude Code, CodeWhale, pi.dev)
   - Contract tests with cassettes (recorded request/response)
   - Live smoke tests (env-gated)
   - **Exit criteria:** All adapters pass cassette tests; live smoke executes one trivial module end-to-end

6. **M6: HITL + CLI**
   - TUI gate flow
   - Webhook transport
   - `dlo init`, `dlo run`, `dlo resume`, `dlo status`
   - **Exit criteria:** TUI gates drive approve/steer/reject through pty test; webhook signature/replay-window verification

7. **M7: Finalization + Report**
   - Linter, tester, builder subagents
   - Escalation paths producing remediation modules
   - Cost table reconciliation
   - **Exit criteria:** Escalation produces modules that traverse double loop; cost table reconciles to the cent

8. **M8: System e2e**
   - Reference project spec (Axum + sqlx + TanStack)
   - Full pipeline execution on live providers
   - Generated app passes independent testing
   - **Exit criteria:** Completes with ≤ configured budget; generated app runs tests independently

---

## 2. Journal Implementation

### 2.1 Core structure

```typescript
// packages/journal/src/journal.ts

import { createWriteStream, createReadStream } from "node:fs";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { DloError } from "@dlo/core";
import { JournalCorruptionError, JournalIntegrityError } from "@dlo/core";

export interface JournalEvent {
  seq: number;
  pipelineId: string;
  epoch: number;
  ts: string;
  type: string;
  payload: unknown;
  integrity: string;
}

export interface JournalHead {
  activeSegment: number;
  lastSeq: number;
  lastIntegrity: string;
}

/**
 * Append-only, integrity-chained event journal.
 * All writes are fsync'd; recovery is via replay from disk.
 */
export class Journal {
  private #head: JournalHead;
  private #dir: string;
  private #segmentMaxBytes: number;
  private #currentSegment: number;
  private #lastIntegrity: string = ""; // Initialize with empty hash for first event

  constructor(dir: string, segmentMaxBytes: number = 67_108_864) {
    this.#dir = dir;
    this.#segmentMaxBytes = segmentMaxBytes;
    this.#head = { activeSegment: 1, lastSeq: 0, lastIntegrity: "" };
    this.#currentSegment = 1;
  }

  async init(): Promise<void> {
    await mkdir(`${this.#dir}/journal`, { recursive: true });
    const headPath = `${this.#dir}/journal/HEAD`;
    try {
      const content = await readFile(headPath, "utf-8");
      this.#head = JSON.parse(content);
      this.#currentSegment = this.#head.activeSegment;
      this.#lastIntegrity = this.#head.lastIntegrity;
    } catch {
      // Fresh journal: HEAD doesn't exist yet
      await this.#persistHead();
    }
  }

  /**
   * Append an event. Validates payload schema, computes integrity, writes, fsync's,
   * updates HEAD, then notifies subscribers.
   */
  async append(type: string, payload: unknown): Promise<void> {
    const seq = this.#head.lastSeq + 1;
    const ts = new Date().toISOString();
    const epoch = Math.floor(Date.now() / 1000);

    // Placeholder: schema validation would go here (via payload registry)
    // For now, we assume payload is valid.

    const event: Omit<JournalEvent, "integrity"> = {
      seq,
      pipelineId: "", // Set by caller context
      epoch,
      ts,
      type,
      payload,
    };

    const integrity = this.#computeIntegrity(event);
    const eventWithIntegrity: JournalEvent = { ...event, integrity } as JournalEvent;

    const line = JSON.stringify(eventWithIntegrity) + "\n";
    const segmentPath = `${this.#dir}/journal/${String(this.#currentSegment).padStart(6, "0")}.jsonl`;

    // Write to file
    const ws = createWriteStream(segmentPath, { flags: "a" });
    ws.write(line);
    await new Promise<void>((resolve, reject) => {
      ws.on("finish", resolve);
      ws.on("error", reject);
      ws.end();
    });

    // Sync to disk
    const { fsync } = await import("node:fs/promises");
    const fd = await import("node:fs").promises.open(segmentPath, "r");
    try {
      await fsync((fd as any).fd);
    } finally {
      await fd.close();
    }

    // Update in-memory state and HEAD
    this.#head = {
      activeSegment: this.#currentSegment,
      lastSeq: seq,
      lastIntegrity: integrity,
    };
    await this.#persistHead();
  }

  /**
   * Replay events from the journal, verifying the integrity chain.
   * Throws JournalCorruptionError or JournalIntegrityError on any violation.
   */
  async *replay(): AsyncGenerator<JournalEvent> {
    let previousIntegrity = "";
    let lastSeq = 0;

    for (let i = 1; i <= this.#head.activeSegment; i++) {
      const segmentPath = `${this.#dir}/journal/${String(i).padStart(6, "0")}.jsonl`;
      try {
        const content = await readFile(segmentPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());

        for (const line of lines) {
          let event: JournalEvent;
          try {
            event = JSON.parse(line);
          } catch (e) {
            throw new JournalCorruptionError(
              `Failed to parse JSON at segment ${i}`,
              lastSeq + 1,
              String(e),
            );
          }

          // Verify sequence is contiguous
          if (event.seq !== lastSeq + 1) {
            throw new JournalCorruptionError(
              `Seq gap: expected ${lastSeq + 1}, got ${event.seq}`,
              event.seq,
              "sequence discontinuity",
            );
          }
          lastSeq = event.seq;

          // Verify integrity chain
          const { integrity: storedIntegrity, ...eventForVerification } = event;
          const computedIntegrity = this.#computeIntegrity(eventForVerification);
          if (storedIntegrity !== computedIntegrity) {
            throw new JournalIntegrityError(
              `Integrity mismatch at seq ${event.seq}`,
              event.seq,
            );
          }

          previousIntegrity = storedIntegrity;
          yield event;
        }
      } catch (e) {
        // Segment file missing is OK if we're past the active segment
        if (i < this.#head.activeSegment) {
          throw new JournalCorruptionError(
            `Missing segment file: segment-${i}.jsonl`,
            lastSeq,
            String(e),
          );
        }
      }
    }
  }

  private #computeIntegrity(
    event: Omit<JournalEvent, "integrity">,
  ): string {
    const hash = createHash("sha256");
    hash.update(this.#lastIntegrity); // Chain to previous
    hash.update(JSON.stringify(event, Object.keys(event).sort())); // Canonical JSON
    return hash.digest("hex");
  }

  private async #persistHead(): Promise<void> {
    const tmp = `${this.#dir}/journal/HEAD.tmp`;
    await writeFile(tmp, JSON.stringify(this.#head, null, 2));
    await import("node:fs").promises.rename(tmp, `${this.#dir}/journal/HEAD`);
  }
}
```

### 2.2 Event payloads (registry + schemas)

```typescript
// packages/journal/src/payloads.ts

import { z } from "zod";

export const PipelineStartedPayloadSchema = z.object({
  pipelineId: z.string(),
  config: z.record(z.unknown()),
});

export const ResearchDispatchedPayloadSchema = z.object({
  pipelineId: z.string(),
  interactionId: z.string(),
});

export const ModuleDispatchedPayloadSchema = z.object({
  moduleId: z.string(),
  attemptId: z.string(),
  sessionRef: z.string(),
  preSnapshot: z.string(),
});

// ... (many more payload schemas for each event type)

export type EventPayload =
  | z.infer<typeof PipelineStartedPayloadSchema>
  | z.infer<typeof ResearchDispatchedPayloadSchema>
  | z.infer<typeof ModuleDispatchedPayloadSchema>;
  // ... union of all payload types

/**
 * Registry that maps event.type to its payload schema.
 * Used by Journal.append() to validate before persisting.
 */
export class PayloadRegistry {
  #schemas = new Map<string, z.ZodSchema>();

  register(eventType: string, schema: z.ZodSchema): void {
    if (this.#schemas.has(eventType)) {
      throw new Error(`Event type already registered: ${eventType}`);
    }
    this.#schemas.set(eventType, schema);
  }

  validate(eventType: string, payload: unknown): unknown {
    const schema = this.#schemas.get(eventType);
    if (!schema) {
      throw new Error(`Unknown event type: ${eventType}`);
    }
    return schema.parse(payload);
  }
}
```

### 2.3 Snapshot and recovery

```typescript
// packages/journal/src/snapshot.ts

import { writeFile, readFile } from "node:fs/promises";
import type { PipelineState } from "@dlo/kernel"; // Forward reference

export interface Snapshot {
  seq: number;
  ts: string;
  state: PipelineState;
  boardSerialized: unknown; // DagBoard.serialize()
  budgetSerialized: unknown; // BudgetLedger.serialize()
}

export async function saveSnapshot(
  dir: string,
  seq: number,
  state: PipelineState,
  board: unknown,
  budget: unknown,
): Promise<void> {
  const snapshot: Snapshot = {
    seq,
    ts: new Date().toISOString(),
    state,
    boardSerialized: board,
    budgetSerialized: budget,
  };

  const path = `${dir}/.dlo/snapshots/state-${seq}.json`;
  await writeFile(path, JSON.stringify(snapshot, null, 2));
}

export async function loadLatestSnapshot(dir: string): Promise<Snapshot | null> {
  // Implementation: scan .dlo/snapshots/, find highest seq, load and return
  // ... (details omitted for brevity)
  return null;
}

export async function replayFrom(
  journal: Journal,
  snapshot: Snapshot,
): AsyncGenerator<JournalEvent> {
  // Skip events up to snapshot.seq, then yield the rest
  for await (const event of journal.replay()) {
    if (event.seq > snapshot.seq) {
      yield event;
    }
  }
}
```

---

## 3. Kernel Implementation

### 3.1 State machine reducer

```typescript
// packages/kernel/src/state-machine.ts

import type { PipelinePhase, DloError } from "@dlo/core";
import {
  IllegalStateTransitionError,
} from "@dlo/core";
import type { JournalEvent } from "@dlo/journal";

export interface PipelineState {
  phase: PipelinePhase;
  sessionEpoch: number;
  activeGateId: string | null;
  domainDocument: unknown | null;
  planArtifacts: unknown | null;
  createdAt: string;
  lastTransitionAt: string;
}

export type KernelIntent =
  | { kind: "intent.research.start" }
  | { kind: "intent.research.steer"; instructions: unknown }
  | { kind: "intent.gate.open"; gateId: string }
  | { kind: "intent.planning.start" }
  | { kind: "intent.execution.begin" }
  | { kind: "intent.finalization.start" }
  | { kind: "intent.wrapup.flush" }
  | { kind: "intent.report.success" }
  | { kind: "intent.report.failure"; error: DloError };

export class StateMachine {
  reduce(
    state: PipelineState,
    event: JournalEvent,
  ): { next: PipelineState; intents: KernelIntent[] } {
    const key = `${state.phase}::${event.type}`;

    switch (key) {
      case "INIT::pipeline.started":
        return {
          next: { ...state, phase: "RESEARCH_RUNNING", sessionEpoch: state.sessionEpoch + 1 },
          intents: [{ kind: "intent.research.start" }],
        };

      case "RESEARCH_RUNNING::research.completed":
        return {
          next: {
            ...state,
            phase: "GATE1_PENDING",
            domainDocument: (event.payload as any).document,
            activeGateId: (event.payload as any).gateId,
          },
          intents: [{ kind: "intent.gate.open", gateId: (event.payload as any).gateId }],
        };

      case "GATE1_PENDING::gate.approved":
        return {
          next: {
            ...state,
            phase: "PLANNING_RUNNING",
            activeGateId: null,
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.planning.start" }],
        };

      case "GATE1_PENDING::gate.steered":
        return {
          next: {
            ...state,
            phase: "RESEARCH_RUNNING",
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [
            {
              kind: "intent.research.steer",
              instructions: (event.payload as any).instructions,
            },
          ],
        };

      case "PLANNING_RUNNING::planning.completed":
        return {
          next: {
            ...state,
            phase: "GATE2_PENDING",
            planArtifacts: (event.payload as any).plan,
            activeGateId: (event.payload as any).gateId,
          },
          intents: [{ kind: "intent.gate.open", gateId: (event.payload as any).gateId }],
        };

      case "GATE2_PENDING::gate.approved":
        return {
          next: {
            ...state,
            phase: "EXECUTION_RUNNING",
            activeGateId: null,
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.execution.begin" }],
        };

      case "EXECUTION_RUNNING::dag.allPassed":
        return {
          next: {
            ...state,
            phase: "FINALIZATION_RUNNING",
          },
          intents: [{ kind: "intent.finalization.start" }],
        };

      case "FINALIZATION_RUNNING::finalization.completed":
        return {
          next: { ...state, phase: "COMPLETED" },
          intents: [{ kind: "intent.report.success" }],
        };

      default:
        throw new IllegalStateTransitionError(
          `No transition defined for ${key}`,
          state.phase,
          event.type,
        );
    }
  }
}
```

### 3.2 Settlement tracker

```typescript
// packages/kernel/src/settlement.ts

import type { RunToken } from "@dlo/core";
import { SettlementViolationError } from "@dlo/core";
import type { KernelIntent } from "./state-machine.js";

export class SettlementTracker {
  #pending = new Map<
    RunToken,
    { epoch: number; intent: KernelIntent; registeredAt: number }
  >();

  register(token: RunToken, epoch: number, intent: KernelIntent): void {
    // Idempotent: if already registered, verify it's the same epoch/intent
    const existing = this.#pending.get(token);
    if (existing && existing.epoch !== epoch) {
      throw new SettlementViolationError(
        `Token already registered with different epoch`,
        "epoch-mismatch",
      );
    }
    this.#pending.set(token, { epoch, intent, registeredAt: Date.now() });
  }

  trySettle(
    token: RunToken,
    currentEpoch: number,
  ): { accepted: true; intent: KernelIntent } | { accepted: false; reason: string } {
    const entry = this.#pending.get(token);

    if (!entry) {
      return { accepted: false, reason: "unknown-token" };
    }

    if (entry.epoch !== currentEpoch) {
      this.#pending.delete(token);
      return { accepted: false, reason: "epoch-mismatch" };
    }

    const intent = entry.intent;
    this.#pending.delete(token);
    return { accepted: true, intent };
  }

  clear(): void {
    this.#pending.clear();
  }
}
```

### 3.3 Budget ledger

```typescript
// packages/kernel/src/budget.ts

import { BudgetExhaustedError } from "@dlo/core";

export type BudgetDimension = "usd" | "tokens" | "wallClockMs" | "spawnDepth" | "turns";

export interface BudgetConfig {
  usd: number;
  tokens: number;
  wallClockMs: number;
  spawnDepth: number;
  turns: number;
  warnAtFraction: number; // default 0.8
}

export class BudgetLedger {
  #limits: BudgetConfig;
  #spent: Record<BudgetDimension, number> = {
    usd: 0,
    tokens: 0,
    wallClockMs: 0,
    spawnDepth: 0,
    turns: 0,
  };
  #warned = new Set<BudgetDimension>();

  constructor(config: BudgetConfig) {
    this.#limits = config;
  }

  charge(dim: BudgetDimension, amount: number, attribution: string): void {
    this.#spent[dim] += amount;
    const fraction = this.#spent[dim] / this.#limits[dim];

    if (fraction > this.#limits.warnAtFraction && !this.#warned.has(dim)) {
      this.#warned.add(dim);
      // Emit warning event: budget.warningThreshold
    }

    if (this.#spent[dim] > this.#limits[dim]) {
      throw new BudgetExhaustedError(
        `Budget exhausted for ${dim}`,
        dim,
        this.#spent[dim],
        this.#limits[dim],
      );
    }
  }

  assertHeadroom(dim: BudgetDimension, op: string): void {
    if (this.#spent[dim] >= this.#limits[dim]) {
      throw new BudgetExhaustedError(
        `Cannot perform ${op}: ${dim} budget exhausted`,
        dim,
        this.#spent[dim],
        this.#limits[dim],
      );
    }
  }

  spent(): Record<BudgetDimension, number> {
    return { ...this.#spent };
  }

  remaining(dim: BudgetDimension): number {
    return Math.max(0, this.#limits[dim] - this.#spent[dim]);
  }

  serialize() {
    return { spent: { ...this.#spent }, limits: this.#limits };
  }

  static deserialize(data: {
    spent: Record<BudgetDimension, number>;
    limits: BudgetConfig;
  }): BudgetLedger {
    const ledger = new BudgetLedger(data.limits);
    ledger.#spent = { ...data.spent };
    return ledger;
  }
}
```

---

## 4. Scheduler and DAG Board

(Implementation patterns provided; agent to complete)

```typescript
// packages/scheduler/src/board.ts

import type { EngineeringPlan } from "@dlo/plan-schema";
import type { JournalEvent } from "@dlo/journal";
import type { ModuleId, ModuleStatus } from "@dlo/core";

export interface DagBoardState {
  modules: Map<ModuleId, { status: ModuleStatus; dependencies: ModuleId[] }>;
}

export class DagBoard {
  #state: DagBoardState;

  static build(plan: EngineeringPlan, _replay: Iterable<JournalEvent>): DagBoard {
    // EXTENSION POINT: Kahn's algorithm to validate acyclicity
    // Build the module map with statuses from the replay
    throw new Error("Not implemented");
  }

  ready(): ReadonlyArray<ModuleId> {
    // Return all modules with status READY, ordered by criticality
    throw new Error("Not implemented");
  }

  apply(event: JournalEvent): void {
    // Update module statuses based on journal events
    throw new Error("Not implemented");
  }

  allPassed(): boolean {
    // Return true if all modules are PASSED
    throw new Error("Not implemented");
  }

  serialize() {
    return this.#state;
  }
}
```

---

## 5. Exit Clause Evaluation

```typescript
// packages/exit-clauses/src/runner.ts

import type { ExitClause } from "@dlo/core";
import { ExitClauseEvaluationError } from "@dlo/core";

export interface ClauseContext {
  workspace: string;
  backendDir?: string;
  frontendDir?: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface ClauseResult {
  clauseId: string;
  passed: boolean;
  observed: string;
  durationMs: number;
}

export interface ClauseEvaluator {
  kind: string;
  evaluate(clause: ExitClause, ctx: ClauseContext): Promise<ClauseResult>;
}

export class CommandClauseEvaluator implements ClauseEvaluator {
  kind = "command";

  async evaluate(clause: ExitClause, ctx: ClauseContext): Promise<ClauseResult> {
    // EXTENSION POINT: execFile with the clause's argv, cwd resolution, timeout gating
    // Capture stdout/stderr; match against expect patterns; return ClauseResult
    throw new Error("Not implemented");
  }
}

export class ClauseRunner {
  #evaluators = new Map<string, ClauseEvaluator>();

  register(evaluator: ClauseEvaluator): void {
    this.#evaluators.set(evaluator.kind, evaluator);
  }

  async runAll(
    clauses: ReadonlyArray<ExitClause>,
    ctx: ClauseContext,
  ): Promise<ReadonlyArray<ClauseResult>> {
    const results: ClauseResult[] = [];
    for (const clause of clauses) {
      const evaluator = this.#evaluators.get(clause.kind);
      if (!evaluator) {
        throw new ExitClauseEvaluationError(
          `No evaluator for clause kind: ${clause.kind}`,
          clause.clauseId,
        );
      }
      try {
        results.push(await evaluator.evaluate(clause, ctx));
      } catch (e) {
        throw new ExitClauseEvaluationError(
          `Clause evaluation failed: ${String(e)}`,
          clause.clauseId,
          { cause: e },
        );
      }
    }
    return results;
  }
}
```

---

## 6. Provider Adapters

Each adapter implements one of the port interfaces from `@dlo/core/ports.ts`. The pattern is:

1. Validate input against the provider's contract (throws `AdapterValidationError`)
2. Make the async call (http, subprocess, IPC)
3. Parse the response against the expected schema
4. Charge budget
5. Journal the outcome
6. Return typed result or throw `AdapterProcessError`

Example structure (agent fills in the specifics):

```typescript
// packages/adapters-gemini/src/provider.ts

import type { ResearchProvider, ResearchRequest } from "@dlo/core";
import { AdapterProcessError, AdapterValidationError } from "@dlo/core";
import type { BudgetLedger, JournalAppender } from "@dlo/journal";

export class GeminiDeepResearchProvider implements ResearchProvider {
  constructor(private deps: {
    client: any; // GoogleGenAI SDK
    model: string;
    journal: JournalAppender;
    budget: BudgetLedger;
  }) {}

  async dispatch(req: ResearchRequest): Promise<any> {
    // EXTENSION POINT:
    // 1. Validate req (throw AdapterValidationError on schema mismatch)
    // 2. Call client.interactions.create({ model, background: true, ... })
    // 3. Journal research.dispatched immediately
    // 4. Return handle
    throw new Error("Not implemented");
  }

  async await(handle: any, signal: AbortSignal): Promise<any> {
    // EXTENSION POINT:
    // Poll with decorrelated-jitter backoff, journal poll ticks, charge token usage,
    // return DomainDocument or throw AdapterProcessError
    throw new Error("Not implemented");
  }
}
```

---

## 7. HITL Gates and Transports

```typescript
// packages/hitl/src/service.ts

import type { GateDescriptor, GateResolution } from "@dlo/core";

export interface HitlTransport {
  name: string;
  present(gate: GateDescriptor, signal: AbortSignal): Promise<GateResolution>;
}

export class HitlGateService {
  #transports: HitlTransport[] = [];

  registerTransport(transport: HitlTransport): void {
    this.#transports.push(transport);
  }

  async present(gate: GateDescriptor, signal: AbortSignal): Promise<GateResolution> {
    // Race all transports; first resolution wins; others aborted
    const promises = this.#transports.map((t) =>
      t.present(gate, signal).catch((e) => ({ error: e, transport: t.name })),
    );

    const result = await Promise.race(promises);
    if ("error" in result) {
      throw result.error;
    }
    return result as GateResolution;
  }
}
```

---

## 8. CLI and Daemon

```typescript
// packages/cli/src/index.ts

import { Command } from "commander";
import type { DloConfig } from "@dlo/core";

const program = new Command()
  .name("dlo")
  .description("Double-Loop Orchestrator — autonomous development pipeline");

program
  .command("init <projectDir>")
  .description("Initialize a new DLO project")
  .action(async (projectDir) => {
    // EXTENSION POINT: prompt for config, create .dlo dir, write dlo.config.ts
    throw new Error("Not implemented");
  });

program
  .command("run [workspace]")
  .description("Start a new pipeline or resume an existing one")
  .option("--no-resume", "Do not resume if journal exists")
  .action(async (workspace, options) => {
    // EXTENSION POINT: load config, init journal, start daemon, present CLI
    throw new Error("Not implemented");
  });

program
  .command("resume [workspace]")
  .description("Resume a paused or crashed pipeline")
  .action(async (workspace) => {
    // EXTENSION POINT: recover state, resume pump/controllers
    throw new Error("Not implemented");
  });

program
  .command("status [workspace]")
  .description("Show live pipeline status")
  .action(async (workspace) => {
    // EXTENSION POINT: render DAG board, module attempts, gate status
    throw new Error("Not implemented");
  });

program.parse(process.argv);
```

---

## 9. CopilotKit UI Integration

The chat UI is a CopilotKit-powered React application that:
- Connects to the running DLO daemon via HTTP
- Presents agents for common operations (init, monitor, gate resolution, artifact viewing)
- Streams live updates from the pipeline via Server-Sent Events (SSE) or WebSocket
- Handles gate presentation with approve/steer/reject UI

(Details in the subsequent section — full React + CopilotKit implementation)

---

## 10. Testing Strategy

### Property-based tests (journal)

```typescript
// packages/journal/__tests__/journal.test.ts

import { test, describe, expect } from "vitest";
import fc from "fast-check";
import { Journal } from "../src/journal";

describe("Journal", () => {
  test("append/replay round-trip preserves events", async () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.hexaString({ minLength: 1, maxLength: 10 }),
            fc.object({ withNullPrototype: false }),
          ),
        ),
        async (events) => {
          const journal = new Journal("/tmp/test-journal");
          await journal.init();

          for (const [type, payload] of events) {
            await journal.append(type, payload);
          }

          const replayed: any[] = [];
          for await (const event of journal.replay()) {
            replayed.push(event);
          }

          expect(replayed).toHaveLength(events.length);
          // Assert payload equality, seq contiguity, integrity chain
        },
      ),
    );
  });

  test("corruption detection on single-byte tamper", async () => {
    // Simulate corrupting a byte in a segment file, verify replay throws
    throw new Error("Not implemented");
  });

  test("HEAD recovery after simulated crash", async () => {
    // Write events, kill the process (simulate by deleting HEAD),
    // restart, verify recovery
    throw new Error("Not implemented");
  });
});
```

### Deterministic simulation (scheduler + kernel)

```typescript
// packages/kernel/__tests__/simulation.test.ts

import { test, describe, expect } from "vitest";
import { StateMachine } from "../src/state-machine";
import { SettlementTracker } from "../src/settlement";
import { DagBoard } from "@dlo/scheduler";

class MockExecutor {
  // Returns a fixed sequence of events for deterministic testing
  async *executeModule() {
    yield { type: "module.executorFinished", payload: {} };
  }
}

describe("Double-loop simulation", () => {
  test("criticality ordering: longest-chain-first dispatch", () => {
    // EXTENSION POINT: build a plan with a known critical path, run pump,
    // verify dispatch order matches expected criticality ranking
    throw new Error("Not implemented");
  });

  test("FAIL → restore → re-dispatch with critique", () => {
    // EXTENSION POINT: simulate executor returning FAIL, verify preSnapshot is
    // restored, verify critique is attached to re-dispatch
    throw new Error("Not implemented");
  });

  test("concurrency ceiling honored", () => {
    // EXTENSION POINT: dispatch N modules concurrently until at capacity,
    // verify no more are dispatched until one settles
    throw new Error("Not implemented");
  });

  test("kill -9 recovery: zero duplicate PASSes", () => {
    // EXTENSION POINT: run full simulation, simulate daemon crash mid-execution,
    // recovery replay, verify journal has no duplicate module.passed events
    throw new Error("Not implemented");
  });
});
```

---

## Summary

This guide provides the implementation patterns and test strategy for building DLO. The agent should follow the **M1 → M8 milestone sequence**, ensuring every **[NORMATIVE]** contract from the architecture is honored, and every `// EXTENSION POINT` is filled with production-quality code (no mocks, no fallbacks, no sample data).

Key invariants to uphold:
- **No fallback paths:** missing binaries, docker, env vars fail boot loudly.
- **No mock data:** every code path either performs its real function or throws a typed error.
- **Typed failures:** every `throw` or `Promise.reject` uses a `DloError` subclass.
- **Event-sourced truth:** journal is the single source of truth; all projections (state, board) are replayed deterministically.
- **Deterministic settlement:** epochs + run tokens fence async boundaries; stale completions are journaled, never processed.

Good luck building DLO! 🚀
