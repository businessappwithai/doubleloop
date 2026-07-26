// src/core/errors.ts — the one error hierarchy in the app (Architecture.md "Error handling").
// Domain and adapter code throws these; only the GraphQL error-translation point at the
// orchestrator boundary is allowed to inspect `code`/`httpStatus` and convert them to a
// transport shape. Nothing in `src/core` may import this file for its *side effects* — it has
// none; it is pure data plus construction logic. `cause` is threaded through the ES2022
// `Error` cause option so a caught adapter error (e.g. a `pg` driver error) is never discarded,
// only re-labelled.

/**
 * Extra structured context about a failure, safe to serialize into a GraphQL error's
 * `extensions.details` or a log line. Never put a secret in here.
 */
export type ErrorDetails = Readonly<Record<string, unknown>>;

export interface AppErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Base of every typed failure in the app. `code` is the machine-readable discriminator carried
 * into `extensions.code` on the GraphQL boundary; `httpStatus` is the nearest REST-style status
 * for any non-GraphQL surface (health checks, the collab websocket upgrade). Both are `readonly`
 * so a catch block can never silently rewrite what a lower layer decided the failure was.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details: ErrorDetails;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

/** The referenced entity does not exist (or is soft-deleted, which reads as absent). */
export class NotFoundError extends AppError {
  readonly code = "not_found";
  readonly httpStatus = 404;
}

/** Input failed a domain or schema invariant before any write was attempted. */
export class ValidationError extends AppError {
  readonly code = "validation";
  readonly httpStatus = 400;
}

/**
 * The requested change conflicts with the entity's current state: a unique constraint, a
 * cycle, a stale optimistic-concurrency version, or a "not empty" precondition on delete.
 */
export class ConflictError extends AppError {
  readonly code = "conflict";
  readonly httpStatus = 409;
}

/** The actor is authenticated but not permitted to perform this operation. */
export class ForbiddenError extends AppError {
  readonly code = "forbidden";
  readonly httpStatus = 403;
}

/**
 * An unexpected failure with no more specific typed error — the catch-all translation target
 * for an adapter exception that isn't itself an `AppError`. Never exposes `cause`'s message to
 * the transport layer; `message` here must already be transport-safe.
 */
export class InternalError extends AppError {
  readonly code = "internal";
  readonly httpStatus = 500;
}

/**
 * Configuration is missing, malformed, or forbidden for the current environment. `code` is
 * supplied per call site and namespaced by concern (`config.invalidDbUrl`, `db.unsupportedVersion`,
 * `git.credentialMissing`, `module.cycle`) rather than fixed, because config failures span many
 * subsystems and a single shared code would lose which one failed.
 */
export class ConfigError extends AppError {
  readonly httpStatus = 500;
  readonly code: string;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options);
    this.code = code;
  }
}

/**
 * A migration file is missing, out of order, or its checksum no longer matches what was
 * recorded when it ran. Same per-call-site `code` convention as `ConfigError`
 * (`migration.checksumMismatch`, `migration.gap`).
 */
export class MigrationError extends AppError {
  readonly httpStatus = 500;
  readonly code: string;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options);
    this.code = code;
  }
}

/** Narrows `unknown` (a catch variable, under `useUnknownInCatchVariables`) to `AppError`. */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Projects an `AppError` onto the shape a GraphQL `extensions` object (or any other transport
 * envelope) carries: the machine-readable code plus whatever structured details were attached
 * at the throw site. Never includes the stack or the raw `cause`.
 */
export function toErrorExtensions(err: AppError): Readonly<{ code: string; details: ErrorDetails }> {
  return Object.freeze({ code: err.code, details: err.details });
}
