import { NextResponse } from "next/server";
import { listAllPipelines, ensureRecovered } from "@/lib/pipeline-helper";

export async function GET() {
  try {
    // First touch of the pipeline API in this process resumes anything a
    // previous process left mid-flight (see orchestrator/recovery.ts).
    await ensureRecovered();
    const list = await listAllPipelines();
    const pipelines = list.map((p) => ({
      pipelineId: p.pipelineId,
      projectName: p.projectName,
      phase: p.phase,
      createdAt: p.createdAt,
      status: ["COMPLETED"].includes(p.phase) 
        ? "completed" 
        : ["FAILED"].includes(p.phase)
        ? "failed"
        : ["ABORTED"].includes(p.phase)
        ? "failed"
        : "running"
    }));
    return NextResponse.json({ pipelines });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
