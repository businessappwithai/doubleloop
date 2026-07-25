import { NextResponse } from "next/server";
import { getPipeline, savePipeline } from "@/lib/pipeline-helper";
import { killProcesses } from "@/lib/orchestrator/processRegistry";
import { appendLog } from "@/lib/orchestrator/logStore";

/**
 * POST /api/pipelines/[pipelineId]/abort
 *
 * Flipping the phase is not enough on its own: the phase loops only notice
 * ABORTED between steps, so an in-flight `claude` subagent would keep running
 * for its full timeout (up to 20 minutes for a build module) and keep writing
 * into the workspace after the user aborted. The registered children are
 * signalled here so abort stops work rather than just relabelling it.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const state = await getPipeline(pipelineId);
    if (!state) {
      return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    }
    state.phase = "ABORTED";
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);

    const killed = killProcesses(pipelineId);
    appendLog(
      pipelineId,
      `[Abort] Pipeline aborted by the user — ${killed} running subagent${killed === 1 ? "" : "s"} terminated.`
    );
    return NextResponse.json({ success: true, killedProcesses: killed });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
