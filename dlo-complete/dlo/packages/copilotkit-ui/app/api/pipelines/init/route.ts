import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { savePipeline, runResearchBackground, runPlanningBackground, runExecutionBackground } from "@/lib/pipeline-helper";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { projectName, objectivesMarkdown, workspaceDir, config } = body;

    if (!projectName || !objectivesMarkdown) {
      return NextResponse.json(
        { error: "Missing required fields: projectName, objectivesMarkdown" },
        { status: 400 }
      );
    }

    const pipelineId = uuidv4();
    const now = new Date().toISOString();

    const pipeline = {
      pipelineId,
      projectName,
      objectivesMarkdown,
      workspaceDir: workspaceDir || process.cwd(),
      config: config || {},
      phase: "RESEARCH_RUNNING",
      createdAt: now,
      lastTransitionAt: now,
    };

    await savePipeline(pipeline);

    runResearchBackground(pipelineId).catch((err) => {
      console.error(`Research phase failed for ${pipelineId}:`, err);
    });

    return NextResponse.json({ pipelineId, phase: "RESEARCH_RUNNING" }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to initialize pipeline" },
      { status: 500 }
    );
  }
}
