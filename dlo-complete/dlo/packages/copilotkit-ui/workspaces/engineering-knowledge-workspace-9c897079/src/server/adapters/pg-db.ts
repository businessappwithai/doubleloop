// src/server/adapters/pg-db.ts — the ONLY file in this repository that imports "pg" (Database.md
// "Connection strategy": "A single pg.Pool ... Nothing else in the codebase constructs a pool or a
// client."). Two non-obvious things live here:
//
// 1. Session settings and the PostgreSQL-17 version guard run once per *physical* connection, in
//    `PgDb.acquire()` — guarded by a `WeakSet` of already-configured clients, so a checkout that
//    reuses a warm connection costs nothing extra (Database.md "Connection strategy").
//
//    They used to run on the pool's `connect` event, and that crashed the whole server process.
//    `connect` listeners cannot be awaited, so `pg` handed the client to its caller while
//    `configureConnection` was still in flight; when the configure later rejected, the listener
//    called `client.release(err)` on a client the caller had *already* released, and `pg-pool`'s
//    `throwOnDoubleRelease` threw from inside a promise callback — an unhandled rejection that
//    killed Node. Against a PostgreSQL 16 server the version guard rejects on every single
//    connection, so the server died on its first query with a stack pointing at `pg-pool`, nothing
//    about the version. Configure at acquisition instead: the failure reaches the caller as an
//    ordinary rejection (`ConfigError('db.unsupportedVersion')`, which is the actionable message),
//    and `acquire` owns the release so it happens exactly once. Passing the error to `release`
//    still tells `pg` to destroy the connection rather than return a half-configured one to the
//    idle set. `configureConnection` remains exported so it can be unit-tested directly.
// 2. `withTransaction` pins one connection for its whole call. A *nested* call (one made from
//    inside the running `fn`) reuses that same connection and issues a `SAVEPOINT` instead of a
//    new `BEGIN`, per Database.md — Postgres cannot nest real transactions. `isolation`/`readOnly`
//    only make sense on the outermost `BEGIN`, so a nested call that supplies either throws rather
//    than silently discarding it.
import { Pool, type PoolClient } from "pg";
import type { AppConfig } from "../../config/config";
import { ConfigError, ValidationError } from "../../core/errors";
import type { Db, Isolation, Logger } from "../ports";

const SESSION_SETTINGS: readonly string[] = [
  "SET statement_timeout = 10000",
  "SET idle_in_transaction_session_timeout = 15000",
  "SET lock_timeout = 3000",
  "SET search_path = public",
];

const MIN_SERVER_VERSION_NUM = 170000;

/**
 * Issues every {@link SESSION_SETTINGS} statement on `client`, then asserts
 * `server_version_num >= 170000`, throwing `ConfigError('db.unsupportedVersion')` otherwise.
 * Exported so the pool's `connect` wiring (which cannot be awaited by `pg` itself) can be tested
 * by calling this directly against a fake client.
 */
export async function configureConnection(client: Pick<PoolClient, "query">): Promise<void> {
  for (const sql of SESSION_SETTINGS) {
    await client.query(sql);
  }
  const result = await client.query("SELECT current_setting('server_version_num') AS version_num");
  const raw = (result.rows[0] as { version_num?: string } | undefined)?.version_num;
  const versionNum = Number(raw);
  if (!Number.isFinite(versionNum) || versionNum < MIN_SERVER_VERSION_NUM) {
    throw new ConfigError(
      "db.unsupportedVersion",
      `PostgreSQL 17.0 or newer is required (server reports server_version_num=${raw ?? "unknown"})`,
      { details: { versionNum: raw ?? null } },
    );
  }
}

/** Any `$` in `sql` not immediately followed by a digit is not a `$n` placeholder. */
function assertPositionalSql(sql: string): void {
  for (let index = sql.indexOf("$"); index !== -1; index = sql.indexOf("$", index + 1)) {
    if (!/^\d/.test(sql.slice(index + 1))) {
      throw new ValidationError("SQL must use only $1..$n positional placeholders", {
        details: { reason: "db.invalidPlaceholder", sql },
      });
    }
  }
}

function buildBeginSql(opts?: { isolation?: Isolation; readOnly?: boolean }): string {
  const modes: string[] = [];
  if (opts?.isolation !== undefined) {
    modes.push(`ISOLATION LEVEL ${opts.isolation.toUpperCase()}`);
  }
  if (opts?.readOnly !== undefined) {
    modes.push(opts.readOnly ? "READ ONLY" : "READ WRITE");
  }
  return modes.length > 0 ? `BEGIN ${modes.join(", ")}` : "BEGIN";
}

/** `Db` bound to a single pinned connection, used inside a `withTransaction` call. */
class PinnedTransactionDb implements Db {
  constructor(
    private readonly client: PoolClient,
    private readonly depth: number,
  ) {}

  async query<TRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: TRow[]; rowCount: number }> {
    assertPositionalSql(sql);
    const result = await this.client.query(sql, params ? [...params] : undefined);
    return { rows: result.rows as TRow[], rowCount: result.rowCount ?? 0 };
  }

  async withTransaction<T>(
    fn: (tx: Db) => Promise<T>,
    opts?: { isolation?: Isolation; readOnly?: boolean },
  ): Promise<T> {
    if (opts?.isolation !== undefined || opts?.readOnly !== undefined) {
      throw new ValidationError(
        "isolation and readOnly can only be requested on the outermost withTransaction call; " +
          "PostgreSQL fixes them for the life of the transaction",
        { details: { reason: "db.nestedTransactionOptions" } },
      );
    }
    const savepoint = `sp_${this.depth + 1}`;
    await this.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(new PinnedTransactionDb(this.client, this.depth + 1));
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (err) {
      try {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      } catch {
        // The connection itself is unusable. The outermost withTransaction's release() below
        // lets the pool discard it instead of returning a poisoned connection to the idle set;
        // masking that secondary failure here would only hide the original `err` being rethrown.
      }
      throw err;
    }
  }
}

/**
 * The real {@link Db} adapter. Constructed once by the orchestrator during `start()` and closed
 * via {@link PgDb.close} during `stop()` — nothing else builds a `Pool`.
 */
export class PgDb implements Db {
  private readonly pool: Pool;
  private readonly logger: Logger;
  /**
   * Physical connections whose session settings have already been applied. A `WeakSet` so a client
   * the pool discards is collectable — this must never keep a dead connection alive.
   */
  private readonly configured = new WeakSet<PoolClient>();

  constructor(config: AppConfig, logger: Logger) {
    this.logger = logger;
    this.pool = new Pool({
      connectionString: config.db.url,
      max: config.db.poolMax,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: `ekw/${config.env}/${config.instanceId}`,
      ssl: config.db.ssl ? { rejectUnauthorized: true } : false,
    });

    // An error on an IDLE pooled connection has no caller to reject, and `pg` treats an
    // unhandled 'error' on the pool as fatal to the process. Log and let the pool discard it.
    this.pool.on("error", (err: Error) => {
      this.logger.error("db.idleClientError", { message: err.message });
    });
  }

  /**
   * Checks out a connection and guarantees its session settings are applied before the caller
   * sees it, exactly once per physical connection.
   *
   * This deliberately does NOT use `pool.on("connect")`, which is where this used to live and
   * which crashed the entire server process. That listener cannot be awaited, so `pg` handed the
   * client to its caller while `configureConnection` was still in flight; when the configure later
   * rejected, the handler called `client.release(err)` on a client the caller had *already*
   * released, and `pg-pool`'s `throwOnDoubleRelease` threw from inside a promise callback — an
   * unhandled rejection that took down Node. Configuring at acquisition instead means the failure
   * reaches the caller as a normal rejection, and this method owns the release, so it happens
   * exactly once. Passing the error to `release` still tells `pg` to destroy the connection rather
   * than return a half-configured one to the idle set.
   */
  private async acquire(): Promise<PoolClient> {
    const client = await this.pool.connect();
    if (this.configured.has(client)) {
      return client;
    }
    try {
      await configureConnection(client);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error("db.connectionConfigFailed", { message: error.message });
      client.release(error);
      throw error;
    }
    this.configured.add(client);
    return client;
  }

  async query<TRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: TRow[]; rowCount: number }> {
    assertPositionalSql(sql);
    const client = await this.acquire();
    try {
      const result = await client.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as TRow[], rowCount: result.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }

  async withTransaction<T>(
    fn: (tx: Db) => Promise<T>,
    opts?: { isolation?: Isolation; readOnly?: boolean },
  ): Promise<T> {
    const client = await this.acquire();
    try {
      await client.query(buildBeginSql(opts));
      try {
        const result = await fn(new PinnedTransactionDb(client, 0));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Same rationale as the SAVEPOINT path above: the original `err` is what callers need.
        }
        throw err;
      }
    } finally {
      client.release();
    }
  }

  /** Closes the pool. Called once, by whatever constructed this `PgDb`, during shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
