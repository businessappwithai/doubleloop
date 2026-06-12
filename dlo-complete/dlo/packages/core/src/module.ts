/**
 * Module identity, status, and execution attempt tracking.
 * A module is a discrete, reusable unit of execution from the Engineering Plan.
 */

import { z } from "zod";
import type { ModuleId } from "./ids.js";

export const ModuleStatusSchema = z.enum([
  "BLOCKED",        // unmet dependencies
  "READY",          // all deps PASSED; eligible for dispatch
  "EXECUTING",      // CodeWhale attempt in flight
  "VERIFYING",      // supervisor evaluation in flight
  "PASSED",         // exit clauses met; committed
  "REJECTED",       // critique issued; awaiting re-dispatch
  "EXHAUSTED",      // maxAttempts reached
]);
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;

export const ExitClauseResultSchema = z.object({
  clauseId: z.string(),
  passed: z.boolean(),
  observed: z.string(),
  durationMs: z.number().int().nonnegative(),
});
export type ExitClauseResult = z.infer<typeof ExitClauseResultSchema>;

export const ModuleAttemptSchema = z.object({
  attemptId: z.string(),
  index: z.number().int().positive(),
  executorSessionRef: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  summary: z.string().optional(),
  changes: z.array(z.object({
    file: z.string(),
    description: z.string(),
  })).optional(),
  preSnapshot: z.string(),
  verdict: z.enum(["PASS", "FAIL"]).optional(),
  critique: z.object({
    sha256: z.string(),
    mediaType: z.string(),
  }).optional(),
  clauseResults: z.array(ExitClauseResultSchema).optional(),
});
export type ModuleAttempt = z.infer<typeof ModuleAttemptSchema>;

// Module state per the board projection
export interface ModuleBoardState {
  moduleId: ModuleId;
  status: ModuleStatus;
  attempts: ReadonlyArray<ModuleAttempt>;
  lastAttempt?: ModuleAttempt;
}
