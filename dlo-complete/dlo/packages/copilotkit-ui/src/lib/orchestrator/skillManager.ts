/**
 * skillManager.ts — Claude Code skill discovery and auto-install.
 *
 * Skills live in ~/.claude/skills/<name>/SKILL.md.
 * The claude CLI loads them automatically from that directory.
 * Additional skill dirs can be passed per-invocation via --plugin-dir.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, access, readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const SKILLS_DIR = join(homedir(), ".claude", "skills");
const GSTACK_DIR = join(SKILLS_DIR, "gstack");
const GSTACK_REPO = "https://github.com/garrytan/gstack.git";

export interface SkillInfo {
  name: string;
  path: string;
  version: string | undefined;
  description: string | undefined;
}

/** Check whether a skill is installed by name. */
export async function isSkillInstalled(name: string): Promise<boolean> {
  try {
    await access(join(SKILLS_DIR, name, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

/** Read basic metadata from a SKILL.md frontmatter. */
async function readSkillMeta(skillDir: string): Promise<{ version: string | undefined; description: string | undefined }> {
  try {
    const content = await readFile(join(skillDir, "SKILL.md"), "utf-8");
    const version = content.match(/^version:\s*(.+)$/m)?.[1]?.trim();
    const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    return { version, description };
  } catch {
    return { version: undefined, description: undefined };
  }
}

/** List all installed skills by scanning ~/.claude/skills/. */
export async function listInstalledSkills(): Promise<SkillInfo[]> {
  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    const skills: SkillInfo[] = [];
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map(async (e) => {
          const path = join(SKILLS_DIR, e.name);
          try {
            await access(join(path, "SKILL.md"));
            const meta = await readSkillMeta(path);
            skills.push({ name: e.name, path, ...meta });
          } catch {
            // No SKILL.md — not a proper skill dir, skip
          }
        })
    );
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface GstackStatus {
  installed: boolean;
  version: string | undefined;
  path: string;
}

export async function getGstackStatus(): Promise<GstackStatus> {
  try {
    await access(join(GSTACK_DIR, "SKILL.md"));
    const { version } = await readSkillMeta(GSTACK_DIR);
    return { installed: true, version, path: GSTACK_DIR };
  } catch {
    return { installed: false, version: undefined, path: GSTACK_DIR };
  }
}

/**
 * Install gstack from GitHub.
 * Requires git on PATH. The gstack setup script requires bun.
 * Returns { ok, message }.
 */
export async function installGstack(): Promise<{ ok: boolean; message: string }> {
  try {
    await mkdir(SKILLS_DIR, { recursive: true });
  } catch {}

  // Clone the repo
  const cloneResult = spawnSync("git", ["clone", "--depth=1", GSTACK_REPO, GSTACK_DIR], {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (cloneResult.status !== 0) {
    return {
      ok: false,
      message: `git clone failed: ${cloneResult.stderr || cloneResult.stdout}`,
    };
  }

  // Run the gstack setup script
  const setupResult = spawnSync("bash", ["setup"], {
    cwd: GSTACK_DIR,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, GSTACK_SETUP_RUNNING: "1" },
  });
  if (setupResult.status !== 0) {
    return {
      ok: false,
      message: `gstack setup failed: ${setupResult.stderr || setupResult.stdout}`,
    };
  }

  const { version } = await readSkillMeta(GSTACK_DIR);
  return { ok: true, message: `gstack ${version || "unknown version"} installed at ${GSTACK_DIR}` };
}

/**
 * Upgrade gstack by pulling the latest and re-running setup.
 */
export async function upgradeGstack(): Promise<{ ok: boolean; message: string }> {
  const status = await getGstackStatus();
  if (!status.installed) {
    return installGstack();
  }

  const pullResult = spawnSync("git", ["-C", GSTACK_DIR, "pull", "--ff-only"], {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (pullResult.status !== 0) {
    return { ok: false, message: `git pull failed: ${pullResult.stderr}` };
  }

  const setupResult = spawnSync("bash", ["setup"], {
    cwd: GSTACK_DIR,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, GSTACK_SETUP_RUNNING: "1" },
  });
  if (setupResult.status !== 0) {
    return {
      ok: false,
      message: `gstack setup failed after pull: ${setupResult.stderr || setupResult.stdout}`,
    };
  }

  const { version } = await readSkillMeta(GSTACK_DIR);
  return { ok: true, message: `gstack upgraded to ${version || "latest"} at ${GSTACK_DIR}` };
}
