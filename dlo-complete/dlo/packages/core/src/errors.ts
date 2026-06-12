/**
 * Comprehensive, typed error hierarchy for DLO.
 * Every fallible operation resolves to a typed DloError subclass.
 * No fallback paths, no silent catches — every error is explicit and catalogued.
 */

import type { PipelinePhase } from "./phases.js";

export abstract class DloError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    public readonly phase?: PipelinePhase,
    public readonly cause?: unknown,
  ) {
    super(message, { cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      phase: this.phase,
      retryable: this.retryable,
      stack: this.stack,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Adapter errors — child processes, HTTP, timeouts
// ─────────────────────────────────────────────────────────────────

export class AdapterProcessError extends DloError {
  readonly code = "ADAPTER/PROCESS";
  readonly retryable = true;

  constructor(
    message: string,
    public readonly adapter: string,
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
    opts?: { phase?: PipelinePhase; cause?: unknown },
  ) {
    super(message, opts?.phase, opts?.cause);
  }
}

export class AdapterTimeoutError extends DloError {
  readonly code = "ADAPTER/TIMEOUT";
  readonly retryable = true;

  constructor(
    message: string,
    public readonly adapter: string,
    public readonly timeoutMs: number,
    opts?: { phase?: PipelinePhase },
  ) {
    super(message, opts?.phase);
  }
}

export class AdapterValidationError extends DloError {
  readonly code = "ADAPTER/VALIDATION";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly adapter: string,
    public readonly details: Record<string, string>,
    opts?: { phase?: PipelinePhase },
  ) {
    super(message, opts?.phase);
  }
}

// ─────────────────────────────────────────────────────────────────
// Kernel errors — state machine, settlement, budget
// ─────────────────────────────────────────────────────────────────

export class IllegalStateTransitionError extends DloError {
  readonly code = "KERNEL/ILLEGAL_TRANSITION";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly from: string,
    public readonly event: string,
  ) {
    super(message);
  }
}

export class SettlementViolationError extends DloError {
  readonly code = "KERNEL/SETTLEMENT_VIOLATION";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly reason: "unknown-token" | "epoch-mismatch" | "duplicate-token",
  ) {
    super(message);
  }
}

export class BudgetExhaustedError extends DloError {
  readonly code = "KERNEL/BUDGET_EXHAUSTED";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly dimension: "usd" | "tokens" | "wallClockMs" | "spawnDepth" | "turns",
    public readonly spent: number,
    public readonly limit: number,
  ) {
    super(message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Journal errors — persistence, corruption
// ─────────────────────────────────────────────────────────────────

export class JournalCorruptionError extends DloError {
  readonly code = "JOURNAL/CORRUPTION";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly seq: number,
    public readonly reason: string,
  ) {
    super(message);
  }
}

export class JournalIntegrityError extends DloError {
  readonly code = "JOURNAL/INTEGRITY";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly seq: number,
  ) {
    super(message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Plan errors — validation, schema
// ─────────────────────────────────────────────────────────────────

export class PlanValidationError extends DloError {
  readonly code = "PLAN/VALIDATION";
  readonly retryable = true; // can steer the planner

  constructor(
    message: string,
    public readonly issues: ReadonlyArray<{
      path: string;
      code: string;
      message: string;
    }>,
  ) {
    super(message);
  }
}

export class PlanCycleError extends DloError {
  readonly code = "PLAN/CYCLE_DETECTED";
  readonly retryable = true;

  constructor(
    message: string,
    public readonly cycle: ReadonlyArray<string>,
  ) {
    super(message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Exit clause errors — evaluation, unknown kind
// ─────────────────────────────────────────────────────────────────

export class ExitClauseEvaluationError extends DloError {
  readonly code = "VERIFY/CLAUSE_EVALUATION";
  readonly retryable = true;

  constructor(
    message: string,
    public readonly clauseId: string,
    opts?: { phase?: PipelinePhase; cause?: unknown },
  ) {
    super(message, opts?.phase, opts?.cause);
  }
}

export class UnknownClauseKindError extends DloError {
  readonly code = "VERIFY/UNKNOWN_CLAUSE_KIND";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly kind: string,
    public readonly registered: ReadonlyArray<string>,
  ) {
    super(message);
  }
}

// ─────────────────────────────────────────────────────────────────
// HITL/Gate errors
// ─────────────────────────────────────────────────────────────────

export class GateRejectedError extends DloError {
  readonly code = "HITL/REJECTED";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly gateId: string,
    public readonly reason: string,
  ) {
    super(message);
  }
}

export class GateExpiredError extends DloError {
  readonly code = "HITL/EXPIRED";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly gateId: string,
  ) {
    super(message);
  }
}

export class HitlTransportError extends DloError {
  readonly code = "HITL/TRANSPORT";
  readonly retryable = true;

  constructor(
    message: string,
    public readonly transport: string,
    opts?: { cause?: unknown },
  ) {
    super(message, undefined, opts?.cause);
  }
}

// ─────────────────────────────────────────────────────────────────
// Configuration errors
// ─────────────────────────────────────────────────────────────────

export class ConfigValidationError extends DloError {
  readonly code = "CONFIG/VALIDATION";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly issues: ReadonlyArray<{
      path: string;
      message: string;
    }>,
  ) {
    super(message);
  }
}

export class ConfigResolutionError extends DloError {
  readonly code = "CONFIG/RESOLUTION";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly missingEnv: ReadonlyArray<string>,
  ) {
    super(message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Plugin errors
// ─────────────────────────────────────────────────────────────────

export class PluginLoadError extends DloError {
  readonly code = "PLUGIN/LOAD";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly packageName: string,
    opts?: { cause?: unknown },
  ) {
    super(message, undefined, opts?.cause);
  }
}

export class PluginRegistrationError extends DloError {
  readonly code = "PLUGIN/REGISTRATION";
  readonly retryable = false;

  constructor(
    message: string,
    public readonly pluginName: string,
    opts?: { cause?: unknown },
  ) {
    super(message, undefined, opts?.cause);
  }
}

// ─────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────

export function isDloError(err: unknown): err is DloError {
  return err instanceof DloError;
}

export function isRetryable(err: unknown): boolean {
  return isDloError(err) && err.retryable;
}

export function serializeDloError(err: DloError): {
  code: string;
  message: string;
  phase?: PipelinePhase;
  retryable: boolean;
  details?: Record<string, unknown>;
} {
  const result: {
    code: string;
    message: string;
    phase?: PipelinePhase;
    retryable: boolean;
    details?: Record<string, unknown>;
  } = {
    code: err.code,
    message: err.message,
    retryable: err.retryable,
    details: {
      // Serialize subclass-specific fields
      ...(err instanceof BudgetExhaustedError && {
        dimension: err.dimension,
        spent: err.spent,
        limit: err.limit,
      }),
      ...(err instanceof PlanValidationError && { issues: err.issues }),
      ...(err instanceof PlanCycleError && { cycle: err.cycle }),
    },
  };
  if (err.phase !== undefined) {
    result.phase = err.phase;
  }
  return result;
}
