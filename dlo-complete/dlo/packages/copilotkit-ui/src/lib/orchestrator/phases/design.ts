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
import { spawnClaudeAgent, claudeAuthFromConfig } from "../subagents/claude";
import { getSubagentRunner } from "../subagents/pi";
import { runCeoReviewBackground } from "./review";

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
## Best Practices            (testing strategy, type safety, security, performance)
## Deployment Shape          (how the app runs locally and in production)

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
      "touches": ["every file this module creates or modifies"],
      "acceptance": ["verifiable acceptance criteria"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
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
- One module MUST implement the database layer exactly per Database.md (migrations from the DDL block,
  a db client module, typed data access).
- dependsOn must form a DAG (no cycles). Modules with no dependency relation run IN PARALLEL — split
  work to maximize safe parallelism (different modules must not touch the same files).
- Every "touches" list must be exhaustive for that module.
- The JSON must be valid and complete. It is parsed programmatically.`;
}

/** Extract the ```json implementation-plan block (or best-effort JSON) from Implementation.md. */
export function parseImplementationPlan(implementationMd: string): any {
  const fenced = implementationMd.match(/```json[^\n]*\n([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim();
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch (e: any) {
      throw new Error(`Implementation.md's json plan block is invalid JSON: ${e.message}`);
    }
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

export async function runDesignBackground(pipelineId: string): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const plannerModel = state.config?.providers?.planner?.model || "claude-sonnet-5";
    const { auth, apiKey } = claudeAuthFromConfig(state.config);
    const runner = await getSubagentRunner(state.config);

    const invoke = async (prompt: string) =>
      spawnClaudeAgent({
        prompt,
        model: plannerModel,
        cwd: state.workspaceDir,
        permissionMode: "plan",
        auth,
        ...(apiKey ? { apiKey } : {}),
        timeoutMs: DESIGN_TIMEOUT_MS,
      });

    // Architecture first (the other two build on it), then DB + Implementation.
    console.log(`[Design] Authoring Architecture.md (model=${plannerModel}, auth=${auth}, runner=${runner.kind})`);
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

    console.log(`[Design] Authoring Database.md + Implementation.md`);
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
