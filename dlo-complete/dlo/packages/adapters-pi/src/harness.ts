/**
 * @dlo/adapters-pi — pi.dev harness adapter.
 *
 * NO MOCK SHIMS. The previous implementation fabricated `claude`, `codewhale`
 * and `ocr` executables that printed fake PASS results — poisoning any real
 * pipeline run. This version only ever reports the truth:
 *
 *  - checkBinaries()          → which real binaries exist on PATH
 *  - checkAndInstallBinaries() → attempts real npm installs for missing
 *    binaries; a binary that cannot be installed stays missing and is
 *    reported as such (callers surface this to the user).
 *  - PiHarnessSession          → real pi SDK when installed, otherwise a
 *    clearly-labeled local session wrapper (kind: "local").
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessSession, SessionRef, ArtifactRef } from "@dlo/core";

const execAsync = promisify(exec);

export interface BinaryStatus {
  name: string;
  available: boolean;
  detail: string;
}

async function which(name: string): Promise<boolean> {
  try {
    await execAsync(`which ${name}`);
    return true;
  } catch {
    return false;
  }
}

export async function checkBinaries(): Promise<BinaryStatus[]> {
  const results: BinaryStatus[] = [];
  for (const name of ["claude", "codewhale", "ocr"]) {
    const available = await which(name);
    results.push({
      name,
      available,
      detail: available ? `${name} found on PATH` : `${name} not found on PATH`,
    });
  }
  return results;
}

/**
 * Attempt REAL installs for missing binaries. Never fabricates executables.
 * Returns the post-install status so callers can report what is genuinely
 * available. DLO_TEST_SKIP_INSTALL=true skips installs (status only).
 */
export async function checkAndInstallBinaries(_workspaceDir?: string): Promise<BinaryStatus[]> {
  const skipNpm = process.env.DLO_TEST_SKIP_INSTALL === "true";

  const installers: Record<string, string> = {
    claude: "npm install -g @anthropic-ai/claude-code",
    ocr: "npm install -g @alibaba-group/open-code-review",
    // codewhale has no public npm package — must be installed by the user.
  };

  for (const [name, cmd] of Object.entries(installers)) {
    if (skipNpm) continue;
    if (await which(name)) continue;
    try {
      console.log(`[Pi] ${name} not found — attempting: ${cmd}`);
      await execAsync(cmd, { timeout: 180_000 });
    } catch (e: any) {
      console.warn(`[Pi] Install of ${name} failed (staying missing): ${e.message?.slice(0, 200)}`);
    }
  }

  return checkBinaries();
}

/**
 * pi.dev harness session. Uses the real pi SDK when installed
 * (@earendil-works/pi-coding-agent); otherwise a local session wrapper that
 * says so (kind === "local") — session bookkeeping without pretending a
 * remote pi service is involved.
 */
export class PiHarnessSession implements HarnessSession {
  private sdk: any | null = null;
  private sdkChecked = false;
  private sessions = new Map<SessionRef, { steered: string[]; checkpoints: string[] }>();

  get kind(): "pi-sdk" | "local" {
    return this.sdk ? "pi-sdk" : "local";
  }

  private async loadSdk(): Promise<void> {
    if (this.sdkChecked) return;
    this.sdkChecked = true;
    try {
      this.sdk = await import("@earendil-works/pi-coding-agent" as string);
      console.log("[Pi] Using real pi.dev SDK for harness sessions");
    } catch {
      this.sdk = null;
      console.log("[Pi] pi SDK not installed — using local session wrapper (kind=local)");
    }
  }

  async forkContext(_parent: SessionRef | null, _systemMd: ArtifactRef[]): Promise<SessionRef> {
    await this.loadSdk();
    if (this.sdk?.createSession) {
      const session = await this.sdk.createSession({});
      const ref = (session?.id ?? `pi-session-${crypto.randomUUID()}`) as SessionRef;
      this.sessions.set(ref, { steered: [], checkpoints: [] });
      return ref;
    }
    const ref = `local-session-${crypto.randomUUID()}` as SessionRef;
    this.sessions.set(ref, { steered: [], checkpoints: [] });
    return ref;
  }

  async steerSession(ref: SessionRef, message: string): Promise<void> {
    const s = this.sessions.get(ref);
    if (!s) throw new Error(`Unknown session: ${ref}`);
    s.steered.push(message);
  }

  async rewindTo(ref: SessionRef, checkpoint: string): Promise<void> {
    const s = this.sessions.get(ref);
    if (!s) throw new Error(`Unknown session: ${ref}`);
    const idx = s.checkpoints.indexOf(checkpoint);
    if (idx === -1) throw new Error(`Unknown checkpoint ${checkpoint} for session ${ref}`);
    s.checkpoints = s.checkpoints.slice(0, idx + 1);
  }

  async compact(ref: SessionRef): Promise<void> {
    const s = this.sessions.get(ref);
    if (!s) throw new Error(`Unknown session: ${ref}`);
    s.steered = s.steered.slice(-5);
  }
}
