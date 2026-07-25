/**
 * orchestrator/phases/design.ts
 * Phase II — Design Analyst.
 *
 * A pi.dev subagent invokes Claude Code (plan mode, subscription-plan aware)
 * three times to author the design documents from RESEARCH.md:
 *
 *   Architecture.md    — frameworks (TanStack Start default), best practices,
 *                        plumbing conventions, modular design with a central
 *                        orchestration module
 *   Database.md        — ALWAYS PostgreSQL; detailed data models + mermaid ERD
 *                        + full SQL DDL
 *   Implementation.md  — ordered module plan (DAG) with a machine-readable
 *                        ```json implementation-plan block → engineeringPlan
 *
 * Then hands off to CEO_REVIEW_RUNNING (/plan-ceo-review pass).
 */

import {
  type PipelineState,
  getPipeline,
  savePipeline,
  saveDesignDoc,
  pushPhaseHistory,
} from "../state";
import { spawnClaudeAgent, claudeAuthFromConfig, claudePermissionModeFromConfig } from "../subagents/claude";
import { getSubagentRunner } from "../subagents/pi";
import { runCeoReviewBackground } from "./review";
import { appendLog } from "../logStore";

const DESIGN_TIMEOUT_MS = 15 * 60_000;

/** Shared context header given to every design invocation. */
function designContext(state: PipelineState): string {
  const research = state.designDocs?.research?.markdown
    || state.domainDocument?.markdown
    || "";
  const notes = (state.contextNotes || [])
    .map((n) => n.note)
    .filter((n) => !n.startsWith("[AgentDesign]"))
    .join("\n");
  return `Project: ${state.projectName}

Objectives:
${state.objectivesMarkdown}
${notes ? `\nSteering notes from the user:\n${notes}\n` : ""}
Domain Research Document (the base for all design decisions):
${research}`;
}

const FRAMEWORK_RULE = `FRAMEWORK RULE: If the research/objectives do not mandate a specific application framework,
you MUST default to TanStack Start (React, file-based routing, server functions, Vite) for the application,
with PostgreSQL as the database. If the research clearly mandates a different stack (e.g. Android/Kotlin,
CLI tool), honor the research instead and say so explicitly.`;

/**
 * The generated application must ship its own test suite — the pipeline's
 * TESTING_RUNNING phase treats "no tests" as a failure, not a pass, so a design
 * that does not plan tests produces a pipeline that cannot finish. Every design
 * prompt carries this rule verbatim.
 */
const TEST_RULE = `TEST RULE (NON-NEGOTIABLE): the application you are designing MUST ship with an extensive
unit-test suite, and the plan must make that happen by construction — tests are not a follow-up task.
- Every unit of behavior (each exported function, data-access module, service, reducer, route handler and
  React component) gets its own unit tests covering the happy path, every branch, boundary/empty values,
  and the failure modes (assert the actual error, not merely that something threw).
- Tests are deterministic: no live network, no real database, no real child processes, no real clock —
  fake them at the module boundary.
- No test may be skipped, and no test-runner flag may be used that lets an EMPTY suite report success.`;

function architecturePrompt(state: PipelineState): string {
  return `You are the Design Analyst agent of the Double-Loop Orchestrator, authoring Architecture.md.

${designContext(state)}

${FRAMEWORK_RULE}

Author the COMPLETE contents of Architecture.md for this project. Respond with ONLY the markdown document
(no outer code fence, no preamble). Required sections:

# Architecture — ${state.projectName}
## Technology Choices        (frameworks with justification; database is PostgreSQL)
## Central Orchestrator      (the single module that coordinates everything: its responsibilities,
                              its public interface, and how modules register with it)
## Modules                   (each module: name, responsibility, narrow public interface, dependencies —
                              the design must be VERY modular; no module talks to another except through
                              declared interfaces or the central orchestrator)
## Plumbing & Conventions    (error handling, configuration, logging, dependency wiring, folder layout —
                              include representative code snippets for the chosen stack)
## Testing Strategy          (MANDATORY, see TEST RULE below)
## Best Practices            (type safety, security, performance)
## Deployment Shape          (how the app runs locally and in production)

${TEST_RULE}

The "## Testing Strategy" section must be concrete enough to build against. It MUST state:
- the test runner and assertion library for the chosen stack, plus the exact dev dependencies and
  config files needed (for a Vite/React/TanStack stack: vitest, @testing-library/react, jsdom,
  vitest.config.ts and vitest.setup.ts);
- the file-naming and location convention for tests (state ONE convention and stick to it);
- the \`test\` script in package.json, which MUST run the whole suite non-interactively and MUST NOT
  pass a flag that makes an empty suite succeed;
- what each layer must have covered: pure functions/parsers, data-access modules (against a fake or
  in-memory driver), service/business logic, and React components (render + interact + assert output);
- how external systems (network, database, child processes, clock, randomness) are faked so tests are
  deterministic and never reach a real service.

Be concrete and complete — this document is the build contract for the implementation subagents.`;
}

function databasePrompt(state: PipelineState, architectureMd: string): string {
  return `You are the Design Analyst agent of the Double-Loop Orchestrator, authoring Database.md.

${designContext(state)}

The approved architecture document:
${architectureMd.slice(0, 12_000)}

The storage layer is ALWAYS PostgreSQL. Author the COMPLETE contents of Database.md. Respond with ONLY
the markdown document (no outer code fence, no preamble). Required sections:

# Database — ${state.projectName}
## Overview                  (PostgreSQL version, extensions, connection strategy, migration approach)
## Data Models               (EVERY table: purpose, columns with types/constraints/defaults, indexes,
                              foreign keys, uniqueness rules — as detailed tables)
## Entity Relationship Diagram
\`\`\`mermaid
erDiagram
  ...complete diagram of every entity and relation...
\`\`\`
## DDL
\`\`\`sql
-- Complete, runnable PostgreSQL DDL for every table, index, and constraint,
-- in dependency order. This block is used as the migration source of truth.
\`\`\`
## Seed & Fixture Strategy
## Query Patterns            (the main access paths the app will use)`;
}

function implementationPrompt(state: PipelineState, architectureMd: string, databaseMd: string): string {
  return `You are the Design Analyst agent of the Double-Loop Orchestrator, authoring Implementation.md.

${designContext(state)}

Architecture.md (the build contract):
${architectureMd.slice(0, 10_000)}

Database.md (data model contract):
${databaseMd.slice(0, 8_000)}

Author the COMPLETE contents of Implementation.md: an ordered implementation plan that build subagents
(cheaper-model Claude Code agents working in parallel) will execute module by module. Respond with ONLY
the markdown document (no outer code fence, no preamble). Required sections:

# Implementation Plan — ${state.projectName}
## Build Order               (narrative: what gets built when, and why)
## Modules                   (for each module: id, title, what to build, files it creates/modifies,
                              modules it depends on, acceptance criteria)
## Machine-Readable Plan

\`\`\`json implementation-plan
{
  "planVersion": 1,
  "generatedBy": "DLO Design Analyst",
  "modules": [
    {
      "moduleId": "m1",
      "title": "…",
      "stackTarget": "fullstack",
      "prompt": "Complete, self-contained build instruction for this module (150-600 chars).",
      "dependsOn": [],
      "estimatedComplexity": "easy|medium|hard",
      "maxAttempts": 3,
      "touches": ["every file this module creates or modifies, INCLUDING its test files"],
      "acceptance": ["verifiable acceptance criteria — each one checkable by running a command"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/<this-module-test-file>.test.ts"], "expect": {"exitCode": 0}}
      ]
    }
  ]
}
\`\`\`

PLAN RULES:
- As many modules as the project genuinely needs (typically 6-20) — do NOT artificially compress.
- The FIRST module MUST scaffold the project: package.json with ALL dependencies and scripts
  (dev/build/test), the framework config files, and the entry point, so the app is installable and
  buildable from module 1. For TanStack Start that means package.json, app.config.ts, tsconfig.json,
  and the src/routes entry files.
- The SECOND module (dependsOn the scaffold, and a dependency of every module that ships tests) MUST
  install and configure the test harness described in Architecture.md "## Testing Strategy": the test
  dependencies, the runner config file, the setup file, and the package.json \`test\` script. That
  script must run the entire suite non-interactively and must NOT use a flag that lets an empty suite
  pass (no --passWithNoTests).
- One module MUST implement the database layer exactly per Database.md (migrations from the DDL block,
  a db client module, typed data access).
- dependsOn must form a DAG (no cycles). Modules with no dependency relation run IN PARALLEL — split
  work to maximize safe parallelism (different modules must not touch the same files).
- Every "touches" list must be exhaustive for that module.
- The JSON must be valid and complete. It is parsed programmatically.

${TEST_RULE}

PER-MODULE TEST RULES (these are what make the suite exist):
- EVERY module that produces behavior (i.e. every module after the scaffold and harness modules) MUST
  list its own test files in "touches" and MUST carry an exit clause that runs exactly those test files.
- EVERY such module's "acceptance" list MUST include at least one criterion of the form
  "unit tests in <path> pass and cover <the behaviors this module adds>".
- The module "prompt" text MUST itself tell the build subagent to write those unit tests — the prompt is
  the only instruction that subagent receives, so a prompt that omits tests produces a module with none.
- Do NOT collect all tests into one trailing "write the tests" module. Tests ship with the module that
  produces the behavior, so a failing module is caught by its own exit clause.`;
}

/**
 * Extract the ```json implementation-plan block from Implementation.md.
 *
 * The document routinely contains OTHER fenced json blocks (an example
 * package.json, a config sample, a tsconfig snippet), and those often appear
 * before the plan. Selecting the first json fence therefore picks up the wrong
 * block and the whole design phase fails on a document that is actually fine.
 * Selection order: the fence explicitly tagged `implementation-plan` wins;
 * otherwise the first json fence that parses AND carries a modules array.
 */
export function parseImplementationPlan(implementationMd: string): any {
  const fences = [...implementationMd.matchAll(/```json([^\n]*)\n([\s\S]*?)```/g)].map((m) => ({
    tag: (m[1] ?? "").trim(),
    body: (m[2] ?? "").trim(),
  }));
  if (fences.length === 0) {
    throw new Error("Implementation.md is missing the ```json implementation-plan block.");
  }

  const tagged = fences.find((f) => f.tag.includes("implementation-plan"));
  if (tagged) {
    try {
      return JSON.parse(tagged.body);
    } catch (e: any) {
      throw new Error(`Implementation.md's json plan block is invalid JSON: ${e.message}`);
    }
  }

  // Untagged: the plan is the block that actually looks like a plan.
  let firstParseError = "";
  for (const fence of fences) {
    try {
      const parsed = JSON.parse(fence.body);
      if (parsed && Array.isArray(parsed.modules)) return parsed;
    } catch (e: any) {
      if (!firstParseError) firstParseError = e.message;
    }
  }
  if (firstParseError) {
    throw new Error(`Implementation.md's json plan block is invalid JSON: ${firstParseError}`);
  }
  throw new Error("Implementation.md is missing the ```json implementation-plan block.");
}

/** Validate the module DAG: unique ids, known deps, acyclic (Kahn). */
export function validatePlanDag(plan: any): string[] {
  const errors: string[] = [];
  const modules: any[] = plan?.modules || [];
  if (!modules.length) errors.push("Plan contains no modules.");
  const ids = new Set<string>();
  for (const m of modules) {
    if (!m.moduleId) errors.push("A module is missing moduleId.");
    else if (ids.has(m.moduleId)) errors.push(`Duplicate moduleId: ${m.moduleId}`);
    else ids.add(m.moduleId);
  }
  for (const m of modules) {
    for (const dep of m.dependsOn || []) {
      if (!ids.has(dep)) errors.push(`Module ${m.moduleId} depends on unknown module ${dep}.`);
    }
  }
  // Kahn's algorithm for cycle detection
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const m of modules) {
    indeg.set(m.moduleId, (m.dependsOn || []).length);
    for (const dep of m.dependsOn || []) {
      out.set(dep, [...(out.get(dep) || []), m.moduleId]);
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const next of out.get(id) || []) {
      const d = (indeg.get(next) || 1) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited !== modules.length) errors.push("dependsOn graph contains a cycle.");
  return errors;
}

/** Does this path look like a test file under any of the conventions we ask for? */
function isTestPath(path: string): boolean {
  return /(?:^|[\\/])(?:tests?|__tests__|spec)[\\/]/i.test(path)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

/**
 * Non-blocking audit of the plan's test coverage. Returns one warning per
 * module that produces behavior but plans no tests for it.
 *
 * Deliberately NOT part of validatePlanDag: a plan missing tests is still a
 * structurally runnable plan, and failing the design phase over it would strand
 * the pipeline. The warnings are surfaced in the logs and the shortfall is
 * enforced for real in TESTING_RUNNING, which refuses to pass an empty suite.
 */
export function validatePlanTestCoverage(plan: any): string[] {
  const warnings: string[] = [];
  const modules: any[] = plan?.modules || [];
  // The scaffold module and the test-harness module legitimately ship no tests
  // of their own: they exist so that everything after them can be tested.
  const setupModules = new Set(
    modules
      .filter((m) => {
        const text = `${m.title ?? ""} ${m.prompt ?? ""}`.toLowerCase();
        const touches: string[] = m.touches || [];
        const isScaffold = touches.some((t) => /(?:^|[\\/])package\.json$/i.test(t));
        const isHarness = /\b(?:test harness|test setup|testing setup|vitest|jest config)\b/.test(text);
        return isScaffold || isHarness;
      })
      .map((m) => m.moduleId)
  );

  for (const m of modules) {
    if (setupModules.has(m.moduleId)) continue;
    const touches: string[] = m.touches || [];
    if (!touches.some(isTestPath)) {
      warnings.push(`Module ${m.moduleId} ("${m.title ?? ""}") lists no test files in touches.`);
      continue;
    }
    const clauses: any[] = m.exitClauses || [];
    const runsTests = clauses.some((c) =>
      Array.isArray(c?.argv) && c.argv.some((a: unknown) => typeof a === "string" && /\b(?:vitest|jest|test)\b/i.test(a))
    );
    if (!runsTests) {
      warnings.push(`Module ${m.moduleId} ("${m.title ?? ""}") has test files but no exit clause that runs them.`);
    }
  }
  return warnings;
}

export async function runDesignBackground(pipelineId: string): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const plannerModel = state.config?.providers?.planner?.model || "claude-sonnet-5";
    const { auth, apiKey } = claudeAuthFromConfig(state.config);
    const permissionMode = claudePermissionModeFromConfig(state.config, "planner", "bypassPermissions");
    const runner = await getSubagentRunner(state.config);

    const pluginDirs: string[] = state.config?.skills?.pluginDirs ?? [];
    const invoke = async (prompt: string) =>
      spawnClaudeAgent({
        prompt,
        model: plannerModel,
        cwd: state.workspaceDir,
        permissionMode,
        auth,
        ...(apiKey ? { apiKey } : {}),
        timeoutMs: DESIGN_TIMEOUT_MS,
        pipelineId,
        ...(pluginDirs.length ? { pluginDirs } : {}),
      });

    // Architecture first (the other two build on it), then DB + Implementation.
    appendLog(pipelineId, `[Design] Starting Design Analyst (model=${plannerModel}, auth=${auth})`);
    appendLog(pipelineId, `[Design] Step 1/3: Authoring Architecture.md…`);
    const [archResult] = await runner.runParallel([
      {
        name: "design-analyst:architecture",
        mission: "Author Architecture.md in plan mode",
        run: () => invoke(architecturePrompt(state)),
      },
    ]);
    if (!archResult?.ok || !archResult.value?.trim()) {
      throw new Error(`Architecture.md generation failed: ${archResult?.error || "empty output"}`);
    }
    const architectureMd = stripOuterFence(archResult.value);

    appendLog(pipelineId, `[Design] Architecture.md complete — Step 2/3: Authoring Database.md…`);
    appendLog(pipelineId, `[Design] Step 3/3: Authoring Implementation.md…`);
    const [dbResult] = await runner.runParallel([
      {
        name: "design-analyst:database",
        mission: "Author Database.md (PostgreSQL) in plan mode",
        run: () => invoke(databasePrompt(state, architectureMd)),
      },
    ]);
    if (!dbResult?.ok || !dbResult.value?.trim()) {
      throw new Error(`Database.md generation failed: ${dbResult?.error || "empty output"}`);
    }
    const databaseMd = stripOuterFence(dbResult.value);

    const [implResult] = await runner.runParallel([
      {
        name: "design-analyst:implementation",
        mission: "Author Implementation.md with machine-readable plan",
        run: () => invoke(implementationPrompt(state, architectureMd, databaseMd)),
      },
    ]);
    if (!implResult?.ok || !implResult.value?.trim()) {
      throw new Error(`Implementation.md generation failed: ${implResult?.error || "empty output"}`);
    }
    const implementationMd = stripOuterFence(implResult.value);

    // Parse + validate the machine-readable plan before accepting the docs.
    const engineeringPlan = parseImplementationPlan(implementationMd);
    const dagErrors = validatePlanDag(engineeringPlan);
    if (dagErrors.length) {
      throw new Error(`Implementation plan invalid: ${dagErrors.join(" | ")}`);
    }

    // Surfaced, never silently tolerated: the gap is enforced in TESTING_RUNNING.
    const testWarnings = validatePlanTestCoverage(engineeringPlan);
    for (const w of testWarnings) appendLog(pipelineId, `[Design] ⚠ Test coverage gap in plan — ${w}`);

    const fresh = await getPipeline(pipelineId);
    if (!fresh || fresh.phase === "ABORTED" || fresh.phase === "FAILED") return;

    await saveDesignDoc(fresh, "architecture", architectureMd);
    await saveDesignDoc(fresh, "database", databaseMd);
    await saveDesignDoc(fresh, "implementation", implementationMd);

    fresh.plan = {
      ceoPlan: architectureMd.slice(0, 400),
      architecturePlan: architectureMd,
      engineeringPlan,
    };
    fresh.board = {
      modules: (engineeringPlan.modules || []).map((m: any) => ({
        moduleId: m.moduleId,
        status: "PENDING",
        attempts: 0,
      })),
    };

    fresh.phase = "CEO_REVIEW_RUNNING";
    pushPhaseHistory(fresh, "CEO_REVIEW_RUNNING");
    fresh.lastTransitionAt = new Date().toISOString();
    await savePipeline(fresh);
    console.log(`[Design] Three documents authored for ${pipelineId}; starting /plan-ceo-review pass`);

    void runCeoReviewBackground(pipelineId);
  } catch (err: any) {
    const s = await getPipeline(pipelineId);
    if (!s) return;
    s.phase = "FAILED";
    pushPhaseHistory(s, "FAILED");
    s.error = `Design phase failed: ${err.message || String(err)}`;
    s.lastTransitionAt = new Date().toISOString();
    await savePipeline(s);
  }
}

function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  return m?.[1] ?? trimmed;
}
