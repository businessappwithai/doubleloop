import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { savePipeline, runResearchBackground, writeWorkspaceMarkdown } from "@/lib/pipeline-helper";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { projectName, objectivesMarkdown, workspaceDir, config, researchMarkdown } = body;

    if (!projectName || !objectivesMarkdown) {
      return NextResponse.json(
        { error: "Missing required fields: projectName, objectivesMarkdown" },
        { status: 400 }
      );
    }

    const pipelineId = uuidv4();
    const now = new Date().toISOString();

    // Each pipeline gets its own workspace named by project slug + short ID
    const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const shortId = pipelineId.slice(0, 8);
    const resolvedWorkspaceDir = workspaceDir && workspaceDir.trim()
      ? workspaceDir.trim()
      : join(process.cwd(), "workspaces", `${slug}-${shortId}`);
    try { mkdirSync(resolvedWorkspaceDir, { recursive: true }); } catch { /* ignore */ }

    const hasManualResearch = typeof researchMarkdown === "string" && researchMarkdown.trim().length > 0;

    const initialPhase = hasManualResearch ? "GATE1_PENDING" : "RESEARCH_RUNNING";
    const pipeline: Record<string, unknown> = {
      pipelineId,
      projectName,
      objectivesMarkdown,
      workspaceDir: resolvedWorkspaceDir,
      config: config || {},
      phase: initialPhase,
      createdAt: now,
      lastTransitionAt: now,
      phaseHistory: [{ phase: initialPhase, timestamp: now }],
      contextNotes: [],
    };

    if (hasManualResearch) {
      const gateId = uuidv4();
      pipeline.domainDocument = {
        markdown: researchMarkdown,
        citations: [{ url: "manual-input", title: "User-Provided Research" }],
      };
      pipeline.activeGate = {
        gateId,
        kind: "DOMAIN_DOCUMENT",
        exhibits: [researchMarkdown],
      };
    }

    await savePipeline(pipeline as any);

    if (hasManualResearch) {
      // Write DOMAIN.md immediately for manual-research path
      await writeWorkspaceMarkdown(
        resolvedWorkspaceDir,
        "DOMAIN.md",
        `# Domain Document — ${projectName}\n\n> Source: User-provided research\n> Created: ${now}\n\n${researchMarkdown}`
      );
    } else {
      runResearchBackground(pipelineId).catch((err) => {
        console.error(`Research phase failed for ${pipelineId}:`, err);
      });
    }

    return NextResponse.json(
      { pipelineId, phase: pipeline.phase },
      { status: 201 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to initialize pipeline" },
      { status: 500 }
    );
  }
}
