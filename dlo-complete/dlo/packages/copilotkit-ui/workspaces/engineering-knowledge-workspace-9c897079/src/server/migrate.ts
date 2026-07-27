// src/server/migrate.ts — module m6 (SQL migrations and the migration runner). Database.md
// "Migration approach": "Plain, numbered, forward-only SQL files plus a ~120-line runner — no
// framework." `planMigrations` is the pure half — ordering, gap detection, checksum comparison —
// and is exercised directly with literal arrays in tests/migrate-plan.test.ts. `runMigrations` is
// the effectful half, built entirely on the `Db` port so tests/migrate-run.test.ts can drive it
// against the fake `Db` from tests/helpers/fake-ports.ts without ever opening a real connection.
//
// Two non-obvious things:
//
// 1. `pg_advisory_lock(4479823001)` is taken before anything else runs — including in check-only
//    mode — and released in a `finally`, so two app instances starting simultaneously (or a
//    check racing an apply) cannot observe or act on an inconsistent ledger.
// 2. `duration_ms` is measured with an injected `Clock` (`opts.clock`), never `Date.now()`
//    directly — this file has no adapter of its own to construct one, per the "central
//    orchestrator" rule that only the orchestrator builds real ports; the caller (a future CLI
//    entry point or the orchestrator) supplies `createNodeClock()` in production and
//    `createFakeClock()` in tests. The window measured is "run the migration's own SQL", not
//    "run the migration and record it" — the bookkeeping INSERT happens after the clock read, so
//    its own (negligible) cost is not attributed to the migration.
import { createHash } from "node:crypto";
import { MigrationError } from "../core/errors";
import type { Clock, Db } from "./ports";

/** `pg_advisory_lock` key. Fixed and arbitrary — any two DLO-generated apps must not collide on
 * a shared Postgres instance's advisory lock namespace, so this is not derived from anything
 * that could coincide with another app's choice. */
export const MIGRATION_ADVISORY_LOCK_KEY = 4479823001;

/** One forward-only migration file, already read from disk and parsed by the caller. */
export interface MigrationFile {
  readonly version: number;
  readonly filename: string;
  readonly name: string;
  readonly sql: string;
}

/** One row of `schema_migrations`, as read back from the database. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

/** The result of `planMigrations`: every file not yet recorded in `schema_migrations`, in the
 * strict numeric order they must be applied. */
export interface MigrationPlan {
  readonly pending: readonly MigrationFile[];
}

/** One applied migration's outcome, returned by `runMigrations`. */
export interface AppliedMigrationResult {
  readonly version: number;
  readonly name: string;
  readonly durationMs: number;
}

export interface RunMigrationsOptions {
  /** Clock used to measure `duration_ms`. Never defaulted — see the module header. */
  readonly clock: Clock;
  /** When true, `runMigrations` acquires the lock, computes the plan, releases the lock, and
   * returns without applying anything or opening a transaction. */
  readonly checkOnly?: boolean;
}

export interface RunMigrationsResult {
  readonly applied: readonly AppliedMigrationResult[];
  readonly pending: readonly MigrationFile[];
}

const FILENAME_PATTERN = /^(\d{3,})_([a-z][a-z0-9_]*)\.sql$/;

/**
 * SHA-256 of a migration file's SQL text, lowercase hex — the exact form
 * `schema_migrations.checksum`'s `CHECK` constraint requires.
 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Parses a migration filename of the form `NNN_name.sql` into its numeric version and bare name.
 * Throws `MigrationError('migration.invalidFilename')` for anything else — a non-numeric prefix,
 * a missing `.sql` extension, or a name with characters outside `[a-z0-9_]`.
 */
export function parseMigrationFilename(filename: string): { version: number; name: string } {
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) {
    throw new MigrationError(
      "migration.invalidFilename",
      `migration filename "${filename}" does not match the required NNN_name.sql shape`,
      { details: { filename } },
    );
  }
  const [, versionText, name] = match;
  return { version: Number(versionText), name: name as string };
}

/** Builds a {@link MigrationFile} from a filename and its contents, deriving `version`/`name`. */
export function loadMigrationFile(filename: string, sql: string): MigrationFile {
  const { version, name } = parseMigrationFilename(filename);
  return { version, filename, name, sql };
}

/**
 * Sorts `files` by version and asserts they form a contiguous `1..N` sequence with no duplicates
 * and no gaps. Throws `MigrationError('migration.gap')` otherwise.
 */
function sortAndAssertContiguous(files: readonly MigrationFile[]): readonly MigrationFile[] {
  const sorted = [...files].sort((a, b) => a.version - b.version);
  sorted.forEach((file, index) => {
    const expectedVersion = index + 1;
    if (file.version !== expectedVersion) {
      throw new MigrationError(
        "migration.gap",
        `expected migration version ${expectedVersion} but found ${file.version} (${file.filename})`,
        {
          details: {
            expectedVersion,
            actualVersion: file.version,
            filename: file.filename,
          },
        },
      );
    }
  });
  return sorted;
}

/**
 * Pure planning step. Validates that `files` are contiguously numbered from 1, that every
 * `applied` record still has a matching file whose checksum has not changed, and returns the
 * files not yet applied, in the order they must run.
 *
 * Throws `MigrationError('migration.gap')` when `files` has a numeric gap/duplicate, or when an
 * `applied` record references a version no longer present in `files` (the file was deleted after
 * having been applied — the ledger and the file list have diverged in the same structural way a
 * gap does). Throws `MigrationError('migration.checksumMismatch')` when an applied file's current
 * checksum no longer matches the one recorded at apply time.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const sortedFiles = sortAndAssertContiguous(files);
  const filesByVersion = new Map(sortedFiles.map((file) => [file.version, file]));
  const appliedVersions = new Set<number>();

  for (const record of applied) {
    const file = filesByVersion.get(record.version);
    if (!file) {
      throw new MigrationError(
        "migration.gap",
        `migration ${record.version}_${record.name} is recorded as applied but no matching file exists`,
        { details: { version: record.version, name: record.name } },
      );
    }
    const currentChecksum = checksumOf(file.sql);
    if (currentChecksum !== record.checksum) {
      throw new MigrationError(
        "migration.checksumMismatch",
        `migration ${file.filename} has been edited since it was applied`,
        {
          details: {
            filename: file.filename,
            recordedChecksum: record.checksum,
            currentChecksum,
          },
        },
      );
    }
    appliedVersions.add(record.version);
  }

  const pending = sortedFiles.filter((file) => !appliedVersions.has(file.version));
  return { pending };
}

interface SchemaMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

/**
 * Applies every pending migration, one file per transaction, in strict numeric order. Takes
 * {@link MIGRATION_ADVISORY_LOCK_KEY} before reading `schema_migrations` and releases it in a
 * `finally` regardless of outcome. In `checkOnly` mode, returns the plan without opening a
 * transaction or writing anything.
 */
export async function runMigrations(
  db: Db,
  files: readonly MigrationFile[],
  opts: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  await db.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    const { rows } = await db.query<SchemaMigrationRow>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    const plan = planMigrations(files, rows);

    if (opts.checkOnly === true) {
      return { applied: [], pending: plan.pending };
    }

    const applied: AppliedMigrationResult[] = [];
    for (const file of plan.pending) {
      const startedAt = opts.clock.now().getTime();
      await db.withTransaction(async (tx) => {
        await tx.query(file.sql);
        const durationMs = Math.max(0, opts.clock.now().getTime() - startedAt);
        await tx.query(
          "INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)",
          [file.version, file.name, checksumOf(file.sql), durationMs],
        );
        applied.push({ version: file.version, name: file.name, durationMs });
      });
    }

    return { applied, pending: [] };
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
  }
}
