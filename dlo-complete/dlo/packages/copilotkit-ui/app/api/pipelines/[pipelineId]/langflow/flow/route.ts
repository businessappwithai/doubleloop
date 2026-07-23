import { NextResponse } from "next/server";
import { getPipeline } from "@/lib/orchestrator";
import {
  exportPipelineAsFlow,
  langflowConfigFrom,
  pushFlowToLangflow,
  checkLangflow,
} from "@/lib/orchestrator/langflow";

/** GET — export the pipeline's agent graph as a Langflow flow JSON. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;
  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  const flow = exportPipelineAsFlow(state);
  const cfg = langflowConfigFrom(state);
  const status = cfg ? await checkLangflow(cfg) : null;
  return NextResponse.json({
    flow,
    langflow: cfg ? { url: cfg.url, ...status } : { url: null, reachable: false, detail: "No Langflow URL configured (config.langflow.url or LANGFLOW_URL). Use the built-in designer canvas instead." },
  });
}

/** POST — push the exported flow to the configured Langflow instance ("Open in Langflow"). */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  const { pipelineId } = await params;
  const state = await getPipeline(pipelineId);
  if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  const cfg = langflowConfigFrom(state);
  if (!cfg) {
    return NextResponse.json(
      { error: "No Langflow URL configured. Set config.langflow.url or LANGFLOW_URL." },
      { status: 400 }
    );
  }

  try {
    const flow = exportPipelineAsFlow(state);
    const { flowId, editorUrl } = await pushFlowToLangflow(cfg, flow);
    return NextResponse.json({ flowId, editorUrl });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
