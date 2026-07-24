/**
 * processRegistry.ts — tracks live subprocess handles by pipeline ID.
 *
 * Allows API routes to write to a running subprocess's stdin (e.g. to answer
 * Claude Code permission prompts or provide context mid-run).
 */

import type { ChildProcess } from "node:child_process";

const registry = new Map<string, ChildProcess>();

export function registerProcess(pipelineId: string, child: ChildProcess): void {
  registry.set(pipelineId, child);
}

export function unregisterProcess(pipelineId: string): void {
  registry.delete(pipelineId);
}

export function hasProcess(pipelineId: string): boolean {
  return registry.has(pipelineId);
}

/**
 * Write text + newline to the subprocess stdin.
 * Returns false if no process is registered or stdin is not available.
 */
export function sendStdin(pipelineId: string, text: string): boolean {
  const child = registry.get(pipelineId);
  if (!child?.stdin) return false;
  try {
    child.stdin.write(text + "\n");
    return true;
  } catch {
    return false;
  }
}
