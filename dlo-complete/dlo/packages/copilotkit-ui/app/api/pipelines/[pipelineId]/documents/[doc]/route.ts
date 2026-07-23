import { NextResponse } from "next/server";
import {
  getPipeline,
  savePipeline,
  updateDocument,
  DOC_FILENAMES,
  type DesignDocKey,
} from "@/lib/orchestrator";

const VALID_DOCS: DesignDocKey[] = ["research", "architecture", "database", "implementation"];

function parseDocKey(doc: string): DesignDocKey | null {
  return (VALID_DOCS as string[]).includes(doc) ? (doc as DesignDocKey) : null;
}

/** GET — one document's markdown + its review (if any). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string; doc: string }> }
) {
  const { pipelineId, doc } = await params;
  const key = parseDocKey(doc);
  if (!key) return NextResponse.json({ error: `Unknown document: ${doc}` }, { status: 400 });

  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  const stored = state.designDocs?.[key];
  const markdown = stored?.markdown
    ?? (key === "research" ? state.domainDocument?.markdown : undefined);
  if (markdown === undefined) {
    return NextResponse.json({ error: `Document not generated yet: ${key}` }, { status: 404 });
  }

  const review = key === "research" ? null : state.reviews?.[key] ?? null;
  return NextResponse.json({
    key,
    filename: DOC_FILENAMES[key],
    markdown,
    version: stored?.version ?? 1,
    updatedAt: stored?.updatedAt ?? null,
    approvedAt: stored?.approvedAt ?? null,
    review,
  });
}

/** PUT — save an edited document (Gate-1 modify / Gate-2 enhancement edits). */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string; doc: string }> }
) {
  const { pipelineId, doc } = await params;
  const key = parseDocKey(doc);
  if (!key) return NextResponse.json({ error: `Unknown document: ${doc}` }, { status: 400 });

  const body = await req.json();
  const markdown = body?.markdown;
  if (typeof markdown !== "string" || !markdown.trim()) {
    return NextResponse.json({ error: "Body must include non-empty 'markdown'" }, { status: 400 });
  }

  try {
    const state = await updateDocument(pipelineId, key, markdown);
    const stored = state.designDocs?.[key];
    return NextResponse.json({
      key,
      version: stored?.version,
      updatedAt: stored?.updatedAt,
      approvedAt: stored?.approvedAt ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** PATCH — update a review suggestion's status (applied / dismissed / open). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string; doc: string }> }
) {
  const { pipelineId, doc } = await params;
  const key = parseDocKey(doc);
  if (!key || key === "research") {
    return NextResponse.json({ error: `Document has no review: ${doc}` }, { status: 400 });
  }

  const body = await req.json();
  const { suggestionId, status } = body || {};
  if (!suggestionId || !["open", "applied", "dismissed"].includes(status)) {
    return NextResponse.json(
      { error: "Body must include suggestionId and status (open|applied|dismissed)" },
      { status: 400 }
    );
  }

  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
  const review = state.reviews?.[key];
  const suggestion = review?.suggestions.find((s) => s.id === suggestionId);
  if (!suggestion) return NextResponse.json({ error: `Suggestion not found: ${suggestionId}` }, { status: 404 });

  suggestion.status = status;
  state.lastTransitionAt = new Date().toISOString();
  await savePipeline(state);
  return NextResponse.json({ key, suggestionId, status });
}
