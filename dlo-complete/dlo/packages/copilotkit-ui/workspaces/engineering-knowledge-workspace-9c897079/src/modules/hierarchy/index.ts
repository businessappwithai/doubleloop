// src/modules/hierarchy/index.ts — the `hierarchy` module's registration point (Architecture.md
// "How modules register"; Implementation.md m10). Ships in the same build wave as `concepts` and
// reads the same `concepts` table independently (see `hierarchy-repository.ts`'s header comment)
// but is its own `ModuleDescriptor` with its own `dependsOn: []` — Implementation.md's "Depends
// on. m5, m6, m7" for m10 names core infra only, not the `concepts` module itself. The concrete
// `ModuleDescriptor`/`OrchestratorModules` types live in `src/server/registry.ts` (m15, not yet
// built); `HierarchyModuleDescriptor` is written to that documented shape so wiring it into the
// real registry later is a drop-in, not a rewrite.
import type { AppConfig } from "../../config/config";
import type { Ports } from "../../server/ports";
import { createHierarchyModule } from "./hierarchy-module";
import type { HierarchyModule } from "./hierarchy-module";
import { createHierarchyRepository } from "./hierarchy-repository";
import { hierarchyResolvers } from "./hierarchy-schema";
import hierarchyTypeDefs from "./hierarchy-schema.graphql?raw";

export type { HierarchyModule, MoveConceptPatch } from "./hierarchy-module";
export { createHierarchyModule } from "./hierarchy-module";
export type {
  HierarchyConceptRow,
  HierarchyRepository,
  MoveSubtreeInput,
  SiblingRow,
} from "./hierarchy-repository";
export { createHierarchyRepository } from "./hierarchy-repository";
export * from "./hierarchy-schema";
export * from "./sort-key";

export interface HierarchyModuleDescriptor {
  readonly name: "hierarchy";
  readonly dependsOn: readonly [];
  readonly create: (args: {
    readonly ports: Ports;
    readonly config: AppConfig;
    readonly deps: Readonly<Record<string, unknown>>;
  }) => HierarchyModule;
  readonly schema: {
    readonly typeDefs: string;
    readonly resolvers: typeof hierarchyResolvers;
  };
}

export const hierarchyModuleDescriptor: HierarchyModuleDescriptor = {
  name: "hierarchy",
  dependsOn: [],
  create: ({ ports }) =>
    createHierarchyModule({
      repo: createHierarchyRepository(ports.db),
      clock: ports.clock,
      logger: ports.logger.child({ module: "hierarchy" }),
    }),
  schema: {
    typeDefs: hierarchyTypeDefs,
    resolvers: hierarchyResolvers,
  },
};
