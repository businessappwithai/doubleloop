# DLO — Double-Loop Orchestrator
## Complete Implementation with CopilotKit UI

Welcome to DLO, a production-grade autonomous development pipeline that orchestrates multiple AI agents to generate fully verified software with human oversight at critical decision gates.

This repository contains:
- **@dlo/core** — Foundational types, error hierarchy, and IDs
- **@dlo/journal** — Event-sourced persistence with integrity-chained JSONL
- **@dlo/kernel** — Pure state machine reducer and settlement tracker
- **@dlo/scheduler** — DAG-based task scheduling with concurrency control
- **@dlo/exit-clauses** — Deterministic, machine-evaluable completion predicates
- **@dlo/hitl** — Human-in-the-loop gate service with pluggable transports
- **@dlo/adapters-\*** — Provider integrations (Gemini, Claude Code, CodeWhale, pi.dev)
- **@dlo/plan-schema** — Engineering Plan zod schemas with cycle detection
- **@dlo/cli** — Command-line daemon and control interface
- **@dlo/copilotkit-ui** — Professional chat interface powered by CopilotKit

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│                    DLO Daemon (Node.js)                         │
│                                                                 │
│  ┌──────────────┐   ┌────────────────────────────────────────┐ │
│  │ CopilotKit   │───│        Pipeline Kernel                 │ │
│  │ Chat UI      │   │  StateMachine · Scheduler · Settlement │ │
│  └──────────────┘   └─────────┬───────────┬────────────────┘ │
│       (Next.js)               │           │                   │
│                       ┌───────▼──────┐    │                   │
│                       │  Journal     │    │ 
│                       │ (append-only)│    │
│                       └──────────────┘    │
└──────────────────────────────────────────┼───────────────────┘
                                           │ HTTP
        ┌──────────────┬──────────────┬────▼──────────┐
        ▼              ▼              ▼               ▼
   Gemini Deep   Claude Code     CodeWhale       pi.dev
   Research     (plan +verify)    (executor)     (harness)
```

## Pipeline

1. **Research (Phase I)** — a pi.dev subagent ensemble (prompt-assembler +
   architecture / domain / ERD researchers, all Gemini) produces one huge
   `RESEARCH.md` in the new project directory. No Gemini key? A large textarea
   accepts user-provided research instead.
2. **HITL Gate 1** — approve, **edit the document in place**, or request
   further research with additional inputs.
3. **Design (Phase II)** — the Design Analyst (Claude Code in **plan mode**,
   subscription-plan aware) authors three documents: `Architecture.md`
   (frameworks — TanStack Start by default, central-orchestrator modular
   design), `Database.md` (always PostgreSQL, full data models + DDL), and
   `Implementation.md` (module DAG with machine-readable plan).
4. **CEO Review (Phase II.b)** — `/plan-ceo-review` (gstack skill, with a
   labeled built-in fallback) reviews each document; suggestions land in
   `*.review.md` and in the `/documents` UI.
5. **HITL Gate 2** — the `/documents` page: read each document, apply/edit/
   dismiss each enhancement, approve per document, then approve all to build.
6. **Execution (Phase III)** — the build fleet: many Claude Code subagents on
   the cheaper model (claude-haiku) build modules **in parallel** along the
   Implementation.md DAG. Per-module vendor/model configurable via
   **Langflow** (or the built-in designer canvas).
7. **Finalization (Phases IV/V)** — build → PostgreSQL provisioning
   (Database.md DDL as migration fallback) → tests → deploy, with a Fixer
   subagent auto-repairing build/test failures (up to 3 rounds).

## Key Features

### ✅ Event-Sourced Kernel
- Append-only, integrity-chained JSONL journal
- Pure state machine reducer
- Crash-only design: recovery is replay from disk

### ✅ Double-Loop Verification
- **Inner loop:** CodeWhale's LSP-driven edit cycle (syntax/type fixes)
- **Outer loop:** Claude Code reviews against deterministic exit clauses and architectural rules
- Prevents logic drift before it compounds downstream

### ✅ Deterministic Exit Clauses
Four kinds: `command`, `httpProbe`, `sqlAssertion`, `fileAssertion`
- Run before the supervisor sees results
- Supervisor can veto a green module but never override a failed clause
- Evidence captured (stdout/stderr/query results) for review

### ✅ Human-in-the-Loop at Critical Gates
- Domain Document approval (research phase)
- Plan approval with permission escalation (planning phase)
- Module exhaustion escalation (execution phase)
- Approve, steer (revise + re-run), or reject (rewind session)

### ✅ Professional Chat UI
- Built on CopilotKit (OpenAI-compatible agent framework)
- Agents for: init pipeline, monitor status, resolve gates, view artifacts
- Real-time status panel with module board, budget gauges, gate alerts
- Artifact viewer for domain documents and strategic plans

### ✅ Type Safety + No Fallbacks
- Strict TypeScript (`strictNullChecks`, `noUncheckedIndexedAccess`, etc.)
- Every fallible operation returns/throws a typed `DloError` subclass
- No mock data, no sample code, no degraded paths
- Missing binaries, unreachable Docker, absent env vars = fail boot loudly

---

## Quick Start

### Prerequisites
- Node.js ≥ 22 (LTS)
- pnpm ≥ 9
- Docker (for transient PostgreSQL in verification)
- Git

### Installation

```bash
git clone <repo>
cd dlo

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Typecheck
pnpm typecheck
```

### Running the Daemon

```bash
# Initialize a project (creates dlo.config.ts in target workspace)
pnpm dlo:init

# Start the daemon (runs on localhost:9090 by default)
pnpm dlo:run
```

### Starting the Chat UI

In a separate terminal:

```bash
cd packages/copilotkit-ui
pnpm dev
```

Opens at `http://localhost:3000`

### Using the Chat Interface

1. **Open the chat** at http://localhost:3000/chat
2. **Initialize a pipeline**
   - Say: "Initialize a new pipeline"
   - Provide project name, objectives, workspace directory
   - The chat agent will confirm and start the pipeline

3. **Monitor progress**
   - Say: "Check pipeline status" or "What's the current phase?"
   - Real-time status panel shows modules, budget, active gates

4. **Resolve HITL gates**
   - When a gate opens, the chat alerts you
   - Say: "Approve the domain document" / "Steer the plan" / "Reject and restart"
   - Provide steering instructions if chosen

5. **View artifacts**
   - Say: "Show me the domain document" / "Display the CEO plan" / "Show the architecture"
   - Chat renders markdown with citations and formatting

---

## Implementation Milestone Checklist

Following the architecture document's M1–M8 milestones:

- **M1: Foundations** ✅
  - [x] Branded IDs (UUID-based)
  - [x] Error hierarchy (typed, comprehensive)
  - [x] Phase constants
  - [x] Artifact schema (content-addressed)
  - [x] Module state and exit clauses
  - [ ] Journal append/replay/integrity tests

- **M2: Kernel**
  - [ ] State machine reducer (exhaustive tests)
  - [ ] Settlement tracker (epoch/token fencing)
  - [ ] Budget ledger (dimensional tracking)

- **M3: Plan + Clauses**
  - [ ] Engineering Plan zod schema
  - [ ] Cycle detection (Kahn's algorithm)
  - [ ] Four clause evaluators + registry

- **M4: Scheduler + Double Loop**
  - [ ] DAG board (projection from plan + journal)
  - [ ] Dispatch pump (concurrency gating)
  - [ ] Double-loop controller
  - [ ] Deterministic simulation harness

- **M5: Adapters**
  - [ ] Gemini Deep Research adapter
  - [ ] Claude Code planner & supervisor
  - [ ] CodeWhale executor (swarm + side-git)
  - [ ] pi.dev harness session wrapper

- **M6: HITL + CLI**
  - [ ] TUI gate presentation
  - [ ] Webhook HITL transport
  - [ ] `dlo init`, `dlo run`, `dlo resume`, `dlo status` commands

- **M7: Finalization**
  - [ ] Linter, tester, builder subagents
  - [ ] Escalation path for remediation
  - [ ] Report generation

- **M8: System e2e**
  - [ ] Reference project (Axum + sqlx + TanStack)
  - [ ] Full pipeline on live providers
  - [ ] Generated app passes independent tests

---

## Code Organization & Dependency Rules

```
dlo/
├── packages/
│   ├── core/              ← Types, errors, ids (zero runtime deps except zod)
│   ├── journal/           ← Event sourcing
│   ├── kernel/            ← State machine, settlement, budget
│   ├── scheduler/         ← DAG board, dispatch pump
│   ├── exit-clauses/      ← Clause evaluators
│   ├── hitl/              ← Gate service + transports
│   ├── adapters-*/        ← Provider implementations
│   ├── plan-schema/       ← Plan zod schemas
│   ├── plugins/           ← Plugin host and registry
│   ├── observability/     ← Logging, OTel
│   ├── cli/               ← Daemon and CLI
│   └── copilotkit-ui/     ← Next.js chat UI
└── docs/
```

**Dependency rule:** `core ← journal ← kernel ← {scheduler, exit-clauses, hitl} ← adapters-* ← cli`

No rightward imports. This keeps the system layered and the kernel decoupled from vendor implementations.

---

## Testing Strategy

### Property-based tests (journal)
```bash
pnpm -C packages/journal test
# Tests: append/replay round-trip, corruption detection, HEAD recovery after crash
```

### Deterministic simulation (kernel + scheduler)
```bash
pnpm -C packages/kernel test
# Tests: exhaustive transition table, settlement fencing, budget threshold warnings
```

### Contract tests (adapters)
```bash
pnpm -C packages/adapters-* test
# Tests: recorded request/response cassettes, live smoke tests (env-gated)
```

---

## Configuration

Each DLO workspace has a `dlo.config.ts` file:

```typescript
import type { DloConfig } from "@dlo/core";

export default {
  project: {
    name: "My Awesome API",
    objectivesPath: "./OBJECTIVES.md",
    groundingPaths: ["./architecture.pdf"],
  },
  providers: {
    research: {
      vendor: "gemini-deep-research",
      model: "deep-research-max-preview-04-2026",
      apiKeyEnv: "GEMINI_API_KEY",
    },
    planner: {
      vendor: "claude-code",
      binPath: "claude",
      maxTurns: 60,
    },
    supervisor: {
      vendor: "claude-code",
      evaluationTimeoutMs: 900_000,
    },
    executor: {
      vendor: "codewhale",
      maxConcurrent: 8,
    },
    harness: {
      vendor: "pi",
      sdkPackage: "@earendil-works/pi-coding-agent",
      subagentsExtension: "@gotgenes/pi-subagents",
    },
  },
  hitl: {
    transports: ["tui", "http-webhook"],
    webhook: {
      url: "https://your-hook-receiver.example.com/gates",
      secretEnv: "WEBHOOK_SECRET",
      listenPort: 9091,
    },
  },
  execution: {
    trustLevel: "scoped", // or "autonomous" if you've escalated permissions via Gate 2
  },
  budgets: {
    usd: 50.0,
    tokens: 5_000_000,
    wallClockMs: 3_600_000, // 1 hour
    spawnDepth: 2,
  },
  verification: {
    evidenceMaxBytes: 16_384,
    pgImage: "postgres:17-alpine",
  },
  plugins: [
    // Optional: custom clause kinds, reporters, transports
  ],
} satisfies DloConfig;
```

**Environment variables** (never in config files):
```bash
export GEMINI_API_KEY="..."
export ANTHROPIC_API_KEY="..."      # For Claude Code CLI
export WEBHOOK_SECRET="..."         # For HITL webhook
```

---

## Observability

### Structured Logging (pino)
Every log line carries context: `{pipelineId, phase, moduleId, attemptId, seq}`

```bash
# View logs with filtering
pnpm dlo:run 2>&1 | jq 'select(.phase=="EXECUTION_RUNNING")'
```

### OpenTelemetry Traces & Metrics
```
dlo_modules_total{status="PASSED"} 12
dlo_attempts_per_module 2.1
dlo_budget_spent{dimension="usd"} 34.50
dlo_gate_latency_seconds{kind="DOMAIN_DOCUMENT"} 180.5
```

### Live Status
```bash
pnpm dlo:run status
# Renders: module grid (status + age), budget gauges, pending gates, recent commits
```

---

## Security

- **Secrets:** Env vars only (never config files); redacted from logs
- **Command execution:** `execFile` only (argv arrays, no shell)
- **Clause allowlist:** `{cargo, npx, npm, psql, docker, pg_dump}`
- **Workspace confinement:** Clauses stay under workspace root (no `..` escapes)
- **Supervisor review:** Checks DB error leakage, server-only secret isolation
- **Permission escalation:** Journaled Gate-2 approval bit (immutable audit trail)

---

## Architecture Deep Dive

For the complete, normative specification (includes state machine transitions, event taxonomy, port definitions, exit clause DSL, settlement semantics), see:
- [`./dlo-architecture.md`](./dlo-architecture.md) — Full specification
- [`./IMPLEMENTATION_GUIDE.md`](./IMPLEMENTATION_GUIDE.md) — Patterns and code examples

---

## Contributing

The codebase follows strict principles:

1. **No mock data.** Every code path either performs its real function or throws a typed error.
2. **No fallbacks.** Missing binaries, unreachable services, absent env vars = fail boot loudly.
3. **Typed failures.** Every `throw` uses a `DloError` subclass with a machine-readable `code`.
4. **Event-sourced truth.** The journal is the single source of truth; all projections are deterministic replays.
5. **Deterministic settlement.** Epochs + run tokens fence async boundaries; stale completions are journaled, never processed.

When implementing a new feature:
1. Add schemas/types to `@dlo/core` first
2. Add journal event types and payloads
3. Extend the state machine reducer (exhaustive test coverage)
4. Implement the feature in the appropriate package
5. Add property-based or integration tests
6. Update the implementation guide

---

## Frequently Asked Questions

**Q: Can I run multiple pipelines concurrently?**
A: Yes. Each pipeline has its own `.dlo/` directory with independent journal, board, and budget. The daemon multiplexes across pipelines.

**Q: What if a provider (Gemini, Claude Code) is down?**
A: Adapter errors are typed and retryable. The system backs off with decorrelated-jitter and journals every attempt. If budget or timeout is exhausted, the pipeline fails gracefully.

**Q: How do I extend DLO with custom clause kinds?**
A: Implement `ClauseEvaluator`, register with the `ClauseEvaluatorRegistry`, and add to the plugin manifest in `dlo.config.ts`.

**Q: Can I abort a pipeline mid-execution?**
A: Yes. `dlo run abort <pipelineId>` or via the chat UI. The daemon flushes the current session and transitions to `ABORTED`. Resume is not possible from ABORTED.

**Q: What happens if the daemon crashes?**
A: On restart, the journal is replayed (integrity-checked), snapshots are loaded, and the recovery sequence reconciles external state (live Gemini interactions, CodeWhale task queue, etc.). The pump resumes execution from the exact point of failure.

---

## License

MIT (or per your organizational policy)

---

## Support

- **Issues:** GitHub Issues
- **Discussions:** GitHub Discussions
- **Documentation:** [dlo-architecture.md](./dlo-architecture.md), [IMPLEMENTATION_GUIDE.md](./IMPLEMENTATION_GUIDE.md)

---

**Built with 🚀 for autonomous, verifiable software generation at scale.**

DLO v0.1.0 · Double-Loop Orchestrator
