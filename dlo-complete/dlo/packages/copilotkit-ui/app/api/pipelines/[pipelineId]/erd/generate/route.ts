import { NextResponse } from "next/server";
import { generateEmlFromResearch, loadErdPreview } from "@/lib/erd-service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    await generateEmlFromResearch(pipelineId);
    const preview = await loadErdPreview(pipelineId);
    if ("error" in preview) {
      return NextResponse.json({ error: preview.error }, { status: 500 });
    }
    return NextResponse.json(preview);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
