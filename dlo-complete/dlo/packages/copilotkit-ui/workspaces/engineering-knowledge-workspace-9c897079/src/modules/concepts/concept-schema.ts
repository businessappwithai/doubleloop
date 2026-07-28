// src/modules/concepts/concept-schema.ts — the resolver map for concept-schema.graphql
// (Implementation.md m10). Mirrors `bundle-schema.ts`'s shape exactly: `ConceptGraphQLContext` is
// this module's own forward-compatible stand-in for the real per-request context m15 will build
// (see that file's header comment for why), and every mutation input builder omits — rather than
// passes `undefined` for — an optional field that was not supplied, per `tsconfig.base.json`'s
// `exactOptionalPropertyTypes`.
import type { Connection } from "../../core/connection";
import type { RequestContext } from "../../core/context";
import { ValidationError } from "../../core/errors";
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

async function resolveConcept(
  _source: unknown,
  args: ConceptQueryArgs,
  ctx: ConceptGraphQLContext,
): Promise<Concept> {
  return ctx.concepts.get(ctx, decodeBundleId(args.bundleId), decodeConceptId(args.id));
}

async function resolveConceptByPath(
  _source: unknown,
  args: ConceptByPathQueryArgs,
  ctx: ConceptGraphQLContext,
): Promise<Concept> {
  return ctx.concepts.getByPath(ctx, decodeBundleId(args.bundleId), args.path);
}

async function resolveConcepts(
  _source: unknown,
  args: ConceptsQueryArgs,
  ctx: ConceptGraphQLContext,
): Promise<Connection<Concept>> {
  return ctx.concepts.list(ctx, decodeBundleId(args.bundleId), {
    ...(args.first !== undefined ? { first: args.first } : {}),
    ...(args.after !== undefined ? { after: args.after } : {}),
    ...(args.last !== undefined ? { last: args.last } : {}),
    ...(args.before !== undefined ? { before: args.before } : {}),
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
