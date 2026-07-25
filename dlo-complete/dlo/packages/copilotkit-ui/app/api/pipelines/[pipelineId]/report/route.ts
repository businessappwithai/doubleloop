import { NextResponse } from "next/server";
import { getPipeline, buildExecutionReport } from "@/lib/pipeline-helper";

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
    return NextResponse.json(buildExecutionReport(state));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
