// tests/migrate-run.test.ts — module m6 (SQL migrations and the migration runner). Covers the
// effectful half of src/server/migrate.ts, runMigrations, exercised only against the FakeDb from
// tests/helpers/fake-ports.ts — no real PostgreSQL connection is ever opened (Database.md "No unit
// test touches PostgreSQL"). Asserts: applying every pending file one transaction at a time, the
// all-applied no-op, check-only mode, the advisory lock being acquired before and released after
// (including when the plan itself throws), and duration_ms being derived from the injected Clock.
import { describe, expect, test } from "vitest";
import { MigrationError } from "../src/core/errors";
import { checksumOf, MIGRATION_ADVISORY_LOCK_KEY, runMigrations, type MigrationFile } from "../src/server/migrate";
import { createFakeClock, createFakeDb, type FakeDb } from "./helpers/fake-ports";

function file(version: number, name: string, sql?: string): MigrationFile {
  const body = sql ?? `-- migration ${version} (${name})`;
  return { version, name, filename: `${String(version).padStart(3, "0")}_${name}.sql`, sql: body };
}

function makeFiles(count: number): MigrationFile[] {
  return Array.from({ length: count }, (_, index) => file(index + 1, `step_${index + 1}`));
}

interface AppliedRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

/**
 * A FakeDb pre-wired with harmless catch-all responses for the advisory lock, every migration
 * file's own SQL, and the bookkeeping INSERT, plus a specific response for the ledger SELECT
 * (returning `appliedRows`) — so each test only has to override what it specifically cares about.
 */
function makeDb(appliedRows: readonly AppliedRow[] = []): FakeDb {
  const db = createFakeDb();
  db.when(/.*/, { rows: [], rowCount: 0 });
  db.when(/FROM schema_migrations/, { rows: [...appliedRows] });
  return db;
}

function lockCalls(db: FakeDb): string[] {
  return db.calls
    .filter((call) => call.sql.includes("pg_advisory_lock") || call.sql.includes("pg_advisory_unlock"))
    .map((call) => call.sql);
}

describe("runMigrations", () => {
  test("empty applied set: applies every file, one transaction per file, in order", async () => {
    const files = makeFiles(3);
    const db = makeDb([]);
    const clock = createFakeClock();

    const result = await runMigrations(db, files, { clock });

    expect(result.applied.map((a) => a.version)).toEqual([1, 2, 3]);
    expect(result.applied.map((a) => a.name)).toEqual(["step_1", "step_2", "step_3"]);
    expect(result.pending).toEqual([]);
    expect(db.transactions).toHaveLength(3);
    expect(db.transactions.every((t) => t.outcome === "commit")).toBe(true);
  });

  test("all-applied: no-op, no transaction is opened", async () => {
    const files = makeFiles(2);
    const applied: AppliedRow[] = files.map((f) => ({
      version: f.version,
      name: f.name,
      checksum: checksumOf(f.sql),
    }));
    const db = makeDb(applied);
    const clock = createFakeClock();

    const result = await runMigrations(db, files, { clock });

    expect(result.applied).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(db.transactions).toHaveLength(0);
  });

  test("partially applied: only pending files are applied, each in its own transaction", async () => {
    const files = makeFiles(3);
    const first = files[0] as MigrationFile;
    const applied: AppliedRow[] = [{ version: first.version, name: first.name, checksum: checksumOf(first.sql) }];
    const db = makeDb(applied);
    const clock = createFakeClock();

    const result = await runMigrations(db, files, { clock });

    expect(result.applied.map((a) => a.version)).toEqual([2, 3]);
    expect(db.transactions).toHaveLength(2);
  });

  test("check-only mode: returns the pending list, opens no transaction, writes nothing", async () => {
    const files = makeFiles(3);
    const first = files[0] as MigrationFile;
    const applied: AppliedRow[] = [{ version: first.version, name: first.name, checksum: checksumOf(first.sql) }];
    const db = makeDb(applied);
    const clock = createFakeClock();

    const result = await runMigrations(db, files, { clock, checkOnly: true });

    expect(result.applied).toEqual([]);
    expect(result.pending.map((f) => f.version)).toEqual([2, 3]);
    expect(db.transactions).toHaveLength(0);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO schema_migrations"))).toBe(false);
  });

  test("boundary: no files at all means zero transactions and an empty result", async () => {
    const db = makeDb([]);
    const clock = createFakeClock();

    const result = await runMigrations(db, [], { clock });

    expect(result).toEqual({ applied: [], pending: [] });
    expect(db.transactions).toHaveLength(0);
  });

  describe("advisory locking", () => {
    test("is acquired before the ledger read and released after, on success", async () => {
      const files = makeFiles(1);
      const db = makeDb([]);
      const clock = createFakeClock();

      await runMigrations(db, files, { clock });

      expect(db.calls[0]?.sql).toBe("SELECT pg_advisory_lock($1)");
      expect(db.calls[0]?.params).toEqual([MIGRATION_ADVISORY_LOCK_KEY]);
      expect(db.calls[db.calls.length - 1]?.sql).toBe("SELECT pg_advisory_unlock($1)");
      expect(db.calls[db.calls.length - 1]?.params).toEqual([MIGRATION_ADVISORY_LOCK_KEY]);
      expect(lockCalls(db)).toEqual(["SELECT pg_advisory_lock($1)", "SELECT pg_advisory_unlock($1)"]);
    });

    test("is acquired and released even in check-only mode", async () => {
      const files = makeFiles(1);
      const db = makeDb([]);
      const clock = createFakeClock();

      await runMigrations(db, files, { clock, checkOnly: true });

      expect(lockCalls(db)).toEqual(["SELECT pg_advisory_lock($1)", "SELECT pg_advisory_unlock($1)"]);
    });

    test("is released even when the plan throws on a numeric gap", async () => {
      const withGap = [file(1, "a"), file(3, "c")];
      const db = makeDb([]);
      const clock = createFakeClock();

      await expect(runMigrations(db, withGap, { clock })).rejects.toThrow(MigrationError);

      expect(lockCalls(db)).toEqual(["SELECT pg_advisory_lock($1)", "SELECT pg_advisory_unlock($1)"]);
      expect(db.transactions).toHaveLength(0);
    });

    test("is released even when the plan throws on a checksum mismatch", async () => {
      const original = file(1, "a", "CREATE TABLE a ();");
      const edited = file(1, "a", "CREATE TABLE a (); -- edited");
      const applied: AppliedRow[] = [{ version: 1, name: "a", checksum: checksumOf(original.sql) }];
      const db = makeDb(applied);
      const clock = createFakeClock();

      await expect(runMigrations(db, [edited], { clock })).rejects.toThrow(MigrationError);

      expect(lockCalls(db)).toEqual(["SELECT pg_advisory_lock($1)", "SELECT pg_advisory_unlock($1)"]);
      expect(db.transactions).toHaveLength(0);
    });
  });

  describe("failure modes", () => {
    test("rejects with MigrationError('migration.gap') when files have a numeric gap", async () => {
      const withGap = [file(1, "a"), file(3, "c")];
      const db = makeDb([]);
      const clock = createFakeClock();

      const promise = runMigrations(db, withGap, { clock });

      await expect(promise).rejects.toBeInstanceOf(MigrationError);
      await expect(promise).rejects.toMatchObject({ code: "migration.gap" });
    });

    test("rejects with MigrationError('migration.checksumMismatch') when an applied file was edited", async () => {
      const original = file(1, "a", "CREATE TABLE a ();");
      const edited = file(1, "a", "CREATE TABLE a (); -- edited");
      const applied: AppliedRow[] = [{ version: 1, name: "a", checksum: checksumOf(original.sql) }];
      const db = makeDb(applied);
      const clock = createFakeClock();

      const promise = runMigrations(db, [edited], { clock });

      await expect(promise).rejects.toBeInstanceOf(MigrationError);
      await expect(promise).rejects.toMatchObject({ code: "migration.checksumMismatch" });
    });
  });

  test("records version/name/checksum/duration_ms for each applied migration via the injected clock", async () => {
    const target = file(1, "extensions_enums_functions", "CREATE EXTENSION pg_trgm;");
    const db = createFakeDb();
    const clock = createFakeClock();
    db.when(/.*/, { rows: [], rowCount: 0 });
    db.when(/FROM schema_migrations/, { rows: [] });
    db.when(target.sql, () => {
      clock.advance(150);
      return { rows: [], rowCount: 0 };
    });

    const result = await runMigrations(db, [target], { clock });

    expect(result.applied).toEqual([{ version: 1, name: "extensions_enums_functions", durationMs: 150 }]);

    const insertCall = db.calls.find((call) => call.sql.includes("INSERT INTO schema_migrations"));
    expect(insertCall?.sql).toBe(
      "INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)",
    );
    expect(insertCall?.params).toEqual([1, "extensions_enums_functions", checksumOf(target.sql), 150]);
  });

  test("measures duration per file independently across multiple pending migrations", async () => {
    const first = file(1, "a", "-- first");
    const second = file(2, "b", "-- second");
    const db = createFakeDb();
    const clock = createFakeClock();
    db.when(/.*/, { rows: [], rowCount: 0 });
    db.when(/FROM schema_migrations/, { rows: [] });
    db.when(first.sql, () => {
      clock.advance(10);
      return { rows: [], rowCount: 0 };
    });
    db.when(second.sql, () => {
      clock.advance(40);
      return { rows: [], rowCount: 0 };
    });

    const result = await runMigrations(db, [first, second], { clock });

    expect(result.applied).toEqual([
      { version: 1, name: "a", durationMs: 10 },
      { version: 2, name: "b", durationMs: 40 },
    ]);
  });
});
