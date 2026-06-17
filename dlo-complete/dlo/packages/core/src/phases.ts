/**
 * The authoritative lifecycle states of a DLO pipeline.
 * Ref: §6 of the architecture document.
 *
 * SINGLE SOURCE OF TRUTH. Every consumer (the running app, the kernel seam,
 * the client types, db-service) MUST import phases from here — never declare a
 * local `string` phase type. The previous drift (the app emitting phases this
 * enum did not know) happened because pipeline-helper.ts typed `phase: string`.
 *
 * The four `*_RUNNING` finalization steps are the "polish" phase (build, db,
 * test, deploy). They are top-level phases today because the running app
 * transitions through each with its own gate. When the kernel finalization
 * controller lands (plan Step 4), these can collapse into a
 * `FINALIZATION_RUNNING` phase + `FinalizationStep` sub-state; until then they
 * stay top-level for minimal blast radius.
 */

export const PIPELINE_PHASES = [
  "INIT",
  "RESEARCH_RUNNING",
  "GATE1_PENDING",
  "PLANNING_RUNNING",
  "GATE2_PENDING",
  "EXECUTION_RUNNING",
  "PAUSED",
  // ── Finalization steps (build → db → test → deploy → launch) ──
  "BUILD_RUNNING",
  "DB_PROVISIONING_RUNNING",
  "TESTING_RUNNING",
  "DEPLOY_RUNNING",
  "APP_LAUNCH_RUNNING",
  "FINALIZATION_RUNNING",
  "COMPLETED",
  "FAILED",
  "ABORTED",
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

/**
 * The build/test/deploy/launch steps that make up finalization, in execution
 * order. Grouped so the kernel seam (and any UI) can treat them as one phase
 * family without hard-coding the literal strings.
 */
export const FINALIZATION_STEPS = [
  "BUILD_RUNNING",
  "DB_PROVISIONING_RUNNING",
  "TESTING_RUNNING",
  "DEPLOY_RUNNING",
  "APP_LAUNCH_RUNNING",
] as const satisfies readonly PipelinePhase[];

export type FinalizationStep = (typeof FINALIZATION_STEPS)[number];

export function isTerminal(phase: PipelinePhase): boolean {
  return phase === "COMPLETED" || phase === "FAILED" || phase === "ABORTED";
}

export function isFinal(phase: PipelinePhase): boolean {
  return isTerminal(phase);
}

/** True for any of the build/db/test/deploy/launch steps (the "polish" family). */
export function isFinalizationStep(phase: PipelinePhase): boolean {
  return (FINALIZATION_STEPS as readonly string[]).includes(phase);
}

/** True for the paused control state (a frozen EXECUTION_RUNNING). */
export function isPaused(phase: PipelinePhase): boolean {
  return phase === "PAUSED";
}
