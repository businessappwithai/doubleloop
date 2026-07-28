// src/server/migrate.ts — the plain, numbered, forward-only SQL migration runner (Database.md
// "Migration approach"). `planMigrations` is pure: given every migration file currently on disk
// and every row already recorded in `schema_migrations`, it validates that the file set is
// exactly the contiguous sequence 1..N (`MigrationError('migration.gap')`) and that no
// already-applied file's current checksum has drifted from what was recorded when it ran
// (`MigrationError('migration.checksumMismatch')`), then returns the files still pending.
// `runMigrations` is the effectful half: it applies those files (or, in check-only mode, just
// returns the plan) behind the session-scoped `pg_advisory_lock(4479823001)` Database.md
// mandates.
//
// That lock is session-scoped — Database.md is explicit that this is `pg_advisory_lock`, not the
// transaction-scoped `pg_advisory_xact_lock` used elsewhere for hierarchy moves — so it must be
// acquired and released on the *same physical connection*. The `Db` port (`ports.ts`) only ever
// pins one connection for the lifetime of a `withTransaction` call, and a nested
// `withTransaction` reuses that same connection via `SAVEPOINT`. So the whole run — lock, every
// pending file, unlock — happens inside one outer `db.withTransaction`, with each file applied
// through a nested `withTransaction`. That is the only way, through nothing but `Db.query` and
// `Db.withTransaction`, to guarantee the lock and every file share one session: it makes a run
// atomic as a whole (every pending file lands, or none do, and the lock is released on the
// connection that took it) rather than committing file-by-file. That is a strictly stronger
// guarantee than partial, independently-committed per-file transactions, not a weaker one.
import { createHash } from "node:crypto";
import { MigrationError } from "../core/errors";
import type { Clock, Db } from "./ports";

/** Fixed advisory lock key. Must match Database.md's "Migration approach" exactly. */
export const MIGRATION_ADVISORY_LOCK_KEY = 4479823001;

/**
 * One migration file as loaded from disk. `sql` is the exact file bytes — used both to run the
 * file and to compute its checksum, so there is no separate precomputed checksum field that
 * could drift out of sync with the file it describes.
 */
export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
}

/** One row already recorded in `schema_migrations`. */
export interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationPlan {
  /** Files not yet recorded in `schema_migrations`, in ascending version order. */
  readonly pending: readonly MigrationFile[];
  readonly appliedCount: number;
}

export interface AppliedMigrationResult {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly durationMs: number;
}

export interface RunMigrationsOptions {
  /** Measures each file's `duration_ms`; injected so runs are deterministic under test. */
  readonly clock: Clock;
  /** When true, only computes and returns the plan. No DDL runs and nothing is recorded. */
  readonly checkOnly?: boolean;
}

export interface RunMigrationsResult {
  /** Empty when `checkOnly` is true. */
  readonly applied: readonly AppliedMigrationResult[];
  /** The files that were pending going into this run (before `applied` ran, if it did). */
  readonly pending: readonly MigrationFile[];
  readonly checkOnly: boolean;
}

/** SHA-256 of `sql`, lowercase hex — the exact format `schema_migrations.checksum` requires. */
export function computeChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function assertContiguous(sorted: readonly MigrationFile[]): void {
  for (let index = 0; index < sorted.length; index += 1) {
    const file = sorted[index];
    if (file === undefined) {
      continue;
    }
    const expectedVersion = index + 1;
    if (file.version !== expectedVersion) {
      throw new MigrationError(
        "migration.gap",
        `expected migration version ${expectedVersion} but found ${file.version} (${file.name})`,
        { details: { expectedVersion, foundVersion: file.version, name: file.name } },
      );
    }
  }
}

/**
 * Pure: validates `files` against `applied` and returns what is still pending. Throws
 * {@link MigrationError} with code `migration.gap` if `files`, sorted by version, is not exactly
 * the contiguous sequence `1..N`, and with code `migration.checksumMismatch` if any file already
 * recorded in `applied` no longer matches the checksum recorded when it ran.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigrationRow[],
): MigrationPlan {
  const sorted = [...files].sort((a, b) => a.version - b.version);
  assertContiguous(sorted);

  const fileByVersion = new Map(sorted.map((file) => [file.version, file]));
  for (const row of applied) {
    const file = fileByVersion.get(row.version);
    if (file === undefined) {
      continue;
    }
    const currentChecksum = computeChecksum(file.sql);
    if (currentChecksum !== row.checksum) {
      const label = `${String(row.version).padStart(3, "0")}_${row.name}.sql`;
      throw new MigrationError(
        "migration.checksumMismatch",
        `migration ${label} has been edited since it was applied`,
        {
          details: {
            version: row.version,
            name: row.name,
            recordedChecksum: row.checksum,
            fileChecksum: currentChecksum,
          },
        },
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = sorted.filter((file) => !appliedVersions.has(file.version));
  return { pending, appliedCount: applied.length };
}

interface SchemaMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

/**
 * Applies every pending migration file (or, when `opts.checkOnly` is true, only computes and
 * returns the plan) inside one outer transaction that holds `pg_advisory_lock` for its whole
 * duration — see the module header for why. Down-migrations do not exist; reversal is a new
 * forward migration file.
 */
export async function runMigrations(
  db: Db,
  files: readonly MigrationFile[],
  opts: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  return db.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      const appliedResult = await tx.query<SchemaMigrationRow>(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      );
      const plan = planMigrations(files, appliedResult.rows);

      if (opts.checkOnly === true) {
        return { applied: [], pending: plan.pending, checkOnly: true };
      }

      const applied: AppliedMigrationResult[] = [];
      for (const file of plan.pending) {
        const checksum = computeChecksum(file.sql);
        const startedAt = opts.clock.now().getTime();
        await tx.withTransaction(async (fileTx) => {
          await fileTx.query(file.sql);
          const durationMs = Math.max(0, opts.clock.now().getTime() - startedAt);
          await fileTx.query(
            "INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)",
            [file.version, file.name, checksum, durationMs],
          );
          applied.push({ version: file.version, name: file.name, checksum, durationMs });
        });
      }

      return { applied, pending: plan.pending, checkOnly: false };
    } finally {
      await tx.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    }
  });
}
