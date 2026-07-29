// src/server/orchestrator.ts — module m15, the Central Orchestrator (Architecture.md "Central
// Orchestrator"). `createOrchestrator(config, ports, registry?)` is deliberately pure over its
// arguments — it never reads `process.env` or constructs a `PgDb` itself — so
// `tests/orchestrator.test.ts` can build one entirely from `tests/helpers/fake-ports.ts` and a
// literal `AppConfig`. `getOrchestrator()` below is the *other* half Architecture.md rule 3
// requires ("the orchestrator is the only place that constructs adapters"): the process-wide
// singleton `src/routes/api/graphql.ts` calls, which does read `process.env` and build the real
// `PgDb`/`NodeClock`/`RandomIds`/`NodeFs`/`NodeGit` — mirroring `src/server/collab-server.ts`'s own
// `main()` composition exactly (same adapters, same construction order), just assembled through
// `wireModules`/`DEFAULT_REGISTRY` instead of by hand for a single module.
//
// `wireModules` builds every module in `resolveWiringOrder`'s order, threading each already-built
// module into the next one's `deps` — the loop itself is the only "computation" this file
// contains, and it is pure plumbing (an object literal keyed by name), not domain logic, so it
// does not violate rule 2 ("the orchestrator constructs; it does not compute").
//
// `start()` runs the migration **check** (`runMigrations(..., { checkOnly: true })`) whenever
// `config.db.autoMigrate` is false — which `loadConfig` (module m4) already forbids outside
// `env: "development"` — and throws `MigrationError('migration.pending')` if anything is still
// pending, rather than ever auto-applying in production. When `autoMigrate` is true it applies
// instead. Migration files are read straight off `sql/migrations/` via `node:fs` — this file is
// the composition root, exactly where Architecture.md rule 4 says filesystem access is allowed
// ("nothing *above* the orchestrator" touches it). `start()` then calls the one other thing in
// `OrchestratorModules` with its own lifecycle and an injected timer, `GitSyncModule.start()`
// (`git-sync-module.ts`'s own header: "Scheduling never uses a module-scope `setInterval`"), which
// is what `stop()`'s "closing the pool and clearing timers" acceptance criterion is actually
// about — `stop()` calls `modules.gitSync.stop()` unconditionally (it is documented idempotent
// even when never started, so this is safe after a `start()` that failed before reaching it) and
// then closes the pool if the injected `Db` exposes a `close()` (duck-typed: `PgDb` does,
// `tests/helpers/fake-ports.ts`'s `FakeDb` does not need to).
import {
  execute as executeGraphQL,
  GraphQLError,
  parse,
  validate,
  type ExecutionResult,
  type GraphQLSchema,
} from "graphql";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/config";
import { loadConfig } from "../config/config";
import type { Actor, RequestContext } from "../core/context";
import { createRequestContext as createCoreRequestContext } from "../core/context";
import { MigrationError } from "../core/errors";
import { createLogger } from "../lib/logger";
import { createNodeClock } from "./adapters/node-clock";
import { createNodeFs } from "./adapters/node-fs";
import { createNodeGit } from "./adapters/node-git";
import { PgDb } from "./adapters/pg-db";
import { createRandomIds } from "./adapters/random-ids";
import { remapExecutionError } from "./graphql-errors";
import { loadMigrationFile, runMigrations, type MigrationFile } from "./migrate";
import type { Ports } from "./ports";
import { createDefaultRegistry, wireModules, type ModuleRegistry } from "./registry";
import type { OrchestratorModules } from "./registry";
import { buildOrchestratorSchema, type OrchestratorRequestContext } from "./schema";

export interface OrchestratorExecuteInput {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  readonly operationName?: string;
  readonly ctx: OrchestratorRequestContext;
}

export interface Orchestrator {
  readonly config: AppConfig;
  readonly modules: OrchestratorModules;
  /** The merged executable schema; built once per orchestrator instance, memoized after that. */
  schema(): GraphQLSchema;
  /** Builds the per-request context every resolver receives. Throws `ValidationError` for a
   * missing/blank `requestId` or a missing `actor` (via `core/context.ts`'s own `createRequestContext`). */
  createRequestContext(input: { requestId: string; actor: Actor }): OrchestratorRequestContext;
  /** Executes one GraphQL operation. Never throws: parse/validation failures and mapped
   * execution errors alike come back as `{ errors }`, never a rejected promise. */
  execute(input: OrchestratorExecuteInput): Promise<ExecutionResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const MIGRATIONS_DIRNAME = fileURLToPath(new URL("../../sql/migrations", import.meta.url));

/** Reads every `*.sql` file directly under `dir`, sorted by filename so version order is stable
 * regardless of the OS's own directory-listing order. */
function loadMigrationFiles(dir: string): readonly MigrationFile[] {
  const filenames = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return filenames.map((filename) => loadMigrationFile(filename, readFileSync(join(dir, filename), "utf8")));
}

/** Closes `db` if it exposes a `close()` — `PgDb` does (a real pool to release);
 * `tests/helpers/fake-ports.ts`'s `FakeDb` does not, and has nothing to close. */
async function closeIfCloseable(db: unknown): Promise<void> {
  const closeable = db as { close?: () => Promise<void> };
  if (typeof closeable.close === "function") {
    await closeable.close();
  }
}

async function toGraphQLExecutionResult(input: OrchestratorExecuteInput, schema: GraphQLSchema, ports: Ports): Promise<ExecutionResult> {
  let document;
  try {
    document = parse(input.query);
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { errors: [err] };
    }
    throw err;
  }

  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    return { errors: validationErrors };
  }

  const result = await executeGraphQL({
    schema,
    document,
    contextValue: input.ctx,
    ...(input.variables !== undefined ? { variableValues: input.variables } : {}),
    ...(input.operationName !== undefined ? { operationName: input.operationName } : {}),
  });

  if (result.errors && result.errors.length > 0) {
    return { ...result, errors: result.errors.map((error) => remapExecutionError(error, ports.logger)) };
  }
  return result;
}

/**
 * Builds an {@link Orchestrator} from an already-validated `config` and already-constructed
 * `ports` — see this file's header for why adapter construction lives in `getOrchestrator`
 * instead. `registry` defaults to a *fresh* {@link createDefaultRegistry} call, not a shared
 * constant: three of the seven descriptors (`documents`, `collab`, `gitSync`) close over a
 * `create()`-time module instance (see `registry.ts`'s own header), so two `createOrchestrator`
 * calls sharing one registry would silently corrupt each other's wiring — every test in this
 * workspace that builds more than one orchestrator depends on this default being call-fresh.
 */
export function createOrchestrator(
  config: AppConfig,
  ports: Ports,
  registry: ModuleRegistry = createDefaultRegistry(),
): Orchestrator {
  const modules = wireModules(registry, ports, config);
  let cachedSchema: GraphQLSchema | undefined;

  function schema(): GraphQLSchema {
    if (!cachedSchema) {
      cachedSchema = buildOrchestratorSchema(registry);
    }
    return cachedSchema;
  }

  function createRequestContext(input: { requestId: string; actor: Actor }): OrchestratorRequestContext {
    const base: RequestContext = createCoreRequestContext(input);
    return {
      ...base,
      bundles: modules.bundles,
      concepts: modules.concepts,
      hierarchy: modules.hierarchy,
    };
  }

  async function execute(input: OrchestratorExecuteInput): Promise<ExecutionResult> {
    return toGraphQLExecutionResult(input, schema(), ports);
  }

  async function start(): Promise<void> {
    const files = loadMigrationFiles(MIGRATIONS_DIRNAME);
    const checkOnly = !config.db.autoMigrate;
    const result = await runMigrations(ports.db, files, { clock: ports.clock, checkOnly });

    if (checkOnly && result.pending.length > 0) {
      throw new MigrationError(
        "migration.pending",
        `cannot start with ${result.pending.length} pending migration(s); apply them before starting ` +
          `(config.db.autoMigrate only applies outside production)`,
        { details: { pending: result.pending.map((file) => ({ version: file.version, name: file.name })) } },
      );
    }

    modules.gitSync.start();
  }

  async function stop(): Promise<void> {
    modules.gitSync.stop();
    await closeIfCloseable(ports.db);
  }

  return { config, modules, schema, createRequestContext, execute, start, stop };
}

let singleton: Orchestrator | undefined;

/**
 * The process-wide {@link Orchestrator}, built from `process.env` and the real adapters —
 * constructed at most once per process. `src/routes/api/graphql.ts` is this function's only
 * caller.
 */
export function getOrchestrator(): Orchestrator {
  if (singleton) {
    return singleton;
  }

  const config = loadConfig(process.env);
  const clock = createNodeClock();
  const logger = createLogger({ level: config.logLevel, clock }).child({ service: "orchestrator" });
  const ports: Ports = {
    db: new PgDb(config, logger),
    clock,
    ids: createRandomIds(),
    logger,
    fs: createNodeFs(config.gitSync.repoPath),
    git: createNodeGit(),
  };

  singleton = createOrchestrator(config, ports);
  return singleton;
}
