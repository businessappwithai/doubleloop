/**
 * Branded identifiers. Construction only via the make* factories.
 * Brand provides compile-time type safety; all values are stable UUIDs at runtime.
 */

export type PipelineId  = string & { readonly __brand: "PipelineId" };
export type ModuleId    = string & { readonly __brand: "ModuleId" };
export type AttemptId   = string & { readonly __brand: "AttemptId" };
export type GateId      = string & { readonly __brand: "GateId" };
export type RunToken    = string & { readonly __brand: "RunToken" };
export type SnapshotRef = string & { readonly __brand: "SnapshotRef" };
export type SessionRef  = string & { readonly __brand: "SessionRef" };

const cast = <T>(s: string): T => s as unknown as T;

export function makePipelineId(): PipelineId {
  return cast(crypto.randomUUID());
}

export function makeModuleId(slug: string): ModuleId {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(slug)) {
    throw new Error(`Invalid module slug: ${slug}`);
  }
  return cast(slug);
}

export function makeAttemptId(): AttemptId {
  return cast(crypto.randomUUID());
}

export function makeGateId(): GateId {
  return cast(crypto.randomUUID());
}

export function makeRunToken(): RunToken {
  return cast(crypto.randomUUID());
}

export function makeSnapshotRef(ref: string): SnapshotRef {
  if (!/^[\w.-]+$/.test(ref)) {
    throw new Error(`Invalid snapshot ref: ${ref}`);
  }
  return cast(ref);
}

export function makeSessionRef(ref: string): SessionRef {
  if (!/^[\w.-]+$/.test(ref)) {
    throw new Error(`Invalid session ref: ${ref}`);
  }
  return cast(ref);
}
