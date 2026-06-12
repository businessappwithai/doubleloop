import { NextResponse } from "next/server";
import { 
  findPipelineByGateId, 
  savePipeline, 
  runResearchBackground, 
  runPlanningBackground, 
  runExecutionBackground 
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

    if (decision === "APPROVE") {
      if (state.activeGate?.kind === "DOMAIN_DOCUMENT") {
        state.phase = "PLANNING_RUNNING";
        state.activeGate = null;
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        // Kick off planning in background
        void runPlanningBackground(state.pipelineId);
      } else if (state.activeGate?.kind === "TRIPARTITE_PLAN") {
        state.phase = "EXECUTION_RUNNING";
        state.activeGate = null;
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        // Kick off execution in background
        void runExecutionBackground(state.pipelineId);
      }
    } else if (decision === "STEER") {
      if (state.activeGate?.kind === "DOMAIN_DOCUMENT") {
        state.phase = "RESEARCH_RUNNING";
        state.activeGate = null;
        state.objectivesMarkdown = `${state.objectivesMarkdown}\n\n[Steering Feedback]: ${instructions || ""}`;
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        void runResearchBackground(state.pipelineId);
      } else if (state.activeGate?.kind === "TRIPARTITE_PLAN") {
        state.phase = "PLANNING_RUNNING";
        state.activeGate = null;
        state.objectivesMarkdown = `${state.objectivesMarkdown}\n\n[Steering Feedback]: ${instructions || ""}`;
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        void runPlanningBackground(state.pipelineId);
      }
    } else if (decision === "REJECT") {
      state.phase = "FAILED";
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
    }

    return NextResponse.json({ accepted: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
