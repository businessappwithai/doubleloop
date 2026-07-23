import { NextResponse } from "next/server";
import { getPipeline, DOC_FILENAMES, type DesignDocKey } from "@/lib/orchestrator";

/** GET — list documents with statuses and review summaries. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;
  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  const keys: DesignDocKey[] = ["research", "architecture", "database", "implementation"];
  const documents = keys.map((key) => {
    const doc = state.designDocs?.[key];
    const review = key === "research" ? undefined : state.reviews?.[key];
    return {
      key,
      filename: DOC_FILENAMES[key],
      exists: !!doc || (key === "research" && !!state.domainDocument),
      version: doc?.version ?? (doc ? 1 : 0),
      updatedAt: doc?.updatedAt ?? null,
      approvedAt: doc?.approvedAt ?? null,
      review: review
        ? {
            reviewer: review.reviewer,
            reviewedAt: review.reviewedAt,
            openSuggestions: review.suggestions.filter((s) => s.status === "open").length,
            totalSuggestions: review.suggestions.length,
          }
        : null,
    };
  });

  return NextResponse.json({ pipelineId, phase: state.phase, documents });
}
