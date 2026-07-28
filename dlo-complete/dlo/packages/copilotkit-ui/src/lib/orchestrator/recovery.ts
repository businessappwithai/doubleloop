/**
 * orchestrator/recovery.ts
 * Crash recovery for interrupted pipelines.
 *
 * Every phase runner is a fire-and-forget async function held only in the
 * Node process that started it. When that process dies — a host restart, an
 * OOM kill, a deploy — the persisted state still says EXECUTION_RUNNING and
 * modules still say EXECUTING, but nothing is running and nothing ever will
 * again. The pipeline looks alive and is dead, and every module the fleet had
 * already finished is stranded behind it.
 *
 * That happened repeatedly in real runs. Calling it "environmental" is not a
 * defence: an autonomous pipeline that needs a human to notice it died and
 * hand-resume it is not autonomous. Recovery therefore belongs in the product.
 *
 * On startup this module finds those pipelines and restarts them from their own
 * persisted state:
 *   - a module left EXECUTING is requeued (its process is gone; its recorded
 *     failure is kept, so the retry starts from what was already learned),
 *   - PASSED modules are never redone,
 *   - the phase's runner is re-invoked.
 *
 * Terminal phases (COMPLETED / FAILED / ABORTED) and gate phases are left
 * alone: a pipeline waiting at a HITL gate is not stuck, it is waiting for a
 * human, and restarting it would discard that.
 */

import type { PipelinePhase } from "@dlo/core";
import { type PipelineState, listAllPipelines, getPipeline, savePipeline } from "./state";
import { appendLog } from "./logStore";
import { hasProcess } from "./processRegistry";

/** Phases that mean "a background runner should be executing right now". */
export const RESUMABLE_PHASES: PipelinePhase[] = [
  "RESEARCH_RUNNING",
  "DESIGN_RUNNING",
  "CEO_REVIEW_RUNNING",
  "EXECUTION_RUNNING",
  "BUILD_RUNNING",
  "DB_PROVISIONING_RUNNING",
  "TESTING_RUNNING",
  "DEPLOY_RUNNING",
  "APP_LAUNCH_RUNNING",
] as unknown as PipelinePhase[];

/**
 * Is this pipeline interrupted — a running phase with nothing actually running?
 *
 * A gate being open is the one case where a running phase is legitimately
 * idle: the phase runner has parked, waiting on a human decision.
 */
export function isInterrupted(
  state: Pick<PipelineState, "phase" | "activeGate">,
  processAlive: boolean
): boolean {
  if (state.activeGate) return false;
  if (processAlive) return false;
  return (RESUMABLE_PHASES as string[]).includes(state.phase as unknown as string);
}

/**
 * Requeue modules that were mid-flight when the process died.
 *
 * Their `failure` text is deliberately preserved: runOneModule seeds its first
 * critique from it, so a module that had already learned something does not
 * start over blind. Returns the ids that were requeued, for the log.
 */
export function requeueStrandedModules(
  modules: Array<{ moduleId: string; status: string; attempts: number; failure?: string }>
): string[] {
  const requeued: string[] = [];
  for (const entry of modules) {
    if (entry.status === "EXECUTING") {
      entry.status = "PENDING";
      entry.attempts = 0;
      requeued.push(entry.moduleId);
    }
  }
  return requeued;
}

/** The phase runners, injected so recovery is testable without spawning anything. */
export interface PhaseRunners {
  research: (pipelineId: string) => unknown;
  design: (pipelineId: string) => unknown;
  ceoReview: (pipelineId: string) => unknown;
  execution: (pipelineId: string) => unknown;
  build: (pipelineId: string, hasPermission: boolean) => unknown;
  dbProvisioning: (pipelineId: string, hasPermission: boolean) => unknown;
  testing: (pipelineId: string, hasPermission: boolean) => unknown;
  deploy: (pipelineId: string, hasPermission: boolean) => unknown;
}

/**
 * Re-invoke the runner for a phase. The terminal phases pass hasPermission
 * false so they re-raise their TERMINAL_PERMISSION gate rather than silently
 * running a command the human never approved in this process's lifetime.
 */
export function resumePhase(phase: string, pipelineId: string, runners: PhaseRunners): boolean {
  switch (phase) {
    case "RESEARCH_RUNNING": runners.research(pipelineId); return true;
    case "DESIGN_RUNNING": runners.design(pipelineId); return true;
    case "CEO_REVIEW_RUNNING": runners.ceoReview(pipelineId); return true;
    case "EXECUTION_RUNNING": runners.execution(pipelineId); return true;
    case "BUILD_RUNNING": runners.build(pipelineId, false); return true;
    case "DB_PROVISIONING_RUNNING": runners.dbProvisioning(pipelineId, false); return true;
    case "TESTING_RUNNING": runners.testing(pipelineId, false); return true;
    case "DEPLOY_RUNNING":
    case "APP_LAUNCH_RUNNING": runners.deploy(pipelineId, false); return true;
    default: return false;
  }
}

export interface RecoveryResult {
  pipelineId: string;
  phase: string;
  requeuedModules: string[];
}

/**
 * Find every interrupted pipeline and restart it. Safe to call more than once:
 * a pipeline with a live process, an open gate, or a terminal phase is skipped.
 */
export async function recoverInterruptedPipelines(
  runners: PhaseRunners,
  isAlive: (pipelineId: string) => boolean = hasProcess
): Promise<RecoveryResult[]> {
  const recovered: RecoveryResult[] = [];
  const summaries = await listAllPipelines();

  for (const summary of summaries) {
    // listAllPipelines may return DB summaries without gates or boards; the
    // full record is what recovery has to reason about.
    const state = await getPipeline(summary.pipelineId);
    if (!state) continue;
    if (!isInterrupted(state, isAlive(state.pipelineId))) continue;

    const requeued = state.board ? requeueStrandedModules(state.board.modules) : [];
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);

    const notice =
      `[Recovery] Pipeline was left in ${state.phase} with no running process — resuming it.` +
      (requeued.length ? ` Requeued interrupted module(s): ${requeued.join(", ")}.` : "");
    console.warn(notice);
    appendLog(state.pipelineId, notice);

    if (resumePhase(state.phase as unknown as string, state.pipelineId, runners)) {
      recovered.push({
        pipelineId: state.pipelineId,
        phase: state.phase as unknown as string,
        requeuedModules: requeued,
      });
    }
  }

  return recovered;
}
