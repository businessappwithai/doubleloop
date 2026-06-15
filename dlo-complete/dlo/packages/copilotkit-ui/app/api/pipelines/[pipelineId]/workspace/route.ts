import { NextResponse } from "next/server";
import { getPipeline } from "@/lib/pipeline-helper";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
}

async function collectFiles(dir: string, rel = ""): Promise<WorkspaceFile[]> {
  const results: WorkspaceFile[] = [];
  try {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...(await collectFiles(dir, relPath)));
      } else {
        try {
          const content = await readFile(join(dir, relPath), "utf-8");
          results.push({ path: relPath, content, size: content.length });
        } catch {}
      }
    }
  } catch {}
  return results;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const state = await getPipeline(pipelineId);
    if (!state) {
      return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    }
    const files = await collectFiles(state.workspaceDir);
    return NextResponse.json({ workspaceDir: state.workspaceDir, files });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
