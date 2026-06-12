# DLO — Double-Loop Orchestrator
## Architecture & Implementation Specification

| | |
|---|---|
| **Document type** | Normative architecture specification (agent-consumable) |
| **Version** | 1.0.0 |
| **Status** | Approved for implementation |
| **Target runtime** | Node.js ≥ 22 (LTS), TypeScript ≥ 5.6, ESM-only |
| **Generated stack (output of the pipeline)** | Rust (Axum) · PostgreSQL · TanStack Start (React) |
| **Orchestrated providers** | Google Gemini Deep Research · Anthropic Claude Code CLI · CodeWhale (DeepSeek V4) · pi.dev harness |

> **How to read this document (instruction to the implementing coding agent).**
> Every section marked **[NORMATIVE]** defines contracts that MUST be implemented exactly as specified — type names, event names, state identifiers, file paths, and wire schemas are load-bearing and are referenced across packages. Sections marked **[GUIDANCE]** describe intent and may be realized with implementation freedom provided the normative contracts are honored. Code blocks tagged `// EXTENSION POINT` mark the locations where the implementing agent must supply the full production logic; the surrounding control flow, signatures, and error semantics are already final and MUST NOT be altered. Do not introduce placeholder, mock, sample, or fallback data anywhere: every code path must either perform its real function or fail loudly with a typed error.

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Architectural Principles](#2-architectural-principles)
3. [System Topology](#3-system-topology)
4. [Monorepo Layout](#4-monorepo-layout)
5. [Core Domain Model](#5-core-domain-model) **[NORMATIVE]**
6. [Pipeline Lifecycle State Machine](#6-pipeline-lifecycle-state-machine) **[NORMATIVE]**
7. [Event Bus and Message Contracts](#7-event-bus-and-message-contracts) **[NORMATIVE]**
8. [Provider Adapter Layer](#8-provider-adapter-layer) **[NORMATIVE]**
9. [Phase I Controller — Domain Research](#9-phase-i-controller--domain-research)
10. [Human-in-the-Loop Gate Subsystem](#10-human-in-the-loop-gate-subsystem) **[NORMATIVE]**
11. [Phase II Controller — Strategic Planning](#11-phase-ii-controller--strategic-planning)
12. [Engineering Plan Schema and Exit-Clause DSL](#12-engineering-plan-schema-and-exit-clause-dsl) **[NORMATIVE]**
13. [DAG Scheduler](#13-dag-scheduler) **[NORMATIVE]**
14. [Phase III/IV Controller — Double-Loop Execution and Verification](#14-phase-iiiiv-controller--double-loop-execution-and-verification) **[NORMATIVE]**
15. [Phase V Controller — Finalization Swarm](#15-phase-v-controller--finalization-swarm)
16. [Persistence, Journaling, and Crash Recovery](#16-persistence-journaling-and-crash-recovery) **[NORMATIVE]**
17. [Resilience: Budgets, Depth Guards, Compaction](#17-resilience-budgets-depth-guards-compaction)
18. [Configuration Schema](#18-configuration-schema) **[NORMATIVE]**
19. [Extensibility and Plugin System](#19-extensibility-and-plugin-system)
20. [Observability](#20-observability)
21. [Security Posture](#21-security-posture)
22. [Implementation Roadmap and Acceptance Criteria](#22-implementation-roadmap-and-acceptance-criteria)
23. [Glossary](#23-glossary)

---

## 1. Purpose and Scope

DLO is a long-running Node.js orchestration daemon that drives a five-phase autonomous software-delivery pipeline:

1. **Research** — acquire a Domain Document via Gemini Deep Research (background interaction).
2. **HITL Gate 1** — human validation/steering/rejection of the Domain Document.
3. **Planning** — Claude Code (plan mode) produces a tripartite plan (CEO / Architectural / Engineering) whose Engineering stratum is a machine-readable acyclic task graph with deterministic exit clauses.
4. **HITL Gate 2** — human validation of the plan; permission escalation on approval.
5. **Execution + Verification (the double loop)** — a concurrent CodeWhale (DeepSeek V4) swarm executes modules (inner loop: LSP-driven micro-iteration) while a persistent Claude Code supervisor evaluates each completed module against its exit clauses (outer loop: approve/commit or critique/rollback/re-dispatch).
6. **Finalization** — parallel lint, test, and release-build subagents; structured completion report.

**In scope:** the orchestrator itself — its state machine, adapters, scheduler, verification engine, persistence, recovery, configuration, plugin surface, and CLI/TUI shell.
**Out of scope:** the generated application's business logic (that is the pipeline's *output*), and the internals of the third-party tools (pi.dev, Claude Code, CodeWhale, Gemini), which are integrated strictly through their published programmatic surfaces.

---

## 2. Architectural Principles

1. **Hexagonal (ports & adapters).** All vendor interaction goes through provider-agnostic ports (`ResearchProvider`, `PlannerProvider`, `ExecutorProvider`, `SupervisorProvider`, `HarnessSession`). Vendors are swappable per-port via configuration; nothing in `core` imports a vendor SDK.
2. **Event-sourced kernel.** The pipeline's authoritative state is an append-only journal of domain events. In-memory projections (the state machine, the DAG board) are rebuilt deterministically from the journal on restart. There is no second source of truth.
3. **Deterministic settlement.** Every asynchronous boundary (subagent finish, CLI exit, interaction poll) is fenced with epochs and run tokens. A completion is acted upon only if its `(sessionEpoch, runToken)` matches the currently pending intent; stale completions are journaled as `settlement.discarded` and ignored.
4. **Crash-only design.** The process may be killed at any instant. Recovery is not a special mode: startup *is* recovery (replay journal → reconcile external state → resume).
5. **Typed failure.** Every fallible operation returns or throws a member of the `DloError` hierarchy carrying a machine-readable `code`, a `phase`, and a `retryable` flag. No silent catches, no degraded fallback paths.
6. **Extension over modification.** New phases, providers, exit-clause kinds, and HITL transports are added through registries resolved at boot from configuration — never by editing the kernel.
7. **Budget as a first-class resource.** Tokens, USD, wall-clock, spawn depth, and turn counts are metered by a central `BudgetLedger`; exhaustion produces graceful wrap-up signals before hard aborts.

---

## 3. System Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DLO Daemon (Node.js)                           │
│                                                                             │
│  ┌──────────┐   commands    ┌────────────────────────────────────────────┐ │
│  │ CLI / TUI│──────────────▶│              Pipeline Kernel               │ │
│  │  shell   │◀──────────────│  StateMachine · DagScheduler · BudgetLedger│ │
│  └──────────┘   events      │  HitlGateService · SettlementTracker       │ │
│       ▲                     └───────┬───────────────────────────┬────────┘ │
│       │                             │ ports                     │ events   │
│       │                     ┌───────▼────────┐          ┌───────▼────────┐ │
│  ┌────┴─────┐               │ Adapter Layer  │          │  Event Journal │ │
│  │  HITL    │               │                │          │  (append-only, │ │
│  │ transports│              │ Gemini · Claude│          │   fsync'd      │ │
│  │ (TUI/web/ │              │ Code · CodeWhale│         │   JSONL)       │ │
│  │  webhook) │              │ · pi.dev SDK   │          └────────────────┘ │
│  └──────────┘               └───────┬────────┘                             │
└─────────────────────────────────────┼───────────────────────────────────── ┘
                                      │ child processes / HTTPS / SDK
        ┌──────────────┬──────────────┼────────────────┬───────────────────┐
        ▼              ▼              ▼                ▼                   ▼
  Gemini Deep    Claude Code     CodeWhale        pi.dev Agent       Workspace
  Research API   CLI (plan /     swarm (≤20       Sessions           (target repo:
  (background    supervisor      concurrent,      (context forking,  Rust+Axum,
  interactions)  modes)          side-git,        subagent_finish)   PostgreSQL,
                                 LSP loop)                           TanStack Start)
```

Data flows left-to-right through the phases; control flows through the kernel only. Adapters never call each other directly — all cross-adapter coordination is mediated by kernel events.

---

## 4. Monorepo Layout

pnpm workspaces + Turborepo. Strict TypeScript (`"strict": true`, `"exactOptionalPropertyTypes": true`, `"noUncheckedIndexedAccess": true`), ESM-only, `tsup` builds, `vitest` tests.

```
dlo/
├── package.json                     # workspace root; engines.node >= 22
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── packages/
│   ├── core/                        # @dlo/core — domain model, errors, ids, result types. Zero runtime deps except zod.
│   ├── journal/                     # @dlo/journal — append-only event journal, snapshots, replay
│   ├── kernel/                      # @dlo/kernel — state machine, settlement tracker, budget ledger
│   ├── scheduler/                   # @dlo/scheduler — DAG board, topological dispatch, concurrency pool
│   ├── exit-clauses/                # @dlo/exit-clauses — clause DSL, evaluators, evaluator registry
│   ├── hitl/                        # @dlo/hitl — gate service + transport plugins (tui, http-webhook)
│   ├── adapters-gemini/             # @dlo/adapters-gemini — ResearchProvider impl (Deep Research interactions)
│   ├── adapters-claude-code/        # @dlo/adapters-claude-code — PlannerProvider + SupervisorProvider impls
│   ├── adapters-codewhale/          # @dlo/adapters-codewhale — ExecutorProvider impl (swarm, side-git)
│   ├── adapters-pi/                 # @dlo/adapters-pi — HarnessSession impl over @earendil-works/pi-coding-agent
│   ├── plan-schema/                 # @dlo/plan-schema — tripartite plan zod schemas + parsers
│   ├── plugins/                     # @dlo/plugins — plugin host, registries, manifest loader
│   ├── observability/               # @dlo/observability — structured logging, OTel traces/metrics
│   └── cli/                         # @dlo/cli — `dlo` binary: init, run, resume, status, gate, report
├── docs/
└── .dlo/                            # runtime state root inside each *target* workspace (journal, snapshots, artifacts)
```

**Dependency rule (enforced via `eslint-plugin-boundaries`):** `core ← journal ← kernel ← {scheduler, exit-clauses, hitl} ← adapters-* ← cli`. Arrows point from dependency to dependent; no package may import rightward.

---

## 5. Core Domain Model

**[NORMATIVE]** — `@dlo/core`. All identifiers below are exported names. All schemas are `zod` schemas with inferred types; the schema is the contract, the type is derived.

```ts
// packages/core/src/ids.ts
import { z } from "zod";

/** Branded identifiers. Construction only via the make* factories (crypto.randomUUID). */
export type PipelineId  = string & { readonly __brand: "PipelineId" };
export type ModuleId    = string & { readonly __brand: "ModuleId" };   // stable across retries
export type AttemptId   = string & { readonly __brand: "AttemptId" };  // unique per dispatch
export type GateId      = string & { readonly __brand: "GateId" };
export type RunToken    = string & { readonly __brand: "RunToken" };
export type SnapshotRef = string & { readonly __brand: "SnapshotRef" }; // side-git snapshot id

export const makePipelineId = (): PipelineId => crypto.randomUUID() as PipelineId;
export const makeAttemptId  = (): AttemptId  => crypto.randomUUID() as AttemptId;
export const makeRunToken   = (): RunToken   => crypto.randomUUID() as RunToken;
```

```ts
// packages/core/src/errors.ts

/** Root of the typed-failure hierarchy. Every throw site in every package uses a subclass. */
export abstract class DloError extends Error {
  abstract readonly code: string;          // stable machine-readable code, e.g. "ADAPTER/CLAUDE_CODE/NONZERO_EXIT"
  abstract readonly retryable: boolean;
  readonly phase?: PipelinePhase;
  readonly cause?: unknown;
  constructor(message: string, opts?: { phase?: PipelinePhase; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.phase = opts?.phase;
  }
}

export class AdapterProcessError extends DloError {
  readonly code = "ADAPTER/PROCESS";
  readonly retryable = true;
  constructor(message: string, readonly exitCode: number | null, readonly stderrTail: string,
              opts?: { phase?: PipelinePhase; cause?: unknown }) { super(message, opts); }
}
export class SettlementViolationError extends DloError {
  readonly code = "KERNEL/SETTLEMENT_VIOLATION"; readonly retryable = false;
}
export class BudgetExhaustedError extends DloError {
  readonly code = "KERNEL/BUDGET_EXHAUSTED"; readonly retryable = false;
  constructor(readonly dimension: BudgetDimension, message: string) { super(message); }
}
export class ExitClauseEvaluationError extends DloError {
  readonly code = "VERIFY/CLAUSE_EVALUATION"; readonly retryable = true;
}
export class PlanValidationError extends DloError {
  readonly code = "PLAN/VALIDATION"; readonly retryable = false;
  constructor(message: string, readonly issues: ReadonlyArray<{ path: string; message: string }>) { super(message); }
}
export class JournalCorruptionError extends DloError {
  readonly code = "JOURNAL/CORRUPTION"; readonly retryable = false;
}
export class GateRejectedError extends DloError {
  readonly code = "HITL/REJECTED"; readonly retryable = false;
  constructor(readonly gateId: GateId, readonly reason: string) { super(`Gate ${gateId} rejected: ${reason}`); }
}
```

```ts
// packages/core/src/phases.ts
export const PIPELINE_PHASES = [
  "INIT",
  "RESEARCH_RUNNING",
  "GATE1_PENDING",          // HITL gate on Domain Document
  "PLANNING_RUNNING",
  "GATE2_PENDING",          // HITL gate on tripartite plan
  "EXECUTION_RUNNING",      // double loop (Phases III + IV interleaved per module)
  "FINALIZATION_RUNNING",
  "COMPLETED",
  "FAILED",
  "ABORTED",
] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];
```

```ts
// packages/core/src/artifacts.ts
import { z } from "zod";

/** Content-addressed artifact stored under .dlo/artifacts/<sha256>/ */
export const ArtifactRefSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),                 // "text/markdown", "image/png", "application/json"
  bytes: z.number().int().nonnegative(),
  label: z.string().min(1),                     // "domain-document", "ceo-plan", "critique:auth-module:2"
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const DomainDocumentSchema = z.object({
  markdown: ArtifactRefSchema,                          // the synthesized report
  citations: z.array(z.object({ url: z.string().url(), title: z.string() })).min(1),
  visualizations: z.array(ArtifactRefSchema),           // base64-decoded charts persisted as artifacts
  geminiInteractionId: z.string().min(1),
  completedAt: z.string().datetime(),
});
export type DomainDocument = z.infer<typeof DomainDocumentSchema>;
```

```ts
// packages/core/src/module.ts
import { z } from "zod";

export const ModuleStatusSchema = z.enum([
  "BLOCKED",        // unmet dependencies
  "READY",          // all deps PASSED; eligible for dispatch
  "EXECUTING",      // CodeWhale attempt in flight (inner loop)
  "VERIFYING",      // supervisor evaluation in flight (outer loop)
  "PASSED",         // exit clauses met; committed
  "REJECTED",       // critique issued; awaiting re-dispatch (transient)
  "EXHAUSTED",      // maxAttempts reached → pipeline-level decision required
]);
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;

export const ModuleAttemptSchema = z.object({
  attemptId: z.string(),
  index: z.number().int().positive(),                  // 1-based attempt counter
  executorSessionRef: z.string(),                      // CodeWhale session id
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  summary: z.string().optional(),                      // SUMMARY paragraph from subagent_finish
  changes: z.array(z.object({ file: z.string(), description: z.string() })).optional(),
  preSnapshot: z.string(),                             // side-git SnapshotRef taken before dispatch
  verdict: z.enum(["PASS", "FAIL"]).optional(),
  critique: ArtifactRefSchema.optional(),              // present iff verdict === "FAIL"
  clauseResults: z.array(z.object({
    clauseId: z.string(),
    passed: z.boolean(),
    observed: z.string(),                              // captured evidence (truncated, see §12.4)
    durationMs: z.number().int().nonnegative(),
  })).optional(),
});
export type ModuleAttempt = z.infer<typeof ModuleAttemptSchema>;
```

A `Module` itself (id, title, prompt, dependencies, exit clauses, stack target) is defined by the Engineering Plan schema in §12 — the scheduler consumes plan modules directly rather than duplicating the shape.

---
## 6. Pipeline Lifecycle State Machine

**[NORMATIVE]** — `@dlo/kernel`. The state machine is a pure reducer over journal events; it performs no I/O. Side effects are emitted as *intents* that phase controllers fulfill.

### 6.1 Transition table

| From | Event | To | Emitted intent |
|---|---|---|---|
| `INIT` | `pipeline.started` | `RESEARCH_RUNNING` | `intent.research.start` |
| `RESEARCH_RUNNING` | `research.completed` | `GATE1_PENDING` | `intent.gate.open(gate1)` |
| `RESEARCH_RUNNING` | `research.failed` | `FAILED` | `intent.report.failure` |
| `GATE1_PENDING` | `gate.approved(gate1)` | `PLANNING_RUNNING` | `intent.planning.start` |
| `GATE1_PENDING` | `gate.steered(gate1)` | `RESEARCH_RUNNING` | `intent.research.steer` |
| `GATE1_PENDING` | `gate.rejected(gate1)` | `RESEARCH_RUNNING` | `intent.research.restart` (session-tree rewind) |
| `PLANNING_RUNNING` | `planning.completed` | `GATE2_PENDING` | `intent.gate.open(gate2)` |
| `PLANNING_RUNNING` | `planning.failed` | `FAILED` | `intent.report.failure` |
| `GATE2_PENDING` | `gate.approved(gate2)` | `EXECUTION_RUNNING` | `intent.execution.begin` (incl. permission escalation) |
| `GATE2_PENDING` | `gate.steered(gate2)` | `PLANNING_RUNNING` | `intent.planning.steer` |
| `GATE2_PENDING` | `gate.rejected(gate2)` | `PLANNING_RUNNING` | `intent.planning.rewind` |
| `EXECUTION_RUNNING` | `dag.allPassed` | `FINALIZATION_RUNNING` | `intent.finalization.start` |
| `EXECUTION_RUNNING` | `module.exhausted` | `GATE2_PENDING`* | `intent.gate.open(escalation)` |
| `EXECUTION_RUNNING` | `budget.exhausted` | `ABORTED` | `intent.wrapup.flush` |
| `FINALIZATION_RUNNING` | `finalization.completed` | `COMPLETED` | `intent.report.success` |
| `FINALIZATION_RUNNING` | `finalization.escalated` | `EXECUTION_RUNNING` | `intent.execution.remediate(moduleIds)` |
| *any non-terminal* | `pipeline.abortRequested` | `ABORTED` | `intent.wrapup.flush` |

\* Module exhaustion (a module failing `maxAttempts` consecutive verifications) re-opens a HITL escalation gate scoped to that module: the human may revise the module spec, raise the attempt cap, or abort.

### 6.2 Reducer skeleton

```ts
// packages/kernel/src/state-machine.ts
import type { PipelinePhase } from "@dlo/core";
import type { JournalEvent } from "@dlo/journal";

export interface PipelineState {
  readonly phase: PipelinePhase;
  readonly sessionEpoch: number;            // bumped on every rewind/steer; fences stale completions
  readonly activeGateId: GateId | null;
  readonly domainDocument: DomainDocument | null;
  readonly planArtifacts: TripartitePlanRefs | null;
}

export type KernelIntent =
  | { kind: "intent.research.start" }
  | { kind: "intent.research.steer"; instructions: ArtifactRef }
  | { kind: "intent.research.restart" }
  | { kind: "intent.gate.open"; gate: GateDescriptor }
  | { kind: "intent.planning.start" } | { kind: "intent.planning.steer"; instructions: ArtifactRef }
  | { kind: "intent.planning.rewind" }
  | { kind: "intent.execution.begin" }
  | { kind: "intent.execution.remediate"; moduleIds: ReadonlyArray<ModuleId> }
  | { kind: "intent.finalization.start" }
  | { kind: "intent.wrapup.flush" }
  | { kind: "intent.report.success" } | { kind: "intent.report.failure"; error: SerializedDloError };

/** Pure. Throws SettlementViolationError on illegal transition — never coerces. */
export function reduce(state: PipelineState, event: JournalEvent):
  { next: PipelineState; intents: ReadonlyArray<KernelIntent> } {
  // EXTENSION POINT — implement the full table in §6.1 as an exhaustive switch over
  // `${state.phase}::${event.type}` with a `never`-typed default that throws
  // SettlementViolationError. Every branch must be covered by a unit test that
  // asserts both the next phase and the exact intent list.
  throw new SettlementViolationError(`No transition from ${state.phase} on ${event.type}`);
}
```

### 6.3 Settlement tracker

```ts
// packages/kernel/src/settlement.ts

/**
 * Fences every async boundary. A pending intent is registered BEFORE the async gap;
 * a completion is accepted only if epoch and token both match. Stale completions are
 * journaled (`settlement.discarded`) and dropped — never processed, never thrown to callers.
 */
export class SettlementTracker {
  #pending = new Map<RunToken, { epoch: number; intent: KernelIntent; registeredAt: number }>();

  register(token: RunToken, epoch: number, intent: KernelIntent): void { /* idempotent put; duplicate token ⇒ SettlementViolationError */ }

  trySettle(token: RunToken, currentEpoch: number):
    | { accepted: true; intent: KernelIntent }
    | { accepted: false; reason: "unknown-token" | "epoch-mismatch" } {
    // EXTENSION POINT — constant-time lookup; on epoch-mismatch also delete the entry
    // so memory cannot grow across long pipelines. Emit `settlement.discarded` via the
    // injected journal appender in both rejection branches.
    return { accepted: false, reason: "unknown-token" };
  }
}
```

---

## 7. Event Bus and Message Contracts

**[NORMATIVE]** — `@dlo/journal` defines the event union; `@dlo/kernel` hosts the in-process bus.

### 7.1 Envelope

```ts
// packages/journal/src/event.ts
import { z } from "zod";

export const JournalEventEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),        // assigned by the journal, gapless
  pipelineId: z.string(),
  epoch: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  type: z.string().min(1),                    // dotted, namespaced — see §7.2
  payload: z.unknown(),                       // validated against the per-type schema in §7.2
  integrity: z.string().regex(/^[a-f0-9]{64}$/), // sha256(prevIntegrity + canonicalJson(this minus integrity))
});
```

The `integrity` hash chain makes truncation and mid-file tampering detectable on replay (→ `JournalCorruptionError`).

### 7.2 Event taxonomy (exhaustive at v1)

| Namespace | Events |
|---|---|
| `pipeline.*` | `started`, `abortRequested`, `completed`, `failed` |
| `research.*` | `dispatched`, `pollTick`, `completed`, `failed`, `steered` |
| `gate.*` | `opened`, `approved`, `steered`, `rejected`, `expired` |
| `planning.*` | `dispatched`, `completed`, `failed`, `steered`, `rewound` |
| `plan.*` | `validated`, `validationFailed` |
| `dag.*` | `built`, `moduleReady`, `allPassed` |
| `module.*` | `dispatched`, `innerLoopTick`, `executorFinished`, `verificationStarted`, `passed`, `rejected`, `rolledBack`, `exhausted` |
| `clause.*` | `evaluated` |
| `budget.*` | `charged`, `warningThreshold`, `exhausted` |
| `settlement.*` | `registered`, `settled`, `discarded` |
| `finalization.*` | `dispatched`, `agentFinished`, `escalated`, `completed` |
| `snapshot.*` | `taken`, `restored`, `promoted` (side-git snapshot promoted to a real git commit) |

Each event type has a dedicated `zod` payload schema in `packages/journal/src/payloads/`. The bus rejects (throws, non-retryable) any publish whose payload fails validation — invalid events must never reach disk.

### 7.3 Bus semantics

- **Publish path:** validate → append to journal (fsync) → dispatch to in-process subscribers, in that order. A subscriber crash after fsync is recoverable by replay; an unjournaled side effect is forbidden.
- **Subscribers** are registered by phase controllers and plugins with `{ types: string[] | "*", handler }`. Handlers are awaited serially per event (deterministic ordering); a throwing handler converts the event into `pipeline.failed` unless the handler declares `isolation: "shielded"` (plugins default to shielded; kernel controllers never are).

---

## 8. Provider Adapter Layer

**[NORMATIVE]** ports in `@dlo/core`; implementations in `adapters-*`.

### 8.1 Ports

```ts
// packages/core/src/ports.ts

export interface ResearchProvider {
  /** Dispatch a background deep-research interaction. Resolves immediately with a handle. */
  dispatch(req: ResearchRequest): Promise<ResearchHandle>;
  /** Poll until terminal. Implementations own backoff (see §9.2) and budget charging. */
  await(handle: ResearchHandle, signal: AbortSignal): Promise<DomainDocument>;
  /** Resume a prior interaction with steering instructions; merges into the same document lineage. */
  steer(handle: ResearchHandle, instructions: ArtifactRef, signal: AbortSignal): Promise<DomainDocument>;
}

export interface PlannerProvider {
  plan(req: PlanningRequest, signal: AbortSignal): Promise<TripartitePlanRefs>;
  steer(prior: TripartitePlanRefs, instructions: ArtifactRef, signal: AbortSignal): Promise<TripartitePlanRefs>;
}

export interface ExecutorProvider {
  /** Dispatch one module to one executor agent. Non-blocking; completion arrives via onFinish. */
  dispatch(task: ExecutionTask): Promise<ExecutorSessionRef>;
  onFinish(cb: (result: ExecutorFinish) => void): Unsubscribe;
  snapshot(workspace: string): Promise<SnapshotRef>;
  restore(workspace: string, ref: SnapshotRef): Promise<void>;
  /** Live concurrency telemetry for the scheduler's pool gate. */
  capacity(): { max: number; inFlight: number };
}

export interface SupervisorProvider {
  /** Outer-loop evaluation. MUST be side-effect-free w.r.t. the workspace except for
      running the read-only/bash commands required by exit clauses. */
  evaluate(req: EvaluationRequest, signal: AbortSignal): Promise<EvaluationVerdict>;
}

export interface HarnessSession {        // pi.dev
  forkContext(parent: SessionRef | null, systemMd: ArtifactRef[]): Promise<SessionRef>;
  steerSession(ref: SessionRef, message: string): Promise<void>;
  rewindTo(ref: SessionRef, checkpoint: string): Promise<void>;
  compact(ref: SessionRef): Promise<void>;
}
```

### 8.2 `adapters-gemini` — Deep Research

Implements `ResearchProvider` over the Google GenAI SDK Interactions API.

```ts
// packages/adapters-gemini/src/deep-research-provider.ts
export class GeminiDeepResearchProvider implements ResearchProvider {
  constructor(private readonly deps: {
    client: GoogleGenAI;                       // injected, never constructed here
    model: "deep-research-preview-04-2026" | "deep-research-max-preview-04-2026";
    mcpServers: ReadonlyArray<{ name: string; url: string; authorizationHeader?: string }>;
    artifacts: ArtifactStore; budget: BudgetLedger; journal: JournalAppender; clock: Clock;
  }) {}

  async dispatch(req: ResearchRequest): Promise<ResearchHandle> {
    // EXTENSION POINT — client.interactions.create({
    //   model: this.deps.model, background: true, visualization: "auto",
    //   input: [systemFraming, req.objectivesMarkdown, ...req.groundingDocuments (PDF/image parts)],
    //   tools: this.deps.mcpServers.map(toMcpToolDecl),
    // });
    // Journal `research.dispatched` with the interaction id BEFORE returning the handle
    // (crash between create and journal is reconciled in §16.3).
    throw new AdapterProcessError("not implemented", null, "", { phase: "RESEARCH_RUNNING" });
  }

  async await(handle: ResearchHandle, signal: AbortSignal): Promise<DomainDocument> {
    // EXTENSION POINT — poll interactions.get(handle.interactionId) with decorrelated-jitter
    // backoff (base 15s, cap 120s); journal `research.pollTick` at most once per 60s of
    // wall clock; on status==="completed": persist markdown + each base64 visualization to
    // the ArtifactStore, validate against DomainDocumentSchema, charge token usage to the
    // BudgetLedger from the interaction's usage metadata, return the document.
    // On status==="failed": throw AdapterProcessError(retryable=true) with provider message.
    throw new AdapterProcessError("not implemented", null, "", { phase: "RESEARCH_RUNNING" });
  }

  async steer(handle: ResearchHandle, instructions: ArtifactRef, signal: AbortSignal): Promise<DomainDocument> {
    // EXTENSION POINT — interactions.continue / follow-up turn on the same interaction id,
    // then delegate to await(). Document lineage: new DomainDocument supersedes prior;
    // both remain in the artifact store.
    throw new AdapterProcessError("not implemented", null, "", { phase: "RESEARCH_RUNNING" });
  }
}
```

### 8.3 `adapters-claude-code` — Planner and Supervisor

Two classes share one process-spawning substrate (`ClaudeCodeProcess`), which wraps the CLI with `execa`, structured `--output-format json` parsing, and per-invocation working-directory pinning.

**Planner invocation (Phase II):**
```
claude -p <engineered planning prompt path> \
  --permission-mode plan \
  --output-format json \
  --max-turns <cfg.planning.maxTurns>
```
The planner prompt instructs Claude Code to emit the tripartite plan as three fenced blocks; the adapter extracts and persists `ceo-plan.md`, `architecture-plan.md`, and `engineering-plan.json`, then validates the latter against `EngineeringPlanSchema` (§12). Validation failure → `PlanValidationError` → `planning.failed` (the kernel surfaces the zod issues into the failure report; the human may steer).

**Supervisor invocation (outer loop, Phase IV):**
```
claude -p <evaluation prompt path> \
  --output-format json \
  --allowed-tools "Bash(cargo *)" "Bash(npm *)" "Bash(psql *)" "Bash(docker *)" "Read" "Grep" "Glob"
```
Escalation to `--dangerously-skip-permissions` occurs only if `cfg.execution.trustLevel === "autonomous"` **and** Gate 2 was approved with the `escalatePermissions` flag set by the human (§10.3). The supervisor prompt embeds: the module spec, the executor's `SUMMARY`/`CHANGES`, the deterministic clause results already computed by `@dlo/exit-clauses` (§14.4 — the supervisor *reviews* evidence; it does not re-run deterministic clauses), and a `transcript_handle` reference for `handle_read` drill-down into the executor session.

```ts
// packages/adapters-claude-code/src/supervisor-provider.ts
export class ClaudeCodeSupervisor implements SupervisorProvider {
  constructor(private readonly deps: {
    proc: ClaudeCodeProcess; prompts: PromptLibrary; artifacts: ArtifactStore;
    budget: BudgetLedger; journal: JournalAppender;
  }) {}

  async evaluate(req: EvaluationRequest, signal: AbortSignal): Promise<EvaluationVerdict> {
    // EXTENSION POINT —
    // 1. Render prompts/supervisor-evaluate.md with req (module, attempt, clauseResults,
    //    transcriptHandle, architecturalPlanRef, ceoPlanRef).
    // 2. Spawn via this.deps.proc.run(...) with the scoped --allowed-tools set above and
    //    cwd = req.workspace. Enforce req.timeoutMs via AbortSignal.timeout composition.
    // 3. Parse the mandated terminal JSON object:
    //      { "verdict": "PASS" | "FAIL", "critique": string|null,
    //        "clauseFindings": [{clauseId, concurs: boolean, note: string}],
    //        "architecturalConcerns": string[] }
    //    A response missing this object, or asserting PASS while any deterministic clause
    //    result is failed, is itself a FAIL with a synthesized critique citing the
    //    discrepancy — the supervisor may never override deterministic clause failures.
    // 4. Persist critique as an artifact; charge usage; return typed verdict.
    throw new AdapterProcessError("not implemented", null, "", { phase: "EXECUTION_RUNNING" });
  }
}
```

### 8.4 `adapters-codewhale` — Executor swarm

Wraps the CodeWhale runtime: `agent_open` dispatch, `subagent_finish` consumption, side-git `snapshot`/`restore`, and `~/.codewhale/config.toml` reconciliation (the adapter verifies `[subagents].max_concurrent` ≥ configured pool size at boot and fails fast otherwise — it never silently lowers throughput).

```ts
// packages/adapters-codewhale/src/codewhale-provider.ts
export class CodeWhaleExecutorProvider implements ExecutorProvider {
  constructor(private readonly deps: {
    runtime: CodeWhaleRuntime;                // thin typed wrapper over the CodeWhale IPC surface
    systemMdRefs: ReadonlyArray<ArtifactRef>; // stack SYSTEM.md, injected into every agent
    budget: BudgetLedger; journal: JournalAppender;
  }) {}

  async dispatch(task: ExecutionTask): Promise<ExecutorSessionRef> {
    // EXTENSION POINT —
    // 1. Compose the agent prompt: SYSTEM.md refs + task.module.prompt + task.module.exitClauses
    //    (rendered human-readably so the agent self-checks before finishing) + task.critique
    //    (present on re-dispatch after a FAIL verdict).
    // 2. runtime.agentOpen({ mode: "yolo", autoRoute: true, cwd: task.workspace, prompt })
    //    — auto-mode routing (flash↔pro, reasoning off/high/max) is delegated to CodeWhale;
    //    DLO only records the chosen tier from the finish payload for cost attribution.
    // 3. Journal `module.dispatched` with {moduleId, attemptId, sessionRef, preSnapshot}.
    throw new AdapterProcessError("not implemented", null, "", { phase: "EXECUTION_RUNNING" });
  }

  onFinish(cb: (result: ExecutorFinish) => void): Unsubscribe {
    // EXTENSION POINT — subscribe to the runtime's subagent_finish stream; parse the
    // structured payload into { sessionRef, summary, changes[], usage, exitedCleanly }.
    // A finish payload that fails schema validation is surfaced as ExecutorFinish with
    // exitedCleanly=false and the raw tail attached — the verification engine treats it
    // as an automatic FAIL with a parsing critique (§14.5), never as a crash of DLO itself.
    return () => {};
  }

  async snapshot(workspace: string): Promise<SnapshotRef> { /* EXTENSION POINT — side-git snapshot; journal `snapshot.taken` */ throw new AdapterProcessError("not implemented", null, ""); }
  async restore(workspace: string, ref: SnapshotRef): Promise<void> { /* EXTENSION POINT — /restore; journal `snapshot.restored` */ throw new AdapterProcessError("not implemented", null, ""); }
  capacity() { return this.deps.runtime.poolTelemetry(); }
}
```

### 8.5 `adapters-pi` — Harness sessions

Implements `HarnessSession` over `@earendil-works/pi-coding-agent`: `SessionManager.create(process.cwd())`, `AgentSession` instantiation with `DefaultResourceLoader` (so `AGENTS.md`/`SYSTEM.md` discovery behaves identically to interactive pi.dev), `steer()`/`followUp()` for steering intents, tree rewind for `gate.rejected` paths, and `/compact` automation per §17.3. The pi event loop's extension events are bridged onto the DLO bus under a `pi.*` namespace reserved for plugins (kernel logic never depends on `pi.*` events — this keeps the harness swappable).

---
## 9. Phase I Controller — Domain Research

**[GUIDANCE]** — `packages/kernel/src/controllers/research.controller.ts`. Subscribes to `intent.research.*`; owns the `ResearchProvider` port.

### 9.1 Responsibilities
1. Compose the research request: project objectives, audience, the mandated stack contract (Rust/Axum, PostgreSQL, TanStack Start), grounding documents (PDF/image artifacts supplied at `dlo init`), and configured remote MCP servers for proprietary context.
2. Dispatch → journal → await with cancellation wired to `pipeline.abortRequested`.
3. On completion, publish `research.completed` carrying the `DomainDocument`; the kernel then opens Gate 1.
4. On `intent.research.steer`, call `provider.steer()` with the human's steering artifact and re-enter the await loop *under a bumped session epoch* (so a completion of the pre-steer poll loop is discarded by settlement).

### 9.2 Polling discipline
Decorrelated-jitter backoff: `delay = min(cap, random(base, prevDelay * 3))` with `base = 15s`, `cap = 120s`. Poll-loop wall-clock is charged against `budget.wallClock.research`. A provider outage (transient HTTP 5xx/429) is retried within the same handle up to `cfg.research.maxTransientRetries`; a hard provider failure publishes `research.failed`.

---

## 10. Human-in-the-Loop Gate Subsystem

**[NORMATIVE]** — `@dlo/hitl`.

### 10.1 Gate model

```ts
// packages/hitl/src/gate.ts
import { z } from "zod";

export const GateKindSchema = z.enum(["DOMAIN_DOCUMENT", "TRIPARTITE_PLAN", "MODULE_ESCALATION"]);

export const GateDescriptorSchema = z.object({
  gateId: z.string(),
  kind: GateKindSchema,
  pipelineId: z.string(),
  epoch: z.number().int(),
  exhibits: z.array(ArtifactRefSchema).min(1),     // what the human reviews
  context: z.record(z.string(), z.string()),       // e.g. { moduleId, attemptCount } for escalations
  openedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),     // cfg.hitl.gateTtl; expiry ⇒ `gate.expired` ⇒ pipeline pauses (never auto-approves)
});

export const GateResolutionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("APPROVE"), gateId: z.string(),
             escalatePermissions: z.boolean().default(false),     // meaningful only for TRIPARTITE_PLAN
             note: z.string().optional() }),
  z.object({ decision: z.literal("STEER"),   gateId: z.string(),
             instructions: z.string().min(1) }),                  // persisted to an artifact by the service
  z.object({ decision: z.literal("REJECT"),  gateId: z.string(),
             reason: z.string().min(1) }),
]);
export type GateResolution = z.infer<typeof GateResolutionSchema>;
```

### 10.2 Transport plugin contract

```ts
export interface HitlTransport {
  readonly name: string;                                          // "tui", "http-webhook", ...
  /** Present the gate to a human. Resolve exactly once. MUST honor the AbortSignal (gate expiry / pipeline abort). */
  present(gate: GateDescriptor, exhibits: ResolvedExhibits, signal: AbortSignal): Promise<GateResolution>;
}
```

Two first-party transports ship at v1:
- **`tui`** — pi.dev-style interactive terminal panel (exhibit pager with markdown rendering, decision keybindings, steering editor via `$EDITOR`). Built on the same TUI substrate as the `dlo` shell; integrates `pi-ask-user` semantics.
- **`http-webhook`** — POSTs the gate descriptor (with signed, expiring artifact download URLs served by the daemon's local HTTP listener) to a configured webhook; resolution arrives at `POST /gates/:gateId/resolution`, authenticated with an HMAC over the body using `cfg.hitl.webhook.secret` (sourced from env, never from config files — §21).

Multiple transports may be active; **first resolution wins**, the rest are aborted. Every resolution is journaled (`gate.approved|steered|rejected`) with the resolver transport's name and an operator identity string.

### 10.3 Permission escalation (Gate 2 only)
On `APPROVE` with `escalatePermissions: true`, the kernel records `executionTrust = "autonomous"` for the remainder of the pipeline; the supervisor adapter may then use `--dangerously-skip-permissions`. With `false`, the supervisor runs with the scoped `--allowed-tools` set only (§8.3). This bit lives in the journal, not in mutable config, so the audit trail of who granted autonomy is permanent.

---

## 11. Phase II Controller — Strategic Planning

**[GUIDANCE]** — mirrors the research controller's shape: fulfills `intent.planning.*` via `PlannerProvider`.

The planning prompt (versioned in `packages/adapters-claude-code/prompts/planner.md`, rendered with the approved Domain Document inlined by artifact reference) mandates:

1. **CEO Plan** — user journeys, business rules, success metrics; markdown.
2. **Architectural Plan** — OpenAPI 3.1 contract for the Axum surface; PostgreSQL relational schema (DDL excerpts with index/constraint rationale); the SSR/CSR boundary map for TanStack Start (which routes use Server Functions, what data crosses the hydration boundary, what is forbidden from the client bundle); error-handling doctrine (application error enum implementing `IntoResponse`; no DB error leakage); markdown.
3. **Engineering Plan** — **JSON only**, conforming to §12, acyclic, with every module carrying deterministic exit clauses.

`planning.completed` is published only after `EngineeringPlanSchema.parse` succeeds **and** the DAG validator proves acyclicity and clause-evaluator resolvability (§13.1). Any failure is a `PlanValidationError` whose zod issue paths are included verbatim in the Gate-2-skipping `planning.failed` report, so a steering human (or an automated re-prompt with the issues appended, up to `cfg.planning.maxValidationRetries`) can correct it.

---

## 12. Engineering Plan Schema and Exit-Clause DSL

**[NORMATIVE]** — `@dlo/plan-schema` (schema) and `@dlo/exit-clauses` (evaluation).

### 12.1 Plan schema

```ts
// packages/plan-schema/src/engineering-plan.ts
import { z } from "zod";

export const StackTargetSchema = z.enum(["rust-axum", "postgresql", "tanstack-start", "cross-cutting"]);

export const EngineeringModuleSchema = z.object({
  moduleId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),       // stable slug, e.g. "auth-session-middleware"
  title: z.string().min(4),
  stackTarget: StackTargetSchema,
  prompt: z.string().min(40),                                     // the executor's full task statement
  dependsOn: z.array(z.string()).default([]),                     // moduleIds
  estimatedComplexity: z.enum(["trivial", "standard", "complex"]),// hint for CodeWhale auto-routing telemetry only
  maxAttempts: z.number().int().min(1).max(10).default(4),
  exitClauses: z.array(ExitClauseSchema).min(1),
  touches: z.array(z.string()).min(1),                            // path globs the module may modify; supervisor flags out-of-bounds writes
});

export const EngineeringPlanSchema = z.object({
  planVersion: z.literal(1),
  generatedBy: z.string(),                                        // model identifier for provenance
  modules: z.array(EngineeringModuleSchema).min(1)
    .superRefine((mods, ctx) => {
      // EXTENSION POINT — enforce: unique moduleIds; every dependsOn resolves;
      // graph is acyclic (Kahn's algorithm; on cycle, report the full cycle path in the issue).
    }),
});
export type EngineeringPlan = z.infer<typeof EngineeringPlanSchema>;
```

### 12.2 Exit-clause DSL

Clauses are deterministic, machine-evaluable predicates. The supervisor *reviews* their evidence and adds architectural judgment; it can fail a module the clauses passed, but never pass a module the clauses failed.

```ts
// packages/plan-schema/src/exit-clause.ts
export const ExitClauseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"),
    clauseId: z.string(), description: z.string(),
    argv: z.array(z.string()).min(1),                 // execFile semantics — never a shell string
    cwd: z.enum(["workspace", "backend", "frontend"]).default("workspace"),
    expect: z.object({ exitCode: z.number().int().default(0),
                       stdoutMatches: z.string().optional(),       // RE2-compatible pattern (linear-time)
                       stderrMaxBytes: z.number().int().optional() }),
    timeoutMs: z.number().int().min(1_000).max(1_800_000) }),
  z.object({ kind: z.literal("httpProbe"),
    clauseId: z.string(), description: z.string(),
    serviceUnderTest: z.object({ startArgv: z.array(z.string()).min(1), readyLogPattern: z.string(),
                                 startupTimeoutMs: z.number().int() }),
    request: z.object({ method: z.enum(["GET","POST","PUT","PATCH","DELETE"]), path: z.string(),
                        headers: z.record(z.string(), z.string()).default({}), bodyArtifact: ArtifactRefSchema.optional() }),
    expect: z.object({ status: z.number().int(), jsonSchemaArtifact: ArtifactRefSchema.optional() }),
    timeoutMs: z.number().int() }),
  z.object({ kind: z.literal("sqlAssertion"),
    clauseId: z.string(), description: z.string(),
    // executed against the per-module transient PostgreSQL container (§14.3)
    query: z.string().min(1),                          // must be a single read-only statement; validated by the evaluator
    expect: z.object({ rowCountAtLeast: z.number().int().optional(),
                       singleValueEquals: z.string().optional() }),
    timeoutMs: z.number().int() }),
  z.object({ kind: z.literal("fileAssertion"),
    clauseId: z.string(), description: z.string(),
    glob: z.string(), mustExist: z.boolean(),
    contentMatches: z.string().optional(), contentForbids: z.string().optional() }),
]);
export type ExitClause = z.infer<typeof ExitClauseSchema>;
```

**Canonical clauses the planner prompt is instructed to use for this stack:**

| Stack target | Typical clauses |
|---|---|
| `rust-axum` | `command`: `["cargo","clippy","--all-targets","--","-D","warnings"]` · `["cargo","test","--package",<crate>]` · `httpProbe` against the route's JSON contract with `jsonSchemaArtifact` |
| `postgresql` | `command`: `["cargo","sqlx","prepare","--check"]` (compile-time query sync) · `sqlAssertion` on `information_schema` for FK/index/constraint presence · migration `command` pair (up applies cleanly on empty DB; down restores) |
| `tanstack-start` | `command`: `["npx","tsc","--noEmit"]` · `fileAssertion` with `contentForbids` matching server-only imports (`process.env`, `pg`, `node:`) in client-bundle globs · `command`: `["npx","vitest","run","--reporter=json", <suite>]` |

### 12.3 Evaluator registry

```ts
// packages/exit-clauses/src/registry.ts
export interface ClauseEvaluator<K extends ExitClause["kind"] = ExitClause["kind"]> {
  readonly kind: K;
  evaluate(clause: Extract<ExitClause, { kind: K }>, ctx: ClauseContext): Promise<ClauseResult>;
}

export class ClauseEvaluatorRegistry {
  #byKind = new Map<string, ClauseEvaluator>();
  register(e: ClauseEvaluator): void { /* duplicate kind ⇒ throw, non-retryable */ }
  resolve(kind: string): ClauseEvaluator { /* unknown kind ⇒ ExitClauseEvaluationError listing registered kinds */ }
}
```
`ClauseContext` carries `{ workspace, backendDir, frontendDir, pgConnection (transient container), artifacts, budget, signal }`. Plugins may register new kinds (§19); the plan validator cross-checks every clause kind in the plan against the registry **at validation time**, so an unimplementable plan never reaches Gate 2.

### 12.4 Evidence capture
Each `ClauseResult` records `{ clauseId, passed, observed, durationMs }` where `observed` is the relevant evidence (tail of stdout/stderr, probe response excerpt, query result) truncated to `cfg.verification.evidenceMaxBytes` (default 16 KiB) with head+tail preservation — enough for the supervisor and the human escalation gate without bloating context windows.

---

## 13. DAG Scheduler

**[NORMATIVE]** — `@dlo/scheduler`.

### 13.1 Board projection

The scheduler maintains a `DagBoard` — a pure projection of `module.*` journal events over the validated plan:

```ts
// packages/scheduler/src/board.ts
export class DagBoard {
  /** Built from the plan; statuses replayed from the journal. Pure data structure — no I/O. */
  static build(plan: EngineeringPlan, replay: Iterable<JournalEvent>): DagBoard { /* EXTENSION POINT */ }

  ready(): ReadonlyArray<EngineeringModule> { /* all deps PASSED, status READY, ordered by depth-first criticality */ }
  apply(event: JournalEvent): void { /* status transitions per §5 ModuleStatus; illegal transition ⇒ SettlementViolationError */ }
  allPassed(): boolean;
  exhausted(): ReadonlyArray<ModuleId>;
}
```

Validation at plan time (re-used here): Kahn's algorithm for acyclicity; unresolved dependency, duplicate id, and unregistered clause-kind checks. Criticality ordering: modules on the longest remaining dependency chain dispatch first, maximizing pool utilization.

### 13.2 Dispatch pump

```ts
// packages/scheduler/src/pump.ts
export class DispatchPump {
  constructor(private readonly deps: {
    board: DagBoard; executor: ExecutorProvider; settlement: SettlementTracker;
    budget: BudgetLedger; journal: JournalAppender; epoch: () => number;
  }) {}

  /** Invoked after every settled module event and on execution begin/resume. Idempotent. */
  async pump(): Promise<void> {
    // EXTENSION POINT —
    // while (capacity.inFlight < capacity.max && board.ready().length > 0):
    //   1. budget.assertHeadroom("usd", "moduleDispatch")   // throws BudgetExhaustedError → kernel handles
    //   2. module = next ready by criticality
    //   3. preSnapshot = await executor.snapshot(workspace)
    //   4. token = makeRunToken(); settlement.register(token, epoch(), {kind:"intent.module.settle", ...})
    //   5. await executor.dispatch({ module, attemptId, critique?, preSnapshot, runToken: token })
    //      — journal `module.dispatched` happens inside dispatch (adapter contract, §8.4)
    // Single-flight: pump() reentrancy is guarded by an internal promise latch, not a boolean.
  }
}
```

---

## 14. Phase III/IV Controller — Double-Loop Execution and Verification

**[NORMATIVE]** — `packages/kernel/src/controllers/double-loop.controller.ts`. This is the heart of the system.

### 14.1 Loop topology

```
            ┌────────────────────────── inner loop (within CodeWhale) ─────────────────────────┐
            │   edit → rust-analyzer / tsserver diagnostics → fix → … until LSP(Cᵢ) = ∅        │
            └──────────────────────────────────────┬─────────────────────────────────────────-─┘
                                                   │ subagent_finish {SUMMARY, CHANGES}
                                                   ▼
  pump() ──dispatch──▶ EXECUTING ──finish──▶ deterministic clause run ──▶ VERIFYING (supervisor)
     ▲                                                                        │
     │                 ┌── PASS: promote snapshot → commit → module.passed ◀──┤
     │                 │                                                      │
     └── re-dispatch ◀─┴── FAIL: persist critique → restore(preSnapshot) → module.rejected
         (attempt+1, critique attached)            (attempt == maxAttempts ⇒ module.exhausted ⇒ escalation gate)
```

### 14.2 Controller skeleton

```ts
// packages/kernel/src/controllers/double-loop.controller.ts
export class DoubleLoopController {
  constructor(private readonly deps: {
    bus: EventBus; board: DagBoard; pump: DispatchPump;
    executor: ExecutorProvider; supervisor: SupervisorProvider;
    clauses: ClauseRunner;                       // orchestrates §12.3 evaluators per module
    settlement: SettlementTracker; journal: JournalAppender;
    artifacts: ArtifactStore; budget: BudgetLedger; epoch: () => number;
    git: GitPromoter;                            // promotes side-git snapshots to real commits
  }) {}

  start(): void {
    this.deps.executor.onFinish((finish) => void this.#onExecutorFinish(finish));
    this.deps.bus.subscribe({ types: ["module.passed", "module.rejected"], handler: () => this.deps.pump.pump() });
  }

  async #onExecutorFinish(finish: ExecutorFinish): Promise<void> {
    const settled = this.deps.settlement.trySettle(finish.runToken, this.deps.epoch());
    if (!settled.accepted) return;                                 // stale — journaled by tracker, dropped

    await this.deps.journal.append("module.executorFinished", finish);

    // ── Deterministic clause pass (cheap, local, authoritative-negative) ──
    const clauseResults = await this.deps.clauses.runAll(finish.module, finish.workspaceCtx);
    await this.deps.journal.append("clause.evaluated", { moduleId: finish.moduleId, clauseResults });

    // ── Outer loop: supervisor evaluation ──
    await this.deps.journal.append("module.verificationStarted", { moduleId: finish.moduleId, attemptId: finish.attemptId });
    const verdict = await this.deps.supervisor.evaluate({
      module: finish.module, attempt: finish.attempt, clauseResults,
      transcriptHandle: finish.transcriptHandle, workspace: finish.workspace,
      timeoutMs: this.cfgTimeoutFor(finish.module),
    }, this.abortSignal());

    if (verdict.kind === "PASS") {
      await this.deps.git.promote(finish.preSnapshot, finish.moduleId);   // snapshot.promoted → real commit, message templated with moduleId + attempt
      await this.deps.journal.append("module.passed", { moduleId: finish.moduleId, attemptId: finish.attemptId });
      if (this.deps.board.allPassed()) await this.deps.journal.append("dag.allPassed", {});
      return;
    }

    // FAIL path
    const critiqueRef = await this.deps.artifacts.putText(verdict.critique, `critique:${finish.moduleId}:${finish.attempt.index}`);
    await this.deps.executor.restore(finish.workspace, finish.preSnapshot);
    await this.deps.journal.append("module.rejected",
      { moduleId: finish.moduleId, attemptId: finish.attemptId, critique: critiqueRef });

    if (finish.attempt.index >= finish.module.maxAttempts) {
      await this.deps.journal.append("module.exhausted", { moduleId: finish.moduleId });   // kernel opens escalation gate
    }
    // Re-dispatch (attempt+1, critique attached) is the pump's job, triggered by the
    // module.rejected subscription above — the controller never dispatches directly.
  }
}
```

### 14.3 Transient PostgreSQL environments
For modules with `stackTarget: "postgresql"` (and any module whose clauses include `sqlAssertion`/`sqlx prepare`), the `ClauseRunner` provisions a disposable PostgreSQL container per attempt (`docker run --rm`, random free port, `pg_isready` gate, hard TTL = module timeout), applies the workspace's migration chain from zero, and tears it down unconditionally in a `finally`. Container lifecycle events are charged to `budget.wallClock.verification`.

### 14.4 Division of authority (restated as an invariant)
- Deterministic clauses are **authoritative-negative**: any failed clause forces `FAIL` regardless of supervisor output (enforced in the adapter, §8.3, *and* re-checked in the controller — defense in depth).
- The supervisor is **authoritative-positive-with-veto**: it may convert an all-clauses-green attempt into `FAIL` on architectural, security, boundary (`touches` violations), or business-rule grounds, with a critique that must cite specific files/lines.

### 14.5 Degenerate finishes
A `subagent_finish` that is unparseable, reports `exitedCleanly=false`, or arrives after executor crash-detection is normalized into an automatic `FAIL` whose critique is synthesized by the controller (template: cause classification + raw tail + instruction to re-attempt from the restored snapshot). This keeps the loop total: every dispatch terminates in exactly one of `module.passed | module.rejected | module.exhausted`.

---

## 15. Phase V Controller — Finalization Swarm

**[GUIDANCE]** — on `intent.finalization.start`, spawn three role-scoped pi.dev subagents in parallel (definitions in `.pi/agents/{linter,tester,builder}.md`, YAML frontmatter restricting tools):

| Agent | Scope | Commands | Escalation |
|---|---|---|---|
| `linter` | read + format-fix only | `cargo fmt`, `cargo clippy -- -D warnings`, `eslint --fix`, `prettier --write` | Structural findings → `finalization.escalated` with synthesized module specs (remediation modules enter the DAG with `dependsOn: []`, normal double-loop applies) |
| `tester` | read + test bash | `cargo test --workspace`, `vitest run`, Playwright e2e suite | Failures → escalate as above, citing failing tests |
| `builder` | read + build bash | `cargo build --release`, `npm run build` | Build break → escalate |

All three green ⇒ `finalization.completed` ⇒ the kernel emits the final structured completion report (`.dlo/report/<pipelineId>.json` + rendered markdown: per-module attempt counts, cost attribution by provider/tier, total wall clock, commit list, residual warnings).

---
## 16. Persistence, Journaling, and Crash Recovery

**[NORMATIVE]** — `@dlo/journal`.

### 16.1 On-disk layout (inside the target workspace)

```
.dlo/
├── journal/
│   ├── 000001.jsonl                 # segment files, rotated at 64 MiB
│   ├── 000002.jsonl
│   └── HEAD                         # { activeSegment, lastSeq, lastIntegrity } — written via tmp+rename
├── snapshots/
│   └── state-<seq>.json             # kernel-state snapshot every cfg.journal.snapshotEvery events (default 500)
├── artifacts/
│   └── <sha256>/{data, meta.json}   # content-addressed, immutable
├── report/
└── pipeline.lock                    # advisory lock (proper-lockfile); prevents concurrent daemons on one workspace
```

### 16.2 Write path
`append(type, payload)` → validate payload schema → assign `seq = lastSeq + 1` → compute integrity hash → `write` + `fsync` segment → update `HEAD` (tmp + atomic rename) → dispatch to subscribers. Throughput is adequate by construction (pipeline events are low-frequency relative to fsync cost); no batching, no write-behind — correctness over micro-optimization.

### 16.3 Recovery sequence (`dlo resume`, also the default `dlo run` path when `.dlo/journal` exists)

1. **Acquire lock**; refuse to start if held (stale-lock detection via PID + boot-time check).
2. **Load newest snapshot**, then **replay** subsequent journal segments, verifying the integrity chain (`JournalCorruptionError` aborts with the exact offending seq — never "best effort" past corruption).
3. **Reconcile external state** — the journal records intents and dispatches; reality may have drifted during the crash window:
   - `RESEARCH_RUNNING`: re-attach to the recorded Gemini interaction id; `interactions.get` tells us whether it completed while we were down.
   - `EXECUTION_RUNNING`: `codewhale resume --last` restores the durable task queue from `.codewhale/state/subagents.v1.json`; the adapter diffs the runtime's live session list against the board's `EXECUTING` modules. Sessions the runtime no longer knows (lost work) are normalized per §14.5 (restore preSnapshot, automatic FAIL, re-dispatch). Finishes that landed during downtime are replayed through `#onExecutorFinish` with their original run tokens.
   - Gates `*_PENDING`: re-present via configured transports (gate ids and epochs are stable across restarts).
4. **Resume pumping.** The pump is idempotent; settlement fencing makes double-resume harmless.

### 16.4 Snapshotting
A kernel-state snapshot is `{ seq, state: PipelineState, board: DagBoardSerialized, budget: LedgerSerialized }`, written off the hot path. Replay cost after crash is bounded by `snapshotEvery`.

---

## 17. Resilience: Budgets, Depth Guards, Compaction

### 17.1 BudgetLedger **[NORMATIVE surface]**

```ts
// packages/kernel/src/budget.ts
export type BudgetDimension = "usd" | "tokens" | "wallClockMs" | "spawnDepth" | "turns";

export class BudgetLedger {
  constructor(limits: Readonly<Record<BudgetDimension, number>>, journal: JournalAppender) {}
  charge(dim: BudgetDimension, amount: number, attribution: string): void;   // journals budget.charged
  assertHeadroom(dim: BudgetDimension, op: string): void;                    // throws BudgetExhaustedError
  /** Soft thresholds (default 80%) emit budget.warningThreshold once per dimension —
      controllers translate this into "wrap up" steering messages to in-flight agents
      (CodeWhale --max-turns style wind-down) before any hard abort. */
}
```

Per-provider cost attribution uses the usage metadata each adapter extracts (Gemini interaction usage; Claude Code JSON output `total_cost_usd`; CodeWhale finish payload tier + token counts). The completion report's cost table is derived purely from `budget.charged` events — no separate accounting.

### 17.2 Depth and recursion guards
`spawnDepth` is carried in every dispatch context; the executor adapter refuses (`BudgetExhaustedError("spawnDepth")`) any spawn beyond `cfg.resilience.maxSpawnDepth` (default 2: orchestrator → swarm agent). Finalization escalation modules re-enter at depth 1, not nested.

### 17.3 Context compaction
The pi adapter watches session token telemetry; crossing `cfg.resilience.compactAtFraction` (default 0.75) of the provider window triggers `compact()` on that session, preserving (by prompt contract) the SYSTEM.md directives, the module spec, and the latest critique verbatim while summarizing earlier turns. Supervisor evaluations are stateless-per-call by design (fresh CLI invocation each time), so the supervisor never needs compaction — its context discipline comes from `transcript_handle` slicing instead of transcript inlining.

---

## 18. Configuration Schema

**[NORMATIVE]** — `dlo.config.ts` in the target workspace, loaded via `jiti`, validated with the schema below. Secrets come exclusively from environment variables referenced by name.

```ts
// packages/core/src/config.ts
import { z } from "zod";

export const DloConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    objectivesPath: z.string(),                          // markdown objectives fed to research
    groundingPaths: z.array(z.string()).default([]),     // PDFs / images for multimodal grounding
    workspace: z.object({ backendDir: z.string().default("backend"),
                          frontendDir: z.string().default("frontend") }),
  }),
  providers: z.object({
    research: z.object({ vendor: z.literal("gemini-deep-research"),
      model: z.enum(["deep-research-preview-04-2026","deep-research-max-preview-04-2026"]),
      apiKeyEnv: z.string().default("GEMINI_API_KEY"),
      mcpServers: z.array(z.object({ name: z.string(), url: z.string().url(),
                                     authorizationHeaderEnv: z.string().optional() })).default([]),
      maxTransientRetries: z.number().int().default(6) }),
    planner: z.object({ vendor: z.literal("claude-code"),
      binPath: z.string().default("claude"), maxTurns: z.number().int().default(60),
      maxValidationRetries: z.number().int().default(2) }),
    supervisor: z.object({ vendor: z.literal("claude-code"),
      evaluationTimeoutMs: z.number().int().default(900_000) }),
    executor: z.object({ vendor: z.literal("codewhale"),
      maxConcurrent: z.number().int().min(1).max(20).default(8),
      configTomlPath: z.string().default("~/.codewhale/config.toml") }),
    harness: z.object({ vendor: z.literal("pi"),
      sdkPackage: z.literal("@earendil-works/pi-coding-agent"),
      subagentsExtension: z.enum(["@gotgenes/pi-subagents","@tintinweb/pi-subagents"]) }),
  }),
  hitl: z.object({
    transports: z.array(z.enum(["tui","http-webhook"])).min(1).default(["tui"]),
    gateTtlMs: z.number().int().optional(),
    webhook: z.object({ url: z.string().url(), secretEnv: z.string(), listenPort: z.number().int() }).optional(),
  }),
  execution: z.object({ trustLevel: z.enum(["scoped","autonomous"]).default("scoped") }),
  budgets: z.object({
    usd: z.number().positive(), tokens: z.number().int().positive(),
    wallClockMs: z.number().int().positive(),
    maxSpawnDepth: z.number().int().default(2), warnAtFraction: z.number().min(0.5).max(0.95).default(0.8),
  }),
  verification: z.object({ evidenceMaxBytes: z.number().int().default(16_384),
                           pgImage: z.string().default("postgres:17-alpine") }),
  journal: z.object({ snapshotEvery: z.number().int().default(500), segmentMaxBytes: z.number().int().default(67_108_864) }),
  resilience: z.object({ compactAtFraction: z.number().default(0.75) }),
  plugins: z.array(z.string()).default([]),              // package names resolved by the plugin host
});
export type DloConfig = z.infer<typeof DloConfigSchema>;
```

Cross-validation at boot (fail-fast, before any provider call): executor `maxConcurrent` ≤ CodeWhale's `[subagents].max_concurrent`; webhook transport configured iff selected; every secret env var present and non-empty; `claude` binary resolvable and version-compatible; Docker daemon reachable if any plan could need transient PostgreSQL (always true for this stack).

---

## 19. Extensibility and Plugin System

**[GUIDANCE]** — `@dlo/plugins`. A plugin is an ESM package exporting:

```ts
export interface DloPlugin {
  readonly name: string;
  readonly compatibleWith: string;                       // semver range against @dlo/core
  register(host: PluginHost): void | Promise<void>;
}

export interface PluginHost {
  clauses: ClauseEvaluatorRegistry;                      // add exit-clause kinds (e.g. "k6LoadProbe", "semgrepScan")
  hitlTransports: Registry<HitlTransport>;               // add gate transports (Slack, email)
  providers: { research: Registry<ResearchProviderFactory>;
               planner: Registry<PlannerProviderFactory>;
               executor: Registry<ExecutorProviderFactory>;
               supervisor: Registry<SupervisorProviderFactory> };
  bus: { subscribe: ShieldedSubscribe };                 // read-only event taps (isolation: "shielded" enforced)
  reporters: Registry<CompletionReporter>;               // additional report sinks (Slack, GitHub PR body)
}
```

Plugins are loaded after config validation, in declared order; a plugin whose `register` throws aborts boot (plugins are infrastructure, not optional decorations). Plugins cannot publish kernel events, mutate the board, or resolve gates — the host exposes no such capability, which is the security boundary.

**Anticipated extensions (design-validated, not v1 scope):** alternative executor vendors behind `ExecutorProvider`; a `git-pr` reporter opening a pull request per pipeline with the completion report as body; a `semgrep` clause kind in the supervisor's security review; a Slack HITL transport.

---

## 20. Observability

- **Structured logs** (`pino`): every log line carries `{pipelineId, phase, moduleId?, attemptId?, seq?}`. Adapter child-process stderr is streamed at `debug` with provider tagging.
- **OpenTelemetry**: one root span per pipeline; child spans per phase, per module attempt (`dispatch → inner-loop wait → clause run → supervisor evaluation`), per gate (span ends at resolution — human latency becomes visible on the trace). Metrics: `dlo_modules_total{status}`, `dlo_attempts_per_module`, `dlo_budget_spent{dimension}`, `dlo_gate_latency_seconds`, `dlo_clause_duration_seconds{kind}`.
- **`dlo status`**: renders the live board (module grid colored by status, in-flight attempt ages, budget gauges, pending gates) from the journal — read-only, safe to run beside the daemon.

## 21. Security Posture

1. **Secrets** only via env (`*Env` config indirection); journal and artifacts are scrubbed by a redaction pass (registered env values replaced before persistence).
2. **Command execution** is `execFile`-only (argv arrays, no shell interpolation) for clause evaluators and adapters; clause `argv[0]` must be on the allowlist `{cargo, npx, npm, psql, docker, pg_dump}` (extendable only via plugin-registered kinds, which own their own allowlists).
3. **Workspace confinement**: clause `cwd` and module `touches` globs are resolved and verified to stay under the workspace root (no `..` escapes, symlink-resolved).
4. **Supervisor leak review**: the supervisor prompt mandates checking that DB errors do not leak through `IntoResponse` and that server-only secrets/config never enter the TanStack client bundle — codified as both a `fileAssertion` clause family and a standing prompt directive (defense in depth).
5. **Webhook HITL** signing (HMAC-SHA256, timestamped, 5-minute replay window) and expiring artifact URLs.
6. **Permission escalation audit**: `--dangerously-skip-permissions` is reachable only through the journaled Gate-2 `escalatePermissions` approval (§10.3).

---

## 22. Implementation Roadmap and Acceptance Criteria

Build order follows the dependency rule (§4). Each milestone gates the next; its acceptance criteria are written to be directly usable as the implementing agent's own exit clauses.

| # | Milestone | Scope | Acceptance criteria (all must hold) |
|---|---|---|---|
| M1 | Foundations | `core`, `journal` | `pnpm -r typecheck` and `vitest run` green · journal property tests: append/replay round-trip over 10⁴ randomized events; integrity chain detects single-byte corruption at any offset; HEAD recovery after simulated crash between segment write and HEAD rename |
| M2 | Kernel | `kernel` (state machine, settlement, budget) | Exhaustive transition-table tests (every cell of §6.1, plus every illegal `phase×event` pair throws) · settlement: stale-epoch and unknown-token completions journaled-and-dropped · budget: threshold warning emitted exactly once per dimension |
| M3 | Plan + clauses | `plan-schema`, `exit-clauses` | Cycle detection reports full cycle path · all four clause evaluators integration-tested against a real fixture workspace (a minimal but genuine Axum crate + TanStack app committed under `fixtures/`, exercised by real `cargo`/`tsc`/`docker` invocations in CI) · unknown clause kind fails plan validation, not runtime |
| M4 | Scheduler + double loop | `scheduler`, double-loop controller | Deterministic simulation harness (scripted `ExecutorProvider`/`SupervisorProvider` test doubles driving real kernel/journal/scheduler code) proves: criticality ordering; concurrency ceiling honored; FAIL→restore→re-dispatch with critique; exhaustion gate; `dag.allPassed` exactly once · kill -9 during 20-module run, then `dlo resume` completes with zero duplicated `module.passed` events |
| M5 | Adapters | `adapters-{gemini,claude-code,codewhale,pi}` | Contract tests against recorded provider sessions (request/response cassettes captured from live runs, replayed in CI) · live smoke suite (env-gated, `DLO_LIVE=1`) executes one trivial module end-to-end against real providers |
| M6 | HITL + CLI | `hitl`, `cli` | TUI gate flow drives approve/steer/reject through a pty-driven e2e test · webhook transport: signature verification, replay-window rejection, first-resolution-wins across simultaneous transports |
| M7 | Finalization + report | finalization controller, reporters | Escalation path produces remediation modules that traverse the full double loop · completion report cost table reconciles to the sum of `budget.charged` events to the cent |
| M8 | System e2e | all | Full pipeline against a reference project spec (small but real: authenticated CRUD service — Axum + sqlx + migrations + TanStack UI) completes with ≤ configured budget on live providers; generated app passes its own `cargo test`/`vitest`/release builds independently of DLO |

**Testing doctrine for the implementing agent:** test doubles are confined to M4's simulation harness and M5's cassette replays — they exercise real kernel code against scripted *provider behavior*, which is the only legitimate use of substitution in this codebase. Everything else (journal, clauses, fixtures, e2e) runs against real I/O. No fallback code paths: a missing binary, unreachable Docker daemon, or absent env var fails boot with a precise `DloError`, never degrades.

---

## 23. Glossary

| Term | Definition |
|---|---|
| **Inner loop** | CodeWhale's autonomous edit→LSP-diagnose→fix cycle within one attempt; terminates when local diagnostics are empty |
| **Outer loop** | Deterministic clause run + Claude Code supervisory evaluation of a finished attempt |
| **Exit clause** | Deterministic, machine-evaluable completion predicate attached to a module by the Engineering Plan |
| **Settlement** | Epoch+token fencing that makes async completions safe against steering, rewind, and crash races |
| **Side-git** | CodeWhale's out-of-band snapshot store; never touches the workspace's primary `.git` |
| **Promotion** | Conversion of an approved attempt's side-git snapshot into a real git commit |
| **Gate** | A journaled HITL decision point (domain document, plan, or module escalation) |
| **Board** | The journal-projected status grid of all plan modules |
| **Authoritative-negative** | A clause failure cannot be overridden by any agent judgment |

---

*End of specification. The implementing agent should begin at M1 and treat every **[NORMATIVE]** identifier in this document as a fixed public contract.*
