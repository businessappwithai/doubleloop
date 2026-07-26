/**
 * processRegistry.ts — tracks live subprocess handles by pipeline ID.
 *
 * Allows API routes to write to a running subprocess's stdin (e.g. to answer
 * Claude Code permission prompts or provide context mid-run) and to kill the
 * fleet when a pipeline is aborted.
 *
 * Two constraints this module encodes:
 *
 * 1. THE STORE LIVES ON globalThis. Next.js bundles every route handler
 *    separately, and a plain module-level `Map` is duplicated once per route
 *    bundle — `/api/gates/[gateId]/resolve` registers a child into its own copy
 *    while `/api/pipelines/[id]/stdin` reads an empty one, so `hasProcess()`
 *    answered false for a subagent that was demonstrably running. A
 *    `Symbol.for` key on `globalThis` is shared by every bundle in the process.
 *
 * 2. A PIPELINE HAS MANY LIVE CHILDREN. The build fleet dispatches up to
 *    maxConcurrent module subagents at once, so keying a single ChildProcess by
 *    pipelineId let each new builder evict the previous one from the registry.
 *    Each pipeline therefore owns a Set, and `unregisterProcess` removes the one
 *    child that exited rather than the whole pipeline's entry.
 */

import type { ChildProcess } from "node:child_process";

const REGISTRY_KEY = Symbol.for("dlo.orchestrator.processRegistry");

type Registry = Map<string, Set<ChildProcess>>;

function registry(): Registry {
  const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  if (!holder[REGISTRY_KEY]) holder[REGISTRY_KEY] = new Map();
  return holder[REGISTRY_KEY];
}

export function registerProcess(pipelineId: string, child: ChildProcess): void {
  const reg = registry();
  const set = reg.get(pipelineId) ?? new Set<ChildProcess>();
  set.add(child);
  reg.set(pipelineId, set);
}

/**
 * Remove one child (the one that just exited). Omitting `child` drops every
 * child of the pipeline — kept for callers that only know the pipeline ID.
 */
export function unregisterProcess(pipelineId: string, child?: ChildProcess): void {
  const reg = registry();
  if (!child) {
    reg.delete(pipelineId);
    return;
  }
  const set = reg.get(pipelineId);
  if (!set) return;
  set.delete(child);
  if (set.size === 0) reg.delete(pipelineId);
}

export function hasProcess(pipelineId: string): boolean {
  return (registry().get(pipelineId)?.size ?? 0) > 0;
}

/** How many live children this pipeline currently has. */
export function processCount(pipelineId: string): number {
  return registry().get(pipelineId)?.size ?? 0;
}

/**
 * Write text + newline to a running subprocess's stdin.
 * Returns false if no process is registered or no stdin is writable.
 *
 * With several builders in flight the input goes to the most recently
 * registered child with a writable stdin — that is the one a user answering a
 * prompt is looking at.
 */
export function sendStdin(pipelineId: string, text: string): boolean {
  const set = registry().get(pipelineId);
  if (!set || set.size === 0) return false;
  for (const child of [...set].reverse()) {
    if (!child.stdin || child.stdin.writable === false) continue;
    try {
      child.stdin.write(text + "\n");
      return true;
    } catch {
      // Try the next candidate rather than reporting a false success.
    }
  }
  return false;
}

/**
 * SIGTERM every live child of a pipeline and forget them.
 * Returns the number of children signalled — abort reports it to the user.
 */
export function killProcesses(pipelineId: string): number {
  const reg = registry();
  const set = reg.get(pipelineId);
  if (!set || set.size === 0) return 0;
  let killed = 0;
  for (const child of set) {
    try {
      child.kill("SIGTERM");
      killed++;
    } catch {
      // Already gone — nothing to signal.
    }
  }
  reg.delete(pipelineId);
  return killed;
}
