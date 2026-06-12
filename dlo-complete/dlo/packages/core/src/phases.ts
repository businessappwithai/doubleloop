/**
 * The authoritative lifecycle states of a DLO pipeline.
 * Ref: §6 of the architecture document.
 */

export const PIPELINE_PHASES = [
  "INIT",
  "RESEARCH_RUNNING",
  "GATE1_PENDING",
  "PLANNING_RUNNING",
  "GATE2_PENDING",
  "EXECUTION_RUNNING",
  "FINALIZATION_RUNNING",
  "COMPLETED",
  "FAILED",
  "ABORTED",
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export function isTerminal(phase: PipelinePhase): boolean {
  return ["COMPLETED", "FAILED", "ABORTED"].includes(phase);
}

export function isFinal(phase: PipelinePhase): boolean {
  return isTerminal(phase);
}
