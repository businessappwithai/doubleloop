// src/modules/bundles/index.ts — the `bundles` module's registration point (Architecture.md "How
// modules register"; Implementation.md m9: "dependsOn: []"). Bundles is a Wave 3 leaf module: it
// imports nothing from another feature module and nothing else may import its `bundle-repository.ts`
// internals — only what this file re-exports. The concrete `ModuleDescriptor`/`OrchestratorModules`
// types live in `src/server/registry.ts`, owned by the not-yet-built assembly module (m15); this
// file's `BundleModuleDescriptor` is written to that documented shape (`name`, `dependsOn`,
// `create({ ports, config, deps })`, `schema`) so wiring it into the real registry later is a
// drop-in, not a rewrite.
import type { AppConfig } from "../../config/config";
import type { Ports } from "../../server/ports";
import { createBundleModule } from "./bundle-module";
import type { BundleModule } from "./bundle-module";
import { createBundleRepository } from "./bundle-repository";
import { bundleResolvers } from "./bundle-schema";
import bundleTypeDefs from "./bundle-schema.graphql?raw";

export type { BundleModule, CreateBundleInput } from "./bundle-module";
export { createBundleModule, dbTrustToDomain, domainTrustToDb, normalizeSlug } from "./bundle-module";
export type { BundleRepository, BundleRow, InsertBundleRow } from "./bundle-repository";
export { createBundleRepository } from "./bundle-repository";
export * from "./bundle-schema";

export interface BundleModuleDescriptor {
  readonly name: "bundles";
  readonly dependsOn: readonly [];
  readonly create: (args: {
    readonly ports: Ports;
    readonly config: AppConfig;
    readonly deps: Readonly<Record<string, unknown>>;
  }) => BundleModule;
  readonly schema: {
    readonly typeDefs: string;
    readonly resolvers: typeof bundleResolvers;
  };
}

export const bundleModuleDescriptor: BundleModuleDescriptor = {
  name: "bundles",
  dependsOn: [],
  create: ({ ports }) =>
    createBundleModule({
      repo: createBundleRepository(ports.db),
      clock: ports.clock,
      ids: ports.ids,
      logger: ports.logger.child({ module: "bundles" }),
    }),
  schema: {
    typeDefs: bundleTypeDefs,
    resolvers: bundleResolvers,
  },
};
