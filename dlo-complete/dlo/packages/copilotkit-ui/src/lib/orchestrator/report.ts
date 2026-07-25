/**
 * orchestrator/report.ts — the execution report projection.
 *
 * Pure over PipelineState so the API route stays a thin dispatcher (and so the
 * numbers are testable without a running pipeline).
 *
 * The non-obvious constraint is elapsed time: `lastTransitionAt` is the moment
 * of the last PHASE change, not "now". Measuring a live pipeline against it
 * reports the time it took to enter the current phase — a pipeline sixteen
 * minutes into DESIGN_RUNNING read as 16 seconds. Elapsed time therefore runs
 * to `now` while the pipeline is live and freezes at `lastTransitionAt` once it
 * reaches a terminal phase.
 */

import type { PipelineState } from "./state";

/** Phases after which no further work happens, so the clock stops. */
const TERMINAL_PHASES = new Set(["COMPLETED", "FAILED", "ABORTED"]);

export function isTerminalPhase(phase: string): boolean {
  return TERMINAL_PHASES.has(phase);
}

export interface ExecutionReport {
  title: string;
  summary: string;
  modulesCompleted: number;
  totalAttempts: number;
  costUsd: number | null;
  wallClockSeconds: number;
  commits: Array<{ hash: string; message: string }>;
  details: Record<string, unknown>;
}

export function computeWallClockSeconds(state: PipelineState, now: number = Date.now()): number {
  const started = new Date(state.createdAt).getTime();
  if (!Number.isFinite(started)) return 0;
  const ended = isTerminalPhase(state.phase)
    ? new Date(state.lastTransitionAt).getTime()
    : now;
  const elapsed = (Number.isFinite(ended) ? ended : now) - started;
  return elapsed > 0 ? Math.floor(elapsed / 1000) : 0;
}

export function buildExecutionReport(state: PipelineState, now: number = Date.now()): ExecutionReport {
  const modules = state.board?.modules ?? [];
  const modulesCompleted = modules.filter((m) => m.status === "PASSED").length;
  const totalAttempts = modules.reduce((acc, m) => acc + (m.attempts ?? 0), 0);

  const summary =
    state.phase === "COMPLETED"
      ? `Completed execution pipeline for ${state.projectName}. ${modulesCompleted} module(s) generated and validated across ${totalAttempts} attempt(s).`
      : state.phase === "FAILED"
        ? `Execution pipeline for ${state.projectName} failed. ${modulesCompleted} module(s) passed before failure.`
        : state.phase === "ABORTED"
          ? `Execution pipeline for ${state.projectName} was aborted.`
          : `Execution pipeline for ${state.projectName} is in phase ${state.phase}.`;

  return {
    title: `${state.projectName} Execution Report`,
    summary,
    modulesCompleted,
    totalAttempts,
    costUsd: state.budget?.spent?.usd ?? null,
    wallClockSeconds: computeWallClockSeconds(state, now),
    commits: [],
    details: {},
  };
}
