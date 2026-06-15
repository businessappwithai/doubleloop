import { NextResponse } from "next/server";
import { getPipeline, savePipeline } from "@/lib/pipeline-helper";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const { note } = await req.json();
    if (!note?.trim()) {
      return NextResponse.json({ error: "Note is required" }, { status: 400 });
    }
    const state = await getPipeline(pipelineId);
    if (!state) {
      return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    }
    if (!state.contextNotes) state.contextNotes = [];
    state.contextNotes.push({ note: note.trim(), timestamp: new Date().toISOString() });
    await savePipeline(state);
    return NextResponse.json({ accepted: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
