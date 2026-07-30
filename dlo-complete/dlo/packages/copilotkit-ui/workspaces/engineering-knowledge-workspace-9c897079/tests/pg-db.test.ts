// tests/pg-db.test.ts — module m5 (Ports and adapters). Covers the real Db adapter (pg-db.ts),
// the ONLY file allowed to import "pg" (Database.md "Connection strategy"). "pg" is fully mocked
// with vi.mock so no test ever opens a socket: MockPool records the options it was constructed
// with, and MockPoolClient records every query issued against a pinned connection so
// BEGIN/SAVEPOINT/COMMIT/ROLLBACK sequencing and the client-release-on-both-paths contract are
// directly assertable.
//
// Session settings are applied in `PgDb.acquire()`, not on the pool's "connect" event, so every
// checkout in these tests really does issue the five configuration statements first. `makeClient`
// therefore answers the version probe with a supported version by default, and `sqlCalls` strips
// the configuration prefix so each test asserts only the SQL it is about.
import { describe, expect, test, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, ValidationError } from "../src/core/errors";
import type { AppConfig } from "../src/config/config";
import type { Logger } from "../src/server/ports";

vi.mock("pg", () => {
  class MockPoolClient {
    query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    release = vi.fn();
  }

  class MockPool {
    static instances: MockPool[] = [];
    options: Record<string, unknown>;
    listeners: Record<string, Array<(arg: never) => void>> = {};
    query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    connect = vi.fn(async () => new MockPoolClient());
    end = vi.fn(async () => undefined);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockPool.instances.push(this);
    }

    on(event: string, handler: (arg: never) => void): this {
      (this.listeners[event] ??= []).push(handler);
      return this;
    }
  }

  return { Pool: MockPool };
});

import { Pool } from "pg";
import { configureConnection, PgDb } from "../src/server/adapters/pg-db";

interface MockPoolClientLike {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface MockPoolInstance {
  options: Record<string, unknown>;
  listeners: Record<string, Array<(arg: never) => void>>;
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

const MockedPool = Pool as unknown as { instances: MockPoolInstance[] };

function latestPool(): MockPoolInstance {
  const instance = MockedPool.instances[MockedPool.instances.length - 1];
  if (!instance) {
    throw new Error("expected a Pool instance to have been constructed");
  }
  return instance;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function makeConfig(
  dbOverrides: Partial<AppConfig["db"]> = {},
  topOverrides: Partial<Pick<AppConfig, "env" | "instanceId">> = {},
): AppConfig {
  return {
    env: topOverrides.env ?? "test",
    instanceId: topOverrides.instanceId ?? "inst-1",
    port: 3000,
    db: {
      url: "postgres://user:pass@localhost:5432/ekw",
      poolMax: 10,
      ssl: false,
      autoMigrate: false,
      ...dbOverrides,
    },
    collab: { wsUrl: "ws://localhost:1234", port: 1234 },
    gitSync: { repoPath: "/repo", branch: "main", intervalMs: 300_000 },
    logLevel: "info",
  };
}

function makeLogger(): Logger & { errorCalls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> } {
  const errorCalls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg, fields) => {
      errorCalls.push({ msg, fields });
    },
    child: () => logger,
  };
  return Object.assign(logger, { errorCalls });
}

function createDb(
  dbOverrides: Partial<AppConfig["db"]> = {},
  topOverrides: Partial<Pick<AppConfig, "env" | "instanceId">> = {},
  logger: Logger = makeLogger(),
): { db: PgDb; config: AppConfig; pool: MockPoolInstance; logger: Logger } {
  const config = makeConfig(dbOverrides, topOverrides);
  const db = new PgDb(config, logger);
  return { db, config, pool: latestPool(), logger };
}

/** The five statements `configureConnection` issues on every physical connection, in order. */
const CONFIG_SQL: readonly string[] = [
  "SET statement_timeout = 10000",
  "SET idle_in_transaction_session_timeout = 15000",
  "SET lock_timeout = 3000",
  "SET search_path = public",
  "SELECT current_setting('server_version_num') AS version_num",
];

/**
 * A pooled client that reports a supported server version, so acquisition succeeds and each test
 * can assert the SQL it actually cares about. Override `query` to model a failing connection.
 */
function makeClient(versionNum = "170000"): MockPoolClientLike {
  return {
    query: vi.fn(async (sql: string) =>
      sql.startsWith("SELECT current_setting")
        ? { rows: [{ version_num: versionNum }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    ),
    release: vi.fn(),
  };
}

/** The SQL a client saw, with the connection-configuration prefix removed. */
function sqlCalls(client: MockPoolClientLike): string[] {
  return client.query.mock.calls
    .map((call) => call[0] as string)
    .filter((sql) => !CONFIG_SQL.includes(sql));
}

beforeEach(() => {
  MockedPool.instances.length = 0;
});

// ---------------------------------------------------------------------------
// configureConnection
// ---------------------------------------------------------------------------

describe("configureConnection", () => {
  function makeVersionClient(versionRow: { version_num?: string } | undefined) {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.startsWith("SELECT current_setting")) {
          return { rows: versionRow ? [versionRow] : [], rowCount: versionRow ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    return { client, calls };
  }

  test("issues every session setting then the version check, in order", async () => {
    const { client, calls } = makeVersionClient({ version_num: "170004" });
    await configureConnection(client);
    expect(calls).toEqual([
      "SET statement_timeout = 10000",
      "SET idle_in_transaction_session_timeout = 15000",
      "SET lock_timeout = 3000",
      "SET search_path = public",
      "SELECT current_setting('server_version_num') AS version_num",
    ]);
  });

  test("resolves when server_version_num is exactly the minimum supported", async () => {
    const { client } = makeVersionClient({ version_num: "170000" });
    await expect(configureConnection(client)).resolves.toBeUndefined();
  });

  test("resolves when server_version_num is newer than the minimum", async () => {
    const { client } = makeVersionClient({ version_num: "180000" });
    await expect(configureConnection(client)).resolves.toBeUndefined();
  });

  test("throws ConfigError('db.unsupportedVersion') when the server predates PostgreSQL 17", async () => {
    const { client } = makeVersionClient({ version_num: "160003" });
    try {
      await configureConnection(client);
      throw new Error("expected configureConnection to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configError = err as ConfigError;
      expect(configError.code).toBe("db.unsupportedVersion");
      expect(configError.details["versionNum"]).toBe("160003");
    }
  });

  test("throws ConfigError('db.unsupportedVersion') when version_num is missing from the row", async () => {
    const { client } = makeVersionClient(undefined);
    try {
      await configureConnection(client);
      throw new Error("expected configureConnection to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).details["versionNum"]).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// PgDb constructor and the pool's "connect" wiring
// ---------------------------------------------------------------------------

describe("PgDb constructor", () => {
  test("constructs a single Pool with the documented connection options", () => {
    const { pool } = createDb({ url: "postgres://a:b@host:5432/db", poolMax: 7, ssl: false }, { env: "production", instanceId: "abc" });
    expect(pool.options).toEqual({
      connectionString: "postgres://a:b@host:5432/db",
      max: 7,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "ekw/production/abc",
      ssl: false,
    });
  });

  test("enables ssl with rejectUnauthorized when config.db.ssl is true", () => {
    const { pool } = createDb({ ssl: true });
    expect(pool.options["ssl"]).toEqual({ rejectUnauthorized: true });
  });

  test("registers a pool 'error' listener so an idle-client error cannot kill the process", () => {
    const { pool } = createDb();
    expect(pool.listeners["error"]).toHaveLength(1);
  });

  test("logs an idle-client error instead of rethrowing it", () => {
    const { pool, logger } = createDb() as ReturnType<typeof createDb> & {
      logger: Logger & { errorCalls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> };
    };

    const onError = pool.listeners["error"]?.[0] as unknown as (err: Error) => void;
    expect(() => onError(new Error("terminated"))).not.toThrow();

    expect(logger.errorCalls).toHaveLength(1);
    expect(logger.errorCalls[0]?.msg).toBe("db.idleClientError");
    expect(logger.errorCalls[0]?.fields?.["message"]).toBe("terminated");
  });

  test("does not register a 'connect' listener — configuration happens at acquisition", () => {
    const { pool } = createDb();
    expect(pool.listeners["connect"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Connection configuration at acquisition
//
// This block is the regression guard for a crash, not a style preference. Configuration used to
// run fire-and-forget on the pool's "connect" event, which cannot be awaited: `pg` handed the
// client to its caller while `configureConnection` was still in flight, and the later rejection
// called `client.release(err)` on a client the caller had already released. `pg-pool`'s
// `throwOnDoubleRelease` then threw from inside a promise callback — an unhandled rejection that
// killed Node. Against a PostgreSQL 16 server the version guard fails on every connection, so the
// server died on its first query.
// ---------------------------------------------------------------------------

describe("PgDb connection configuration", () => {
  test("applies every session setting before the caller's first statement", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.query("SELECT 1");

    expect(client.query.mock.calls.slice(0, 5).map((call) => call[0])).toEqual(CONFIG_SQL);
    expect(client.query.mock.calls[5]?.[0]).toBe("SELECT 1");
  });

  test("configures a physical connection once, not on every checkout", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValue(client);

    await db.query("SELECT 1");
    await db.query("SELECT 2");

    const configureCount = client.query.mock.calls.filter(
      (call) => call[0] === "SET statement_timeout = 10000",
    ).length;
    expect(configureCount).toBe(1);
    expect(sqlCalls(client)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("configures each distinct physical connection", async () => {
    const { db, pool } = createDb();
    const first = makeClient();
    const second = makeClient();
    pool.connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await db.query("SELECT 1");
    await db.query("SELECT 2");

    expect(first.query.mock.calls[0]?.[0]).toBe("SET statement_timeout = 10000");
    expect(second.query.mock.calls[0]?.[0]).toBe("SET statement_timeout = 10000");
  });

  test("rejects the caller with ConfigError when the server predates PostgreSQL 17", async () => {
    const { db, pool } = createDb();
    const client = makeClient("160013");
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("SELECT 1")).rejects.toBeInstanceOf(ConfigError);
    await expect(db.query("SELECT 1").catch((e: ConfigError) => e.code)).resolves.toBe(
      "db.unsupportedVersion",
    );
  });

  test("releases the bad connection exactly once, passing the error so pg destroys it", async () => {
    const { db, pool } = createDb();
    const client = makeClient("160013");
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("SELECT 1")).rejects.toThrow(ConfigError);

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(ConfigError);
  });

  test("never issues the caller's statement on a connection that failed configuration", async () => {
    const { db, pool } = createDb();
    const client = makeClient("160013");
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("SELECT 1")).rejects.toThrow(ConfigError);

    expect(sqlCalls(client)).toEqual([]);
  });

  test("logs db.connectionConfigFailed with the error message", async () => {
    const { db, pool, logger } = createDb() as ReturnType<typeof createDb> & {
      logger: Logger & { errorCalls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> };
    };
    const client = makeClient("160013");
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("SELECT 1")).rejects.toThrow(ConfigError);

    expect(logger.errorCalls).toHaveLength(1);
    expect(logger.errorCalls[0]?.msg).toBe("db.connectionConfigFailed");
    expect(String(logger.errorCalls[0]?.fields?.["message"])).toContain("PostgreSQL 17.0 or newer");
  });

  test("rejects the caller when a session-setting query itself fails, releasing once", async () => {
    const { db, pool, logger } = createDb() as ReturnType<typeof createDb> & {
      logger: Logger & { errorCalls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> };
    };
    const client = makeClient();
    const failure = new Error("connection lost");
    client.query.mockRejectedValue(failure);
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("SELECT 1")).rejects.toBe(failure);

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBe(failure);
    expect(logger.errorCalls[0]?.fields?.["message"]).toBe("connection lost");
  });

  test("a failed acquisition does not poison later checkouts on a healthy connection", async () => {
    const { db, pool } = createDb();
    const bad = makeClient("160013");
    const good = makeClient();
    pool.connect.mockResolvedValueOnce(bad).mockResolvedValueOnce(good);

    await expect(db.query("SELECT 1")).rejects.toThrow(ConfigError);
    await expect(db.query("SELECT 2")).resolves.toEqual({ rows: [], rowCount: 0 });

    expect(sqlCalls(good)).toEqual(["SELECT 2"]);
  });

  test("configuration also runs for withTransaction, before BEGIN", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok");

    expect(client.query.mock.calls.slice(0, 5).map((call) => call[0])).toEqual(CONFIG_SQL);
    expect(sqlCalls(client)).toEqual(["BEGIN", "COMMIT"]);
  });

  test("withTransaction rejects and never BEGINs when configuration fails", async () => {
    const { db, pool } = createDb();
    const client = makeClient("160013");
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.withTransaction(async () => "ok")).rejects.toThrow(ConfigError);

    expect(sqlCalls(client)).toEqual([]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PgDb.query
// ---------------------------------------------------------------------------

describe("PgDb.query", () => {
  test("issues sql and params on a pooled connection, returning rows and rowCount", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT current_setting")) {
        return { rows: [{ version_num: "170000" }], rowCount: 1 };
      }
      return { rows: [{ id: 1 }], rowCount: 1 };
    });
    pool.connect.mockResolvedValueOnce(client);

    const result = await db.query<{ id: number }>("SELECT * FROM t WHERE id = $1", [1]);

    expect(client.query).toHaveBeenCalledWith("SELECT * FROM t WHERE id = $1", [1]);
    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
  });

  test("releases the connection back to the pool after a successful query", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.query("SELECT 1");

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  test("releases the connection even when the query itself rejects", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    const failure = new Error("syntax error");
    client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT current_setting")) {
        return { rows: [{ version_num: "170000" }], rowCount: 1 };
      }
      if (sql.startsWith("SET ")) {
        return { rows: [], rowCount: 0 };
      }
      throw failure;
    });
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("SELECT bad")).rejects.toBe(failure);

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("defaults rowCount to 0 when the driver reports a nullish rowCount", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT current_setting")
        ? { rows: [{ version_num: "170000" }], rowCount: 1 }
        : { rows: [], rowCount: null },
    );
    pool.connect.mockResolvedValueOnce(client);

    const result = await db.query("SELECT 1");

    expect(result.rowCount).toBe(0);
  });

  test("passes params through as undefined when none are given", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.query("SELECT 1");

    expect(client.query).toHaveBeenCalledWith("SELECT 1", undefined);
  });

  test("rejects with ValidationError before checking out a connection when sql has a non-numeric placeholder", async () => {
    const { db, pool } = createDb();

    try {
      await db.query("SELECT * FROM t WHERE name = $name");
      throw new Error("expected query to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details["reason"]).toBe("db.invalidPlaceholder");
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("rejects with ValidationError when a bare '$' is the final character", async () => {
    const { db, pool } = createDb();

    await expect(db.query("SELECT a$")).rejects.toThrow(ValidationError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("accepts a '$' inside a single-quoted literal — it is a regex anchor, not a placeholder", async () => {
    // This is the exact shape every migration's CHECK constraint uses:
    //   CHECK (checksum ~ '^[0-9a-f]{64}$')
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(
      db.query("SELECT * FROM t WHERE checksum ~ '^[0-9a-f]{64}$'"),
    ).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  test("handles the '' escape inside a literal without losing track of the quote", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("SELECT 'it''s $ fine'")).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  test("rejects an unterminated single-quoted literal rather than skipping the rest", async () => {
    const { db, pool } = createDb();

    await expect(db.query("SELECT 'unterminated $x")).rejects.toThrow(ValidationError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("accepts a '$' inside a double-quoted identifier", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query('SELECT "odd$column" FROM t')).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  test("ignores a '$' inside a -- line comment but still checks the line after it", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("-- costs $5\nSELECT 1")).resolves.toEqual({ rows: [], rowCount: 0 });
    await expect(db.query("-- costs $5\nSELECT $bad")).rejects.toThrow(ValidationError);
  });

  test("ignores a '$' inside a nested block comment", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("/* outer /* inner $x */ still */ SELECT 1")).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
  });

  test("rejects an unterminated block comment", async () => {
    const { db, pool } = createDb();

    await expect(db.query("/* never closed SELECT 1")).rejects.toThrow(ValidationError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("accepts every migration file checked into sql/migrations", async () => {
    // The guard rejected all seven of them at one point — `$` is the end-of-string anchor in the
    // CHECK-constraint regexes, and `DO $$ ... $$` is the only conditional CREATE TYPE form — so
    // no database could be migrated at all. Reading the real files keeps that honest: a new
    // migration using another legitimate `$` construct fails here rather than in production.
    const dir = join(process.cwd(), "sql", "migrations");
    const files = readdirSync(dir).filter((name) => name.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const { db, pool } = createDb();
      pool.connect.mockResolvedValueOnce(makeClient());
      await expect(db.query(readFileSync(join(dir, name), "utf8"))).resolves.toBeDefined();
    }
  });

  test("accepts DDL containing a DO $$ ... $$ block", async () => {
    // The migration files use `DO $$ BEGIN ... END $$` for conditional CREATE TYPE, which has no
    // IF NOT EXISTS form. Scanning inside those bodies made every migration fail, so no database
    // could ever be migrated.
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(
      db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1) THEN CREATE TYPE t AS ENUM ('a'); END IF; END $$"),
    ).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  test("accepts a tagged dollar-quoted body", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(
      db.query("CREATE FUNCTION f() RETURNS void AS $body$ SELECT $notaparam $body$ LANGUAGE sql"),
    ).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  test("still validates placeholders OUTSIDE a dollar-quoted body", async () => {
    const { db, pool } = createDb();

    await expect(db.query("SELECT * FROM t WHERE a = $bad AND b = $$ok$$")).rejects.toThrow(
      ValidationError,
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("still accepts $1..$n alongside a dollar-quoted body", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(
      db.query("SELECT * FROM t WHERE a = $1 AND note = $$literal$$", [1]),
    ).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  test("rejects an unbalanced dollar-quote opener rather than treating the rest as quoted", async () => {
    const { db, pool } = createDb();

    await expect(db.query("SELECT $$ unterminated")).rejects.toThrow(ValidationError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("accepts a query using only $1..$n positional placeholders", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await expect(db.query("SELECT * FROM t WHERE a = $1 AND b = $2", [1, 2])).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// PgDb.withTransaction
// ---------------------------------------------------------------------------

describe("PgDb.withTransaction", () => {
  test("commits and releases the connection once fn resolves", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    const result = await db.withTransaction(async () => 42);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(sqlCalls(client)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
    expect(result).toBe(42);
  });

  test("builds BEGIN with an isolation level and READ ONLY when both opts are given", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok", { isolation: "serializable", readOnly: true });

    expect(sqlCalls(client)[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY");
  });

  test("builds BEGIN with only an isolation level when readOnly is omitted", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok", { isolation: "repeatable read" });

    expect(sqlCalls(client)[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  });

  test("builds BEGIN with only READ WRITE when readOnly is explicitly false", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok", { readOnly: false });

    expect(sqlCalls(client)[0]).toBe("BEGIN READ WRITE");
  });

  test("builds a bare BEGIN when no opts are given", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok");

    expect(sqlCalls(client)[0]).toBe("BEGIN");
  });

  test("rolls back and rethrows the original error on rejection, still releasing the connection", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);
    const failure = new Error("boom");

    await expect(db.withTransaction(async () => Promise.reject(failure))).rejects.toBe(failure);

    expect(sqlCalls(client)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("swallows a failing ROLLBACK and still rethrows the original error", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);
    const failure = new Error("boom");
    client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT current_setting")) {
        return { rows: [{ version_num: "170000" }], rowCount: 1 };
      }
      if (sql === "ROLLBACK") {
        throw new Error("connection already closed");
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(db.withTransaction(async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("a nested call reuses the same connection and opens a SAVEPOINT instead of BEGIN", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    const result = await db.withTransaction(async (tx) => {
      const inner = await tx.withTransaction(async () => "inner-value");
      return `outer-${inner}`;
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(sqlCalls(client)).toEqual([
      "BEGIN",
      "SAVEPOINT sp_1",
      "RELEASE SAVEPOINT sp_1",
      "COMMIT",
    ]);
    expect(result).toBe("outer-inner-value");
  });

  test("a doubly-nested call uses sp_2 and releases savepoints inside out", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async (tx) => {
      await tx.withTransaction(async (tx2) => {
        await tx2.withTransaction(async () => "deep");
      });
    });

    expect(sqlCalls(client)).toEqual([
      "BEGIN",
      "SAVEPOINT sp_1",
      "SAVEPOINT sp_2",
      "RELEASE SAVEPOINT sp_2",
      "RELEASE SAVEPOINT sp_1",
      "COMMIT",
    ]);
  });

  test("a nested call that supplies isolation or readOnly throws ValidationError without issuing a SAVEPOINT", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    try {
      await db.withTransaction(async (tx) => {
        await tx.withTransaction(async () => "x", { isolation: "serializable" });
      });
      throw new Error("expected withTransaction to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details["reason"]).toBe("db.nestedTransactionOptions");
    }

    expect(sqlCalls(client)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  test("a nested failure rolls back to its SAVEPOINT, then the outer transaction rolls back too", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);
    const failure = new Error("inner boom");

    await expect(
      db.withTransaction(async (tx) => {
        await tx.withTransaction(async () => Promise.reject(failure));
      }),
    ).rejects.toBe(failure);

    expect(sqlCalls(client)).toEqual([
      "BEGIN",
      "SAVEPOINT sp_1",
      "ROLLBACK TO SAVEPOINT sp_1",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("swallows a failing ROLLBACK TO SAVEPOINT and still rethrows the original nested error", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);
    const failure = new Error("inner boom");
    client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT current_setting")) {
        return { rows: [{ version_num: "170000" }], rowCount: 1 };
      }
      if (sql === "ROLLBACK TO SAVEPOINT sp_1") {
        throw new Error("connection already closed");
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(
      db.withTransaction(async (tx) => {
        await tx.withTransaction(async () => Promise.reject(failure));
      }),
    ).rejects.toBe(failure);
  });

  test("queries issued through a nested tx go through the same pinned connection", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);
    client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT current_setting")) {
        return { rows: [{ version_num: "170000" }], rowCount: 1 };
      }
      return sql.startsWith("SELECT") ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    });

    await db.withTransaction(async (tx) => {
      await tx.withTransaction(async (tx2) => {
        const result = await tx2.query<{ n: number }>("SELECT 1 AS n");
        expect(result.rows).toEqual([{ n: 1 }]);
      });
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PgDb.close
// ---------------------------------------------------------------------------

describe("PgDb.close", () => {
  test("closes the underlying pool", async () => {
    const { db, pool } = createDb();
    await db.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
