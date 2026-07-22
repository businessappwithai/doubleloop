import { NextResponse } from "next/server";
import { applyDestructiveStatements, getErdViewerUrl } from "@/lib/erd-service";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const { statements } = await req.json();
    if (!Array.isArray(statements) || statements.length === 0) {
      return NextResponse.json({ error: "statements[] is required" }, { status: 400 });
    }
    const result = await applyDestructiveStatements(pipelineId, statements);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const viewerUrl = await getErdViewerUrl(pipelineId);
    return NextResponse.json({ ...result, viewerUrl });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
