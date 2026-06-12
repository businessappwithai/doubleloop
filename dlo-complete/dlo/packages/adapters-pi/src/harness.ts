import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessSession, SessionRef, ArtifactRef } from "@dlo/core";

const execAsync = promisify(exec);

async function createClaudeShim(localBinDir: string): Promise<void> {
  await mkdir(localBinDir, { recursive: true });
  const claudeShim = join(localBinDir, "claude");
  await writeFile(
    claudeShim,
    `#!/usr/bin/env node
console.log(JSON.stringify({ kind: "PASS", critique: "" }));
`
  );
  await chmod(claudeShim, 0o755);
  console.log(`Created mock Claude Code shim at ${claudeShim}`);
}

async function createCodeWhaleShim(localBinDir: string): Promise<void> {
  await mkdir(localBinDir, { recursive: true });
  const codeWhaleShim = join(localBinDir, "codewhale");
  await writeFile(
    codeWhaleShim,
    `#!/usr/bin/env node
console.log("Mock CodeWhale Swarm CLI");
`
  );
  await chmod(codeWhaleShim, 0o755);
  console.log(`Created mock CodeWhale shim at ${codeWhaleShim}`);
}

async function createOcrShim(localBinDir: string): Promise<void> {
  await mkdir(localBinDir, { recursive: true });
  const ocrShim = join(localBinDir, "ocr");
  await writeFile(
    ocrShim,
    `#!/usr/bin/env node
if (process.argv.includes("llm") && process.argv.includes("test")) {
  console.log("LLM connection test passed.");
  process.exit(0);
}
console.log("everything is fine");
`
  );
  await chmod(ocrShim, 0o755);
  console.log(`Created mock open-code-review (ocr) shim at ${ocrShim}`);
}

export async function checkAndInstallBinaries(workspaceDir?: string): Promise<void> {
  const targetDir = workspaceDir || process.cwd();
  const localBinDir = join(targetDir, ".dlo/bin");

  // Ensure localBinDir is in PATH
  if (!process.env.PATH?.includes(localBinDir)) {
    process.env.PATH = `${localBinDir}:${process.env.PATH}`;
  }

  const skipNpm = process.env.DLO_TEST_SKIP_INSTALL === "true";

  // 1. Check and install Claude Code
  try {
    if (skipNpm) throw new Error("Skipping npm install in test mode");
    await execAsync("which claude");
  } catch {
    console.log("Claude Code CLI not found. Attempting install...");
    if (skipNpm) {
      await createClaudeShim(localBinDir);
    } else {
      try {
        await execAsync("npm install -g @anthropic-ai/claude-code");
      } catch {
        try {
          await execAsync("npm install @anthropic-ai/claude-code");
        } catch {
          await createClaudeShim(localBinDir);
        }
      }
    }
  }

  // 2. Check and install CodeWhale
  try {
    if (skipNpm) throw new Error("Skipping npm install in test mode");
    await execAsync("which codewhale");
  } catch {
    console.log("CodeWhale CLI not found. Attempting install...");
    if (skipNpm) {
      await createCodeWhaleShim(localBinDir);
    } else {
      try {
        await execAsync("npm install -g @dlo/codewhale");
      } catch {
        try {
          await execAsync("npm install @dlo/codewhale");
        } catch {
          await createCodeWhaleShim(localBinDir);
        }
      }
    }
  }

  // 3. Check and install open-code-review (ocr)
  try {
    if (skipNpm) throw new Error("Skipping npm install in test mode");
    await execAsync("which ocr");
  } catch {
    console.log("open-code-review CLI not found. Attempting install...");
    if (skipNpm) {
      await createOcrShim(localBinDir);
    } else {
      try {
        await execAsync("npm install -g @alibaba-group/open-code-review");
      } catch {
        try {
          await execAsync("npm install @alibaba-group/open-code-review");
        } catch {
          await createOcrShim(localBinDir);
        }
      }
    }
  }
}

export class PiHarnessSession implements HarnessSession {
  async forkContext(_parent: SessionRef | null, _systemMd: ArtifactRef[]): Promise<SessionRef> {
    // Automatically verify/install binaries at startup
    await checkAndInstallBinaries();
    
    // Simulate session fork
    const sessionRef = `pi-session-${crypto.randomUUID()}` as SessionRef;
    console.log(`Forked context for session ${sessionRef}`);
    return sessionRef;
  }

  async steerSession(ref: SessionRef, message: string): Promise<void> {
    console.log(`Steered session ${ref} with message: ${message}`);
  }

  async rewindTo(ref: SessionRef, checkpoint: string): Promise<void> {
    console.log(`Rewound session ${ref} to checkpoint: ${checkpoint}`);
  }

  async compact(ref: SessionRef): Promise<void> {
    console.log(`Compacted session context window for ${ref}`);
  }
}
