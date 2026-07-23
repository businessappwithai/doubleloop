import { NextResponse } from "next/server";
import { getPipeline, savePipeline, type AgentDesign } from "@/lib/orchestrator";

/** GET — current agentDesign (Langflow- or canvas-sourced). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;
  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
  return NextResponse.json({ agentDesign: state.agentDesign ?? null });
}

/** PUT — save the designer canvas's per-module assignments as first-class agentDesign. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;
  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const modules = body?.modules;
  if (!modules || typeof modules !== "object") {
    return NextResponse.json({ error: "Body must include 'modules' (moduleId → {vendor, model})" }, { status: 400 });
  }

  const allowed = ["claude-code", "codewhale", "gemini", "pi"];
  for (const [moduleId, raw] of Object.entries<any>(modules)) {
    if (!raw?.vendor || !allowed.includes(raw.vendor)) {
      return NextResponse.json({ error: `Module ${moduleId}: unknown vendor "${raw?.vendor}"` }, { status: 400 });
    }
    if (!raw?.model || typeof raw.model !== "string") {
      return NextResponse.json({ error: `Module ${moduleId}: model is required` }, { status: 400 });
    }
    // The canvas's legacy "pi" vendor means "pi harness driving CodeWhale".
    if (raw.vendor === "pi") raw.vendor = "codewhale";
  }

  const maxConcurrent = Number(body?.maxConcurrent);
  const agentDesign: AgentDesign = {
    modules,
    ...(Number.isFinite(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 16
      ? { maxConcurrent }
      : {}),
    source: "designer-canvas",
    updatedAt: new Date().toISOString(),
  };

  state.agentDesign = agentDesign;
  state.lastTransitionAt = new Date().toISOString();
  await savePipeline(state);
  return NextResponse.json({ applied: true, agentDesign });
}
