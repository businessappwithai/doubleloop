import { NextResponse } from "next/server";
import {
  findPipelineByGateId,
  savePipeline,
  runResearchBackground,
  runPlanningBackground,
  runExecutionBackground,
  runBuildBackground,
  runDbProvisioningBackground,
  runTestingBackground,
  runDeployBackground,
  runAppLaunchBackground,
  runToolInstallScript,
  pushPhaseHistory,
} from "@/lib/pipeline-helper";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ gateId: string }> }
) {
  try {
    const { gateId } = await params;
    const body = await req.json();
    const { decision, instructions } = body;

    const state = await findPipelineByGateId(gateId);
    if (!state) {
      return NextResponse.json({ error: "Gate not found" }, { status: 404 });
    }

    const gateKind = state.activeGate?.kind;

    // ── TOOL_INSTALL_PERMISSION gate ─────────────────────────────────────────
    if (gateKind === "TOOL_INSTALL_PERMISSION") {
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();

      if (decision === "APPROVE") {
        // Run installer, then continue with execution (tools confirmed)
        await savePipeline(state);
        void (async () => {
          const result = await runToolInstallScript();
          console.log(`[ToolInstall] ${result.success ? "OK" : "FAILED"}: ${result.log.slice(0, 500)}`);
          void runExecutionBackground(state.pipelineId, true);
        })();
      } else if (decision === "USE_CLAUDE") {
        // User chose Claude Haiku as executor — no external tools needed
        if (!state.config) state.config = {};
        if (!state.config.providers) state.config.providers = {};
        state.config.providers.executor = {
          type: "claude",
          model: "claude-haiku-4-5-20251001",
        };
        await savePipeline(state);
        void runExecutionBackground(state.pipelineId, true);
      } else {
        // REJECT — abort pipeline
        state.phase = "FAILED";
        pushPhaseHistory(state, "FAILED");
        await savePipeline(state);
      }
      return NextResponse.json({ accepted: true });
    }

    // ── TERMINAL_PERMISSION gate ─────────────────────────────────────────────
    if (gateKind === "TERMINAL_PERMISSION") {
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();

      if (decision === "APPROVE") {
        await savePipeline(state);

        if (state.phase === "BUILD_RUNNING") {
          void runBuildBackground(state.pipelineId, true);
        } else if (state.phase === "DB_PROVISIONING_RUNNING") {
          void runDbProvisioningBackground(state.pipelineId, true);
        } else if (state.phase === "TESTING_RUNNING") {
          void runTestingBackground(state.pipelineId, true);
        } else if (state.phase === "DEPLOY_RUNNING") {
          void runDeployBackground(state.pipelineId, true);
        } else if (state.phase === "APP_LAUNCH_RUNNING") {
          void runAppLaunchBackground(state.pipelineId, true);
        }
      } else {
        // REJECT — skip this phase and advance
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
        } else if (state.phase === "DEPLOY_RUNNING") {
          state.phase = "COMPLETED";
          pushPhaseHistory(state, "COMPLETED");
          await savePipeline(state);
        } else if (state.phase === "APP_LAUNCH_RUNNING") {
          state.phase = "COMPLETED";
          pushPhaseHistory(state, "COMPLETED");
          await savePipeline(state);
        } else {
          await savePipeline(state);
        }
      }

      return NextResponse.json({ accepted: true });
    }

    // ── Standard HITL gates (DOMAIN_DOCUMENT, TRIPARTITE_PLAN) ──────────────
    if (decision === "APPROVE") {
      if (gateKind === "DOMAIN_DOCUMENT") {
        state.phase = "PLANNING_RUNNING";
        pushPhaseHistory(state, "PLANNING_RUNNING");
        state.activeGate = null;
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        void runPlanningBackground(state.pipelineId);
      } else if (gateKind === "TRIPARTITE_PLAN") {
        state.phase = "EXECUTION_RUNNING";
        pushPhaseHistory(state, "EXECUTION_RUNNING");
        state.activeGate = null;
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        void runExecutionBackground(state.pipelineId);
      }
    } else if (decision === "STEER") {
      if (gateKind === "DOMAIN_DOCUMENT") {
        state.phase = "RESEARCH_RUNNING";
        pushPhaseHistory(state, "RESEARCH_RUNNING");
        state.activeGate = null;
        state.objectivesMarkdown = `${state.objectivesMarkdown}\n\n[Steering Feedback]: ${instructions || ""}`;
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        void runResearchBackground(state.pipelineId);
      } else if (gateKind === "TRIPARTITE_PLAN") {
        state.phase = "PLANNING_RUNNING";
        pushPhaseHistory(state, "PLANNING_RUNNING");
        state.activeGate = null;
        state.objectivesMarkdown = `${state.objectivesMarkdown}\n\n[Steering Feedback]: ${instructions || ""}`;
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        void runPlanningBackground(state.pipelineId);
      }
    } else if (decision === "REJECT") {
      state.phase = "FAILED";
      pushPhaseHistory(state, "FAILED");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
    }

    return NextResponse.json({ accepted: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
