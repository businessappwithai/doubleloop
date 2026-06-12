import { NextResponse } from "next/server";
import { getPipeline, savePipeline } from "@/lib/pipeline-helper";

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
    if (state.phase === "PAUSED") {
      state.phase = "EXECUTION_RUNNING";
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
