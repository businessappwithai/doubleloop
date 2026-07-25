/**
 * orchestrator/subagents/claude.ts
 * Claude Code CLI invocation — the one place we spawn `claude`.
 *
 * Supports:
 *  - permissionMode "plan" (design documents are authored in plan mode, R10)
 *  - auth "subscription": strips ANTHROPIC_API_KEY so the CLI uses its
 *    logged-in Claude subscription (R8) — vs "api-key" which injects the key.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { appendLog } from "../logStore";
import { registerProcess, unregisterProcess } from "../processRegistry";

export type ClaudeAuthMode = "subscription" | "api-key";
export type ClaudePermissionMode = "plan" | "bypassPermissions" | "acceptEdits" | "default";

export interface ClaudeAgentOptions {
  prompt: string;
  model: string;
  cwd?: string;
  permissionMode?: ClaudePermissionMode;
  auth?: ClaudeAuthMode;
  apiKey?: string;
  timeoutMs?: number;
  /** When set, stdout/stderr are streamed to the in-process log store. */
  pipelineId?: string;
  /** Extra skill/plugin directories loaded for this invocation via --plugin-dir. */
  pluginDirs?: string[];
}

/** Resolve the auth mode for a pipeline config (providers.planner.auth). */
export function claudeAuthFromConfig(config: any): { auth: ClaudeAuthMode; apiKey?: string } {
  const auth: ClaudeAuthMode =
    config?.providers?.planner?.auth === "subscription" ? "subscription" : "api-key";
  const apiKey = config?.providers?.planner?.apiKey || process.env.ANTHROPIC_API_KEY;
  return auth === "subscription" ? { auth } : { auth, ...(apiKey ? { apiKey } : {}) };
}

/**
 * Resolve the permission mode for a specific provider from the pipeline config.
 * Falls back to the provided default if the config doesn't specify one.
 */
export function claudePermissionModeFromConfig(
  config: any,
  provider: "planner" | "reviewer" | "executor",
  fallback: ClaudePermissionMode = "bypassPermissions"
): ClaudePermissionMode {
  const configured = config?.providers?.[provider]?.permissionMode;
  const valid: ClaudePermissionMode[] = ["plan", "bypassPermissions", "acceptEdits", "default"];
  return valid.includes(configured) ? (configured as ClaudePermissionMode) : fallback;
}

/**
 * Adjust a permission mode to what the host will actually accept.
 *
 * `bypassPermissions` becomes `--dangerously-skip-permissions`, and the Claude
 * CLI refuses that outright when running with root/sudo privileges — it exits 1
 * before doing any work. Containers (Docker, CI, hosted runners) commonly run
 * as root, so the pipeline's own default permission mode would kill every
 * subagent there. `acceptEdits` is the closest mode the CLI does allow as root:
 * the agent still writes files, it just does not get the blanket bypass.
 *
 * The refusal is unconditional under root — setting IS_SANDBOX does NOT lift it
 * (verified against CLI 2.1.220), so root is the only signal consulted here.
 * Pure and parameterized so the decision is testable without becoming root.
 */
export function resolveHostPermissionMode(
  requested: ClaudePermissionMode | undefined,
  host: { isRoot: boolean }
): { mode: ClaudePermissionMode | undefined; adjusted: boolean } {
  if (requested === "bypassPermissions" && host.isRoot) {
    return { mode: "acceptEdits", adjusted: true };
  }
  return { mode: requested, adjusted: false };
}

export async function spawnClaudeAgent(opts: ClaudeAgentOptions): Promise<string> {
  const cwd = opts.cwd || process.cwd();
  await mkdir(cwd, { recursive: true });

  const { mode: permissionMode, adjusted } = resolveHostPermissionMode(opts.permissionMode, {
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
  });
  if (adjusted) {
    // Never silent: the run is not using the mode that was asked for.
    const notice =
      `[Claude] permission mode "bypassPermissions" is rejected by the CLI when running as root — ` +
      `using "acceptEdits" instead for this invocation.`;
    console.warn(notice);
    if (opts.pipelineId) appendLog(opts.pipelineId, notice);
  }

  const args = ["-p", opts.prompt, "--model", opts.model, "--output-format", "json"];
  if (permissionMode && permissionMode !== "default") {
    args.push("--permission-mode", permissionMode);
  }
  for (const dir of opts.pluginDirs ?? []) {
    args.push("--plugin-dir", dir);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.auth === "subscription") {
    // Subscription mode: the CLI must use its OAuth login, not API-key billing.
    delete env.ANTHROPIC_API_KEY;
  } else if (opts.apiKey) {
    env.ANTHROPIC_API_KEY = opts.apiKey;
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });

    // Close stdin immediately — the -p flag reads the prompt from argv, not stdin.
    // Leaving stdin open causes Claude CLI to wait 3 s and then exit 1.
    // The /stdin API (for interactive permission responses) will re-open the pipe
    // only when the process is still alive and stdin writable.
    child.stdin.end();

    if (opts.pipelineId) registerProcess(opts.pipelineId, child);

    let out = "";
    let err = "";
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          if (opts.pipelineId) unregisterProcess(opts.pipelineId, child);
          reject(new Error(`claude timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      out += text;
      if (opts.pipelineId) appendLog(opts.pipelineId, text);
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      err += text;
      if (opts.pipelineId) appendLog(opts.pipelineId, text);
    });
    child.on("error", (e) => {
      if (timeout) clearTimeout(timeout);
      if (opts.pipelineId) unregisterProcess(opts.pipelineId, child);
      reject(e);
    });
    child.on("close", (code: number | null) => {
      if (timeout) clearTimeout(timeout);
      if (opts.pipelineId) unregisterProcess(opts.pipelineId, child);
      if (code !== 0) {
        // Include both stderr and stdout — the actual build failure is often in stdout
        // while stderr only has the "no stdin data" warning or similar noise.
        const stderrClean = err.trim().replace(/Warning: no stdin data received.*\n?/g, "").trim();
        const detail = [stderrClean, out.trim()].filter(Boolean).join("\n---\n").slice(-2000) || err.trim();
        reject(new Error(`claude exited ${code}: ${detail}`));
        return;
      }
      try {
        const parsed = JSON.parse(out.trim());
        resolve(parsed.result ?? out.trim());
      } catch {
        resolve(out.trim());
      }
    });
  });
}

/**
 * Legacy signature kept for existing callers (façade compat).
 */
export async function spawnClaude(
  prompt: string,
  model: string,
  workspaceDir?: string
): Promise<string> {
  return spawnClaudeAgent({
    prompt,
    model,
    ...(workspaceDir ? { cwd: workspaceDir } : {}),
  });
}

/** Check whether the claude CLI is available and (optionally) logged in. */
export async function checkClaudeCli(): Promise<{ available: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { env: process.env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => resolve({ available: false, detail: "claude CLI not found in PATH" }));
    child.on("close", (code) =>
      resolve(
        code === 0
          ? { available: true, detail: out.trim() }
          : { available: false, detail: `claude --version exited ${code}` }
      )
    );
  });
}
