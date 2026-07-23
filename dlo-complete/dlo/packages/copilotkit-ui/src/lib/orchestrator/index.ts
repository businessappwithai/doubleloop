/**
 * orchestrator/index.ts
 * The CENTRAL ORCHESTRATOR: owns every phase transition and gate resolution.
 * Phase modules do the work; nothing else moves the pipeline between phases.
 *
 *   research → gate1 → design → ceo-review → gate2 → execution(fleet)
 *            → build → db → test → deploy → completed
 */

import {
  type PipelineState,
  getPipeline,
  savePipeline,
  saveDesignDoc,
  findPipelineByGateId,
  pushPhaseHistory,
} from "./state";
import { runResearchBackground } from "./phases/research";
import { runDesignBackground } from "./phases/design";
import { runExecutionBackground } from "./phases/build";
import {
  runBuildBackground,
  runDbProvisioningBackground,
  runTestingBackground,
  runDeployBackground,
  runAppLaunchBackground,
  runToolInstallScript,
} from "./phases/finalize";

// Re-export the whole orchestrator surface.
export * from "./state";
export { runResearchBackground } from "./phases/research";
export { runDesignBackground, parseImplementationPlan, validatePlanDag } from "./phases/design";
export { runCeoReviewBackground, reviewDocument, parseSuggestions } from "./phases/review";
export { runExecutionBackground } from "./phases/build";
export {
  runBuildBackground,
  runDbProvisioningBackground,
  runTestingBackground,
  runDeployBackground,
  runAppLaunchBackground,
  runToolInstallScript,
  scaffoldMissingInfrastructure,
  detectDatabaseNeeded,
  detectTestCommand,
  detectLaunchCommand,
  detectBuildCommand,
} from "./phases/finalize";
export { spawnClaude, spawnClaudeAgent, claudeAuthFromConfig, checkClaudeCli } from "./subagents/claude";
export { generateWithGemini, friendlyGeminiError } from "./subagents/gemini";
export { getSubagentRunner } from "./subagents/pi";

/**
 * Legacy alias: pipelines created before the Design Analyst existed called
 * runPlanningBackground on Gate-1 approval. New pipelines run the Design
 * Analyst; the alias keeps old imports working.
 */
export async function runPlanningBackground(pipelineId: string): Promise<void> {
  return runDesignBackground(pipelineId);
}

// ─── Gate resolution (the ONLY place gates advance the pipeline) ─────────────

export interface GateDecisionInput {
  gateId: string;
  decision: string; // APPROVE | STEER | REJECT | USE_CLAUDE
  instructions?: string;
  reason?: string;
}

export interface GateDecisionResult {
  accepted: boolean;
  error?: string;
  status?: number;
}

export async function resolveGateDecision(input: GateDecisionInput): Promise<GateDecisionResult> {
  const state = await findPipelineByGateId(input.gateId);
  if (!state) return { accepted: false, error: "Gate not found", status: 404 };

  const gateKind = state.activeGate?.kind;
  const { decision, instructions } = input;

  // ── TOOL_INSTALL_PERMISSION (CodeWhale executor path) ─────────────────────
  if (gateKind === "TOOL_INSTALL_PERMISSION") {
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();

    if (decision === "APPROVE") {
      await savePipeline(state);
      void (async () => {
        const result = await runToolInstallScript();
        console.log(`[ToolInstall] ${result.success ? "OK" : "FAILED"}: ${result.log.slice(0, 500)}`);
        void runExecutionBackground(state.pipelineId, true);
      })();
    } else if (decision === "USE_CLAUDE") {
      if (!state.config) state.config = {};
      if (!state.config.providers) state.config.providers = {};
      state.config.providers.executor = {
        type: "claude",
        vendor: "claude-code",
        model: "claude-haiku-4-5-20251001",
      };
      await savePipeline(state);
      void runExecutionBackground(state.pipelineId, true);
    } else {
      state.phase = "FAILED";
      pushPhaseHistory(state, "FAILED");
      await savePipeline(state);
    }
    return { accepted: true };
  }

  // ── TERMINAL_PERMISSION (build / db / test / deploy) ──────────────────────
  if (gateKind === "TERMINAL_PERMISSION") {
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();

    if (decision === "APPROVE") {
      await savePipeline(state);
      if (state.phase === "BUILD_RUNNING") void runBuildBackground(state.pipelineId, true);
      else if (state.phase === "DB_PROVISIONING_RUNNING") void runDbProvisioningBackground(state.pipelineId, true);
      else if (state.phase === "TESTING_RUNNING") void runTestingBackground(state.pipelineId, true);
      else if (state.phase === "DEPLOY_RUNNING") void runDeployBackground(state.pipelineId, true);
      else if (state.phase === "APP_LAUNCH_RUNNING") void runAppLaunchBackground(state.pipelineId, true);
    } else {
      // REJECT — skip this step and advance.
      if (state.phase === "BUILD_RUNNING") {
        state.phase = "DB_PROVISIONING_RUNNING";
        pushPhaseHistory(state, "DB_PROVISIONING_RUNNING");
        await savePipeline(state);
        void runDbProvisioningBackground(state.pipelineId, false);
      } else if (state.phase === "DB_PROVISIONING_RUNNING") {
        state.phase = "TESTING_RUNNING";
        pushPhaseHistory(state, "TESTING_RUNNING");
        await savePipeline(state);
        void runTestingBackground(state.pipelineId, false);
      } else if (state.phase === "TESTING_RUNNING") {
        state.phase = "DEPLOY_RUNNING";
        pushPhaseHistory(state, "DEPLOY_RUNNING");
        await savePipeline(state);
        void runDeployBackground(state.pipelineId, false);
      } else if (state.phase === "DEPLOY_RUNNING" || state.phase === "APP_LAUNCH_RUNNING") {
        state.phase = "COMPLETED";
        pushPhaseHistory(state, "COMPLETED");
        await savePipeline(state);
      } else {
        await savePipeline(state);
      }
    }
    return { accepted: true };
  }

  // ── Gate 1: DOMAIN_DOCUMENT ────────────────────────────────────────────────
  if (gateKind === "DOMAIN_DOCUMENT") {
    if (decision === "APPROVE") {
      state.phase = "DESIGN_RUNNING";
      pushPhaseHistory(state, "DESIGN_RUNNING");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runDesignBackground(state.pipelineId);
    } else if (decision === "STEER") {
      // "Research further" with additional inputs.
      state.phase = "RESEARCH_RUNNING";
      pushPhaseHistory(state, "RESEARCH_RUNNING");
      state.activeGate = null;
      if (!state.contextNotes) state.contextNotes = [];
      if (instructions) {
        state.contextNotes.push({ note: `[ResearchInput] ${instructions}`, timestamp: new Date().toISOString() });
      }
      state.objectivesMarkdown = `${state.objectivesMarkdown}\n\n[Additional research input]: ${instructions || ""}`;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runResearchBackground(state.pipelineId);
    } else if (decision === "REJECT") {
      state.phase = "FAILED";
      pushPhaseHistory(state, "FAILED");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
    }
    return { accepted: true };
  }

  // ── Gate 2 (new): DESIGN_REVIEW over the three documents ─────────────────
  if (gateKind === "DESIGN_REVIEW") {
    if (decision === "APPROVE") {
      // Approve-all shortcut: mark every design doc approved, then build.
      const now = new Date().toISOString();
      for (const key of ["architecture", "database", "implementation"] as const) {
        const doc = state.designDocs?.[key];
        if (doc && !doc.approvedAt) doc.approvedAt = now;
      }
      // Re-parse the (possibly edited) Implementation.md so the fleet builds
      // exactly what the user approved.
      try {
        const { parseImplementationPlan, validatePlanDag } = await import("./phases/design");
        const implMd = state.designDocs?.implementation?.markdown;
        if (implMd) {
          const plan = parseImplementationPlan(implMd);
          const errors = validatePlanDag(plan);
          if (errors.length) {
            return { accepted: false, error: `Implementation.md plan invalid: ${errors.join(" | ")}`, status: 400 };
          }
          state.plan = {
            ceoPlan: state.plan?.ceoPlan || "",
            architecturePlan: state.designDocs?.architecture?.markdown || state.plan?.architecturePlan || "",
            engineeringPlan: plan,
          };
          // Preserve PASSED verdicts from a previous fleet run so approval
          // after a partial failure resumes instead of rebuilding everything.
          state.board = {
            modules: (plan.modules || []).map((m: any) => {
              const prev = state.board?.modules.find((b) => b.moduleId === m.moduleId);
              return prev?.status === "PASSED"
                ? prev
                : { moduleId: m.moduleId, status: "PENDING", attempts: 0, ...(prev && (prev as any).failure ? { failure: (prev as any).failure } : {}) };
            }),
          };
        }
      } catch (e: any) {
        return { accepted: false, error: `Implementation plan re-parse failed: ${e.message}`, status: 400 };
      }

      state.phase = "EXECUTION_RUNNING";
      pushPhaseHistory(state, "EXECUTION_RUNNING");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runExecutionBackground(state.pipelineId);
    } else if (decision === "STEER") {
      // Regenerate the design documents with the new instructions.
      state.phase = "DESIGN_RUNNING";
      pushPhaseHistory(state, "DESIGN_RUNNING");
      state.activeGate = null;
      if (!state.contextNotes) state.contextNotes = [];
      if (instructions) {
        state.contextNotes.push({ note: `[DesignSteering] ${instructions}`, timestamp: new Date().toISOString() });
      }
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runDesignBackground(state.pipelineId);
    } else if (decision === "REJECT") {
      state.phase = "FAILED";
      pushPhaseHistory(state, "FAILED");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
    }
    return { accepted: true };
  }

  // ── Legacy Gate 2: TRIPARTITE_PLAN (old pipelines) ────────────────────────
  if (gateKind === "TRIPARTITE_PLAN") {
    if (decision === "APPROVE") {
      state.phase = "EXECUTION_RUNNING";
      pushPhaseHistory(state, "EXECUTION_RUNNING");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runExecutionBackground(state.pipelineId);
    } else if (decision === "STEER") {
      state.phase = "DESIGN_RUNNING";
      pushPhaseHistory(state, "DESIGN_RUNNING");
      state.activeGate = null;
      state.objectivesMarkdown = `${state.objectivesMarkdown}\n\n[Steering Feedback]: ${instructions || ""}`;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runDesignBackground(state.pipelineId);
    } else if (decision === "REJECT") {
      state.phase = "FAILED";
      pushPhaseHistory(state, "FAILED");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
    }
    return { accepted: true };
  }

  return { accepted: false, error: `Unknown gate kind: ${gateKind}`, status: 400 };
}

// ─── Document editing (Gate-1 "modify" + /documents page) ────────────────────

export async function updateDocument(
  pipelineId: string,
  key: "research" | "architecture" | "database" | "implementation",
  markdown: string
): Promise<PipelineState> {
  const state = await getPipeline(pipelineId);
  if (!state) throw new Error(`Pipeline not found: ${pipelineId}`);
  await saveDesignDoc(state, key, markdown);
  // Edits to an approved doc reopen it for approval.
  const doc = state.designDocs?.[key];
  if (doc?.approvedAt) delete doc.approvedAt;
  // Keep Gate-1 exhibit in sync so approval approves what the user sees.
  if (key === "research" && state.activeGate?.kind === "DOMAIN_DOCUMENT") {
    state.activeGate.exhibits = [markdown];
  }
  state.lastTransitionAt = new Date().toISOString();
  await savePipeline(state);
  return state;
}

export async function approveDocument(
  pipelineId: string,
  key: "architecture" | "database" | "implementation"
): Promise<PipelineState> {
  const state = await getPipeline(pipelineId);
  if (!state) throw new Error(`Pipeline not found: ${pipelineId}`);
  const doc = state.designDocs?.[key];
  if (!doc) throw new Error(`Document not generated yet: ${key}`);
  doc.approvedAt = new Date().toISOString();
  state.lastTransitionAt = new Date().toISOString();
  await savePipeline(state);
  return state;
}
