import { NextResponse } from "next/server";
import { savePipeline, runResearchBackground } from "@/lib/pipeline-helper";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectName, objectivesMarkdown, workspaceDir, config } = body;

    const pipelineId = `pipe-${crypto.randomUUID()}`;
    const state = {
      pipelineId,
      projectName,
      objectivesMarkdown,
      workspaceDir,
      config,
      phase: "RESEARCH_RUNNING",
      createdAt: new Date().toISOString(),
      lastTransitionAt: new Date().toISOString(),
      budget: {
        spent: { usd: 0, tokens: 0, wallClockMs: 0 },
        remaining: { usd: config?.budgets?.usd || 100, tokens: config?.budgets?.tokens || 10000000, wallClockMs: config?.budgets?.wallClockMs || 3600000 }
      }
    };

    await savePipeline(state);
    
    // Trigger research in background
    void runResearchBackground(pipelineId);

    return NextResponse.json({ pipelineId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
