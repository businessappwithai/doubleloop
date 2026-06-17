# Visual Agent Builder — Engineering Plan (reviewed)

**Status:** Reviewed via `/plan-eng-review`. Decision A confirmed: revive the kernel/scheduler seam; strangler-migrate off `pipeline-helper.ts`.
**Date:** 2026-06-17

> **Load-bearing fact:** DLO already contains a real, tested, graph-native orchestrator
> (`@dlo/kernel` + `@dlo/scheduler` + `@dlo/journal`) that the running app does not use.
> The running app orchestrates through a 1,726-line procedural script
> (`copilotkit-ui/src/lib/pipeline-helper.ts`) that has drifted from `@dlo/core`'s phase enum.
> This plan revives the orphaned seam rather than building a third orchestrator.

---

## 1. Target architecture

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                         PRESENTATION (React 19)                          │
 │                                                                          │
 │  copilotkit-ui (chat, existing)        agentflow canvas (NEW, iframe)    │
 │   Tailwind                              React 18 + MUI, isolated          │
 │      │                                        │                          │
 │      │                                 onFlowChange/onSave                │
 │      │                                        ▼                          │
 │      │                              ┌─────────────────────┐               │
 │      │                              │ FlowData JSON       │  postMessage  │
 │      │                              │ (nodes/edges/vp)    │  ◄──────────► │
 │      │                              └─────────────────────┘               │
 └──────┼──────────────────────────────────┼─────────────────────────────────┘
        │                                  │
        ▼                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                    GRAPH LOADER + VALIDATION (NEW, thin)                 │
 │   FlowData JSON  ──►  DloGraph  ──►  EngineeringPlan + DagBoard modules   │
 │   (agentflow node)  maps to   (DagBoard module / gate / loop)            │
 └──────────────────────────────────────────┬─────────────────────────────────┘
                                            │ inject ports
                                            ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │              THE REVIVED SEAM (already built + tested)                   │
 │                                                                          │
 │   DispatchPump ──► ExecutorProvider.onFinish ──► DoubleLoopController    │
 │   (capacity)        (dispatch)              (inner OCR ─► clauses        │
 │         │                                        ─► supervisor           │
 │         ▼                                         ─► promote/reject)      │
 │   DagBoard (module DAG)   StateMachine (phase reduce)   BudgetLedger     │
 │                                                                  Settlement│
 └──────────────────────────────────────────────────┬───────────────────────┘
                                                    │ ports (core/ports.ts)
                            ┌───────────────────────┼───────────────────────┐
                            ▼                       ▼                       ▼
              ┌──────────────────────┐ ┌─────────────────────┐ ┌──────────────────┐
              │ adapters-pi (BUILD)  │ │ adapters-claude     │ │ adapters-gemini  │
              │  ExecutorProvider    │ │  SupervisorProvider │ │  ResearchProvider│
              │  (pi.dev swarm)      │ │  (Claude review)    │ │  (deep research) │
              │  HarnessSession ◄ pi │ │                     │ │                  │
              └──────────┬───────────┘ └─────────────────────┘ └──────────────────┘
                         ▼
                    pi.dev  ──►  Claude / Gemini / DeepSeek
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                       @dlo/journal  +  @dlo/db-service                   │
 │   append-only events (integrity chain)   ◄─►   MariaDB projections       │
 │   = single source of truth; UI rebuilt by replay                         │
 └──────────────────────────────────────────────────────────────────────────┘
```

**Key property:** the canvas never executes anything. It emits `FlowData` JSON. The graph
loader converts it to the kernel's `EngineeringPlan`/`DagBoard` shape. The revived
`DispatchPump`+`DoubleLoopController` execute it. Events stream back via the existing
SSE channel (`/api/pipelines/:id/status/stream`) and the canvas status overlay reflects them.

---

## 2. Migration sequence (strangler fig — incremental, reversible)

Never migrate the whole app at once. Each step ships behind a feature flag and is independently revertable.

```
STEP 0  Reconcile phase drift         [make the change easy]
        core/phases.ts absorbs BUILD/DB/TESTING/DEPLOY from the app,
        OR pipeline-helper collapses them into FINALIZATION sub-states.
        ONE phase enum. Delete the duplicate.         (~1-2 days)

STEP 1  Build adapters-pi ExecutorProvider + SupervisorProvider  [real impl]
        PiExecutorProvider.dispatch()  ─► pi.dev swarm (replace mock)
        PiSupervisorProvider.evaluate() ─► Claude review
        Wire behind core/ports.ts. Unit-test against the port contract. (~3-5 days)

STEP 2  Stand up the kernel seam as a NEW execution path (parallel to pipeline-helper)
        /api/graph-pipelines/init  ─► graph loader ─► DispatchPump ─► adapters
        Feature-flagged. Chat pipelines (pipeline-helper) keep running untouched.
        Bridge both through db-service (shared persistence).             (~3-5 days)

STEP 3  Visual builder (agentflow, iframe-isolated) bound to the graph path
        FlowData ─► graph loader. Status overlay binds to SSE.           (~1 week)

STEP 4  Migrate chat-driven pipelines onto the kernel seam (retire pipeline-helper)
        One phase at a time: research ─► planning ─► execution ─► finalize.
        Delete pipeline-helper.ts when the last route moves.            (~1-2 weeks)
```

Step 0 first (Beck: make the change easy, then make the easy change). The phase drift
is the root cause of the orphaning — two phase models made the kernel unusable as-is.

---

## 3. Contracts (the seams that make this modular)

### 3a. Graph schema — agentflow FlowData ─► DloGraph (HYBRID, per D2)

**Decision D2: hybrid.** agentflow's generic nodes carry the *graph topology* (what connects to
what). A **DLO side panel** carries the *domain richness* the canvas structurally can't hold
(gate exhibits, 3-way Approve/Steer/Reject, module attempts, settlement state). No fork of
agentflow — this respects its documented `renderHeader` / `renderNodePalette` / `canvasActions`
extension surface and survives its pre-1.0 churn.

agentflow emits `{ nodes, edges, viewport }`. The loader maps topology to a **`DloGraph`**;
node `data` carries a `dloKind` discriminator the panel reads:

```
FlowData (agentflow generic node)        DloGraph (ours)              Side panel renders
─────────────────────────────────        ────────────────             ───────────────────────────────
"agentAgentflow"   data.dloKind=module ► ModuleNode                   module prompt, adapterHint,
                                                                        touched files, attempts, verdict
"llmAgentflow"     data.dloKind=model  ► ModelCallNode                provider/model/role picker
"conditionAgentflow" data.dloKind=gate► GateNode                      EXHIBITS + Approve/Steer/Reject
                                                                        + reason/instructions fields
"iterationAgentflow" data.dloKind=loop► LoopNode                      inner modules, maxAttempts,
                                                                        inner(OCR)/outer(Claude) status
"executeFlowAgentflow" data.dloKind=sub► SubpipelineNode              sub-graph link
"httpAgentflow"    data.dloKind=probe  ► ProbeNode                    url + assertion (httpProbe clause)
"customFunctionAgentflow" dloKind=clause►ClauseNode                   command | fileAssertion | sqlAssertion
"startAgentflow"                        ► (entry marker)              —
edges                                   ► dependencies                (feeds DagBoard criticality ordering)
```

DloGraph ─► `EngineeringPlan` (the input `DagBoard` already consumes, `scheduler/board.ts:11`).
**No new execution concepts** — topology maps onto the existing module/board/clause model;
the panel is pure presentation bound to SSE status. The canvas stays a generic graph editor;
DLO never leaks its domain types into agentflow's node registry.

### 3b. Orchestrator → adapter contract (already exists — `core/ports.ts`)

```
ExecutorProvider   { dispatch(module, snapshot, runToken): AttemptId;            ← BUILD THIS for pi.dev
                     onFinish(cb); capacity(): number }
SupervisorProvider { evaluate(module, attempt, clauses): Verdict }               ← BUILD THIS for Claude
ResearchProvider   { research(objectives): DomainDocument }                       ← adapt existing Gemini path
PlannerProvider    { plan(domain): TripartitePlanRefs }                          ← adapt existing Claude path
HarnessSession     { forkContext; steerSession; rewindTo; compact }              ← pi.dev (replace mock)
```

`DoubleLoopController` (kernel) already consumes exactly these. No orchestrator rewrite.
The missing work is the two pi.dev implementations in `adapters-pi`.

### 3c. Canvas binding — events ─► status overlay

```
DispatchPump event ─► journal append ─► SSE /status/stream ─► canvas node status
   (EXECUTING/PASSED/REJECTED)                                  (running/finished/error/stopped)
```

agentflow already renders node execution states (running/finished/error/stopped).
We map our module statuses onto them. No custom viz layer needed for the basics.

---

## 4. agentflow integration — React 19 conflict resolution

`copilotkit-ui` is React 19 + Tailwind. agentflow pins `react ^18.2.0` + MUI 5 + Emotion.
**Resolution: iframe isolation** (agentflow is embeddable + uncontrolled by design).

```
copilotkit-ui (React 19, parent)
   └─ <iframe src="/agentflow-host">  (separate React 18 bundle)
         └─ <Agentflow ... />
      parent ◄──postMessage(FlowData)──► iframe
      parent ──postMessage(nodeStatus)─► iframe   (SSE consumed in parent, forwarded)
```

This sidesteps the entire peer-dep + MUI/Tailwind collision. agentflow's imperative API
(`getFlow`/`toJSON`/`onSave`) + JSON export are purpose-built for this boundary.
**Spike first** to confirm before committing (it's `0.0.0-dev.14`).

---

## 5. Phase reconciliation (Step 0 detail)

Today: `core/phases.ts` ends at `FINALIZATION_RUNNING`. The app added `BUILD_RUNNING`,
`DB_PROVISIONING_RUNNING`, `TESTING_RUNNING`, `DEPLOY_RUNNING` inline. Two phase models = drift.

Recommendation: **model build/db/test/deploy as `FINALIZATION` sub-states**, not top-level
phases. They are finalization concerns (lint/build/test/deploy are the "polish" phase per the
architecture doc). Add `FinalizationStep` enum to core; `StateMachine` reduces
`finalization.step.changed` events. One phase enum in `core`, consumed everywhere. DRY.

---

## 6. Test strategy (non-negotiable per eng preferences)

```
UNIT      adapters-pi   dispatch/evaluate against port contract (mock pi.dev; assert calls + errors)
UNIT      graph-loader  FlowData ─► DloGraph (every node type, malformed input, cycles)
UNIT      kernel        (already tested) re-run after phase reconciliation
INTEGRATION DispatchPump ─► fake adapters ─► DoubleLoopController ─► assert promote/reject/exhaust
INTEGRATION graph-loader ─► kernel seam ─► db-service round-trip (journal replay == projection)
E2E       agentflow canvas ─► draw a 3-module graph ─► run ─► SSE status reflected on nodes
PROP      journal append/replay round-trip (already exists in journal tests — extend)
```

Every new adapter is unit-tested against its port interface, not the implementation.
Graph-loader gets a test per node-type mapping + malformed-input + cycle-detection cases.

---

## 7. Risks (ranked)

| # | Risk | Mitigation |
|---|---|---|
| R1 | agentflow dev-version (`0.0.0-dev.14`) API churn | iframe isolation contains blast radius; pin exact version; spike before commit |
| R2 | pi.dev ExecutorProvider semantics don't match `ExecutorProvider` port | Write the adapter's contract tests FIRST; discover mismatch before wiring |
| R3 | Phase reconciliation breaks existing chat pipelines | Strangler: chat path stays on pipeline-helper until Step 4; feature-flagged |
| R4 | db-service schema drift (loose VARCHAR phases, 80% unused surface) | Step 0 enforces enum; migrate tables to FK-backed enums in same step |
| R5 | DoubleLoopController assumes interfaces the orphaning drifted from | Re-run kernel simulation tests against revived adapters before Step 2 |

---

## 8. What is explicitly OUT of scope

- Rewriting CopilotKit chat (it coexists; only its orchestration backend migrates in Step 4).
- Multi-tenant/auth (none exists today).
- Replacing MariaDB (db-service stays; we just use more of its surface).

---

## Decision log

- **D1 (confirmed):** Revive kernel/scheduler seam via strangler (Option A). Graph-native,
  already tested, matches canvas; migration incremental + reversible.
- **D2 (confirmed):** Hybrid canvas (Option C). agentflow generic nodes carry topology;
  DLO side panel carries domain richness (gates/exhibits/3-way decisions/attempts/settlement).
  No fork — survives agentflow pre-1.0 churn.
