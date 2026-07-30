// src/modules/hierarchy/hierarchy-schema.ts — the resolver map for hierarchy-schema.graphql
// (Implementation.md m10). `children`/`ancestors` are field resolvers on `Concept`, not root Query
// fields — `source` is the already-resolved parent `Concept`, and its own `bundleId`/`id` are what
// scope the lookup, so neither field takes a `bundleId` argument (see the SDL fragment's header
// comment). `HierarchyGraphQLContext` and the two `decode*Id` helpers deliberately duplicate
// `concept-schema.ts`'s shapes rather than importing them — importing another module's GraphQL
// context type would be importing that module's internals, exactly what Architecture.md forbids
// even though `concepts` and `hierarchy` ship in the same build wave.
import type { RequestContext } from "../../core/context";
import { ValidationError } from "../../core/errors";
import { fromGlobalId } from "../../core/global-id";
import type { BundleId, ConceptId } from "../../core/ids";
import { asBundleId, asConceptId } from "../../core/ids";
import type { Concept } from "../../core/types";
import type { HierarchyModule, MoveConceptPatch } from "./hierarchy-module";

/** The per-request GraphQL context every resolver in this file receives. */
export interface HierarchyGraphQLContext extends RequestContext {
  readonly hierarchy: HierarchyModule;
}

/** Throws `ValidationError('globalId.wrongType')` if `id` does not decode as a `Bundle`. */
function decodeBundleId(id: string): BundleId {
  const decoded = fromGlobalId(id);
  if (decoded.typeName !== "Bundle") {
    throw new ValidationError("globalId.wrongType", {
      details: { id, expected: "Bundle", actual: decoded.typeName },
    });
  }
  return asBundleId(decoded.localId);
}

/** Throws `ValidationError('globalId.wrongType')` if `id` does not decode as a `Concept`. */
function decodeConceptId(id: string): ConceptId {
  const decoded = fromGlobalId(id);
  if (decoded.typeName !== "Concept") {
    throw new ValidationError("globalId.wrongType", {
      details: { id, expected: "Concept", actual: decoded.typeName },
    });
  }
  return asConceptId(decoded.localId);
}

// ---------------------------------------------------------------------------
// Concept field resolvers (children / ancestors)
// ---------------------------------------------------------------------------

/**
 * Pagination arguments arrive from GraphQL, where a nullable argument the caller did not mean to
 * supply comes through as an explicit `null`, not as `undefined` — Relay sends `after: null` for
 * the first page of every connection it fetches. Every forwarding site below therefore tests
 * `!= null`, not `!== undefined`: passing that `null` straight through reached the cursor decoder
 * and failed the request with `cursor.malformed`, so the first page of any Relay-driven connection
 * could never load.
 */
export interface ChildrenFieldArgs {
  readonly first?: number;
  readonly after?: string;
  readonly last?: number;
  readonly before?: string;
}

async function resolveChildren(source: Concept, args: ChildrenFieldArgs, ctx: HierarchyGraphQLContext) {
  return ctx.hierarchy.children(ctx, source.bundleId, source.id, {
    ...(args.first != null ? { first: args.first } : {}),
    ...(args.after != null ? { after: args.after } : {}),
    ...(args.last != null ? { last: args.last } : {}),
    ...(args.before != null ? { before: args.before } : {}),
  });
}

/**
 * `Bundle.children` — the bundle's top-level concepts, i.e. `parentId = null`.
 *
 * `HierarchyModule.children` has always accepted `null` for "bundle root" (its own signature says
 * so); nothing exposed it through GraphQL, which is the gap `use-tree-pagination.ts`'s header
 * documents. With this field the sidebar's root node is the Bundle itself, so a bundle needs no
 * concept at path "index" for its tree to render.
 */
async function resolveBundleChildren(
  source: { id: BundleId },
  args: ChildrenFieldArgs,
  ctx: HierarchyGraphQLContext,
) {
  return ctx.hierarchy.children(ctx, source.id, null, {
    ...(args.first != null ? { first: args.first } : {}),
    ...(args.after != null ? { after: args.after } : {}),
    ...(args.last != null ? { last: args.last } : {}),
    ...(args.before != null ? { before: args.before } : {}),
  });
}

export const bundleHierarchyFieldResolvers = {
  children: resolveBundleChildren,
};

async function resolveAncestors(source: Concept, _args: Record<string, never>, ctx: HierarchyGraphQLContext) {
  return ctx.hierarchy.ancestors(ctx, source.bundleId, source.id);
}

export const conceptHierarchyFieldResolvers = {
  children: resolveChildren,
  ancestors: resolveAncestors,
};

// ---------------------------------------------------------------------------
// Mutation resolver (moveConcept)
// ---------------------------------------------------------------------------

export interface MoveConceptMutationInput {
  readonly bundleId: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly newParentId?: string | null;
  readonly afterId?: string | null;
}

async function resolveMoveConcept(
  _source: unknown,
  args: { input: MoveConceptMutationInput },
  ctx: HierarchyGraphQLContext,
): Promise<{ concept: Concept }> {
  const { input } = args;
  const patch: MoveConceptPatch = {
    newParentId:
      input.newParentId === undefined || input.newParentId === null ? null : decodeConceptId(input.newParentId),
    ...(Object.prototype.hasOwnProperty.call(input, "afterId")
      ? { afterId: input.afterId === null ? null : decodeConceptId(input.afterId!) }
      : {}),
  };
  const concept = await ctx.hierarchy.move(
    ctx,
    decodeBundleId(input.bundleId),
    decodeConceptId(input.id),
    input.expectedVersion,
    patch,
  );
  return { concept };
}

export const hierarchyMutationResolvers = {
  moveConcept: resolveMoveConcept,
};

export const hierarchyResolvers = {
  Bundle: bundleHierarchyFieldResolvers,
  Concept: conceptHierarchyFieldResolvers,
  Mutation: hierarchyMutationResolvers,
};
