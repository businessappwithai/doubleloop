import { NextResponse } from "next/server";
import { listAllPipelines } from "@/lib/pipeline-helper";

export async function GET() {
  try {
    const pipelines = await listAllPipelines();
    return NextResponse.json({
      status: "ok",
      version: "0.1.0",
      pipelinesStored: pipelines.length,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}
