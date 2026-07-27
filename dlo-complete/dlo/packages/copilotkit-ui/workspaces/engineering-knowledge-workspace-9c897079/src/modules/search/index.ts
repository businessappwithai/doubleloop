// src/modules/search/index.ts — the ModuleDescriptor for module m12 (Architecture.md "How
// modules register"; Implementation.md m12, `dependsOn: []` — search reads `concepts` and
// `concept_documents` directly through its own repository, never through another module's
// interface). `src/server/registry.ts`, which owns the real generic `ModuleDescriptor`/
// `SchemaContribution` types, is module m15's responsibility and does not exist in this
// workspace yet. The shapes below are declared locally, field-for-field identical to
// Architecture.md's registry.ts contract (`name`, `dependsOn`, `create({ports,config,deps})`,
// `schema: {typeDefs, resolvers}`), so this descriptor already satisfies a future
// `ModuleDescriptor<"search">` by structural typing — no change needed here once m15 lands.
//
// `searchTypeDefs` is loaded via Vite's `?raw` import (ambient-declared in `vite/client.d.ts`,
// which `tsconfig.json`'s `types` already includes) rather than read from disk with `node:fs`:
// Architecture.md rule 4 reserves filesystem access for the orchestrator/adapters layer, and a
// build-time text import keeps this module's SDL fragment a plain string constant instead.
import type { GraphQLFieldResolver } from "graphql";
import type { AppConfig } from "../../config/config";
import { ConfigError } from "../../core/errors";
import type { RequestContext } from "../../core/context";
import type { Ports } from "../../server/ports";
import { createSearchRepository } from "./search-repository";
import { createSearchModule, type SearchModule } from "./search-module";
import { createSearchResolvers } from "./search-schema";
import searchTypeDefs from "./search-schema.graphql?raw";

export interface SchemaContribution {
  readonly typeDefs: string;
  readonly resolvers: Record<string, Record<string, GraphQLFieldResolver<unknown, RequestContext>>>;
}

export interface SearchModuleDescriptor {
  readonly name: "search";
  readonly dependsOn: readonly [];
  readonly create: (args: {
    readonly ports: Ports;
    readonly config: AppConfig;
    readonly deps: Readonly<Record<string, unknown>>;
  }) => SearchModule;
  readonly schema: SchemaContribution;
}

function createSearchModuleDescriptor(): SearchModuleDescriptor {
  let instance: SearchModule | undefined;

  const getSearchModule = (): SearchModule => {
    if (instance === undefined) {
      throw new ConfigError(
        "module.notInitialized",
        "search module used before its ModuleDescriptor.create() ran",
      );
    }
    return instance;
  };

  return {
    name: "search",
    dependsOn: [],
    create: ({ ports }) => {
      instance = createSearchModule(createSearchRepository(ports.db));
      return instance;
    },
    schema: {
      typeDefs: searchTypeDefs,
      resolvers: createSearchResolvers(getSearchModule),
    },
  };
}

export const searchModuleDescriptor: SearchModuleDescriptor = createSearchModuleDescriptor();

export default searchModuleDescriptor;
