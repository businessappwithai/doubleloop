import { NextResponse } from "next/server";
import { getPipeline } from "@/lib/pipeline-helper";

export async function GET(
  request: Request,
  { params }: { params: { pipelineId: string } }
) {
  try {
    const { pipelineId } = params;

    if (!pipelineId) {
      return NextResponse.json(
        { error: "Missing pipeline ID" },
        { status: 400 }
      );
    }

    const pipeline = await getPipeline(pipelineId);

    if (!pipeline) {
      return NextResponse.json(
        { error: "Pipeline not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(pipeline);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to get pipeline status" },
      { status: 500 }
    );
  }
}
