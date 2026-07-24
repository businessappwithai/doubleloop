/**
 * orchestrator/phases/build.ts
 * Phase III — Execution: the build fleet.
 *
 * Many build subagents (default: Claude Code on the cheaper model,
 * claude-haiku) build the application's modules IN PARALLEL following the
 * Implementation.md DAG: a module is dispatched as soon as every dependsOn
 * module has PASSED, up to maxConcurrent at a time.
 *
 * Per-module subagent assignment (vendor/model/prompt) comes from
 * state.agentDesign — written by the Langflow import or the designer canvas —
 * and IS honored here. Verdicts are real: a module passes only when its
 * builder succeeded, the review loop is clean, and its command exit clauses
 * pass; otherwise it's retried up to maxAttempts and then marked FAILED.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type PipelineState,
  type AgentAssignment,
  getPipeline,
  savePipeline,
  pushPhaseHistory,
} from "../state";
import { spawnClaudeAgent, claudeAuthFromConfig, claudePermissionModeFromConfig } from "../subagents/claude";
import { runDbProvisioningBackground, runBuildBackground, scaffoldMissingInfrastructure } from "./finalize";
import { appendLog } from "../logStore";

const execFileAsync = promisify(execFile);
const MODULE_TIMEOUT_MS = 20 * 60_000;

// ─── Module + context types ───────────────────────────────────────────────────

interface PlanModule {
  moduleId: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
  touches?: string[];
  acceptance?: string[];
  maxAttempts?: number;
  exitClauses?: Array<{
    clauseId: string;
    description: string;
    kind: string;
    argv?: string[];
    expect?: { exitCode?: number };
  }>;
}

function buildProjectContext(state: PipelineState): string {
  const parts = [
    `Project: ${state.projectName}`,
    `Objectives: ${state.objectivesMarkdown.slice(0, 800)}`,
  ];
  const arch = state.designDocs?.architecture?.markdown;
  const db = state.designDocs?.database?.markdown;
  if (arch) parts.push(`Architecture contract (Architecture.md, excerpt):\n${arch.slice(0, 4000)}`);
  if (db) parts.push(`Database contract (Database.md, excerpt):\n${db.slice(0, 3000)}`);
  if (!arch && state.domainDocument?.markdown) {
    parts.push(`Research / Requirements:\n${state.domainDocument.markdown.slice(0, 2000)}`);
  }
  const notes = (state.contextNotes || [])
    .map((n) => n.note)
    .filter((n) => !n.startsWith("[AgentDesign]"))
    .join("\n");
  if (notes) parts.push(`Steering notes from the user:\n${notes}`);
  return parts.join("\n\n");
}

function assignmentFor(state: PipelineState, moduleId: string): AgentAssignment {
  const fromDesign = state.agentDesign?.modules?.[moduleId];
  if (fromDesign) return fromDesign;
  const executor = state.config?.providers?.executor || {};
  const vendor: AgentAssignment["vendor"] =
    executor.type === "claude" || executor.vendor === "claude-code" ? "claude-code"
    : executor.vendor === "codewhale" ? "codewhale"
    : "claude-code"; // default fleet: Claude Code on the cheaper model
  return {
    vendor,
    model: executor.model || "claude-haiku-4-5-20251001",
  };
}

// ─── Builders ────────────────────────────────────────────────────────────────

/** Claude Code as a real agentic builder: it creates/edits every file the module touches. */
async function buildModuleWithClaude(
  state: PipelineState,
  mod: PlanModule,
  assignment: AgentAssignment,
  critique?: string
): Promise<void> {
  const { auth, apiKey } = claudeAuthFromConfig(state.config);
  const permissionMode = claudePermissionModeFromConfig(state.config, "executor", "acceptEdits");
  const prompt = `You are a build subagent of the Double-Loop Orchestrator, implementing ONE module of this application inside the current workspace.

${buildProjectContext(state)}

Module: ${mod.title} (${mod.moduleId})
Task: ${mod.prompt}
Files this module owns (create/modify ONLY these): ${(mod.touches || []).join(", ") || "(as needed for the task)"}
Acceptance criteria:
${(mod.acceptance || []).map((a) => `- ${a}`).join("\n") || "- Implements the task completely"}
${critique ? `\nA code review found these issues in the previous attempt — fix ALL of them:\n${critique.slice(0, 2000)}\n` : ""}
Rules:
- Implement completely: no TODOs, no placeholders, no stub bodies.
- Match Architecture.md and Database.md exactly (stack, conventions, schema).
- ${assignment.systemPrompt ? assignment.systemPrompt : "Follow the project's established conventions."}
- Do not modify files owned by other modules except where the touches list says so.
- When done, verify your files parse/compile if a quick check is possible.`;

  await spawnClaudeAgent({
    prompt,
    model: assignment.model,
    cwd: state.workspaceDir,
    permissionMode,
    auth,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: MODULE_TIMEOUT_MS,
  });
}

async function buildModuleWithCodeWhale(
  state: PipelineState,
  mod: PlanModule,
  critique?: string
): Promise<void> {
  const env = { ...process.env };
  const deepseekKey = state.config?.providers?.executor?.apiKey || process.env.DEEPSEEK_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const provider = deepseekKey ? "deepseek" : openaiKey ? "openai" : openrouterKey ? "openrouter" : null;
  const key = deepseekKey || openaiKey || openrouterKey;
  if (provider && key) {
    try {
      await execFileAsync("codewhale", ["auth", "set", "--provider", provider, "--api-key", key], { env, timeout: 15_000 });
    } catch (e: any) {
      console.warn(`[CodeWhale] ${provider} config failed:`, e.message);
    }
  }

  const cwPrompt = `You are implementing a software module.

${buildProjectContext(state)}

Module: ${mod.title}
Task: ${mod.prompt}
Files to create/modify: ${(mod.touches || []).join(", ")}
${critique ? `\nFix these review issues from the previous attempt:\n${critique.slice(0, 1500)}\n` : ""}
Requirements:
- Create all listed files with complete, production-ready code
- Match the architecture and database contracts above
- Include error handling
- Do not use placeholder or TODO comments — implement fully`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("codewhale", ["exec", "--auto", cwPrompt], { cwd: state.workspaceDir, env });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`CodeWhale exited ${code}: ${stderr.slice(0, 800)}`));
      } else {
        resolve();
      }
    });
  });
}

// ─── Review + verification ──────────────────────────────────────────────────

async function reviewWorkspace(state: PipelineState, _mod?: PlanModule): Promise<{ passed: boolean; critique: string }> {
  // Prefer the ocr CLI when present; otherwise a Claude diff review.
  try {
    await execFileAsync("ocr", ["--version"], { timeout: 10_000 });
    const { stdout } = await execFileAsync("ocr", ["review", "--format", "json"], {
      cwd: state.workspaceDir,
      timeout: 120_000,
    });
    try {
      const result = JSON.parse(stdout.trim());
      const issues: any[] = result.issues || result.errors || result.findings || [];
      if (Array.isArray(issues) && issues.length > 0) {
        return { passed: false, critique: issues.map((i: any) => i.message || i.description || String(i)).join("\n") };
      }
      return { passed: true, critique: "" };
    } catch {
      const passed = stdout.toLowerCase().includes("no issue") || stdout.toLowerCase().includes("everything is fine");
      return { passed, critique: passed ? "" : stdout.slice(0, 2000) };
    }
  } catch { /* ocr unavailable — Claude review below */ }

  try {
    // Confine the diff to the workspace directory — a bare `git diff` from a
    // workspace nested inside a larger repo returns the WHOLE repo's diff,
    // and the reviewer would fail modules over unrelated files.
    const { stdout: diffFull } = await execFileAsync("git", ["diff", "--", "."], {
      cwd: state.workspaceDir,
      timeout: 15_000,
    }).catch(() => ({ stdout: "" }));
    if (!diffFull.trim()) return { passed: true, critique: "" };

    const { auth, apiKey } = claudeAuthFromConfig(state.config);
    const review = await spawnClaudeAgent({
      prompt: `You are a code review subagent. Review this git diff for bugs, missing imports, and broken code:
${diffFull.slice(0, 6000)}

If the code has no significant issues, reply with exactly: "everything is fine".
Otherwise list the specific errors that must be fixed (one per line).`,
      model: "claude-haiku-4-5-20251001",
      cwd: state.workspaceDir,
      auth,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: 5 * 60_000,
    });
    const passed = review.toLowerCase().includes("everything is fine");
    return { passed, critique: passed ? "" : review };
  } catch (err: any) {
    console.warn("[Review] Fallback review failed:", err.message);
    return { passed: true, critique: "" };
  }
}

// ─── Failure diagnosis ────────────────────────────────────────────────────────

interface TsError { file: string; line: number; col: number; code: string; message: string; }

function parseTsErrors(output: string): TsError[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  const errors: TsError[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null)
    errors.push({ file: m[1]!, line: Number(m[2]), col: Number(m[3]), code: m[4]!, message: m[5]! });
  return errors;
}

function parseTestFailures(output: string): string[] {
  const lines = output.split("\n");
  const failures: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*●\s+/.test(line)) { inBlock = true; failures.push(line.trim()); continue; }
    if (inBlock) {
      if (/^(PASS|FAIL|✓|✗|✕|×|\s*at\s)/.test(line) && failures.length > 0) inBlock = false;
      else failures.push(line.trimEnd());
    }
  }
  return failures.slice(0, 80);
}

async function readFileSlice(absPath: string, centerLine: number, radius = 12): Promise<string | null> {
  try {
    const content = await readFile(absPath, "utf-8");
    const lines = content.split("\n");
    const from = Math.max(0, centerLine - 1 - radius);
    const to = Math.min(lines.length - 1, centerLine - 1 + radius);
    return lines.slice(from, to + 1)
      .map((l, i) => `${from + i + 1}${from + i + 1 === centerLine ? " ► " : "   "}${l}`)
      .join("\n");
  } catch { return null; }
}

async function diagnoseFailure(
  state: PipelineState,
  mod: PlanModule,
  stepDescription: string,
  rawOutput: string,
): Promise<string> {
  const tsErrors = parseTsErrors(rawOutput);
  const testFailures = parseTestFailures(rawOutput);

  const snippetParts: string[] = [];
  const seen = new Set<string>();
  for (const err of tsErrors.slice(0, 4)) {
    const abs = join(state.workspaceDir, err.file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const slice = await readFileSlice(abs, err.line);
    if (slice) snippetParts.push(`### ${err.file} (around line ${err.line})\n\`\`\`\n${slice}\n\`\`\``);
  }

  const structuredErrors = [
    tsErrors.length > 0
      ? `TypeScript errors (${tsErrors.length}):\n${tsErrors.slice(0, 20).map((e) => `  ${e.file}(${e.line},${e.col}) ${e.code}: ${e.message}`).join("\n")}`
      : "",
    testFailures.length > 0
      ? `Test failures:\n${testFailures.join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n") || rawOutput.slice(-1500);

  try {
    const { auth, apiKey } = claudeAuthFromConfig(state.config);
    const prescription = await spawnClaudeAgent({
      prompt: `You are a diagnostic agent. A build step failed and you must produce a surgical fix prescription.

FAILED STEP: ${stepDescription}
MODULE: ${mod.title} (${mod.moduleId})
FILES OWNED BY THIS MODULE: ${(mod.touches || []).join(", ") || "(as needed)"}

ERRORS:
${structuredErrors}

${snippetParts.length > 0 ? `FILE SNIPPETS (arrow ► marks the error line):\n${snippetParts.join("\n\n")}` : ""}

Respond with a numbered list of SPECIFIC, SURGICAL changes. For each:
- State the file path and line number
- State the exact problem (wrong import, wrong type, missing export, etc.)
- State what to write instead (be precise — include actual code if helpful)

Do NOT give generic advice. Do NOT explain concepts. Fix THESE specific errors. Under 400 words.`,
      model: "claude-haiku-4-5-20251001",
      cwd: state.workspaceDir,
      auth,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: 90_000,
    });
    appendLog(state.pipelineId, `[Diagnose] "${mod.title || mod.moduleId}" — ${prescription.slice(0, 300)}`);
    return `Diagnostic prescription for "${stepDescription}":\n${prescription}`;
  } catch {
    return `${stepDescription} failed:\n${structuredErrors}`;
  }
}

/**
 * Make sure the workspace's npm dependencies are installed before exit
 * clauses run — otherwise typecheck/build clauses fail with "cannot find
 * module" no matter how good the generated code is, and retries fly blind.
 * Idempotent: npm short-circuits quickly when node_modules is current.
 */
async function ensureDependencies(state: PipelineState): Promise<{ ok: boolean; detail: string }> {
  if (!existsSync(join(state.workspaceDir, "package.json"))) return { ok: true, detail: "" };
  try {
    await execFileAsync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
      cwd: state.workspaceDir,
      timeout: 300_000,
      env: { ...process.env },
    });
    return { ok: true, detail: "" };
  } catch (e: any) {
    return {
      ok: false,
      detail: `npm install failed: ${((e.stderr || "") + (e.stdout || "") || e.message).slice(-1200)}`,
    };
  }
}

/** Run a module's command exit clauses. Non-command kinds are skipped here. */
async function runExitClauses(
  state: PipelineState,
  mod: PlanModule
): Promise<{ passed: boolean; detail: string }> {
  const clauses = (mod.exitClauses || []).filter((c) => c.kind === "command" && Array.isArray(c.argv) && c.argv.length);
  for (const clause of clauses) {
    const [cmd, ...args] = clause.argv!;
    try {
      await execFileAsync(cmd!, args, { cwd: state.workspaceDir, timeout: 180_000 });
    } catch (e: any) {
      const expected = clause.expect?.exitCode ?? 0;
      const actual = typeof e.code === "number" ? e.code : 1;
      if (actual !== expected) {
        const rawOutput = ((e.stdout || "") + "\n" + (e.stderr || "")).trim() || e.message || "";
        const clauseDesc = `${clause.argv!.join(" ")} (${clause.description})`;
        appendLog(state.pipelineId, `[Clause] "${mod.title || mod.moduleId}" — "${clauseDesc}" failed (exit ${actual}), diagnosing…`);
        const detail = await diagnoseFailure(state, mod, clauseDesc, rawOutput);
        return { passed: false, detail };
      }
    }
  }
  return { passed: true, detail: "" };
}

// ─── The fleet ───────────────────────────────────────────────────────────────

async function runOneModule(pipelineId: string, mod: PlanModule): Promise<boolean> {
  const state = await getPipeline(pipelineId);
  if (!state) return false;
  const assignment = assignmentFor(state, mod.moduleId);
  const maxAttempts = assignment.maxAttempts ?? mod.maxAttempts ?? 3;

  // Seed the critique with the failure from a previous fleet run (if the
  // gate was reopened after a FAILED execution) so retries keep their memory.
  const label = mod.title || mod.moduleId;
  let critique =
    (state.board?.modules.find((m) => m.moduleId === mod.moduleId) as any)?.failure || "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const latest = await getPipeline(pipelineId);
    if (!latest || latest.phase === "ABORTED" || latest.phase === "FAILED") return false;

    appendLog(pipelineId, `[Module] "${label}" — attempt ${attempt}/${maxAttempts} (${assignment.vendor}:${assignment.model})`);
    console.log(`[Fleet] ${mod.moduleId} attempt ${attempt}/${maxAttempts} via ${assignment.vendor}:${assignment.model}`);
    try {
      if (assignment.vendor === "codewhale") {
        await buildModuleWithCodeWhale(latest, mod, critique || undefined);
      } else {
        await buildModuleWithClaude(latest, mod, assignment, critique || undefined);
      }
    } catch (buildErr: any) {
      const msg = buildErr.message?.slice(0, 200) ?? "unknown error";
      console.warn(`[Fleet] ${mod.moduleId} builder error:`, msg);
      if (assignment.vendor === "codewhale") {
        appendLog(pipelineId, `[Module] "${label}" — CodeWhale unavailable, falling back to Claude`);
        try {
          await buildModuleWithClaude(latest, mod, { ...assignment, vendor: "claude-code", model: latest.config?.providers?.executor?.model || "claude-haiku-4-5-20251001" }, critique || undefined);
        } catch (e2: any) {
          critique = `Builder failed: ${e2.message}`;
          appendLog(pipelineId, `[Module] "${label}" — builder error (attempt ${attempt}): ${e2.message?.slice(0, 200)}`);
          continue;
        }
      } else {
        critique = `Builder failed: ${msg}`;
        appendLog(pipelineId, `[Module] "${label}" — builder error (attempt ${attempt}): ${msg}`);
        continue;
      }
    }

    const review = await reviewWorkspace(latest, mod);
    if (!review.passed) {
      critique = review.critique;
      appendLog(pipelineId, `[Module] "${label}" — review failed (attempt ${attempt}): ${review.critique.slice(0, 300)}`);
      console.log(`[Fleet] ${mod.moduleId} review found issues (attempt ${attempt})`);
      continue;
    }

    const deps = await ensureDependencies(latest);
    if (!deps.ok) {
      appendLog(pipelineId, `[Module] "${label}" — dependency install failed (attempt ${attempt}), diagnosing…`);
      critique = await diagnoseFailure(latest, mod, "npm install", deps.detail);
      console.log(`[Fleet] ${mod.moduleId} dependency install failed (attempt ${attempt}): ${deps.detail.slice(0, 200)}`);
      continue;
    }

    const clauses = await runExitClauses(latest, mod);
    if (!clauses.passed) {
      critique = clauses.detail;
      appendLog(pipelineId, `[Module] "${label}" — exit clause failed (attempt ${attempt}): ${clauses.detail.slice(0, 200)}`);
      console.log(`[Fleet] ${mod.moduleId} exit clause failed (attempt ${attempt}): ${clauses.detail.slice(0, 200)}`);
      continue;
    }

    await updateModuleStatus(pipelineId, mod.moduleId, "PASSED", attempt);
    appendLog(pipelineId, `[Module] "${label}" — PASSED ✓ (${attempt} attempt${attempt > 1 ? "s" : ""})`);
    console.log(`[Fleet] ${mod.moduleId} PASSED (attempt ${attempt})`);
    return true;
  }

  await updateModuleStatus(pipelineId, mod.moduleId, "FAILED", maxAttempts, critique);
  appendLog(pipelineId, `[Module] "${label}" — FAILED ✗ after ${maxAttempts} attempt${maxAttempts > 1 ? "s" : ""}. Last issue: ${critique.slice(0, 300)}`);
  console.warn(`[Fleet] ${mod.moduleId} FAILED after ${maxAttempts} attempts`);
  return false;
}

async function updateModuleStatus(
  pipelineId: string,
  moduleId: string,
  status: string,
  attempts: number,
  failure?: string
): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state?.board) return;
  const entry = state.board.modules.find((m) => m.moduleId === moduleId);
  if (entry) {
    entry.status = status;
    entry.attempts = attempts;
    if (failure) (entry as any).failure = failure.slice(0, 500);
  }
  state.lastTransitionAt = new Date().toISOString();
  await savePipeline(state);
}

const FLEET_MAX_RETRIES = 3;

/**
 * DAG-parallel dispatch: run every module whose dependencies have PASSED,
 * up to maxConcurrent at a time, until all modules are settled.
 *
 * If every single module fails the fleet retries up to FLEET_MAX_RETRIES times
 * total before giving up. Partial failures (some passed) still proceed to build.
 */
export async function runExecutionBackground(pipelineId: string, _toolsConfirmed = false, fleetAttempt = 1): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  const planModules: PlanModule[] = state.plan?.engineeringPlan?.modules || [];
  if (planModules.length === 0) {
    state.phase = "DB_PROVISIONING_RUNNING";
    pushPhaseHistory(state, "DB_PROVISIONING_RUNNING");
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);
    void runDbProvisioningBackground(pipelineId, false);
    return;
  }

  const maxConcurrent =
    state.agentDesign?.maxConcurrent
    ?? state.config?.providers?.executor?.maxConcurrent
    ?? 4;

  const settled = new Map<string, "PASSED" | "FAILED">();
  const inFlight = new Map<string, Promise<void>>();

  // Resume support: modules already PASSED in the persisted board (from a
  // previous fleet run whose gate was reopened) keep their verdict — the
  // fleet only builds what is not yet done.
  for (const m of planModules) {
    const entry = state.board?.modules.find((b) => b.moduleId === m.moduleId);
    if (entry?.status === "PASSED") settled.set(m.moduleId, "PASSED");
  }
  if (settled.size > 0) {
    console.log(`[Fleet] Resuming: ${settled.size}/${planModules.length} modules already PASSED`);
  }

  const depsOk = (m: PlanModule) => (m.dependsOn || []).every((d) => settled.get(d) === "PASSED");
  const depsFailed = (m: PlanModule) => (m.dependsOn || []).some((d) => settled.get(d) === "FAILED");

  const fleetLabel = fleetAttempt > 1 ? ` (fleet retry ${fleetAttempt}/${FLEET_MAX_RETRIES})` : "";
  console.log(`[Fleet] Dispatching ${planModules.length} modules (maxConcurrent=${maxConcurrent})${fleetLabel}`);
  appendLog(pipelineId, `[Fleet] Dispatching ${planModules.length} modules, maxConcurrent=${maxConcurrent}${fleetLabel}`);

  while (settled.size < planModules.length) {
    const latest = await getPipeline(pipelineId);
    if (!latest || latest.phase === "ABORTED" || latest.phase === "FAILED") return;
    if (latest.phase === "PAUSED") {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    // Modules whose dependencies failed can never run — settle them as FAILED.
    for (const m of planModules) {
      if (!settled.has(m.moduleId) && !inFlight.has(m.moduleId) && depsFailed(m)) {
        settled.set(m.moduleId, "FAILED");
        const failedDeps = (m.dependsOn || []).filter((d) => settled.get(d) === "FAILED");
        const blockedLabel = m.title || m.moduleId;
        appendLog(pipelineId, `[Module] "${blockedLabel}" — BLOCKED (dependency failed: ${failedDeps.join(", ")})`);
        await updateModuleStatus(pipelineId, m.moduleId, "BLOCKED", 0, `Dependency failed: ${failedDeps.join(", ")}`);
      }
    }

    // Dispatch every ready module up to the concurrency limit.
    for (const m of planModules) {
      if (inFlight.size >= maxConcurrent) break;
      if (settled.has(m.moduleId) || inFlight.has(m.moduleId) || !depsOk(m)) continue;

      appendLog(pipelineId, `[Fleet] Dispatching "${m.title || m.moduleId}" (${settled.size}/${planModules.length} settled, ${inFlight.size + 1} in-flight)`);
      await updateModuleStatus(pipelineId, m.moduleId, "EXECUTING", 0);
      const p = runOneModule(pipelineId, m)
        .then((ok) => { settled.set(m.moduleId, ok ? "PASSED" : "FAILED"); })
        .catch(() => { settled.set(m.moduleId, "FAILED"); })
        .finally(() => { inFlight.delete(m.moduleId); });
      inFlight.set(m.moduleId, p);
    }

    if (inFlight.size === 0 && settled.size < planModules.length) {
      // Nothing running and nothing dispatchable → remaining modules are stuck
      // (should be impossible with a validated DAG, but never spin forever).
      for (const m of planModules) {
        if (!settled.has(m.moduleId)) {
          settled.set(m.moduleId, "FAILED");
          await updateModuleStatus(pipelineId, m.moduleId, "BLOCKED", 0, "Unschedulable (dependency deadlock)");
        }
      }
      break;
    }

    if (inFlight.size > 0) {
      await Promise.race(inFlight.values());
    }
  }

  const failures = [...settled.values()].filter((v) => v === "FAILED").length;
  const passed = [...settled.values()].filter((v) => v === "PASSED").length;
  appendLog(pipelineId, `[Fleet] Complete — ${passed} passed, ${failures} failed out of ${planModules.length} modules`);
  const finalState = await getPipeline(pipelineId);
  if (!finalState) return;

  if (failures === planModules.length) {
    if (fleetAttempt < FLEET_MAX_RETRIES) {
      appendLog(
        pipelineId,
        `[Fleet] All ${planModules.length} modules failed on fleet attempt ${fleetAttempt}/${FLEET_MAX_RETRIES} — resetting and retrying entire fleet…`
      );
      // Reset every FAILED/BLOCKED module back to PENDING so the fleet reruns them.
      if (finalState.board) {
        for (const entry of finalState.board.modules) {
          if (entry.status === "FAILED" || entry.status === "BLOCKED") {
            entry.status = "PENDING";
            entry.attempts = 0;
            delete (entry as any).failure;
          }
        }
      }
      finalState.lastTransitionAt = new Date().toISOString();
      await savePipeline(finalState);
      return runExecutionBackground(pipelineId, _toolsConfirmed, fleetAttempt + 1);
    }

    appendLog(
      pipelineId,
      `[Fleet] All ${planModules.length} modules failed on all ${FLEET_MAX_RETRIES} fleet attempts — marking pipeline FAILED.`
    );
    finalState.phase = "FAILED";
    pushPhaseHistory(finalState, "FAILED");
    finalState.error = `Every build module failed after ${FLEET_MAX_RETRIES} full-fleet attempts — nothing was built.`;
    finalState.lastTransitionAt = new Date().toISOString();
    await savePipeline(finalState);
    return;
  }

  await scaffoldMissingInfrastructure(finalState.workspaceDir, finalState.projectName);

  if (finalState.phase === "EXECUTION_RUNNING") {
    finalState.phase = "BUILD_RUNNING";
    pushPhaseHistory(finalState, "BUILD_RUNNING");
    finalState.lastTransitionAt = new Date().toISOString();
    await savePipeline(finalState);
    console.log(`[Fleet] Execution complete (${planModules.length - failures}/${planModules.length} passed). Starting build phase.`);
  }
  void runBuildBackground(pipelineId, false);
}
