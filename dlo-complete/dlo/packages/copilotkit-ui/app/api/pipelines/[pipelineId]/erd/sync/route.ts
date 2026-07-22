import { NextResponse } from "next/server";
import { syncErdToDatabase, getErdViewerUrl } from "@/lib/erd-service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const result = await syncErdToDatabase(pipelineId);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const viewerUrl = await getErdViewerUrl(pipelineId);
    return NextResponse.json({ ...result, viewerUrl });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
