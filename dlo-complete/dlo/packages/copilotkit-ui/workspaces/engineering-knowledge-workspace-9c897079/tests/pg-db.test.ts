// tests/pg-db.test.ts — module m5 (Ports and adapters). Covers the real Db adapter (pg-db.ts),
// the ONLY file allowed to import "pg" (Database.md "Connection strategy"). "pg" is fully mocked
// with vi.mock so no test ever opens a socket: MockPool records the options it was constructed
// with and the "connect" listener pg-db.ts registers, and MockPoolClient records every query
// issued against a pinned connection so BEGIN/SAVEPOINT/COMMIT/ROLLBACK sequencing and the
// client-release-on-both-paths contract are directly assertable.
import { describe, expect, test, vi, beforeEach } from "vitest";
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
    connectHandler: ((client: MockPoolClient) => void) | undefined;
    query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    connect = vi.fn(async () => new MockPoolClient());
    end = vi.fn(async () => undefined);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockPool.instances.push(this);
    }

    on(event: string, handler: (client: MockPoolClient) => void): this {
      if (event === "connect") {
        this.connectHandler = handler;
      }
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
  connectHandler: ((client: MockPoolClientLike) => void) | undefined;
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

function makeClient(): MockPoolClientLike {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
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

  test("registers exactly one 'connect' handler on the pool", () => {
    const { pool } = createDb();
    expect(pool.connectHandler).toBeTypeOf("function");
  });

  test("a healthy connection is configured and never released", async () => {
    const { pool, logger } = createDb();
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT current_setting") ? { rows: [{ version_num: "170000" }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );

    pool.connectHandler?.(client);
    await flushMicrotasks();

    expect(client.query).toHaveBeenCalledWith("SET statement_timeout = 10000");
    expect(client.release).not.toHaveBeenCalled();
    expect((logger as Logger & { errorCalls: unknown[] }).errorCalls).toEqual([]);
  });

  test("releases the connection with the error and logs when the version guard fails", async () => {
    const { pool, logger } = createDb() as ReturnType<typeof createDb> & {
      logger: Logger & { errorCalls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> };
    };
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT current_setting") ? { rows: [{ version_num: "160000" }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );

    pool.connectHandler?.(client);
    await flushMicrotasks();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(ConfigError);
    expect(logger.errorCalls).toHaveLength(1);
    expect(logger.errorCalls[0]?.msg).toBe("db.connectionConfigFailed");
  });

  test("releases the connection with the error when a session-setting query itself fails", async () => {
    const { pool, logger } = createDb() as ReturnType<typeof createDb> & {
      logger: Logger & { errorCalls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> };
    };
    const client = makeClient();
    const failure = new Error("connection lost");
    client.query.mockRejectedValue(failure);

    pool.connectHandler?.(client);
    await flushMicrotasks();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBe(failure);
    expect(logger.errorCalls[0]?.fields?.["message"]).toBe("connection lost");
  });
});

// ---------------------------------------------------------------------------
// PgDb.query
// ---------------------------------------------------------------------------

describe("PgDb.query", () => {
  test("delegates to the pool with sql and params, returning rows and rowCount", async () => {
    const { db, pool } = createDb();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

    const result = await db.query<{ id: number }>("SELECT * FROM t WHERE id = $1", [1]);

    expect(pool.query).toHaveBeenCalledWith("SELECT * FROM t WHERE id = $1", [1]);
    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
  });

  test("defaults rowCount to 0 when the driver reports a nullish rowCount", async () => {
    const { db, pool } = createDb();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: null });

    const result = await db.query("SELECT 1");

    expect(result.rowCount).toBe(0);
  });

  test("passes params through as undefined when none are given", async () => {
    const { db, pool } = createDb();

    await db.query("SELECT 1");

    expect(pool.query).toHaveBeenCalledWith("SELECT 1", undefined);
  });

  test("rejects with ValidationError before reaching the pool when sql has a non-numeric placeholder", async () => {
    const { db, pool } = createDb();

    try {
      await db.query("SELECT * FROM t WHERE name = $name");
      throw new Error("expected query to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details["reason"]).toBe("db.invalidPlaceholder");
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("rejects with ValidationError when a '$' is the final character", async () => {
    const { db, pool } = createDb();

    await expect(db.query("SELECT '$'")).rejects.toThrow(ValidationError);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("accepts a query using only $1..$n positional placeholders", async () => {
    const { db, pool } = createDb();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

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
    expect(client.query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "COMMIT"]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
    expect(result).toBe(42);
  });

  test("builds BEGIN with an isolation level and READ ONLY when both opts are given", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok", { isolation: "serializable", readOnly: true });

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY");
  });

  test("builds BEGIN with only an isolation level when readOnly is omitted", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok", { isolation: "repeatable read" });

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  });

  test("builds BEGIN with only READ WRITE when readOnly is explicitly false", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok", { readOnly: false });

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN READ WRITE");
  });

  test("builds a bare BEGIN when no opts are given", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await db.withTransaction(async () => "ok");

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
  });

  test("rolls back and rethrows the original error on rejection, still releasing the connection", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);
    const failure = new Error("boom");

    await expect(db.withTransaction(async () => Promise.reject(failure))).rejects.toBe(failure);

    expect(client.query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("swallows a failing ROLLBACK and still rethrows the original error", async () => {
    const { db, pool } = createDb();
    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);
    const failure = new Error("boom");
    client.query.mockImplementation(async (sql: string) => {
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
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
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

    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
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

    expect(client.query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
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

    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
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
    client.query.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT") ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );

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
