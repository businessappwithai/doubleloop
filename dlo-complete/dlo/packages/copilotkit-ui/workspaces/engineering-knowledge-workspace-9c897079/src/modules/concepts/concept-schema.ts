// src/modules/concepts/concept-schema.ts — the resolver map for concept-schema.graphql
// (Implementation.md m10). Mirrors `bundle-schema.ts`'s shape exactly: `ConceptGraphQLContext` is
// this module's own forward-compatible stand-in for the real per-request context m15 will build
// (see that file's header comment for why), and every mutation input builder omits — rather than
// passes `undefined` for — an optional field that was not supplied, per `tsconfig.base.json`'s
// `exactOptionalPropertyTypes`.
import type { Connection } from "../../core/connection";
import type { RequestContext } from "../../core/context";
import { NotFoundError, ValidationError } from "../../core/errors";
import { fromGlobalId, toGlobalId } from "../../core/global-id";
import type { BundleId, ConceptId } from "../../core/ids";
import { asBundleId, asConceptId } from "../../core/ids";
import type { Concept } from "../../core/types";
import type { ConceptModule, CreateConceptInput, UpdateConceptMetadataPatch } from "./concept-module";

/** The per-request GraphQL context every resolver in this file receives. */
export interface ConceptGraphQLContext extends RequestContext {
  readonly concepts: ConceptModule;
}

/** Throws `ValidationError('globalId.wrongType')` if `id` does not decode as a `Bundle`. */
export function decodeBundleId(id: string): BundleId {
  const decoded = fromGlobalId(id);
  if (decoded.typeName !== "Bundle") {
    throw new ValidationError("globalId.wrongType", {
      details: { id, expected: "Bundle", actual: decoded.typeName },
    });
  }
  return asBundleId(decoded.localId);
}

/** Throws `ValidationError('globalId.wrongType')` if `id` does not decode as a `Concept`. */
export function decodeConceptId(id: string): ConceptId {
  const decoded = fromGlobalId(id);
  if (decoded.typeName !== "Concept") {
    throw new ValidationError("globalId.wrongType", {
      details: { id, expected: "Concept", actual: decoded.typeName },
    });
  }
  return asConceptId(decoded.localId);
}

// ---------------------------------------------------------------------------
// Concept field resolvers
// ---------------------------------------------------------------------------

export const conceptFieldResolvers = {
  id: (concept: Concept): string => toGlobalId("Concept", concept.id),
  bundleId: (concept: Concept): string => toGlobalId("Bundle", concept.bundleId),
  parentId: (concept: Concept): string | null =>
    concept.parentId === null ? null : toGlobalId("Concept", concept.parentId),
  slug: (concept: Concept): string => concept.slug,
  path: (concept: Concept): string => concept.path,
  title: (concept: Concept): string => concept.title,
  sortKey: (concept: Concept): string => concept.sortKey,
  depth: (concept: Concept): number => concept.depth,
  isIndex: (concept: Concept): boolean => concept.isIndex,
  childCount: (concept: Concept): number => concept.childCount,
  version: (concept: Concept): number => concept.version,
  createdAt: (concept: Concept): string => concept.createdAt,
  updatedAt: (concept: Concept): string => concept.updatedAt,
};

// ---------------------------------------------------------------------------
// Query resolvers
// ---------------------------------------------------------------------------

export interface ConceptQueryArgs {
  readonly bundleId: string;
  readonly id: string;
}

export interface ConceptByPathQueryArgs {
  readonly bundleId: string;
  readonly path: string;
}

export interface ConceptsQueryArgs {
  readonly bundleId: string;
  readonly first?: number;
  readonly after?: string;
  readonly last?: number;
  readonly before?: string;
}

/**
 * Maps `NotFoundError('concept.notFound')` to `null`, rethrowing everything else.
 *
 * `concept` and `conceptByPath` are declared **nullable** in `concept-schema.graphql`
 * (`concept(...): Concept`, not `Concept!`), but `ConceptModule.get`/`getByPath` signal absence by
 * throwing — that is their documented contract, and other callers depend on it. Without this
 * translation the nullable field could never actually be null, and asking for something that does
 * not exist failed the whole operation instead of returning `null` for one field.
 *
 * That is not hypothetical: the bundle route asks for `conceptByPath(path: "index")` to find a
 * landing concept, a bundle is not required to have one, and every bundle without an `index`
 * concept rendered "Couldn't load this bundle — concept.notFound" instead of its concept tree. The
 * route already reads `data?.rootConcept?.id ?? null`; it was never given the chance.
 *
 * Only `concept.notFound` is swallowed. A `bundle.notFound`, a validation failure or a database
 * error still propagates — absence of one concept is a legitimate answer, everything else is not.
 */
const CONCEPT_NOT_FOUND = "concept.notFound";

async function orNullIfConceptMissing(load: () => Promise<Concept>): Promise<Concept | null> {
  try {
    return await load();
  } catch (err: unknown) {
    if (err instanceof NotFoundError && err.message === CONCEPT_NOT_FOUND) {
      return null;
    }
    throw err;
  }
}

async function resolveConcept(
  _source: unknown,
  args: ConceptQueryArgs,
  ctx: ConceptGraphQLContext,
): Promise<Concept | null> {
  return orNullIfConceptMissing(() =>
    ctx.concepts.get(ctx, decodeBundleId(args.bundleId), decodeConceptId(args.id)),
  );
}

async function resolveConceptByPath(
  _source: unknown,
  args: ConceptByPathQueryArgs,
  ctx: ConceptGraphQLContext,
): Promise<Concept | null> {
  return orNullIfConceptMissing(() =>
    ctx.concepts.getByPath(ctx, decodeBundleId(args.bundleId), args.path),
  );
}

async function resolveConcepts(
  _source: unknown,
  args: ConceptsQueryArgs,
  ctx: ConceptGraphQLContext,
): Promise<Connection<Concept>> {
  return ctx.concepts.list(ctx, decodeBundleId(args.bundleId), {
    ...(args.first != null ? { first: args.first } : {}),
    ...(args.after != null ? { after: args.after } : {}),
    ...(args.last != null ? { last: args.last } : {}),
    ...(args.before != null ? { before: args.before } : {}),
  });
}

export const conceptQueryResolvers = {
  concept: resolveConcept,
  conceptByPath: resolveConceptByPath,
  concepts: resolveConcepts,
};

// ---------------------------------------------------------------------------
// Mutation resolvers
// ---------------------------------------------------------------------------

export interface CreateConceptMutationInput {
  readonly bundleId: string;
  readonly parentId?: string;
  readonly slug: string;
  readonly title: string;
  readonly isIndex?: boolean;
}

export interface UpdateConceptMetadataMutationInput {
  readonly bundleId: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly isIndex?: boolean;
}

export interface ArchiveConceptMutationInput {
  readonly bundleId: string;
  readonly id: string;
  readonly expectedVersion: number;
}

async function resolveCreateConcept(
  _source: unknown,
  args: { input: CreateConceptMutationInput },
  ctx: ConceptGraphQLContext,
): Promise<{ concept: Concept }> {
  const { input } = args;
  const domainInput: CreateConceptInput = {
    bundleId: decodeBundleId(input.bundleId),
    parentId: input.parentId !== undefined ? decodeConceptId(input.parentId) : null,
    slug: input.slug,
    title: input.title,
    ...(input.isIndex !== undefined ? { isIndex: input.isIndex } : {}),
  };
  const concept = await ctx.concepts.create(ctx, domainInput);
  return { concept };
}

async function resolveUpdateConceptMetadata(
  _source: unknown,
  args: { input: UpdateConceptMetadataMutationInput },
  ctx: ConceptGraphQLContext,
): Promise<{ concept: Concept }> {
  const { input } = args;
  const patch: UpdateConceptMetadataPatch = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.isIndex !== undefined ? { isIndex: input.isIndex } : {}),
  };
  const concept = await ctx.concepts.updateMetadata(
    ctx,
    decodeBundleId(input.bundleId),
    decodeConceptId(input.id),
    input.expectedVersion,
    patch,
  );
  return { concept };
}

async function resolveArchiveConcept(
  _source: unknown,
  args: { input: ArchiveConceptMutationInput },
  ctx: ConceptGraphQLContext,
): Promise<{ concept: Concept }> {
  const { input } = args;
  const concept = await ctx.concepts.archive(
    ctx,
    decodeBundleId(input.bundleId),
    decodeConceptId(input.id),
    input.expectedVersion,
  );
  return { concept };
}

export const conceptMutationResolvers = {
  createConcept: resolveCreateConcept,
  updateConceptMetadata: resolveUpdateConceptMetadata,
  archiveConcept: resolveArchiveConcept,
};

export const conceptResolvers = {
  Concept: conceptFieldResolvers,
  Query: conceptQueryResolvers,
  Mutation: conceptMutationResolvers,
};
