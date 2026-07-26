// src/core/ids.ts — branded entity ids (Architecture.md "core" §1: "a raw string can never be
// passed where a BundleId is expected"). The brand is a phantom field that exists only in the
// type system; at runtime these are plain strings. The only way to obtain a branded id is
// through its `asXId` constructor, and the only thing that constructor does beyond branding is
// reject a value that isn't a v4 UUID — the shape `gen_random_uuid()` produces for every primary
// key in Database.md. Rejecting the wrong UUID version here, not just "not a UUID at all", is
// deliberate: a v1/v5 id slipping through would still look plausible in a log line while never
// matching a row.
import { ValidationError } from "./errors";

export type BundleId = string & { readonly __brand: "BundleId" };
export type ConceptId = string & { readonly __brand: "ConceptId" };
export type ActorId = string & { readonly __brand: "ActorId" };
export type RevisionId = string & { readonly __brand: "RevisionId" };

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuidV4(typeName: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${typeName} must be a non-empty UUID string`, {
      details: { typeName, value },
    });
  }
  if (!UUID_V4_PATTERN.test(value)) {
    throw new ValidationError(`${typeName} must be a v4 UUID`, {
      details: { typeName, value },
    });
  }
  return value;
}

/** Brands `value` as a {@link BundleId}. Throws `ValidationError` if it is not a v4 UUID. */
export function asBundleId(value: string): BundleId {
  return assertUuidV4("BundleId", value) as BundleId;
}

/** Brands `value` as a {@link ConceptId}. Throws `ValidationError` if it is not a v4 UUID. */
export function asConceptId(value: string): ConceptId {
  return assertUuidV4("ConceptId", value) as ConceptId;
}

/** Brands `value` as an {@link ActorId}. Throws `ValidationError` if it is not a v4 UUID. */
export function asActorId(value: string): ActorId {
  return assertUuidV4("ActorId", value) as ActorId;
}

/** Brands `value` as a {@link RevisionId}. Throws `ValidationError` if it is not a v4 UUID. */
export function asRevisionId(value: string): RevisionId {
  return assertUuidV4("RevisionId", value) as RevisionId;
}
