// src/server/schema.ts — module m15: merges every registered module's SDL fragment with the root
// document into one executable `GraphQLSchema`, and implements the `Node` field.
//
// Built with `graphql`'s own `buildSchema` (`buildASTSchema` under the hood), not
// `@graphql-tools/schema`'s `makeExecutableSchema` — the latter is not a declared dependency
// (Architecture.md's "Technology Choices" table lists only `graphql@^16`), and `bundle-schema.ts`'s
// own header comment already establishes this precedent project-wide ("Built that way
// (`buildASTSchema`/`extendSchema`, not `makeExecutableSchema`), a plain-SDL enum's internal value
// is its literal SDL name"). `buildSchema` produces a schema with no resolvers attached at all —
// every field falls back to `graphql`'s `defaultFieldResolver` (`source[fieldName]`) — so
// `attachResolvers` below is this file's own small stand-in for `addResolversToSchema`: it walks
// `schema.getTypeMap()` and assigns `.resolve` onto the exact fields each module's
// `SchemaContribution.resolvers` names, throwing loudly (never silently skipping) if a module's
// map names a type or field the merged SDL does not actually declare — a mismatch there is a
// module wiring bug, not a runtime condition to tolerate.
//
// Concatenating raw SDL strings (not `scripts/emit-schema.ts`'s `mergeSchemaDocuments`, which is
// deliberately build-tooling-only — see that file's own header) is safe here because
// `buildSchema`/`buildASTSchema` already reject two *definitions* (not extensions) of the same
// type name with its own parse error; this file does not need to reimplement that check to get the
// same safety net at runtime.
//
// `resolveNode` is the one piece of real logic in this file (Architecture.md rule 2 makes the
// orchestrator/schema layer "thin delegation", and this is exactly that): decode the opaque global
// id, and dispatch to the module that owns the decoded type. `Bundle` dispatches cleanly —
// `BundleModule.get(ctx, id)` needs nothing else. `Concept` cannot: `ConceptModule.get(ctx,
// bundleId, id)` (and `ConceptRepository.findById(bundleId, id)` beneath it) require a bundle
// scope no `Concept` global id carries — `concept-schema.ts`'s own `toGlobalId("Concept",
// concept.id)` call site (module m10, out of this module's `touches` list) encodes only the
// concept's own uuid, never its bundle. There is no by-id-only lookup anywhere in `ConceptModule`'s
// public interface to call instead, and this module may not add one to a file m10 owns. Rather
// than invent a bundle scope (there is none to invent) or silently return the wrong thing, `node(id)`
// for a `Concept` fails loudly with a typed, documented `NotFoundError` — consistent with "no
// module imports another module's repository internals" and "no silent fallbacks".
import {
  buildSchema,
  GraphQLInterfaceType,
  GraphQLObjectType,
  type GraphQLFieldResolver,
  type GraphQLSchema,
} from "graphql";
import rootTypeDefs from "../graphql/schema.root.graphql?raw";
import type { RequestContext } from "../core/context";
import { ConfigError, NotFoundError, ValidationError } from "../core/errors";
import { fromGlobalId, type DecodedGlobalId } from "../core/global-id";
import { asBundleId } from "../core/ids";
import type { ModuleDescriptor, ModuleRegistry, OrchestratorModules, ResolverMap } from "./registry";
import { resolveWiringOrder } from "./registry";

/** The per-request context every merged resolver receives. Modules that need their own module
 * instance declare it here (`bundles`, `concepts`, `hierarchy` — see each module's own
 * `*GraphQLContext` interface); modules wired via a closure over their `create()`-time instance
 * (`documents`, `search`, `collab`, `gitSync` — see each one's `index.ts`) only ever read the base
 * `RequestContext` fields off `ctx`. */
export interface OrchestratorRequestContext extends RequestContext {
  readonly bundles: OrchestratorModules["bundles"];
  readonly concepts: OrchestratorModules["concepts"];
  readonly hierarchy: OrchestratorModules["hierarchy"];
}

type MergedResolvers = Record<string, Record<string, GraphQLFieldResolver<any, any, any, any>>>;

/**
 * Decodes `id` for the `node(id:)` field. `fromGlobalId` throws `ValidationError('globalId.malformed')`
 * for every malformed shape it recognises, folding "not base64", "no separator", "empty part" and
 * "unknown node type" into one code — but Implementation.md's m15 contract distinguishes them:
 * an unrecognised type name is a `node(id:)`-level "not found" (a syntactically fine reference to
 * something this schema does not expose as a `Node`), while every other malformed shape is
 * genuinely a bad-input `ValidationError`. This re-classifies only the former, by matching the
 * specific `reason` `fromGlobalId` attaches — `global-id.ts` (module m7) is not in this module's
 * `touches` list, so this reclassification happens here rather than by changing what it throws.
 */
function decodeNodeId(id: string): DecodedGlobalId {
  try {
    return fromGlobalId(id);
  } catch (err) {
    if (err instanceof ValidationError) {
      const reason = err.details["reason"];
      if (typeof reason === "string" && reason.startsWith("unknown node type")) {
        throw new NotFoundError("no Node type matches this global id", {
          details: { reason: "node.unknownType", id },
        });
      }
    }
    throw err;
  }
}

async function resolveNode(
  _source: unknown,
  args: { id: string },
  ctx: OrchestratorRequestContext,
): Promise<(Record<string, unknown> & { __typename: string }) | null> {
  const decoded = decodeNodeId(args.id);

  if (decoded.typeName === "Bundle") {
    const bundle = await ctx.bundles.get(ctx, asBundleId(decoded.localId));
    return { ...bundle, __typename: "Bundle" };
  }

  // decoded.typeName is `NodeTypeName` ("Bundle" | "Concept"); the `Bundle` arm above returned,
  // so the only value left here is "Concept" — see this file's header comment for why it cannot
  // be resolved by id alone.
  throw new NotFoundError("a Concept cannot be resolved by node(id:) alone; it requires a bundle scope", {
    details: { reason: "node.conceptRequiresBundleScope", typeName: decoded.typeName, id: args.id },
  });
}

const ROOT_RESOLVERS: MergedResolvers = {
  Query: {
    node: resolveNode,
  },
};

/**
 * Merges every descriptor's `schema.resolvers` (in wiring order, so a duplicate-field failure
 * always names the same "first defined at / also defined at" pair regardless of registry
 * iteration order) into one map, throwing `ConfigError('schema.duplicateResolver')` if two
 * descriptors each contribute a resolver for the same `Type.field` — SDL legally lets two
 * fragments each `extend type Concept` with *different* fields (`hierarchy-schema.graphql` adding
 * `children`/`ancestors` to the `Concept` `concept-schema.graphql` defines), but two resolvers for
 * the *same* field would silently mean "whichever module happened to merge last wins", exactly the
 * kind of silent fallback the project's design principles forbid.
 */
function mergeResolvers(order: readonly ModuleDescriptor[]): MergedResolvers {
  const merged: MergedResolvers = { Query: { ...ROOT_RESOLVERS["Query"] } };

  for (const descriptor of order) {
    if (!descriptor.schema) {
      continue;
    }
    // See registry.ts's `SchemaContribution.resolvers` comment for why this cast is necessary:
    // the field is typed as the bare `object` there (some modules' resolver maps are named
    // interfaces without an index signature), but every module's actual value is a plain
    // `{ TypeName: { fieldName: resolver } }` map — the shape this function needs to walk.
    const resolvers = descriptor.schema.resolvers as ResolverMap;
    for (const [typeName, fields] of Object.entries(resolvers)) {
      const target = merged[typeName] ?? (merged[typeName] = {});
      for (const [fieldName, resolve] of Object.entries(fields)) {
        if (Object.prototype.hasOwnProperty.call(target, fieldName)) {
          throw new ConfigError(
            "schema.duplicateResolver",
            `field "${typeName}.${fieldName}" is contributed by more than one module`,
            { details: { typeName, fieldName, module: descriptor.name } },
          );
        }
        target[fieldName] = resolve;
      }
    }
  }

  return merged;
}

/** Assigns `.resolve` on the exact fields `resolvers` names. Throws `ConfigError` for a type or
 * field the merged SDL does not declare — a module-wiring bug, never a condition to tolerate. */
function attachResolvers(schema: GraphQLSchema, resolvers: MergedResolvers): void {
  const typeMap = schema.getTypeMap();

  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = typeMap[typeName];
    if (!(type instanceof GraphQLObjectType) && !(type instanceof GraphQLInterfaceType)) {
      throw new ConfigError(
        "schema.unknownResolverType",
        `a module's resolvers reference GraphQL type "${typeName}", which the merged schema does not declare`,
        { details: { typeName } },
      );
    }

    const typeFields = type.getFields();
    for (const [fieldName, resolve] of Object.entries(fields)) {
      const field = typeFields[fieldName];
      if (!field) {
        throw new ConfigError(
          "schema.unknownResolverField",
          `a module's resolvers reference field "${typeName}.${fieldName}", which the merged schema does not declare`,
          { details: { typeName, fieldName } },
        );
      }
      field.resolve = resolve;
    }
  }
}

/**
 * Builds the one executable schema for `registry`: concatenates the root SDL document with every
 * module's fragment (in {@link resolveWiringOrder}'s order), builds it with `buildSchema`, then
 * attaches every resolver — the root `Query.node` plus every module's own. Pure given `registry`;
 * callers (`orchestrator.ts`) are what memoize a single call's result per orchestrator instance.
 */
export function buildOrchestratorSchema(registry: ModuleRegistry): GraphQLSchema {
  const order = resolveWiringOrder(registry);
  const fragments = order.flatMap((descriptor) => (descriptor.schema ? [descriptor.schema.typeDefs] : []));
  const sdl = [rootTypeDefs, ...fragments].join("\n\n");
  const schema = buildSchema(sdl, { assumeValidSDL: false });
  attachResolvers(schema, mergeResolvers(order));
  return schema;
}
