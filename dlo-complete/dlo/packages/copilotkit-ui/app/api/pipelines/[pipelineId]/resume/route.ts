import { NextResponse } from "next/server";
import {
  getPipeline,
  savePipeline,
  pushPhaseHistory,
} from "@/lib/pipeline-helper";
import {
  runResearchBackground,
  runDesignBackground,
  runCeoReviewBackground,
  runExecutionBackground,
  runBuildBackground,
  runDbProvisioningBackground,
  runTestingBackground,
  runDeployBackground,
  runAppLaunchBackground,
} from "@/lib/orchestrator";

const RUNNING_PHASES = new Set([
  "RESEARCH_RUNNING",
  "DESIGN_RUNNING",
  "CEO_REVIEW_RUNNING",
  "EXECUTION_RUNNING",
  "BUILD_RUNNING",
  "DB_PROVISIONING_RUNNING",
  "TESTING_RUNNING",
  "DEPLOY_RUNNING",
  "APP_LAUNCH_RUNNING",
  // Legacy phase names from earlier versions
  "PLANNING_RUNNING",
]);

/** Map legacy or aliased phase names to their current handler. */
const PHASE_ALIAS: Record<string, string> = {
  PLANNING_RUNNING: "DESIGN_RUNNING",
};

/**
 * POST /api/pipelines/[pipelineId]/resume
 *
 * Body (all optional):
 *   { "action": "retry" | "skip" }
 *
 * "retry" (default): restarts the background process for the current running phase.
 * "skip":  for CEO_REVIEW_RUNNING only — advances directly to GATE2_PENDING
 *          without running the CEO review (useful when Claude CLI is unavailable).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const state = await getPipeline(pipelineId);
    if (!state) {
      return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const action: "retry" | "skip" = body?.action === "skip" ? "skip" : "retry";

    // ── Skip CEO review ───────────────────────────────────────────────────
    if (action === "skip" && state.phase === "CEO_REVIEW_RUNNING") {
      state.phase = "GATE2_PENDING";
      pushPhaseHistory(state, "GATE2_PENDING");
      state.lastTransitionAt = new Date().toISOString();
      state.activeGate = {
        gateId: `gate-${crypto.randomUUID()}`,
        kind: "DESIGN_REVIEW",
        exhibits: [
          state.designDocs?.architecture?.markdown ?? "",
          state.designDocs?.database?.markdown ?? "",
          state.designDocs?.implementation?.markdown ?? "",
        ],
        context: { reviewFailures: ["CEO review skipped by user"] },
      };
      await savePipeline(state);
      return NextResponse.json({ success: true, advanced: "GATE2_PENDING" });
    }

    // ── Handle legacy PAUSED → EXECUTION_RUNNING ──────────────────────────
    if (state.phase === "PAUSED") {
      state.phase = "EXECUTION_RUNNING";
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runExecutionBackground(pipelineId);
      return NextResponse.json({ success: true, restarted: "EXECUTION_RUNNING" });
    }

    // ── Restart from FAILED: find the last running phase and re-enter it ──
    if (state.phase === "FAILED" || state.phase === "ABORTED") {
      const history: Array<{ phase: string }> = (state as any).phaseHistory || [];
      const lastRunning = [...history].reverse().find((h) => RUNNING_PHASES.has(h.phase))?.phase;
      if (!lastRunning) {
        return NextResponse.json(
          { error: "Cannot resume: no previous running phase found in history" },
          { status: 400 }
        );
      }
      delete state.error;
      state.phase = lastRunning as typeof state.phase;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
    }

    // ── Restart stuck running phases ──────────────────────────────────────
    if (!RUNNING_PHASES.has(state.phase)) {
      return NextResponse.json(
        { error: `Phase ${state.phase} cannot be resumed (not a running phase)` },
        { status: 400 }
      );
    }

    // Clear any stale error before restarting
    delete state.error;
    // Resolve legacy phase aliases before dispatching.
    const targetPhase = PHASE_ALIAS[state.phase] ?? state.phase;
    state.phase = targetPhase as typeof state.phase;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);

    switch (targetPhase) {
      case "RESEARCH_RUNNING":
        void runResearchBackground(pipelineId);
        break;
      case "DESIGN_RUNNING":
        void runDesignBackground(pipelineId);
        break;
      case "CEO_REVIEW_RUNNING":
        void runCeoReviewBackground(pipelineId);
        break;
      case "EXECUTION_RUNNING":
        void runExecutionBackground(pipelineId);
        break;
      case "BUILD_RUNNING":
        void runBuildBackground(pipelineId, true);
        break;
      case "DB_PROVISIONING_RUNNING":
        void runDbProvisioningBackground(pipelineId, true);
        break;
      case "TESTING_RUNNING":
        void runTestingBackground(pipelineId, true);
        break;
      case "DEPLOY_RUNNING":
        void runDeployBackground(pipelineId, true);
        break;
      case "APP_LAUNCH_RUNNING":
        void runAppLaunchBackground(pipelineId, true);
        break;
      default:
        return NextResponse.json(
          { error: `No restart handler for phase: ${state.phase}` },
          { status: 400 }
        );
    }

    return NextResponse.json({ success: true, restarted: state.phase });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
