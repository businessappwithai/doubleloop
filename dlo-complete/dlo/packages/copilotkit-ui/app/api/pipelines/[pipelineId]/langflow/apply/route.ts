import { NextResponse } from "next/server";
import { getPipeline, savePipeline } from "@/lib/orchestrator";
import {
  langflowConfigFrom,
  fetchFlowFromLangflow,
  parseFlowIntoAgentDesign,
} from "@/lib/orchestrator/langflow";

/**
 * POST — apply a Langflow flow as the pipeline's agentDesign.
 * Body: { flowId } to pull from the configured Langflow instance,
 *   or  { flow }   to apply an exported/edited flow JSON directly.
 * The stored agentDesign is honored by the build fleet per module.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;
  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  let flow = body?.flow;
  const flowId: string | undefined = body?.flowId;

  try {
    if (!flow && flowId) {
      const cfg = langflowConfigFrom(state);
      if (!cfg) {
        return NextResponse.json(
          { error: "flowId given but no Langflow URL configured (config.langflow.url or LANGFLOW_URL)." },
          { status: 400 }
        );
      }
      flow = await fetchFlowFromLangflow(cfg, flowId);
    }
    if (!flow) {
      return NextResponse.json({ error: "Body must include 'flowId' or 'flow'." }, { status: 400 });
    }

    const { agentDesign, warnings } = parseFlowIntoAgentDesign(flow, flowId);

    // Validate module ids against the current engineering plan.
    const planIds = new Set<string>(
      (state.plan?.engineeringPlan?.modules || []).map((m: any) => String(m.moduleId))
    );
    const unknown = Object.keys(agentDesign.modules).filter((id) => planIds.size > 0 && !planIds.has(id));
    if (unknown.length) {
      return NextResponse.json(
        { error: `Flow references unknown module ids: ${unknown.join(", ")}` },
        { status: 400 }
      );
    }

    state.agentDesign = agentDesign;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);
    return NextResponse.json({ applied: true, agentDesign, warnings });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
