// src/modules/search/search-schema.ts — resolver map for search-schema.graphql (module m12).
// Kept intentionally thin, mirroring the "orchestrator constructs, modules compute" rule
// (Architecture.md "Central Orchestrator" rule 2) applied to resolvers: this file only parses
// GraphQL args into `SearchQueryInput`/`ConnectionArgs` and encodes the Relay global id. Every
// domain decision — empty-query/term-limit validation, ranking, snippet highlighting — happens in
// `query-builder.ts`/`search-module.ts`, where it is unit tested; there is nothing left here to
// test beyond argument plumbing.
//
// `getSearchModule` is a thunk rather than a `SearchModule` value because the resolver map is
// built once, statically, as part of `index.ts`'s `ModuleDescriptor.schema` — before
// `ModuleDescriptor.create()` has run and produced the actual module instance. Resolving the
// module lazily, at request time, is what makes that ordering safe.
import { z } from "zod";
import type { GraphQLFieldResolver } from "graphql";
import type { RequestContext } from "../../core/context";
import type { ConnectionArgs } from "../../core/connection";
import { toGlobalId, localIdOfType } from "../../core/global-id";
import { asBundleId } from "../../core/ids";
import type { SearchHit, SearchModule } from "./search-module";
import type { SearchQueryInput } from "./query-builder";

const SearchArgsSchema = z.object({
  bundleId: z.string(),
  text: z.string().nullish(),
  containment: z.record(z.unknown()).nullish(),
  first: z.number().int().nullish(),
  after: z.string().nullish(),
  last: z.number().int().nullish(),
  before: z.string().nullish(),
});

type SearchArgs = z.infer<typeof SearchArgsSchema>;

function toSearchQuery(args: SearchArgs): SearchQueryInput {
  return {
    bundleId: asBundleId(localIdOfType(args.bundleId, "Bundle")),
    ...(args.text != null ? { text: args.text } : {}),
    ...(args.containment != null ? { containment: args.containment } : {}),
  };
}

function toConnectionArgs(args: SearchArgs): ConnectionArgs {
  return {
    ...(args.first != null ? { first: args.first } : {}),
    ...(args.after != null ? { after: args.after } : {}),
    ...(args.last != null ? { last: args.last } : {}),
    ...(args.before != null ? { before: args.before } : {}),
  };
}

export type SearchResolverMap = Record<string, Record<string, GraphQLFieldResolver<unknown, RequestContext>>>;

export function createSearchResolvers(getSearchModule: () => SearchModule): SearchResolverMap {
  return {
    Query: {
      search: async (_source, rawArgs) => {
        const args = SearchArgsSchema.parse(rawArgs);
        return getSearchModule().search(toSearchQuery(args), toConnectionArgs(args));
      },
    },
    SearchHit: {
      id: (source) => toGlobalId("Concept", (source as SearchHit).id),
    },
  };
}
