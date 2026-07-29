// tests/registry.test.ts — module m15 (src/server/registry.ts). `resolveWiringOrder` is pure
// over `name`/`dependsOn`, so most cases here use tiny stub descriptors built from real
// `OrchestratorModuleName`s (there is no way to construct a `ModuleDescriptor` typed against a
// synthetic name — the generic is bound to the seven real keys — so cycle/dangling fixtures repurpose
// real names with deliberately wrong `dependsOn` edges instead of inventing fictitious ones).
// `wireModules`/`createDefaultRegistry`/`DEFAULT_REGISTRY` are exercised against the real module
// descriptors and `tests/helpers/fake-ports.ts`'s fakes — no real Postgres, no real git, no real
// clock.
import { describe, expect, test } from "vitest";
import {
  createDefaultRegistry,
  DEFAULT_REGISTRY,
  resolveWiringOrder,
  wireModules,
  type ModuleDescriptor,
  type OrchestratorModuleName,
  type OrchestratorModules,
} from "../src/server/registry";
import { ConfigError } from "../src/core/errors";
import type { AppConfig } from "../src/config/config";
import { createFakePorts } from "./helpers/fake-ports";

const CONFIG: AppConfig = Object.freeze({
  env: "test",
  instanceId: "registry-test",
  port: 3000,
  db: Object.freeze({ url: "postgres://ekw:ekw@localhost:5432/ekw", poolMax: 10, ssl: false, autoMigrate: false }),
  collab: Object.freeze({ wsUrl: "ws://localhost:1234", port: 1234 }),
  gitSync: Object.freeze({ repoPath: "/tmp/registry-test-repo", branch: "main", intervalMs: 300_000 }),
  logLevel: "error",
});

const ALL_NAMES: readonly OrchestratorModuleName[] = [
  "bundles",
  "concepts",
  "hierarchy",
  "documents",
  "search",
  "collab",
  "gitSync",
];

function stub<TName extends OrchestratorModuleName>(
  name: TName,
  dependsOn: readonly OrchestratorModuleName[] = [],
): ModuleDescriptor<TName> {
  return {
    name,
    dependsOn,
    create: () => ({}) as OrchestratorModules[TName],
    schema: { typeDefs: "", resolvers: {} },
  };
}

function expectConfigError(fn: () => unknown, code: string): ConfigError {
  try {
    fn();
    throw new Error(`expected a ConfigError with code "${code}" but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const configError = err as ConfigError;
    expect(configError.code).toBe(code);
    return configError;
  }
}

describe("resolveWiringOrder — topological order", () => {
  test("orders a dependency before its dependent regardless of input order", () => {
    const documents = stub("documents");
    const collab = stub("collab", ["documents"]);

    const order = resolveWiringOrder([collab, documents]);

    expect(order.map((d) => d.name)).toEqual(["documents", "collab"]);
  });

  test("a module with no dependencies keeps its relative position among other roots", () => {
    const bundles = stub("bundles");
    const concepts = stub("concepts");
    const hierarchy = stub("hierarchy");

    const order = resolveWiringOrder([bundles, concepts, hierarchy]);

    expect(order.map((d) => d.name)).toEqual(["bundles", "concepts", "hierarchy"]);
  });

  test("a diamond dependency graph visits the shared base module exactly once", () => {
    const documents = stub("documents");
    const collab = stub("collab", ["documents"]);
    const gitSync = stub("gitSync", ["documents"]);
    const search = stub("search", []);

    const order = resolveWiringOrder([search, collab, gitSync, documents]);

    expect(order.filter((d) => d.name === "documents")).toHaveLength(1);
    const names = order.map((d) => d.name);
    expect(names.indexOf("documents")).toBeLessThan(names.indexOf("collab"));
    expect(names.indexOf("documents")).toBeLessThan(names.indexOf("gitSync"));
  });

  test("an empty registry resolves to an empty order", () => {
    expect(resolveWiringOrder([])).toEqual([]);
  });
});

describe("resolveWiringOrder — dangling dependency", () => {
  test("throws ConfigError('registry.unknownDependency') naming the missing module", () => {
    const collab = stub("collab", ["documents"]); // "documents" never registered

    const err = expectConfigError(() => resolveWiringOrder([collab]), "registry.unknownDependency");

    expect(err.details["module"]).toBe("collab");
    expect(err.details["dependsOn"]).toBe("documents");
  });
});

describe("resolveWiringOrder — cycle detection", () => {
  test("a two-module cycle throws ConfigError('registry.cycle')", () => {
    const collab = stub("collab", ["gitSync"]);
    const gitSync = stub("gitSync", ["collab"]);

    const err = expectConfigError(() => resolveWiringOrder([collab, gitSync]), "registry.cycle");

    expect(Array.isArray(err.details["cycle"])).toBe(true);
    expect(err.details["cycle"]).toContain("collab");
    expect(err.details["cycle"]).toContain("gitSync");
  });

  test("a self-dependency throws ConfigError('registry.cycle')", () => {
    const collab = stub("collab", ["collab"]);

    expectConfigError(() => resolveWiringOrder([collab]), "registry.cycle");
  });

  test("a three-module cycle throws ConfigError('registry.cycle')", () => {
    const bundles = stub("bundles", ["concepts"]);
    const concepts = stub("concepts", ["hierarchy"]);
    const hierarchy = stub("hierarchy", ["bundles"]);

    expectConfigError(() => resolveWiringOrder([bundles, concepts, hierarchy]), "registry.cycle");
  });
});

describe("resolveWiringOrder — duplicate registration", () => {
  test("registering the same module name twice throws ConfigError('registry.duplicateName')", () => {
    const err = expectConfigError(() => resolveWiringOrder([stub("bundles"), stub("bundles")]), "registry.duplicateName");
    expect(err.details["name"]).toBe("bundles");
  });
});

describe("wireModules", () => {
  test("builds every module in OrchestratorModules from the real DEFAULT_REGISTRY", () => {
    const ports = createFakePorts();
    const modules = wireModules(createDefaultRegistry(), ports, CONFIG);

    for (const name of ALL_NAMES) {
      expect(modules[name]).toBeDefined();
    }
    expect(typeof modules.bundles.get).toBe("function");
    expect(typeof modules.concepts.get).toBe("function");
    expect(typeof modules.hierarchy.children).toBe("function");
    expect(typeof modules.documents.load).toBe("function");
    expect(typeof modules.search.search).toBe("function");
    expect(typeof modules.collab.listPresence).toBe("function");
    expect(typeof modules.gitSync.syncBundle).toBe("function");
  });

  test("passes each dependent module exactly the sibling instances named in dependsOn", () => {
    let receivedDeps: Readonly<Record<string, unknown>> | undefined;
    const documentsInstance = { marker: "documents-instance" } as unknown as OrchestratorModules["documents"];

    const descriptors: ModuleDescriptor[] = [
      stub("bundles"),
      stub("concepts"),
      stub("hierarchy"),
      { name: "documents", dependsOn: [], create: () => documentsInstance, schema: { typeDefs: "", resolvers: {} } },
      stub("search"),
      {
        name: "collab",
        dependsOn: ["documents"],
        create: ({ deps }) => {
          receivedDeps = deps;
          return {} as OrchestratorModules["collab"];
        },
        schema: { typeDefs: "", resolvers: {} },
      },
      stub("gitSync"),
    ];

    wireModules(descriptors, createFakePorts(), CONFIG);

    expect(receivedDeps).toEqual({ documents: documentsInstance });
  });

  test("two calls with independently-created registries do not share module instances", () => {
    const portsA = createFakePorts();
    const portsB = createFakePorts();

    const modulesA = wireModules(createDefaultRegistry(), portsA, CONFIG);
    const modulesB = wireModules(createDefaultRegistry(), portsB, CONFIG);

    expect(modulesA.documents).not.toBe(modulesB.documents);
    expect(modulesA.collab).not.toBe(modulesB.collab);
    expect(modulesA.gitSync).not.toBe(modulesB.gitSync);
  });

  test("throws ConfigError('registry.incomplete') when the registry does not cover every module", () => {
    const ports = createFakePorts();
    const partial = createDefaultRegistry().filter((d) => d.name !== "gitSync");

    const err = expectConfigError(() => wireModules(partial, ports, CONFIG), "registry.incomplete");
    expect(err.details["missing"]).toEqual(["gitSync"]);
  });
});

describe("DEFAULT_REGISTRY", () => {
  test("lists exactly the seven real module descriptors, one each", () => {
    expect(DEFAULT_REGISTRY).toHaveLength(7);
    expect(new Set(DEFAULT_REGISTRY.map((d) => d.name))).toEqual(new Set(ALL_NAMES));
  });

  test("resolves without throwing (no cycle, no dangling dependency)", () => {
    expect(() => resolveWiringOrder(DEFAULT_REGISTRY)).not.toThrow();
  });
});
