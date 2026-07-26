// src/core/context.ts — the per-request identity carried through every module call
// (Architecture.md "orchestrator" §"Responsibilities": "create a per-request RequestContext").
// This is the *pure* half of that responsibility: validating and freezing the request id and
// actor. The orchestrator's own `createRequestContext` enriches this with side-effecting
// pieces (a logger child, a unit-of-work handle) that don't belong in `core` — this module
// stays free of the `Logger`/`Db` ports entirely, per the "core has zero I/O" rule.
import type { ActorId } from "./ids";
import { ValidationError } from "./errors";

/** The identity a mutation, revision, or collaboration session is attributed to. */
export interface Actor {
  readonly id: ActorId;
  readonly email: string;
  readonly displayName: string;
}

/** Per-request identity handed to every module method as the first argument. */
export interface RequestContext {
  readonly requestId: string;
  readonly actor: Actor;
}

/**
 * Builds a {@link RequestContext}. Throws `ValidationError` for a missing/blank `requestId` or a
 * missing `actor` — both are structural preconditions of every module call, not domain checks
 * any individual module should have to repeat.
 */
export function createRequestContext(input: { requestId: string; actor: Actor }): RequestContext {
  if (typeof input.requestId !== "string" || input.requestId.trim().length === 0) {
    throw new ValidationError("RequestContext requires a non-empty requestId", {
      details: { requestId: input.requestId },
    });
  }
  if (input.actor === null || input.actor === undefined) {
    throw new ValidationError("RequestContext requires an actor", {
      details: { requestId: input.requestId },
    });
  }
  return Object.freeze({ requestId: input.requestId, actor: input.actor });
}
