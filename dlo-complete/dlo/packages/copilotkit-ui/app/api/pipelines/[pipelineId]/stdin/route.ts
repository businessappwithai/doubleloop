import { NextResponse } from "next/server";
import { hasProcess, sendStdin } from "@/lib/orchestrator/processRegistry";

/**
 * POST /api/pipelines/[pipelineId]/stdin
 * Body: { "text": "..." }
 *
 * Writes the text to the running subprocess's stdin — e.g. to answer
 * a Claude Code permission prompt or provide requested input mid-run.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;

  if (!hasProcess(pipelineId)) {
    return NextResponse.json(
      { error: "No running subprocess for this pipeline — it may have already finished or not started yet." },
      { status: 404 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const text: string = body?.text ?? "";

  const sent = sendStdin(pipelineId, text);
  if (!sent) {
    return NextResponse.json(
      { error: "Subprocess exists but stdin is not writable." },
      { status: 500 }
    );
  }

  return NextResponse.json({ sent: true, text });
}

/** GET — check if a subprocess is currently running (stdin is open). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;
  return NextResponse.json({ running: hasProcess(pipelineId) });
}
