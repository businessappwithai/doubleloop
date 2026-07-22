import { NextResponse } from "next/server";
import { buildLiamViewer, getErdViewerUrl, loadErdPreview } from "@/lib/erd-service";

/** Returns the already-built static viewer URL for this pipeline, if any. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const url = await getErdViewerUrl(pipelineId);
    return NextResponse.json({ url });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** (Re)builds the static Liam viewer from the current EML file, without touching the database. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const preview = await loadErdPreview(pipelineId);
    if ("error" in preview) {
      return NextResponse.json({ error: preview.error }, { status: 404 });
    }
    const { url } = await buildLiamViewer(pipelineId, preview.liamSchema);
    return NextResponse.json({ url });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
