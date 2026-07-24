import { NextResponse } from "next/server";
import {
  listInstalledSkills,
  getGstackStatus,
  installGstack,
  upgradeGstack,
} from "@/lib/orchestrator/skillManager";

/**
 * GET /api/skills
 * Returns all installed Claude Code skills and gstack status.
 */
export async function GET() {
  const [skills, gstack] = await Promise.all([
    listInstalledSkills(),
    getGstackStatus(),
  ]);
  return NextResponse.json({ skills, gstack });
}

/**
 * POST /api/skills
 * Body: { action: "install-gstack" | "upgrade-gstack" }
 *
 * Installs or upgrades gstack in the background.
 * Returns { ok, message } when done.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action: string = body?.action ?? "";

  if (action === "install-gstack") {
    const result = await installGstack();
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }

  if (action === "upgrade-gstack") {
    const result = await upgradeGstack();
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
