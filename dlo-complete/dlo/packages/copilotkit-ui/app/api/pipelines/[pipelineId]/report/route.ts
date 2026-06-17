import { NextResponse } from "next/server";
import { getPipeline } from "@/lib/pipeline-helper";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const state = await getPipeline(pipelineId);
    if (!state) {
      return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    }
    const modulesCompleted = state.board?.modules?.filter(m => m.status === "PASSED")?.length || 0;
    const totalAttempts = state.board?.modules?.reduce((acc, m) => acc + m.attempts, 0) || 0;
    const wallClockSeconds = Math.floor((new Date(state.lastTransitionAt).getTime() - new Date(state.createdAt).getTime()) / 1000) || 0;
    const costUsd = state.budget?.spent?.usd ?? null;
    const summary =
      state.phase === "COMPLETED"
        ? `Completed execution pipeline for ${state.projectName}. ${modulesCompleted} module(s) generated and validated across ${totalAttempts} attempt(s).`
        : state.phase === "FAILED"
          ? `Execution pipeline for ${state.projectName} failed. ${modulesCompleted} module(s) passed before failure.`
          : state.phase === "ABORTED"
            ? `Execution pipeline for ${state.projectName} was aborted.`
            : `Execution pipeline for ${state.projectName} is in phase ${state.phase}.`;
    const report = {
      title: `${state.projectName} Execution Report`,
      summary,
      modulesCompleted,
      totalAttempts,
      costUsd,
      wallClockSeconds,
      commits: [] as Array<{ hash: string; message: string }>,
      details: {}
    };
    return NextResponse.json(report);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
