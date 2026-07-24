import { NextResponse } from "next/server";
import { getPipeline } from "@/lib/pipeline-helper";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".next", "dist", ".gradle", "build", "__pycache__"]);
const MAX_FILE_BYTES = 512 * 1024; // 512 KB

export interface TreeNode {
  name: string;
  path: string;       // relative to workspaceDir
  type: "file" | "dir";
  size?: number;
  children?: TreeNode[];
}

async function buildTree(absDir: string, rel = ""): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];
  try {
    const entries = await readdir(join(absDir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const children = await buildTree(absDir, relPath);
        nodes.push({ name: e.name, path: relPath, type: "dir", children });
      } else {
        const s = await stat(join(absDir, relPath)).catch(() => null);
        nodes.push({ name: e.name, path: relPath, type: "file", size: s?.size ?? 0 });
      }
    }
  } catch {}
  // Dirs first, then files, both alphabetical
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * GET /api/pipelines/[pipelineId]/workspace
 *   → { workspaceDir, tree: TreeNode[] }     (directory tree, no file content)
 *
 * GET /api/pipelines/[pipelineId]/workspace?file=src/foo.ts
 *   → { path, content, size }                (single file content on demand)
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const { pipelineId } = await params;
    const state = await getPipeline(pipelineId);
    if (!state) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

    const url = new URL(req.url);
    const filePath = url.searchParams.get("file");

    // ── Single file fetch ───────────────────────────────────────────────
    if (filePath) {
      const abs = join(state.workspaceDir, filePath);
      if (!abs.startsWith(state.workspaceDir)) {
        return NextResponse.json({ error: "Path outside workspace" }, { status: 400 });
      }
      const s = await stat(abs).catch(() => null);
      if (!s || !s.isFile()) return NextResponse.json({ error: "File not found" }, { status: 404 });
      if (s.size > MAX_FILE_BYTES) {
        return NextResponse.json({
          path: filePath, size: s.size,
          content: `[File too large to display inline: ${(s.size / 1024).toFixed(0)} KB]`,
        });
      }
      const content = await readFile(abs, "utf-8").catch(() => "[Binary file — cannot display]");
      return NextResponse.json({ path: filePath, content, size: s.size });
    }

    // ── Directory tree (no content) ─────────────────────────────────────
    const tree = await buildTree(state.workspaceDir);
    return NextResponse.json({ workspaceDir: state.workspaceDir, tree });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
