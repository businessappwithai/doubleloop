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

export type ClaudeAuthMode = "subscription" | "api-key";
export type ClaudePermissionMode = "plan" | "acceptEdits" | "default";

export interface ClaudeAgentOptions {
  prompt: string;
  model: string;
  cwd?: string;
  permissionMode?: ClaudePermissionMode;
  auth?: ClaudeAuthMode;
  apiKey?: string;
  timeoutMs?: number;
}

/** Resolve the auth mode for a pipeline config (providers.planner.auth). */
export function claudeAuthFromConfig(config: any): { auth: ClaudeAuthMode; apiKey?: string } {
  const auth: ClaudeAuthMode =
    config?.providers?.planner?.auth === "subscription" ? "subscription" : "api-key";
  const apiKey = config?.providers?.planner?.apiKey || process.env.ANTHROPIC_API_KEY;
  return auth === "subscription" ? { auth } : { auth, ...(apiKey ? { apiKey } : {}) };
}

export async function spawnClaudeAgent(opts: ClaudeAgentOptions): Promise<string> {
  const cwd = opts.cwd || process.cwd();
  await mkdir(cwd, { recursive: true });

  const args = ["-p", opts.prompt, "--model", opts.model, "--output-format", "json"];
  if (opts.permissionMode && opts.permissionMode !== "default") {
    args.push("--permission-mode", opts.permissionMode);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.auth === "subscription") {
    // Subscription mode: the CLI must use its OAuth login, not API-key billing.
    delete env.ANTHROPIC_API_KEY;
  } else if (opts.apiKey) {
    env.ANTHROPIC_API_KEY = opts.apiKey;
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env, cwd });
    let out = "";
    let err = "";
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`claude timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => {
      if (timeout) clearTimeout(timeout);
      reject(e);
    });
    child.on("close", (code: number | null) => {
      if (timeout) clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${err.trim() || out.trim()}`));
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
 * Uses api-key auth semantics identical to the old pipeline-helper spawnClaude.
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
