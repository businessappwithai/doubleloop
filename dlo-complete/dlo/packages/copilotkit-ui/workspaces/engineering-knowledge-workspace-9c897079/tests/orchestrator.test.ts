// @vitest-environment node
//
// Runs in the node environment, not jsdom: MIGRATIONS_DIR below resolves via
// `fileURLToPath(new URL(..., import.meta.url))`, which is not a `file:` URL under the jsdom
// environment wrapper (see tests/emit-schema.test.ts's own header for the same reasoning).
//
// tests/orchestrator.test.ts — module m15 (src/server/orchestrator.ts), the Central Orchestrator.
// `createOrchestrator` is pure over its `(config, ports, registry?)` arguments (see that file's own
// header), so every test here builds one from `tests/helpers/fake-ports.ts` and a literal
// `AppConfig` — never `getOrchestrator()`'s real `process.env`/`PgDb` composition, which is exactly
// why that half is split out. Covers: wiring against the real `DEFAULT_REGISTRY`, `schema()`
// memoization, `createRequestContext` delegating to `core/context.ts`, `execute()` never throwing
// across parse/validation/execution-error/happy-path branches (with execution errors remapped
// through `graphql-errors.ts`), and `start()`/`stop()`'s migration-check-vs-apply branches and
// pool/timer cleanup — the last two against a spied `GitSyncModule` swapped into an otherwise-real
// registry, so this file asserts exactly what `orchestrator.ts` itself is responsible for
// delegating, not `git-sync-module.ts`'s own internal behaviour (already covered by that module's
// own tests).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { createOrchestrator } from "../src/server/orchestrator";
import { createDefaultRegistry, type ModuleRegistry } from "../src/server/registry";
import type { GitSyncModule } from "../src/modules/git-sync/git-sync-module";
import { checksumOf, loadMigrationFile } from "../src/server/migrate";
import { MigrationError } from "../src/core/errors";
import { toGlobalId } from "../src/core/global-id";
import { asActorId } from "../src/core/ids";
import type { AppConfig } from "../src/config/config";
import { createFakeDb, createFakePorts } from "./helpers/fake-ports";
import type { Ports } from "../src/server/ports";

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

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return Object.freeze({
    env: "test",
    instanceId: "orchestrator-test",
    port: 3000,
    db: Object.freeze({ url: "postgres://ekw:ekw@localhost:5432/ekw", poolMax: 10, ssl: false, autoMigrate: false }),
    collab: Object.freeze({ wsUrl: "ws://localhost:1234", port: 1234 }),
    gitSync: Object.freeze({ repoPath: "/tmp/orchestrator-test-repo", branch: "main", intervalMs: 300_000 }),
    logLevel: "error",
    ...overrides,
  }) as AppConfig;
}

function spyGitSync(): GitSyncModule & { startCalls: number; stopCalls: number } {
  const spy: GitSyncModule & { startCalls: number; stopCalls: number } = {
    startCalls: 0,
    stopCalls: 0,
    syncBundle: vi.fn(),
    runs: vi.fn(),
    start: vi.fn(() => {
      spy.startCalls += 1;
    }),
    stop: vi.fn(() => {
      spy.stopCalls += 1;
    }),
  };
  return spy;
}

/** The real `DEFAULT_REGISTRY` with its `gitSync` descriptor swapped for one that returns `gitSync`
 * unchanged — every other module stays real, so schema assembly and bundle resolution still work. */
function registryWithGitSync(gitSync: GitSyncModule): ModuleRegistry {
  return createDefaultRegistry().map((descriptor) =>
    descriptor.name === "gitSync" ? { ...descriptor, create: () => gitSync } : descriptor,
  );
}

function buildPortsWithBundle(): { ports: Ports; fakeDb: ReturnType<typeof createFakeDb> } {
  const fakeDb = createFakeDb();
  fakeDb.when(/FROM bundles/, { rows: [BUNDLE_ROW] });
  return { ports: createFakePorts({ db: fakeDb }), fakeDb };
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../sql/migrations", import.meta.url));

/** Reads the real, committed migration files and computes their current checksums — the same
 * files `orchestrator.ts`'s own `loadMigrationFiles` reads off disk at `start()` time — so a test
 * can assert "nothing pending" against the actual repository state instead of a fabricated one. */
function readRealMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => loadMigrationFile(filename, readFileSync(join(MIGRATIONS_DIR, filename), "utf8")));
}

describe("createOrchestrator — wiring", () => {
  test("wires the real DEFAULT_REGISTRY and exposes config/modules", () => {
    const config = buildConfig();
    const orchestrator = createOrchestrator(config, createFakePorts());

    expect(orchestrator.config).toBe(config);
    expect(typeof orchestrator.modules.bundles.get).toBe("function");
    expect(typeof orchestrator.modules.gitSync.start).toBe("function");
  });

  test("schema() is built once and memoized across calls", () => {
    const orchestrator = createOrchestrator(buildConfig(), createFakePorts());

    const first = orchestrator.schema();
    const second = orchestrator.schema();

    expect(first).toBe(second);
  });

  // Building two real schemas (each parsing the full merged SDL from scratch via `buildSchema`)
  // is measurably slower than everything else in this file — comfortably under a second in
  // isolation, but the default 5000ms `testTimeout` has been observed to be too tight for it when
  // the whole `pnpm test` suite runs under load (many worker processes contending for CPU). Under
  // `--coverage`, v8's instrumentation adds further overhead on top of that contention — measured
  // at ~18.5s in isolation, which left the earlier 20_000ms budget for genuine timeouts under a
  // fully loaded suite. The assertion itself is cheap; only the two real
  // `buildOrchestratorSchema` calls are not.
  test(
    "two orchestrators from the same process do not share module instances",
    () => {
      const a = createOrchestrator(buildConfig(), createFakePorts());
      const b = createOrchestrator(buildConfig(), createFakePorts());

      expect(a.modules.documents).not.toBe(b.modules.documents);
      expect(a.schema()).not.toBe(b.schema());
    },
    45_000,
  );
});

describe("createOrchestrator — createRequestContext", () => {
  test("builds a context carrying bundles/concepts/hierarchy from the wired modules", () => {
    const orchestrator = createOrchestrator(buildConfig(), createFakePorts());

    const ctx = orchestrator.createRequestContext({ requestId: "req-1", actor: actor() });

    expect(ctx.requestId).toBe("req-1");
    expect(ctx.actor).toEqual(actor());
    expect(ctx.bundles).toBe(orchestrator.modules.bundles);
    expect(ctx.concepts).toBe(orchestrator.modules.concepts);
    expect(ctx.hierarchy).toBe(orchestrator.modules.hierarchy);
  });

  test("delegates requestId/actor validation to core/context.ts and propagates its ValidationError", () => {
    const orchestrator = createOrchestrator(buildConfig(), createFakePorts());

    expect(() => orchestrator.createRequestContext({ requestId: "", actor: actor() })).toThrow();
  });
});

describe("createOrchestrator — execute", () => {
  test("happy path: a valid query against a real module resolves with data", async () => {
    const { ports } = buildPortsWithBundle();
    const orchestrator = createOrchestrator(buildConfig(), ports);
    const ctx = orchestrator.createRequestContext({ requestId: "req-1", actor: actor() });
    const globalId = toGlobalId("Bundle", BUNDLE_ID);

    const result = await orchestrator.execute({
      query: `query($id: ID!) { bundle(id: $id) { id title } }`,
      variables: { id: globalId },
      ctx,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ bundle: { id: globalId, title: "Onboarding" } });
  });

  test("respects operationName when the document names more than one operation", async () => {
    const { ports } = buildPortsWithBundle();
    const orchestrator = createOrchestrator(buildConfig(), ports);
    const ctx = orchestrator.createRequestContext({ requestId: "req-1", actor: actor() });
    const globalId = toGlobalId("Bundle", BUNDLE_ID);
    const query = `
      query GetBundle($id: ID!) { bundle(id: $id) { title } }
      query Ping { __typename }
    `;

    const result = await orchestrator.execute({ query, variables: { id: globalId }, operationName: "GetBundle", ctx });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ bundle: { title: "Onboarding" } });
  });

  test("a syntax error returns { errors } and never rejects", async () => {
    const orchestrator = createOrchestrator(buildConfig(), createFakePorts());
    const ctx = orchestrator.createRequestContext({ requestId: "req-1", actor: actor() });

    const result = await orchestrator.execute({ query: "{ bundle(", ctx });

    expect(result.data).toBeUndefined();
    expect(result.errors).toHaveLength(1);
  });

  test("a validation error (unknown field) returns { errors } and never rejects", async () => {
    const orchestrator = createOrchestrator(buildConfig(), createFakePorts());
    const ctx = orchestrator.createRequestContext({ requestId: "req-1", actor: actor() });

    const result = await orchestrator.execute({ query: "{ thisFieldDoesNotExist }", ctx });

    expect(result.data).toBeUndefined();
    expect(result.errors).toHaveLength(1);
  });

  test("a resolver's typed error is remapped to a GraphQLError with extensions.code, never thrown", async () => {
    const fakeDb = createFakeDb();
    fakeDb.when(/FROM bundles/, { rows: [] });
    const orchestrator = createOrchestrator(buildConfig(), createFakePorts({ db: fakeDb }));
    const ctx = orchestrator.createRequestContext({ requestId: "req-1", actor: actor() });
    const globalId = toGlobalId("Bundle", BUNDLE_ID);

    const result = await orchestrator.execute({
      query: `query($id: ID!) { bundle(id: $id) { id } }`,
      variables: { id: globalId },
      ctx,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.message).toBe("bundle.notFound");
    expect(result.errors?.[0]?.extensions?.["code"]).toBe("not_found");
  });
});

describe("createOrchestrator — start/stop", () => {
  test("start() throws MigrationError('migration.pending') when autoMigrate is false and migrations are pending", async () => {
    const fakeDb = createFakeDb();
    fakeDb.when("to_regclass", { rows: [{ table_name: "schema_migrations" }] });
    fakeDb.when("SELECT version, name, checksum FROM schema_migrations", { rows: [] });
    fakeDb.when("pg_advisory_lock", { rows: [] });
    fakeDb.when("pg_advisory_unlock", { rows: [] });
    const gitSync = spyGitSync();
    const registry = registryWithGitSync(gitSync);
    const orchestrator = createOrchestrator(buildConfig({ db: { url: "postgres://x", poolMax: 2, ssl: false, autoMigrate: false } }), createFakePorts({ db: fakeDb }), registry);

    await expect(orchestrator.start()).rejects.toThrow(MigrationError);
    expect(gitSync.startCalls).toBe(0);
  });

  test("start() applies pending migrations and starts gitSync when autoMigrate is true", async () => {
    const fakeDb = createFakeDb();
    fakeDb.when(/[\s\S]*/, { rows: [] }); // catch-all: lets every migration file's own SQL body run
    fakeDb.when("to_regclass", { rows: [{ table_name: "schema_migrations" }] });
    fakeDb.when("SELECT version, name, checksum FROM schema_migrations", { rows: [] });
    fakeDb.when("pg_advisory_lock", { rows: [] });
    fakeDb.when("pg_advisory_unlock", { rows: [] });
    fakeDb.when("INSERT INTO schema_migrations", { rows: [] });
    const gitSync = spyGitSync();
    const registry = registryWithGitSync(gitSync);
    const orchestrator = createOrchestrator(
      buildConfig({ env: "development", db: { url: "postgres://x", poolMax: 2, ssl: false, autoMigrate: true } }),
      createFakePorts({ db: fakeDb }),
      registry,
    );

    await expect(orchestrator.start()).resolves.toBeUndefined();

    expect(gitSync.startCalls).toBe(1);
    const insertCalls = fakeDb.calls.filter((c) => c.sql.includes("INSERT INTO schema_migrations"));
    expect(insertCalls).toHaveLength(7);
  });

  test("start() succeeds without applying anything when checkOnly and nothing is pending", async () => {
    const applied = readRealMigrations().map((file) => ({
      version: file.version,
      name: file.name,
      checksum: checksumOf(file.sql),
    }));
    const fakeDb = createFakeDb();
    fakeDb.when("to_regclass", { rows: [{ table_name: "schema_migrations" }] });
    fakeDb.when("SELECT version, name, checksum FROM schema_migrations", { rows: applied });
    fakeDb.when("pg_advisory_lock", { rows: [] });
    fakeDb.when("pg_advisory_unlock", { rows: [] });
    const gitSync = spyGitSync();
    const registry = registryWithGitSync(gitSync);
    const orchestrator = createOrchestrator(
      buildConfig({ db: { url: "postgres://x", poolMax: 2, ssl: false, autoMigrate: false } }),
      createFakePorts({ db: fakeDb }),
      registry,
    );

    await expect(orchestrator.start()).resolves.toBeUndefined();

    expect(gitSync.startCalls).toBe(1);
    const insertCalls = fakeDb.calls.filter((c) => c.sql.includes("INSERT INTO schema_migrations"));
    expect(insertCalls).toHaveLength(0);
  });

  test("stop() closes a closeable db pool and stops gitSync, even after a failed start()", async () => {
    const fakeDb = createFakeDb();
    fakeDb.when("to_regclass", { rows: [{ table_name: "schema_migrations" }] });
    fakeDb.when("SELECT version, name, checksum FROM schema_migrations", { rows: [] });
    fakeDb.when("pg_advisory_lock", { rows: [] });
    fakeDb.when("pg_advisory_unlock", { rows: [] });
    const close = vi.fn(async () => {});
    const closeableDb = Object.assign(fakeDb, { close });
    const gitSync = spyGitSync();
    const registry = registryWithGitSync(gitSync);
    const orchestrator = createOrchestrator(
      buildConfig({ db: { url: "postgres://x", poolMax: 2, ssl: false, autoMigrate: false } }),
      createFakePorts({ db: closeableDb }),
      registry,
    );

    await expect(orchestrator.start()).rejects.toThrow(MigrationError);
    await expect(orchestrator.stop()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(gitSync.stopCalls).toBe(1);
  });

  test("stop() is a no-op-safe when the injected db has no close()", async () => {
    const orchestrator = createOrchestrator(buildConfig(), createFakePorts());

    await expect(orchestrator.stop()).resolves.toBeUndefined();
  });
});
