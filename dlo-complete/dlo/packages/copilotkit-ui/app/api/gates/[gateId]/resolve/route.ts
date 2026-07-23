import { NextResponse } from "next/server";
import { resolveGateDecision } from "@/lib/orchestrator";

/**
 * Gate resolution endpoint — a thin dispatcher; all transition logic lives in
 * the central orchestrator (resolveGateDecision).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ gateId: string }> }
) {
  try {
    const { gateId } = await params;
    const body = await req.json();
    const result = await resolveGateDecision({
      gateId,
      decision: body.decision,
      instructions: body.instructions,
      reason: body.reason,
    });

    if (!result.accepted) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 400 });
    }
    return NextResponse.json({ accepted: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
