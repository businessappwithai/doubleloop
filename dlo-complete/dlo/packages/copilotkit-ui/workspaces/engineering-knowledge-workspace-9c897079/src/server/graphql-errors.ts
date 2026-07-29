// src/server/graphql-errors.ts — module m15's one `AppError` → GraphQL translation point
// (Architecture.md "Error handling": "One hierarchy, one translation point... it never leaks an
// internal message for an unknown error"). `toGraphQLError` is the whole of that decision:
// an `AppError` becomes a `GraphQLError` carrying `extensions.code`/`extensions.details` straight
// from `core/errors.ts`'s own `toErrorExtensions`, using the `AppError`'s own (already
// transport-safe, per that file's header) `message`. Anything else — a raw `Error`, a rejected
// promise's string, a driver exception that was never wrapped — becomes a fixed, generic
// `InternalError` message; the real value is logged (never thrown away) but never placed on the
// `GraphQLError` itself, which is what "never leaked" means here.
import { GraphQLError } from "graphql";
import { isAppError, toErrorExtensions } from "../core/errors";
import type { Logger } from "./ports";

const GENERIC_INTERNAL_MESSAGE = "Internal server error";

function toLoggableCause(err: unknown): { message: string; stack: string | null; name: string | null } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack ?? null, name: err.name };
  }
  return { message: String(err), stack: null, name: null };
}

/**
 * Maps a thrown value to a `GraphQLError` safe to place on a response's `errors` array.
 *
 * - An `AppError` (`NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`,
 *   `ConfigError`, `MigrationError`, or a future subclass) keeps its own `message` and carries
 *   `extensions.code`/`extensions.details` — the exact shape `toErrorExtensions` already builds.
 * - Anything else is logged in full via `logger.error` (message, stack, and constructor name when
 *   available) and reported to the caller only as a fixed `"Internal server error"` message with
 *   `extensions.code = "internal"` — the same code `InternalError` itself uses, so a caller can't
 *   distinguish "a typed InternalError was thrown" from "something unwrapped blew up" and doesn't
 *   need to: both are equally "our fault, nothing you can do about it."
 */
export function toGraphQLError(err: unknown, logger: Logger): GraphQLError {
  if (isAppError(err)) {
    const { code, details } = toErrorExtensions(err);
    return new GraphQLError(err.message, { extensions: { code, details } });
  }

  const cause = toLoggableCause(err);
  logger.error("graphql.unhandledError", { message: cause.message, stack: cause.stack, name: cause.name });
  return new GraphQLError(GENERIC_INTERNAL_MESSAGE, { extensions: { code: "internal" } });
}

/**
 * Re-maps a `GraphQLError` produced by `graphql`'s own `execute()` — which wraps every
 * field-resolver throw in a `GraphQLError` whose `.originalError` is the value actually thrown —
 * through {@link toGraphQLError}, while preserving the response-shape fields (`path`, `nodes`,
 * `source`, `positions`) `execute()` computed. A `GraphQLError` with no `originalError` (a pure
 * syntax/validation-rule violation, never a domain throw) passes through `toGraphQLError` as
 * itself, which is intentionally not an `AppError` and therefore becomes a generic `InternalError`
 * — `orchestrator.ts` never calls this for parse/validation errors precisely to avoid that; see
 * its own header comment.
 */
export function remapExecutionError(error: GraphQLError, logger: Logger): GraphQLError {
  const mapped = toGraphQLError(error.originalError ?? error, logger);
  return new GraphQLError(mapped.message, {
    ...(error.nodes !== undefined ? { nodes: error.nodes } : {}),
    ...(error.source !== undefined ? { source: error.source } : {}),
    ...(error.positions !== undefined ? { positions: error.positions } : {}),
    ...(error.path !== undefined ? { path: error.path } : {}),
    extensions: mapped.extensions,
  });
}
