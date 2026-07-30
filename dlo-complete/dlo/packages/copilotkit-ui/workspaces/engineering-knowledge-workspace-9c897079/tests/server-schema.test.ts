// @vitest-environment node
//
// Runs in the node environment, not jsdom: this suite reads the real, committed `schema.graphql`
// off disk via `fileURLToPath(new URL(..., import.meta.url))` (mirroring tests/emit-schema.test.ts's
// own header comment on why), and under the jsdom environment wrapper `import.meta.url` is not
// resolved to a `file:` scheme. There is nothing DOM-dependent here.
//
// tests/server-schema.test.ts — module m15 (src/server/schema.ts). Covers: `buildOrchestratorSchema`
// merging the real `DEFAULT_REGISTRY` into one schema that declares every module's root fields;
// `node(id:)` dispatch for both `NODE_TYPES` entries (`Bundle` succeeds; `Concept` fails loudly with
// a documented `NotFoundError`, per this module's own header) and for an unrecognised type name
// (also `NotFoundError`, re-classified from `fromGlobalId`'s `ValidationError`) and a genuinely
// malformed id (stays a `ValidationError`, not re-classified); `ConfigError('schema.duplicateResolver')`
// for two modules contributing the same `Type.field`; `ConfigError('schema.unknownResolverType')`/
// `('schema.unknownResolverField')` for a resolver map naming a type/field the merged SDL does not
// declare; and that the repo's committed `schema.graphql` (`npm run schema:emit`'s output) is SDL
// `graphql`'s own `buildSchema` accepts.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildSchema, execute as executeGraphQL, parse } from "graphql";
import { buildOrchestratorSchema } from "../src/server/schema";
import {
  createDefaultRegistry,
  wireModules,
  type ModuleDescriptor,
  type ModuleRegistry,
} from "../src/server/registry";
import { ConfigError, NotFoundError, ValidationError } from "../src/core/errors";
import { toGlobalId } from "../src/core/global-id";
import { asActorId } from "../src/core/ids";
import type { AppConfig } from "../src/config/config";
import { createFakeDb, createFakePorts } from "./helpers/fake-ports";

const CONFIG: AppConfig = Object.freeze({
  env: "test",
  instanceId: "schema-test",
  port: 3000,
  db: Object.freeze({ url: "postgres://ekw:ekw@localhost:5432/ekw", poolMax: 10, ssl: false, autoMigrate: false }),
  collab: Object.freeze({ wsUrl: "ws://localhost:1234", port: 1234 }),
  gitSync: Object.freeze({ repoPath: "/tmp/schema-test-repo", branch: "main", intervalMs: 300_000 }),
  logLevel: "error",
});

const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "40000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-01-01T00:00:00.000Z");

const BUNDLE_ROW = {
  id: BUNDLE_ID,
  workspace_id: "10000000-0000-4000-8000-000000000001",
  slug: "onboarding",
  title: "Onboarding",
  description: "",
  okf_version: "1.0",
  default_trust: "unverified",
  created_by: ACTOR_ID,
  concept_count: 0,
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
};

function actor() {
  return { id: asActorId(ACTOR_ID), email: "a@example.com", displayName: "A" };
}

/** Builds one registry, wires it against a fake `Db` pre-loaded with `BUNDLE_ROW`, and builds the
 * matching schema off the *same* registry instance — required because `documents`/`collab`/`gitSync`
 * resolvers close over the exact module instance their own `create()` produced. */
function buildFixture() {
  const fakeDb = createFakeDb();
  fakeDb.when(/FROM bundles/, { rows: [BUNDLE_ROW] });
  const registry = createDefaultRegistry();
  const modules = wireModules(registry, createFakePorts({ db: fakeDb }), CONFIG);
  const schema = buildOrchestratorSchema(registry);
  const ctx = {
    requestId: "req-1",
    actor: actor(),
    bundles: modules.bundles,
    concepts: modules.concepts,
    hierarchy: modules.hierarchy,
  };
  return { schema, ctx, fakeDb };
}

/** A `concepts` row as `ConceptRepository` reads it back — only the columns the tests assert on. */
function conceptRow(overrides: { id: string; title: string }): Record<string, unknown> {
  return {
    id: overrides.id,
    bundle_id: BUNDLE_ID,
    parent_id: null,
    slug: "quickstart",
    path: "quickstart",
    title: overrides.title,
    sort_key: "a",
    depth: 0,
    is_index: false,
    child_count: 0,
    created_by: "00000000-0000-4000-8000-000000000001",
    version: 1,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    deleted_at: null,
  };
}

function encodeRaw(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("buildOrchestratorSchema — assembly", () => {
  test("builds the real DEFAULT_REGISTRY without throwing and declares every module's root fields", () => {
    const schema = buildOrchestratorSchema(createDefaultRegistry());

    const queryFields = Object.keys(schema.getQueryType()?.getFields() ?? {});
    expect(queryFields).toEqual(
      expect.arrayContaining(["node", "bundles", "bundle", "concept", "concepts", "search", "conceptDocument", "presence"]),
    );

    const mutationFields = Object.keys(schema.getMutationType()?.getFields() ?? {});
    expect(mutationFields).toEqual(expect.arrayContaining(["createBundle", "createConcept", "moveConcept", "saveDocument"]));

    // hierarchy-schema.graphql legally `extend type Concept` with children/ancestors defined in
    // concept-schema.graphql — both fields land on the one merged Concept type.
    const conceptType = schema.getType("Concept");
    const conceptFields = conceptType && "getFields" in conceptType ? Object.keys(conceptType.getFields()) : [];
    expect(conceptFields).toEqual(expect.arrayContaining(["title", "children", "ancestors"]));
  });

  test("Bundle and Concept both implement the Node interface", () => {
    const schema = buildOrchestratorSchema(createDefaultRegistry());
    const nodeType = schema.getType("Node");
    expect(nodeType).toBeDefined();
    const possibleTypeNames = nodeType
      ? schema.getPossibleTypes(nodeType as never).map((t) => t.name)
      : [];
    expect(possibleTypeNames.sort()).toEqual(["Bundle", "Concept"]);
  });
});

describe("node(id:) dispatch", () => {
  test("Bundle resolves the real bundle through BundleModule.get", async () => {
    const { schema, ctx } = buildFixture();
    const globalId = toGlobalId("Bundle", BUNDLE_ID);
    const document = parse(`query($id: ID!) { node(id: $id) { id ... on Bundle { title slug } } }`);

    const result = await executeGraphQL({ schema, document, contextValue: ctx, variableValues: { id: globalId } });

    expect(result.errors).toBeUndefined();
    expect(result.data?.["node"]).toEqual({ id: globalId, title: "Onboarding", slug: "onboarding" });
  });

  test("Concept resolves from its global id alone, as the Node interface requires", async () => {
    // This used to throw NotFoundError('node.conceptRequiresBundleScope') on the reasoning that a
    // Concept global id carries no bundle. `concepts.id` is a uuid PRIMARY KEY, so it needs none —
    // and a Node that cannot be refetched by node(id:) is not a Node. It broke the app outright:
    // the concept route and every sidebar expansion below the root fetch through node(id:).
    const CONCEPT_ID = "50000000-0000-4000-8000-000000000001";
    const { schema, ctx, fakeDb } = buildFixture();
    fakeDb.when(/FROM concepts WHERE id = \$1 AND deleted_at IS NULL/, {
      rows: [conceptRow({ id: CONCEPT_ID, title: "Quickstart" })],
    });
    const globalId = toGlobalId("Concept", CONCEPT_ID);
    const document = parse(`query($id: ID!) { node(id: $id) { id ... on Concept { title } } }`);

    const result = await executeGraphQL({ schema, document, contextValue: ctx, variableValues: { id: globalId } });

    expect(result.errors).toBeUndefined();
    expect(result.data?.["node"]).toEqual({ id: globalId, title: "Quickstart" });
  });

  test("the Concept lookup is not bundle-scoped — node(id:) has no bundle to scope by", async () => {
    const CONCEPT_ID = "50000000-0000-4000-8000-000000000001";
    const { schema, ctx, fakeDb } = buildFixture();
    fakeDb.when(/FROM concepts WHERE id = \$1 AND deleted_at IS NULL/, {
      rows: [conceptRow({ id: CONCEPT_ID, title: "Quickstart" })],
    });
    const document = parse(`query($id: ID!) { node(id: $id) { id } }`);

    await executeGraphQL({
      schema,
      document,
      contextValue: ctx,
      variableValues: { id: toGlobalId("Concept", CONCEPT_ID) },
    });

    const call = fakeDb.calls.find((c) => /FROM concepts WHERE id = \$1/.test(c.sql));
    expect(call?.sql).not.toContain("bundle_id = $2");
    expect(call?.params).toEqual([CONCEPT_ID]);
  });

  test("a Concept global id for a row that does not exist is a NotFoundError, not a crash", async () => {
    const { schema, ctx, fakeDb } = buildFixture();
    fakeDb.when(/FROM concepts WHERE id = \$1 AND deleted_at IS NULL/, { rows: [] });
    const document = parse(`query($id: ID!) { node(id: $id) { id } }`);

    const result = await executeGraphQL({
      schema,
      document,
      contextValue: ctx,
      variableValues: { id: toGlobalId("Concept", "50000000-0000-4000-8000-0000000000ff") },
    });

    expect(result.data?.["node"]).toBeNull();
    expect(result.errors?.[0]?.originalError).toBeInstanceOf(NotFoundError);
  });

  test("an unrecognised type name is reclassified from ValidationError to NotFoundError('node.unknownType')", async () => {
    const { schema, ctx } = buildFixture();
    const globalId = encodeRaw("Widget:123");
    const document = parse(`query($id: ID!) { node(id: $id) { id } }`);

    const result = await executeGraphQL({ schema, document, contextValue: ctx, variableValues: { id: globalId } });

    const originalError = result.errors?.[0]?.originalError;
    expect(originalError).toBeInstanceOf(NotFoundError);
    expect((originalError as NotFoundError).details["reason"]).toBe("node.unknownType");
  });

  test("a genuinely malformed id (not valid base64) stays a ValidationError, not reclassified", async () => {
    const { schema, ctx } = buildFixture();
    const document = parse(`query($id: ID!) { node(id: $id) { id } }`);

    const result = await executeGraphQL({ schema, document, contextValue: ctx, variableValues: { id: "not base64!!" } });

    const originalError = result.errors?.[0]?.originalError;
    expect(originalError).toBeInstanceOf(ValidationError);
  });

  test("a missing bundle surfaces BundleModule's own NotFoundError('bundle.notFound')", async () => {
    const fakeDb = createFakeDb();
    fakeDb.when(/FROM bundles/, { rows: [] });
    const registry = createDefaultRegistry();
    const modules = wireModules(registry, createFakePorts({ db: fakeDb }), CONFIG);
    const schema = buildOrchestratorSchema(registry);
    const ctx = { requestId: "req-2", actor: actor(), bundles: modules.bundles, concepts: modules.concepts, hierarchy: modules.hierarchy };
    const globalId = toGlobalId("Bundle", BUNDLE_ID);
    const document = parse(`query($id: ID!) { node(id: $id) { id } }`);

    const result = await executeGraphQL({ schema, document, contextValue: ctx, variableValues: { id: globalId } });

    const originalError = result.errors?.[0]?.originalError;
    expect(originalError).toBeInstanceOf(NotFoundError);
    expect((originalError as NotFoundError).code).toBe("not_found");
  });
});

describe("buildOrchestratorSchema — wiring-bug guards", () => {
  // Swaps the real `search` descriptor's `schema` for a synthetic one, keeping the registry at
  // exactly seven entries (one per `OrchestratorModuleName`) so these fixtures exercise schema.ts's
  // own guards, not registry.ts's separate `registry.duplicateName`/`registry.incomplete` checks
  // (covered in tests/registry.test.ts) — `ModuleDescriptor.name` is typed against the seven real
  // module names, so there is no way to register a fictitious eighth name here anyway.
  function withSearchSchema(schema: ModuleDescriptor["schema"]): ModuleRegistry {
    return createDefaultRegistry().map((descriptor) =>
      descriptor.name === "search" ? { ...descriptor, schema } : descriptor,
    );
  }

  function expectConfigError(fn: () => unknown, code: string): void {
    try {
      fn();
      throw new Error(`expected a ConfigError with code "${code}" but nothing was thrown`);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe(code);
    }
  }

  test("throws ConfigError('schema.duplicateResolver') when two modules resolve the same Type.field", () => {
    const registry = withSearchSchema({ typeDefs: "", resolvers: { Query: { bundles: () => null } } });

    expectConfigError(() => buildOrchestratorSchema(registry), "schema.duplicateResolver");
  });

  test("throws ConfigError('schema.unknownResolverType') for a resolver map naming an undeclared type", () => {
    const registry = withSearchSchema({ typeDefs: "", resolvers: { NoSuchType: { field: () => null } } });

    expectConfigError(() => buildOrchestratorSchema(registry), "schema.unknownResolverType");
  });

  test("throws ConfigError('schema.unknownResolverField') for a resolver map naming an undeclared field", () => {
    const registry = withSearchSchema({ typeDefs: "", resolvers: { Query: { thisFieldDoesNotExist: () => null } } });

    expectConfigError(() => buildOrchestratorSchema(registry), "schema.unknownResolverField");
  });

  test("two descriptors each *defining* the same SDL type name fail to parse (buildSchema's own duplicate-type check)", () => {
    const registry = withSearchSchema({ typeDefs: "type Bundle { bogus: String }", resolvers: {} });

    expect(() => buildOrchestratorSchema(registry)).toThrow();
  });

  test("a descriptor with no schema contributes no SDL and no resolvers", () => {
    const registry = createDefaultRegistry().map((descriptor) =>
      descriptor.name === "search" ? { ...descriptor, schema: undefined } : descriptor,
    ) as ModuleRegistry;

    const schema = buildOrchestratorSchema(registry);
    expect(schema.getQueryType()?.getFields()["search"]).toBeUndefined();
  });
});

describe("the committed schema.graphql", () => {
  test("is SDL that graphql's own buildSchema accepts", () => {
    const path = fileURLToPath(new URL("../schema.graphql", import.meta.url));
    const sdl = readFileSync(path, "utf8");

    expect(() => buildSchema(sdl)).not.toThrow();
    const schema = buildSchema(sdl);
    expect(schema.getQueryType()?.name).toBe("Query");
  });
});
