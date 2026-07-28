// src/modules/concepts/index.ts — the `concepts` module's registration point (Architecture.md "How
// modules register"; Implementation.md m10: "Depends on. m5, m6, m7" — core infra only, no other
// feature module). Concepts is a leaf module exactly like `bundles`: it imports nothing from
// another feature module (its one intra-task import, `hierarchy/sort-key.ts`, is a pure,
// dependency-free utility, not a service — see `concept-module.ts`'s header comment) and nothing
// else may import its `concept-repository.ts` internals — only what this file re-exports. The
// concrete `ModuleDescriptor`/`OrchestratorModules` types live in `src/server/registry.ts`, owned
// by the not-yet-built assembly module (m15); `ConceptModuleDescriptor` is written to that
// documented shape so wiring it into the real registry later is a drop-in, not a rewrite.
import type { AppConfig } from "../../config/config";
import type { Ports } from "../../server/ports";
import { createConceptModule } from "./concept-module";
import type { ConceptModule } from "./concept-module";
import { createConceptRepository } from "./concept-repository";
import { conceptResolvers } from "./concept-schema";
import conceptTypeDefs from "./concept-schema.graphql?raw";

export type { ConceptModule, CreateConceptInput, UpdateConceptMetadataPatch } from "./concept-module";
export { createConceptModule, normalizeSlug } from "./concept-module";
export type { ConceptRepository, ConceptRow, InsertConceptRow } from "./concept-repository";
export { createConceptRepository } from "./concept-repository";
export * from "./concept-schema";

export interface ConceptModuleDescriptor {
  readonly name: "concepts";
  readonly dependsOn: readonly [];
  readonly create: (args: {
    readonly ports: Ports;
    readonly config: AppConfig;
    readonly deps: Readonly<Record<string, unknown>>;
  }) => ConceptModule;
  readonly schema: {
    readonly typeDefs: string;
    readonly resolvers: typeof conceptResolvers;
  };
}

export const conceptModuleDescriptor: ConceptModuleDescriptor = {
  name: "concepts",
  dependsOn: [],
  create: ({ ports }) =>
    createConceptModule({
      repo: createConceptRepository(ports.db),
      clock: ports.clock,
      ids: ports.ids,
      logger: ports.logger.child({ module: "concepts" }),
    }),
  schema: {
    typeDefs: conceptTypeDefs,
    resolvers: conceptResolvers,
  },
};
