# CLAUDE.md — DLO (Double-Loop Orchestrator)

Guidance for Claude Code and other AI assistants working in this repository.
Read this before editing anything. It describes what the code **actually does
today**, not what the aspirational docs promise.

---

## 1. What this repository is

DLO is an **autonomous development pipeline**: a human states objectives, and a
fleet of AI subagents researches, designs, builds, tests and deploys a complete
application — pausing at human-in-the-loop (HITL) gates for approval.

The pipeline generates *other* applications. Those generated apps land in
`dlo-complete/dlo/packages/copilotkit-ui/workspaces/<slug>-<id>/` and are
committed to this repo as evidence of pipeline runs.

### Repository layout

```
/                                    ← repo root (this file)
├── README.md                        ← one line; not a real README
├── ENHANCEMENT_PLAN.md              ← THE canonical spec of the current design (R1–R15, M-A–M-F). Read §4 before changing pipeline behavior.
└── dlo-complete/
    ├── CLAUDE.md                    ← gstack skill-routing notes for the dev environment
    ├── dlo-architecture.md          ← 74 KB normative architecture spec (state machine, event taxonomy, ports)
    ├── IMPLEMENTATION_GUIDE.md      ← patterns and code examples
    ├── DLO_IMPLEMENTATION_SUMMARY.md, DELIVERABLES_INDEX.md, README_FIRST.md
    ├── *.png                        ← UI screenshots from pipeline runs
    └── dlo/                         ← ★ THE CODE: pnpm + turbo monorepo
        ├── package.json             ← root scripts (typecheck / lint / test / build)
        ├── pnpm-workspace.yaml      ← packages/* + language
        ├── tsconfig.base.json       ← strict TS settings all packages inherit
        ├── turbo.json
        ├── README.md                ← ASPIRATIONAL. Lists packages that do not exist (hitl, cli, plugins, observability). Do not trust it.
        ├── language/                ← @dlo/language — the EML modeling language
        └── packages/
```

**Everything you need to run lives under `dlo-complete/dlo/`.** Treat that as
the project root for all commands.

---

## 2. The pipeline (what the product does)

Phases are defined once, in `packages/core/src/phases.ts` — the single source of
truth. Never declare a local `phase: string`.

```
INIT
 → RESEARCH_RUNNING        Gemini subagent ensemble → RESEARCH.md
 → GATE1_PENDING           HITL: approve | edit in place | research further
 → DESIGN_RUNNING          Design Analyst (Claude Code, plan mode) → Architecture.md, Database.md, Implementation.md
 → CEO_REVIEW_RUNNING      /plan-ceo-review per document → *.review.md suggestions
 → GATE2_PENDING           HITL: /documents page — apply/edit/dismiss suggestions, approve each doc, approve all
 → EXECUTION_RUNNING       build fleet: parallel Claude Code (haiku) subagents along the Implementation.md DAG
 → BUILD_RUNNING → DB_PROVISIONING_RUNNING → TESTING_RUNNING → DEPLOY_RUNNING → APP_LAUNCH_RUNNING
 → COMPLETED | FAILED | ABORTED        (PAUSED = frozen EXECUTION_RUNNING)
```

`PLANNING_RUNNING` and gate kind `TRIPARTITE_PLAN` are **legacy** — kept only so
pipelines persisted before the Design Analyst still load. New pipelines use
`DESIGN_RUNNING` + `CEO_REVIEW_RUNNING` + `DESIGN_REVIEW`.

### Gate kinds

| Kind | Phase | Decisions |
|---|---|---|
| `DOMAIN_DOCUMENT` | GATE1_PENDING | `APPROVE` · `STEER` (re-research with extra input) · `REJECT` |
| `DESIGN_REVIEW` | GATE2_PENDING | `APPROVE` (re-parses Implementation.md, resumes PASSED modules) · `STEER` · `REJECT` |
| `TRIPARTITE_PLAN` | legacy GATE2 | `APPROVE` · `STEER` · `REJECT` |
| `TOOL_INSTALL_PERMISSION` | pre-execution | `APPROVE` · `USE_CLAUDE` (switch executor to Claude) · else FAILED |
| `TERMINAL_PERMISSION` | build/db/test/deploy/launch | `APPROVE` (run step) · `REJECT` (skip step, advance) |

---

## 3. Package map

| Package | Path | Role | Wired into the running app? |
|---|---|---|---|
| `@dlo/copilotkit-ui` | `packages/copilotkit-ui` | **The actual runtime.** Next.js 15 app: UI, API routes, and the whole orchestrator. | ★ this *is* the app |
| `@dlo/core` | `packages/core` | Types, branded IDs, error hierarchy, phases, artifacts, module/exit-clause schemas, ports, config. Zero runtime deps except zod. | ✅ yes |
| `@dlo/language` | `language` | EML (ERDwithAI Modeling Language): typed loader over `erdwithai-language.json`, grammar, spec, examples. | ✅ yes |
| `@dlo/erd` | `packages/erd` | EML → model → Postgres DDL / DBML / Liam schema, introspection, diffing. | ✅ yes |
| `@dlo/adapters-pi` | `packages/adapters-pi` | pi.dev harness adapter. | ✅ imported |
| `@dlo/db-service` | `packages/db-service` | Express service on **:3099** persisting pipeline metadata to **MariaDB**. | ✅ called over HTTP |
| `@dlo/journal` | `packages/journal` | Append-only integrity-chained JSONL event log + snapshots. | ❌ **library only** |
| `@dlo/kernel` | `packages/kernel` | Pure state-machine reducer, settlement tracker (epoch/token fencing), budget ledger, double-loop controller. | ❌ **library only** |
| `@dlo/scheduler` | `packages/scheduler` | DAG board + dispatch pump. | ❌ **library only** |
| `@dlo/exit-clauses` | `packages/exit-clauses` | Evaluators for `command`, `httpProbe`, `sqlAssertion`, `fileAssertion` + registry/runner. | ❌ **library only** |
| `@dlo/plan-schema` | `packages/plan-schema` | Engineering Plan zod schema + Kahn cycle detection. | ❌ **library only** |

> ⚠️ **The most important fact about this codebase:** the five packages marked
> "library only" are well-tested but **not imported by the running app**.
> `copilotkit-ui` depends only on `@dlo/core`, `@dlo/language`, `@dlo/erd`,
> `@dlo/adapters-pi`. The orchestrator re-implements board/dispatch/verdicts
> inline. Wiring them in is desirable, but do not *assume* a change to
> `@dlo/kernel` affects pipeline behavior — it does not. Verify with
> `grep -rn "@dlo/kernel" packages/copilotkit-ui/` before making that claim.

**Dependency rule:** `core ← journal ← kernel ← {scheduler, exit-clauses} ← adapters-* ← ui`.
No rightward imports. `eslint-plugin-boundaries` is a declared devDependency
intended to enforce this (see §9 — the config is missing).

### The orchestrator (`packages/copilotkit-ui/src/lib/orchestrator/`)

```
index.ts              ← CENTRAL ORCHESTRATOR. Owns every phase transition and gate resolution.
state.ts              ← PipelineState + persistence (db-service dual-write, local JSON authoritative)
phases/research.ts    ← Phase I: prompt-assembler + architecture/domain/ERD researchers (Gemini)
phases/design.ts      ← Phase II: three design docs; parseImplementationPlan / validatePlanDag
phases/review.ts      ← Phase II.b: /plan-ceo-review per doc; parseSuggestions
phases/build.ts       ← Phase III: the build fleet (DAG-parallel, per-module agent assignment)
phases/finalize.ts    ← Phases IV/V: build → db → test → deploy → launch, each with a fix loop
subagents/claude.ts   ← THE ONLY place `claude` is spawned (plan mode, subscription vs api-key auth)
subagents/gemini.ts   ← Gemini client
subagents/pi.ts       ← pi.dev runner seam: real pi SDK when installed, else LocalSubagentRunner
langflow.ts           ← export/apply the agent graph as a Langflow flow
skillManager.ts       ← discovers/installs Claude skills under ~/.claude/skills
logStore.ts           ← in-process per-pipeline log ring buffer (feeds /logs + SSE)
processRegistry.ts    ← live child processes per pipeline (abort, stdin injection)
```

**Rule: `orchestrator/index.ts` is the only file allowed to change
`state.phase` or resolve a gate.** Phase modules do work and report; they do
not move the pipeline between phases. API routes are thin dispatchers.

### HTTP API (`packages/copilotkit-ui/app/api/`)

| Route | Methods |
|---|---|
| `/api/health` | GET |
| `/api/pipelines` | GET |
| `/api/pipelines/init` | POST |
| `/api/pipelines/[id]` | GET |
| `/api/pipelines/[id]/status` · `/status/stream` | GET · GET (SSE) |
| `/api/pipelines/[id]/logs` · `/report` · `/workspace` | GET |
| `/api/pipelines/[id]/pause` · `/resume` · `/abort` · `/context` | POST |
| `/api/pipelines/[id]/stdin` | POST, GET |
| `/api/pipelines/[id]/documents` | GET |
| `/api/pipelines/[id]/documents/[doc]` | GET, PUT, PATCH |
| `/api/pipelines/[id]/documents/[doc]/review` · `/approve` | POST |
| `/api/pipelines/[id]/agent-design` | GET, PUT |
| `/api/pipelines/[id]/langflow/flow` | GET, POST |
| `/api/pipelines/[id]/langflow/apply` | POST |
| `/api/pipelines/[id]/erd` | GET |
| `/api/pipelines/[id]/erd/generate` · `/sync` · `/apply-destructive` | POST |
| `/api/pipelines/[id]/erd/viewer` | GET, POST |
| `/api/gates/[gateId]/resolve` | POST |
| `/api/skills` | GET, POST |
| `/api/copilotkit` · `/api/test-config` | POST |

Pages: `/` · `/chat` (2.4 kLOC — the main console) · `/documents` (Gate 2) ·
`/designer` (agent canvas) · `/erd` (Liam viewer).

### Persistence & state

- `PipelineState` (`orchestrator/state.ts`) is the one state shape.
- **`.dlo/pipelines/<pipelineId>.json` is authoritative** — it holds the full
  record (designDocs, reviews, agentDesign, gates, board). `.dlo/` is gitignored.
- `db-service` (MariaDB, `:3099`) stores a **summary row only**. `getPipeline()`
  reads the file first and falls back to the DB summary.
- Two different databases, do not confuse them: **MariaDB** = DLO's own pipeline
  metadata; **PostgreSQL 17 in Docker (port 5433, user `dlo`, db `dlo_app`)** =
  the database provisioned *for the generated application*. Generated apps are
  always Postgres.
- Design docs are written both to state and to disk in the pipeline's workspace:
  `RESEARCH.md`, `Architecture.md`, `Database.md`, `Implementation.md` (+
  `*.review.md`, and `DOMAIN.md` as a back-compat mirror of research).

---

## 4. Development environment

### Prerequisites

- Node ≥ 22, pnpm ≥ 9 (`packageManager: pnpm@9.0.0`)
- Docker — for the Postgres provisioning phase
- `claude` CLI on PATH — the Design Analyst, reviewer, build fleet and fixer all
  spawn it. `checkClaudeCli()` reports availability; a missing CLI fails loudly.
- Optional: MariaDB (`packages/db-service/setup-db.sh`), Langflow (`:7860`),
  `codewhale` / `ocr` CLIs for the alternate executor and review paths.

### Environment variables (never in config files, never committed)

`GEMINI_API_KEY` · `ANTHROPIC_API_KEY` · `DEEPSEEK_API_KEY` ·
`OPENAI_API_KEY` / `OPENROUTER_API_KEY` (CodeWhale fallbacks) · `PI_API_KEY` ·
`LANGFLOW_URL` / `LANGFLOW_API_KEY` · `DB_SERVICE_URL` (default
`http://localhost:3099`) · `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` ·
`NEXT_PUBLIC_DLO_DAEMON_URL` · `PORT` (default **8090**).
Start from `packages/copilotkit-ui/.env.example`.

### Commands

All from `dlo-complete/dlo/` unless noted.

```bash
pnpm install                      # workspace install

# run the app (predev builds @dlo/language → erd → core → adapters-pi first)
pnpm -C packages/copilotkit-ui dev            # http://localhost:8090
pnpm -C packages/copilotkit-ui build          # next build (runs prebuild)
pnpm -C packages/db-service dev               # metadata service on :3099

pnpm typecheck                    # tsc --noEmit at root + every package
pnpm test                         # pnpm -r test  (vitest per package)
pnpm build                        # build every package
pnpm -r clean

# single package
pnpm -C packages/kernel test
pnpm -C packages/journal test
```

Docker Compose (`packages/copilotkit-ui/docker-compose.yml`) brings up the app
on `:8090` plus Langflow on `:7860`.

---

## 5. Testing policy — MANDATORY

> **Every code change must ship with detailed unit tests. This is not optional
> and not deferred to a follow-up.** A change that adds or modifies behavior
> without tests covering that behavior is incomplete work; say so rather than
> reporting it as done.

This applies in two places, and both are required:

### 5.1 Code you write in this repository

**Framework:** vitest. **Location:** `packages/<pkg>/__tests__/<subject>.test.ts`
(sibling to `src/`, not inside it). **Imports:** `.js` extensions on relative
source imports (`../src/journal.js`) — the packages are ESM.

Use `vitest run` (not bare `vitest`) whenever you invoke it yourself, so it
does not enter watch mode and hang the session.

Per change, write tests that cover **all** of:

1. **The happy path** — the behavior the change exists to provide, asserted on
   real return values, not on "did not throw".
2. **Every branch you introduced** — each `if`/`switch` arm, each decision
   string, each phase transition. Gate resolution and phase transitions must be
   asserted per decision (`APPROVE`/`STEER`/`REJECT`/`USE_CLAUDE`).
3. **Boundaries and empties** — empty arrays/strings, missing optional fields,
   zero and threshold values (budget warn fraction, `maxAttempts`,
   `maxConcurrent` = 1).
4. **Failure modes** — assert the *typed* error and its `code`, not just that
   something threw: `await expect(fn()).rejects.toThrow(BudgetExhaustedError)`.
5. **Invalid input** — malformed markdown/JSON reaching a parser, DAG cycles,
   unknown vendors/models, unknown gate kinds.
6. **Ordering/concurrency** where relevant — DAG dispatch order, parallel
   subagent settlement, stale-epoch discards.

Table-driven cases are preferred over copy-pasted blocks. Match the existing
style: `describe` per subject, nested `describe` per unit, one behavior per
`test`, and a name that states the expectation
(`"discards stale epoch settlements"`, not `"test settlement 2"`).

**By subject type:**

| What you changed | What the tests must do |
|---|---|
| Pure function / schema / parser (`core`, `plan-schema`, `erd`, `language`) | Exhaustive input/output tables including invalid input. Zod schemas: assert both accept and reject, and the rejection path. |
| Reducer / state machine (`kernel`) | Assert `next` state **and** emitted `intents` for every legal transition; assert illegal transitions throw. |
| Journal / persistence (`journal`, `state.ts`) | Round-trip append→replay; corruption/tamper detection; recovery after simulated crash. Use a temp dir created in `beforeEach` and removed in `afterEach` (see `journal.test.ts`). |
| Orchestrator phase module | Inject fakes for the subagent spawners; assert the state written back (phase, board, docs, activeGate) and that the phase module never sets a phase it isn't allowed to. |
| Anything spawning a process (`claude`, `codewhale`, `docker`, `psql`) | **Never spawn the real binary in a unit test.** `vi.mock("node:child_process")`. Assert on the exact argv (e.g. that `--permission-mode plan` is present, that `ANTHROPIC_API_KEY` is stripped in subscription auth) and on timeout/non-zero-exit handling. |
| Network calls (Gemini, Langflow, db-service) | Stub `fetch`/the SDK. Cover non-2xx, malformed body, and timeout. No live calls, no recorded secrets. |
| API route | Call the exported `GET`/`POST` handler directly with a `Request`; assert status code and body for success, not-found, and validation failure. |
| React component | `@testing-library/react` + jsdom: render, interact, assert observable output. |

Fixtures are code: keep them minimal, name them for what makes them
interesting (`planWithCycle`, `moduleMissingDependency`).

### 5.2 Code the pipeline generates

When you touch the prompts in `phases/design.ts` or `phases/build.ts`, the
generated application must also come out tested:

- `Implementation.md` modules must carry acceptance criteria that are
  **verifiable by running something**, and each module must own its test files
  in its `touches` list.
- Build-fleet module prompts must require a unit test per unit of behavior
  produced by that module — colocated per the generated project's convention
  (`tests/<subject>.test.ts` for the TanStack Start default, vitest +
  `@testing-library/react` + jsdom for components).
- `runTestingBackground` must find a real test command. A generated app whose
  `package.json` has no `test` script is a defect in the design/build prompts,
  not an acceptable outcome.

`workspaces/quick-notes-e9bdb8ee/` is the reference for a good result: vitest
config, `vitest.setup.ts`, and `tests/` covering service, repository, and
component layers.

### 5.3 Definition of done

```
[ ] pnpm typecheck                    # clean
[ ] pnpm -C packages/<pkg> test       # new tests present and passing
[ ] tests cover happy path + every new branch + failure modes
[ ] no real process spawns, network calls, or secrets in tests
[ ] docs updated if behavior/config changed (this file, ENHANCEMENT_PLAN.md)
```

Report failures honestly with the output. Do not describe untested code as
verified.

---

## 6. Coding conventions

### TypeScript

`tsconfig.base.json` is strict and unforgiving — inherit it, do not relax it:
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noUnusedLocals`/`Parameters`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`.

Consequences to plan for:

- Index access is `T | undefined` — narrow it (`events[0]?.type`).
- With `exactOptionalPropertyTypes`, never assign `undefined` to an optional
  property. Spread it conditionally: `...(apiKey ? { apiKey } : {})`.
- ESM everywhere (`"type": "module"`). Relative imports inside `packages/*/src`
  use `.js` extensions. `copilotkit-ui` uses the `@/*` → `./src/*` alias.
- Libraries are bundled with `tsup` and export `dist/index.d.ts` + `dist/index.js`.

### Design principles (from `dlo-architecture.md`, honored in library code)

1. **No mock data, no sample code.** Every path performs its real function or
   throws.
2. **No silent fallbacks.** Missing binary, unreachable service, absent env var
   → fail loudly. When a substitute *is* used (built-in reviewer instead of the
   gstack skill, `LocalSubagentRunner` instead of the pi SDK), it must be
   **labeled** in state and surfaced in the UI (`researchMeta.runner`,
   `DocumentReview.reviewer`, `RESEARCH.md` front-matter). Never pretend.
3. **Typed failures.** `throw` a `DloError` subclass with a machine-readable
   `code`. New failure modes get a new error type in `@dlo/core`.
4. **Event-sourced truth** (library layer): the journal is the source of truth;
   projections are deterministic replays.
5. **Deterministic settlement:** epochs + run tokens fence async boundaries;
   stale completions are journaled, never processed.

> Honest caveat: `orchestrator/state.ts` **does** swallow db-service errors and
> fall back to local files (by design — the file is authoritative). Do not cite
> principle 2 as already universal in the UI layer; several `console.warn` +
> continue paths exist there. New code should not add more of them.

### Security (non-negotiable)

- Secrets from env only; never in config files, commits, logs, or tests.
- Spawn with `execFile`/`spawn` and an **argv array — never a shell string**.
- Keep clause/command execution confined to the pipeline workspace root; no
  `..` escapes.
- Destructive DB operations go through the explicit
  `erd/apply-destructive` path with human approval.
- Terminal actions (build/db/test/deploy/launch, tool installs) stay behind
  their `TERMINAL_PERMISSION` / `TOOL_INSTALL_PERMISSION` gates. Do not add a
  code path that runs them without a gate.

### Comment style

Every module opens with a block comment: path, one-line purpose, and the
non-obvious constraints it encodes (see `subagents/claude.ts` on why
`child.stdin.end()` is required, or `core/src/phases.ts` on why phases live
there). Preserve these when editing; extend them when you add a constraint.
Match the surrounding density — inline comments explain *why*, never *what*.

---

## 7. Adding a feature — the order that works here

1. Types/schemas into `@dlo/core` (or `@dlo/plan-schema`) first.
2. New phases → `core/src/phases.ts` only. New gate kinds → the resolver in
   `orchestrator/index.ts`.
3. Implement the work in the appropriate `phases/*.ts` module. It must not set
   `state.phase`.
4. Wire transitions in `orchestrator/index.ts`; keep the API route a thin
   dispatcher.
5. **Write the unit tests (§5).**
6. `pnpm typecheck` + affected package tests.
7. Update `ENHANCEMENT_PLAN.md` / this file if behavior or config changed.

Back-compat matters: persisted pipeline JSON from older versions must still
load. Keep legacy phases and gate kinds working, and prefer additive state
fields with `?`.

---

## 8. Git workflow

- Develop on the branch you were assigned; never push to `main` directly.
- `git push -u origin <branch>`; retry network failures with backoff.
- Commit messages: `type(scope): summary` — the history uses `fix(fleet):`,
  `fix(deploy):`, `chore:`, `feat:`.
- Do not open a PR unless asked. When you do, fill in
  `packages/copilotkit-ui/.github/PULL_REQUEST_TEMPLATE.md` — including its
  Test Plan section, with the tests you actually ran.
- CI (`packages/copilotkit-ui/.github/workflows/`): `ci.yml` runs lint →
  typecheck → build; `pr-review.yml` runs a size check and secret scan;
  `deploy.yml` deploys `main` to Vercel. **Note CI does not run `pnpm test`** —
  that does not excuse you from writing tests; it means a reviewer will not
  catch you.

---

## 9. Known gaps and traps

Real, verified, and worth knowing before you trust a command or a doc:

1. **`pnpm lint` fails — no ESLint config exists.** Root `package.json` runs
   `eslint . --ext .ts,.tsx` and `turbo.json` lists `eslint.config.js` as a
   global dependency, but no `eslint.config.js` / `.eslintrc*` is present
   anywhere. ESLint 9 requires the flat config. The declared
   `eslint-plugin-boundaries` (intended to enforce the dependency rule) is
   therefore not enforcing anything. Adding the config is a genuine
   improvement; until then, do not report lint as passing.
2. **`pnpm test` is uneven.** `journal`, `kernel`, `scheduler`, `plan-schema`,
   `exit-clauses`, `adapters-pi` have tests. `erd` declares
   `"test": "vitest run"` but has **no test files** (that package's test task
   fails on "no test files found"). `core`, `language`, `db-service`,
   **and `copilotkit-ui` — where all the pipeline logic lives — have no test
   script and no tests at all.** The orchestrator is the least-tested and
   highest-risk code in the repo; adding tests there is the highest-value
   contribution available.
3. Several packages use `"test": "vitest"` (watch mode) rather than
   `vitest run`. Invoke `vitest run` explicitly.
4. **`dlo/README.md` is aspirational.** It documents `@dlo/hitl`, `@dlo/cli`,
   `@dlo/plugins`, `@dlo/observability`, `dlo.config.ts`, `pnpm dlo:init` /
   `dlo:run`, and OTel metrics. None of those packages exist; the root
   `dlo:init`/`dlo:run` scripts point at a non-existent `packages/cli`. The app
   is started with `pnpm -C packages/copilotkit-ui dev` on **:8090** (not 3000).
   `ENHANCEMENT_PLAN.md` and this file are the accurate documents.
5. `packages/copilotkit-ui/app/chat/page.tsx` is ~2,400 lines and
   `phases/finalize.ts` ~1,000. Read the region you are changing; do not
   restructure either wholesale as a side effect of a small fix.
6. Generated app workspaces under `packages/copilotkit-ui/workspaces/` **are
   git-tracked** (~92 files across four apps), including a committed
   `local.properties` and Gradle state in the Android sample. `.dlo/`,
   `.next/`, `dist/`, `node_modules/`, and `public/erd/` are ignored. Do not
   commit new generated workspaces without being asked.
7. `db-service` is **MariaDB/MySQL** (`mariadb` driver, `?` placeholders,
   `LONGTEXT`, `ENGINE=InnoDB`) even though generated applications are always
   PostgreSQL. Do not "fix" its SQL to Postgres dialect.
8. `phases/build.ts` module prompts currently demand "no TODOs, no
   placeholders" but **do not explicitly require unit tests per module** — tests
   in generated apps come from whatever Implementation.md happens to plan. If
   you are asked to make generated code reliably tested, that prompt (and the
   design-phase acceptance-criteria prompt) is where the change belongs.
9. `pnpm install` has not been run in a fresh clone — `node_modules/` is
   absent. Install before typechecking or testing anything.

---

## 10. Where to look first

| Question | File |
|---|---|
| What is this system supposed to do? | `ENHANCEMENT_PLAN.md` §1, §4 |
| What are the legal phases? | `packages/core/src/phases.ts` |
| How does a gate advance the pipeline? | `orchestrator/index.ts` → `resolveGateDecision` |
| What is stored per pipeline? | `orchestrator/state.ts` → `PipelineState` |
| How is `claude` invoked? | `orchestrator/subagents/claude.ts` |
| How do modules get built in parallel? | `orchestrator/phases/build.ts` |
| How does build/test/deploy work? | `orchestrator/phases/finalize.ts` |
| What does a good test look like? | `packages/journal/__tests__/journal.test.ts`, `packages/kernel/__tests__/kernel.test.ts` |
| What does a good generated app look like? | `packages/copilotkit-ui/workspaces/quick-notes-e9bdb8ee/` |
| Normative architecture spec | `dlo-complete/dlo-architecture.md` |
| Skill routing for this dev environment | `dlo-complete/CLAUDE.md` |
