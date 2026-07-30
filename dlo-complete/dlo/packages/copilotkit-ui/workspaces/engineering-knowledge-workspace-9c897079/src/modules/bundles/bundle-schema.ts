// src/modules/bundles/bundle-schema.ts — the resolver map for bundle-schema.graphql
// (Implementation.md m9). The `src/server/registry.ts`/`schema.ts` assembly point that would
// declare the canonical `ModuleDescriptor`/`SchemaContribution` types is module m15 and does not
// exist yet (Implementation.md "Build Order": m9 runs in Wave 3, m15 in Wave 4, and modules never
// import each other). `BundleGraphQLContext` is this module's own forward-compatible stand-in:
// it extends the real `RequestContext` (so every resolver can hand `ctx` straight through to
// `BundleModule` methods unchanged) and adds the one thing a resolver needs that a pure
// `RequestContext` does not carry — a handle to the wired module instance, keyed the same way
// `OrchestratorModules` names it in Architecture.md. When m15 assembles the real per-request
// context it only needs to satisfy this shape, not replace it.
//
// Enum serialisation: Architecture.md's "GraphQL server" choice is `graphql`'s `execute()` over a
// schema built from concatenated SDL text, with no `@graphql-tools/schema` dependency declared in
// package.json. Built that way (`buildASTSchema`/`extendSchema`, not `makeExecutableSchema`), a
// plain-SDL enum's internal value is its literal SDL name — there is nowhere in this module's
// `SchemaContribution` to attach a custom internal value. So `defaultTrust` is translated
// explicitly at the boundary: the domain's hyphenated `TrustLevel` ("machine-confirmed") becomes
// the enum's SCREAMING_SNAKE_CASE name ("MACHINE_CONFIRMED") going out, and the reverse coming in
// through a mutation input argument.
import type { Connection } from "../../core/connection";
import type { RequestContext } from "../../core/context";
import { ValidationError } from "../../core/errors";
import { fromGlobalId, toGlobalId } from "../../core/global-id";
import type { BundleId } from "../../core/ids";
import { asBundleId } from "../../core/ids";
import type { Bundle, TrustLevel } from "../../core/types";
import type { BundleModule, CreateBundleInput } from "./bundle-module";

/** The per-request GraphQL context every resolver in this file receives. */
export interface BundleGraphQLContext extends RequestContext {
  readonly bundles: BundleModule;
}

const TRUST_TO_GRAPHQL: Readonly<Record<TrustLevel, string>> = {
  unverified: "UNVERIFIED",
  "machine-confirmed": "MACHINE_CONFIRMED",
  "human-reviewed": "HUMAN_REVIEWED",
};

const TRUST_FROM_GRAPHQL: Readonly<Record<string, TrustLevel>> = {
  UNVERIFIED: "unverified",
  MACHINE_CONFIRMED: "machine-confirmed",
  HUMAN_REVIEWED: "human-reviewed",
};

export function trustLevelToGraphQL(level: TrustLevel): string {
  return TRUST_TO_GRAPHQL[level];
}

/** Throws `ValidationError('bundle.invalidTrustLevel')` for a name outside the `TrustLevel` enum. */
export function trustLevelFromGraphQL(value: string): TrustLevel {
  const mapped = TRUST_FROM_GRAPHQL[value];
  if (mapped === undefined) {
    throw new ValidationError("bundle.invalidTrustLevel", { details: { value } });
  }
  return mapped;
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

// ---------------------------------------------------------------------------
// Bundle field resolvers
// ---------------------------------------------------------------------------

export const bundleFieldResolvers = {
  id: (bundle: Bundle): string => toGlobalId("Bundle", bundle.id),
  workspaceId: (bundle: Bundle): string => bundle.workspaceId,
  slug: (bundle: Bundle): string => bundle.slug,
  title: (bundle: Bundle): string => bundle.title,
  description: (bundle: Bundle): string => bundle.description,
  okfVersion: (bundle: Bundle): string => bundle.okfVersion,
  defaultTrust: (bundle: Bundle): string => trustLevelToGraphQL(bundle.defaultTrust),
  conceptCount: (bundle: Bundle): number => bundle.conceptCount,
  version: (bundle: Bundle): number => bundle.version,
  createdAt: (bundle: Bundle): string => bundle.createdAt,
  updatedAt: (bundle: Bundle): string => bundle.updatedAt,
};

// ---------------------------------------------------------------------------
// Query resolvers
// ---------------------------------------------------------------------------

export interface BundleQueryArgs {
  readonly id: string;
}

export interface BundlesQueryArgs {
  readonly workspaceId: string;
  readonly first?: number;
  readonly after?: string;
  readonly last?: number;
  readonly before?: string;
}

async function resolveBundle(
  _source: unknown,
  args: BundleQueryArgs,
  ctx: BundleGraphQLContext,
): Promise<Bundle> {
  return ctx.bundles.get(ctx, decodeBundleId(args.id));
}

async function resolveBundles(
  _source: unknown,
  args: BundlesQueryArgs,
  ctx: BundleGraphQLContext,
): Promise<Connection<Bundle>> {
  return ctx.bundles.list(ctx, args.workspaceId, {
    ...(args.first != null ? { first: args.first } : {}),
    ...(args.after != null ? { after: args.after } : {}),
    ...(args.last != null ? { last: args.last } : {}),
    ...(args.before != null ? { before: args.before } : {}),
  });
}

export const bundleQueryResolvers = {
  bundle: resolveBundle,
  bundles: resolveBundles,
};

// ---------------------------------------------------------------------------
// Mutation resolvers
// ---------------------------------------------------------------------------

export interface CreateBundleMutationInput {
  readonly workspaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly okfVersion?: string;
  readonly defaultTrust?: string;
}

export interface RenameBundleMutationInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly title: string;
}

export interface ArchiveBundleMutationInput {
  readonly id: string;
  readonly expectedVersion: number;
}

async function resolveCreateBundle(
  _source: unknown,
  args: { input: CreateBundleMutationInput },
  ctx: BundleGraphQLContext,
): Promise<{ bundle: Bundle }> {
  const { input } = args;
  const domainInput: CreateBundleInput = {
    workspaceId: input.workspaceId,
    slug: input.slug,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.okfVersion !== undefined ? { okfVersion: input.okfVersion } : {}),
    ...(input.defaultTrust !== undefined ? { defaultTrust: trustLevelFromGraphQL(input.defaultTrust) } : {}),
  };
  const bundle = await ctx.bundles.create(ctx, domainInput);
  return { bundle };
}

async function resolveRenameBundle(
  _source: unknown,
  args: { input: RenameBundleMutationInput },
  ctx: BundleGraphQLContext,
): Promise<{ bundle: Bundle }> {
  const { input } = args;
  const bundle = await ctx.bundles.rename(ctx, decodeBundleId(input.id), input.expectedVersion, input.title);
  return { bundle };
}

async function resolveArchiveBundle(
  _source: unknown,
  args: { input: ArchiveBundleMutationInput },
  ctx: BundleGraphQLContext,
): Promise<{ bundle: Bundle }> {
  const { input } = args;
  const bundle = await ctx.bundles.archive(ctx, decodeBundleId(input.id), input.expectedVersion);
  return { bundle };
}

export const bundleMutationResolvers = {
  createBundle: resolveCreateBundle,
  renameBundle: resolveRenameBundle,
  archiveBundle: resolveArchiveBundle,
};

export const bundleResolvers = {
  Bundle: bundleFieldResolvers,
  Query: bundleQueryResolvers,
  Mutation: bundleMutationResolvers,
};
