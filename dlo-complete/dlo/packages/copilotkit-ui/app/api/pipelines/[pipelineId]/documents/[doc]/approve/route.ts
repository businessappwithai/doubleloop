import { NextResponse } from "next/server";
import { approveDocument } from "@/lib/orchestrator";

/** POST — mark one design document approved (Gate 2 requires all three). */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string; doc: string }> }
) {
  const { pipelineId, doc } = await params;
  if (!["architecture", "database", "implementation"].includes(doc)) {
    return NextResponse.json({ error: `Document is not approvable: ${doc}` }, { status: 400 });
  }

  try {
    const state = await approveDocument(pipelineId, doc as "architecture" | "database" | "implementation");
    const approved = (["architecture", "database", "implementation"] as const)
      .filter((k) => state.designDocs?.[k]?.approvedAt);
    return NextResponse.json({
      key: doc,
      approvedAt: state.designDocs?.[doc as "architecture"]?.approvedAt,
      allApproved: approved.length === 3,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
