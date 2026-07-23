import { NextResponse } from "next/server";
import { getPipeline, savePipeline, reviewDocument } from "@/lib/orchestrator";

/** POST — re-run /plan-ceo-review for one design document. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string; doc: string }> }
) {
  const { pipelineId, doc } = await params;
  if (!["architecture", "database", "implementation"].includes(doc)) {
    return NextResponse.json({ error: `Document is not reviewable: ${doc}` }, { status: 400 });
  }
  const key = doc as "architecture" | "database" | "implementation";

  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  try {
    const review = await reviewDocument(state, key);
    const fresh = await getPipeline(pipelineId);
    if (!fresh) return NextResponse.json({ error: "Pipeline vanished during review" }, { status: 500 });
    if (!fresh.reviews) fresh.reviews = {};
    fresh.reviews[key] = review;
    fresh.lastTransitionAt = new Date().toISOString();
    await savePipeline(fresh);
    return NextResponse.json({ key, review });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
