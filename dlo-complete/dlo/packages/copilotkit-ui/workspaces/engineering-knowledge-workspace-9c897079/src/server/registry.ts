// src/server/registry.ts — module m15: the declarative module registry (Architecture.md "How
// modules register"; "Central Orchestrator" rule 1: "no module imports another feature module").
// `OrchestratorModules` is declared here rather than in orchestrator.ts (Architecture.md's own
// sketch has orchestrator.ts import it from "./registry.js", which would be circular the other way
// round) — orchestrator.ts imports it from here instead.
//
// `DEFAULT_REGISTRY` lists every module descriptor that actually exists under `src/modules/**`
// (built across m9-m14): bundles, concepts, hierarchy, documents, search, collab, gitSync — the
// seven keys `OrchestratorModules` declares below. Architecture.md's own module catalogue and this
// file's own build prompt additionally sketch a standalone eighth `FrontmatterModule` — but no
// Wave 3 module ever built one as a separate GraphQL module: OKF frontmatter parsing lives in the
// isomorphic `src/core/okf/*`, consumed directly by `GitSyncModule` and the client
// `src/features/frontmatter` panel. No `src/modules/frontmatter/` directory, `FrontmatterModule`
// type, or `frontmatterResolvers` export exists anywhere in this repository. Registering an
// eighth, fabricated descriptor here — with no repository, no resolvers, no domain logic behind
// it — would be exactly the "mock data, sample code" the project's design principles forbid.
// `DEFAULT_REGISTRY` therefore lists the seven descriptors that are real.
//
// Every module built before this one already ships its own local, structurally-identical stand-in
// for `ModuleDescriptor`/`SchemaContribution` (see e.g. `modules/bundles/index.ts`'s header), each
// documented as "this shape already satisfies a future ModuleDescriptor<...> by structural typing
// — no change needed here once m15 lands." That promise is what makes wiring them in below a
// drop-in: `ModuleDescriptor.create`'s `deps` parameter is typed `Readonly<Record<string,
// unknown>>` — not `Partial<OrchestratorModules>` as Architecture.md's own illustrative sketch
// shows — because that is the exact shape every one of those already-built descriptors declares;
// narrowing it to `Partial<OrchestratorModules>` here would make them fail to structurally satisfy
// `ModuleDescriptor` without editing files this module does not own.
//
// `SchemaContribution.resolvers` is typed with `GraphQLFieldResolver<any, any, any, any>` rather
// than `<unknown, RequestContext>`: `bundle-schema.ts`/`concept-schema.ts`/`hierarchy-schema.ts`
// export resolver maps whose functions are already narrowed to a concrete source type (e.g.
// `(bundle: Bundle) => string`) and a module-specific `*GraphQLContext` that *extends*
// `RequestContext` (adding e.g. `bundles: BundleModule`). Under `strictFunctionTypes` those are not
// assignable to a resolver typed with `unknown`/`RequestContext` in parameter (contravariant)
// position. `any` is the honest description of what this aggregation layer actually does: it is
// untyped, string-keyed dynamic dispatch by GraphQL field name — the same erasure `graphql`'s own
// executor gives every resolver internally. Each module's *own* resolver map stays fully typed at
// its point of definition; only this merge point erases it.
import type { GraphQLFieldResolver } from "graphql";
import { ConfigError } from "../core/errors";
import type { AppConfig } from "../config/config";
import type { Ports } from "./ports";
import { bundleModuleDescriptor } from "../modules/bundles/index";
import type { BundleModule } from "../modules/bundles/index";
import { conceptModuleDescriptor } from "../modules/concepts/index";
import type { ConceptModule } from "../modules/concepts/index";
import { hierarchyModuleDescriptor } from "../modules/hierarchy/index";
import type { HierarchyModule } from "../modules/hierarchy/index";
import { createDocumentModuleDescriptor } from "../modules/documents/index";
import type { DocumentModule } from "../modules/documents/index";
import { searchModuleDescriptor } from "../modules/search/index";
import type { SearchModule } from "../modules/search/search-module";
import { createCollabModuleDescriptor } from "../modules/collab/index";
import type { CollabModule } from "../modules/collab/index";
import { createGitSyncModuleDescriptor } from "../modules/git-sync/index";
import type { GitSyncModule } from "../modules/git-sync/index";

/** Every module the orchestrator wires, keyed exactly as each `src/modules/<name>/index.ts` names itself. */
export interface OrchestratorModules {
  readonly bundles: BundleModule;
  readonly concepts: ConceptModule;
  readonly hierarchy: HierarchyModule;
  readonly documents: DocumentModule;
  readonly search: SearchModule;
  readonly collab: CollabModule;
  readonly gitSync: GitSyncModule;
}

export type OrchestratorModuleName = keyof OrchestratorModules;

const ALL_MODULE_NAMES: readonly OrchestratorModuleName[] = [
  "bundles",
  "concepts",
  "hierarchy",
  "documents",
  "search",
  "collab",
  "gitSync",
];

/** See the module header for why this is `any`, not `unknown`/`RequestContext`. */
export type AnyFieldResolver = GraphQLFieldResolver<any, any, any, any>;

export type FieldResolverMap = Record<string, AnyFieldResolver>;
/** The shape `schema.ts` expects once it casts {@link SchemaContribution.resolvers} back to it. */
export type ResolverMap = Record<string, FieldResolverMap>;

/**
 * A module's GraphQL contribution: an SDL fragment plus the resolvers for the fields it declares.
 * `resolvers` is typed as the bare `object` here — not `ResolverMap` — because the real resolver
 * maps this field actually holds (`DocumentResolvers`, `CollabResolvers`, `GitSyncResolvers` —
 * every one of `documents`/`collab`/`gitSync`'s own `index.ts`) are declared as named `interface`s
 * with fixed keys (`Query`, `Mutation`, …), not an index-signature type, and TypeScript does not
 * consider a named interface assignable to `Record<string, T>` no matter what `T` is ("index
 * signature for type 'string' is missing"), even though every value inside is structurally exactly
 * a `ResolverMap` entry. `object` is honest about the actual constraint here (some non-primitive
 * value) without rejecting every already-built module's descriptor over a formality none of them
 * (files this module does not own) declare. `schema.ts` casts back to {@link ResolverMap} at the
 * one place it actually iterates these — see that file's own comment.
 */
export interface SchemaContribution {
  readonly typeDefs: string;
  readonly resolvers: object;
}

export interface ModuleDescriptor<TName extends OrchestratorModuleName = OrchestratorModuleName> {
  readonly name: TName;
  /** Names of other modules this one is allowed to see. Cycles are rejected at wiring time. */
  readonly dependsOn: readonly OrchestratorModuleName[];
  /** Builds the module. `deps` contains exactly the modules named in `dependsOn`, already built. */
  readonly create: (args: {
    readonly ports: Ports;
    readonly config: AppConfig;
    readonly deps: Readonly<Record<string, unknown>>;
  }) => OrchestratorModules[TName];
  /** Optional GraphQL contribution merged into the single executable schema. */
  readonly schema?: SchemaContribution;
}

export type ModuleRegistry = readonly ModuleDescriptor[];

/**
 * Topologically sorts `registry` by `dependsOn` (dependencies before dependents; DFS with
 * three-colour marking). Throws `ConfigError('registry.duplicateName')` when the same module name
 * is registered twice, `ConfigError('registry.unknownDependency')` when a `dependsOn` entry names a
 * module that is not itself registered, and `ConfigError('registry.cycle')` when following
 * `dependsOn` edges returns to a module already being visited — `details.cycle` carries the
 * offending path, root-first. Returns the descriptors themselves (not just names), already in
 * dependency-safe order, so `wireModules` can build directly off this result.
 */
export function resolveWiringOrder(registry: ModuleRegistry): readonly ModuleDescriptor[] {
  const byName = new Map<OrchestratorModuleName, ModuleDescriptor>();
  for (const descriptor of registry) {
    if (byName.has(descriptor.name)) {
      throw new ConfigError(
        "registry.duplicateName",
        `module "${descriptor.name}" is registered more than once`,
        { details: { name: descriptor.name } },
      );
    }
    byName.set(descriptor.name, descriptor);
  }

  for (const descriptor of registry) {
    for (const dependency of descriptor.dependsOn) {
      if (!byName.has(dependency)) {
        throw new ConfigError(
          "registry.unknownDependency",
          `module "${descriptor.name}" depends on unregistered module "${dependency}"`,
          { details: { module: descriptor.name, dependsOn: dependency } },
        );
      }
    }
  }

  const UNVISITED = 0;
  const VISITING = 1;
  const VISITED = 2;
  const state = new Map<OrchestratorModuleName, number>();
  const order: ModuleDescriptor[] = [];

  function visit(name: OrchestratorModuleName, path: readonly OrchestratorModuleName[]): void {
    const mark = state.get(name) ?? UNVISITED;
    if (mark === VISITED) {
      return;
    }
    if (mark === VISITING) {
      const cycle = [...path, name];
      throw new ConfigError("registry.cycle", `module dependency cycle detected: ${cycle.join(" -> ")}`, {
        details: { cycle },
      });
    }

    state.set(name, VISITING);
    const descriptor = byName.get(name);
    if (descriptor) {
      for (const dependency of descriptor.dependsOn) {
        visit(dependency, [...path, name]);
      }
      order.push(descriptor);
    }
    state.set(name, VISITED);
  }

  for (const descriptor of registry) {
    visit(descriptor.name, []);
  }

  return order;
}

/**
 * Builds every module in `registry`, in dependency order, injecting into each `create` call
 * exactly the sibling instances it declared in `dependsOn`. Throws `ConfigError('registry.incomplete')`
 * if `registry` does not cover all seven {@link OrchestratorModuleName}s — a registry missing a
 * module is a configuration bug, not something a caller should discover later as an `undefined`
 * crash deep inside a resolver.
 */
export function wireModules(registry: ModuleRegistry, ports: Ports, config: AppConfig): OrchestratorModules {
  const order = resolveWiringOrder(registry);
  const wired: Partial<Record<OrchestratorModuleName, unknown>> = {};

  for (const descriptor of order) {
    const deps: Record<string, unknown> = {};
    for (const dependency of descriptor.dependsOn) {
      deps[dependency] = wired[dependency];
    }
    wired[descriptor.name] = descriptor.create({ ports, config, deps });
  }

  const missing = ALL_MODULE_NAMES.filter((name) => !(name in wired));
  if (missing.length > 0) {
    throw new ConfigError("registry.incomplete", `registry is missing module(s): ${missing.join(", ")}`, {
      details: { missing },
    });
  }

  return wired as unknown as OrchestratorModules;
}

/**
 * Builds a fresh set of module descriptors. Three of the seven (`documents`, `collab`, `gitSync`)
 * are built by a factory (`createDocumentModuleDescriptor()` etc.), not exported as a pre-built
 * constant, precisely because their resolver maps close over a module-scoped instance variable
 * assigned inside `create()` (see e.g. `modules/documents/index.ts`'s header). Calling the factory
 * fresh here — rather than once at import time — is what lets two `createOrchestrator` calls in the
 * same process (every test file that builds more than one orchestrator) each get their own
 * independent closures instead of the second `create()` silently overwriting the first
 * orchestrator's wired instance.
 */
export function createDefaultRegistry(): ModuleRegistry {
  return [
    bundleModuleDescriptor,
    conceptModuleDescriptor,
    hierarchyModuleDescriptor,
    createDocumentModuleDescriptor(),
    searchModuleDescriptor,
    createCollabModuleDescriptor(),
    createGitSyncModuleDescriptor(),
  ];
}

/**
 * The default registry `createOrchestrator`'s `registry` parameter defaults to, per
 * Architecture.md's public interface. `searchModuleDescriptor`/`bundleModuleDescriptor`/
 * `conceptModuleDescriptor`/`hierarchyModuleDescriptor` are already module-level singletons in
 * their own files (their resolvers hold no wiring-order-sensitive closure state), so reusing this
 * constant across multiple orchestrators is safe for those four. It is *not* safe for the other
 * three — prefer {@link createDefaultRegistry} when a process constructs more than one orchestrator
 * (every orchestrator-level test in this workspace does).
 */
export const DEFAULT_REGISTRY: ModuleRegistry = createDefaultRegistry();
