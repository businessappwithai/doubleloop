// tests/migrate-plan.test.ts — module m6 (SQL migrations and the migration runner). Covers the
// pure half of src/server/migrate.ts: checksumOf, parseMigrationFilename/loadMigrationFile, and
// planMigrations's ordering, gap detection, and checksum-mismatch detection. None of this touches
// a database — planMigrations is a pure function over literal arrays, per Database.md's "No unit
// test touches PostgreSQL" rule.
import { describe, expect, test } from "vitest";
import { MigrationError } from "../src/core/errors";
import {
  checksumOf,
  loadMigrationFile,
  parseMigrationFilename,
  planMigrations,
  type AppliedMigration,
  type MigrationFile,
} from "../src/server/migrate";

function file(version: number, name: string, sql = `-- ${name}`): MigrationFile {
  return { version, name, filename: `${String(version).padStart(3, "0")}_${name}.sql`, sql };
}

function appliedFrom(f: MigrationFile): AppliedMigration {
  return { version: f.version, name: f.name, checksum: checksumOf(f.sql) };
}

/** Calls `fn`, asserts it throws a `MigrationError` with `code`, and returns the caught error so
 * the caller can make further assertions on its `details`. Mirrors `expectConfigError` in
 * tests/config.test.ts. */
function expectMigrationError(fn: () => unknown, code: string): MigrationError {
  try {
    fn();
    throw new Error(`expected fn to throw MigrationError with code "${code}"`);
  } catch (err) {
    expect(err).toBeInstanceOf(MigrationError);
    const migrationError = err as MigrationError;
    expect(migrationError.code).toBe(code);
    return migrationError;
  }
}

const THREE_FILES: readonly MigrationFile[] = [
  file(1, "extensions_enums_functions"),
  file(2, "identity_and_workspaces"),
  file(3, "bundles_and_concepts"),
];

// ---------------------------------------------------------------------------
// checksumOf
// ---------------------------------------------------------------------------

describe("checksumOf", () => {
  test("returns a lowercase 64-character hex string", () => {
    const checksum = checksumOf("CREATE TABLE example (id uuid);");
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same input", () => {
    const sql = "CREATE TABLE t (id uuid);";
    expect(checksumOf(sql)).toBe(checksumOf(sql));
  });

  test("differs for different input", () => {
    expect(checksumOf("CREATE TABLE a (id uuid);")).not.toBe(checksumOf("CREATE TABLE b (id uuid);"));
  });

  test("differs on trailing whitespace (byte-exact, not normalised)", () => {
    expect(checksumOf("CREATE TABLE t (id uuid);")).not.toBe(checksumOf("CREATE TABLE t (id uuid); "));
  });

  test("accepts the empty string and still produces a well-formed digest", () => {
    expect(checksumOf("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// parseMigrationFilename / loadMigrationFile
// ---------------------------------------------------------------------------

describe("parseMigrationFilename", () => {
  test("extracts the numeric version and the bare name", () => {
    expect(parseMigrationFilename("001_extensions_enums_functions.sql")).toEqual({
      version: 1,
      name: "extensions_enums_functions",
    });
  });

  test("does not require a fixed digit width", () => {
    expect(parseMigrationFilename("042_some_migration.sql")).toEqual({
      version: 42,
      name: "some_migration",
    });
  });

  test.each([
    ["no numeric prefix", "extensions_enums_functions.sql"],
    ["missing .sql extension", "001_extensions_enums_functions"],
    ["uppercase characters in the name", "001_Extensions.sql"],
    ["empty string", ""],
    ["prefix with no separator", "001.sql"],
  ])("throws MigrationError('migration.invalidFilename') for %s", (_label, filename) => {
    const err = expectMigrationError(() => parseMigrationFilename(filename), "migration.invalidFilename");
    expect(err.details).toMatchObject({ filename });
  });
});

describe("loadMigrationFile", () => {
  test("builds a MigrationFile from a filename and its contents", () => {
    const result = loadMigrationFile("003_bundles_and_concepts.sql", "CREATE TABLE bundles ();");
    expect(result).toEqual({
      version: 3,
      name: "bundles_and_concepts",
      filename: "003_bundles_and_concepts.sql",
      sql: "CREATE TABLE bundles ();",
    });
  });

  test("propagates the invalidFilename error for a malformed name", () => {
    expectMigrationError(
      () => loadMigrationFile("not-a-migration.txt", "select 1;"),
      "migration.invalidFilename",
    );
  });
});

// ---------------------------------------------------------------------------
// planMigrations
// ---------------------------------------------------------------------------

describe("planMigrations", () => {
  test("empty applied set: every file is pending, in ascending version order", () => {
    const plan = planMigrations(THREE_FILES, []);
    expect(plan.pending.map((f) => f.version)).toEqual([1, 2, 3]);
    expect(plan.pending).toEqual(THREE_FILES);
  });

  test("all-applied: pending is empty (no-op)", () => {
    const applied = THREE_FILES.map(appliedFrom);
    const plan = planMigrations(THREE_FILES, applied);
    expect(plan.pending).toEqual([]);
  });

  test("partially applied: only the unapplied files are pending, still in order", () => {
    const applied = [appliedFrom(THREE_FILES[0] as MigrationFile)];
    const plan = planMigrations(THREE_FILES, applied);
    expect(plan.pending.map((f) => f.version)).toEqual([2, 3]);
  });

  test("boundary: empty files and empty applied returns an empty plan without throwing", () => {
    expect(planMigrations([], [])).toEqual({ pending: [] });
  });

  test("files do not need to be pre-sorted by the caller", () => {
    const shuffled: MigrationFile[] = [
      THREE_FILES[2] as MigrationFile,
      THREE_FILES[0] as MigrationFile,
      THREE_FILES[1] as MigrationFile,
    ];
    const plan = planMigrations(shuffled, []);
    expect(plan.pending.map((f) => f.version)).toEqual([1, 2, 3]);
  });

  describe("gap detection", () => {
    test("throws MigrationError('migration.gap') when a file version is skipped", () => {
      const withGap = [file(1, "a"), file(2, "b"), file(4, "d")];
      const err = expectMigrationError(() => planMigrations(withGap, []), "migration.gap");
      expect(err.details).toMatchObject({ expectedVersion: 3, actualVersion: 4 });
    });

    test("throws MigrationError('migration.gap') when two files share a version", () => {
      const withDuplicate = [file(1, "a"), file(2, "b"), file(2, "b-again")];
      expectMigrationError(() => planMigrations(withDuplicate, []), "migration.gap");
    });

    test("throws MigrationError('migration.gap') when files do not start at version 1", () => {
      const startsAtTwo = [file(2, "b"), file(3, "c")];
      expectMigrationError(() => planMigrations(startsAtTwo, []), "migration.gap");
    });

    test("throws MigrationError('migration.gap') when an applied record has no matching file", () => {
      const applied: AppliedMigration[] = [
        { version: 4, name: "ghost_migration", checksum: checksumOf("-- gone") },
      ];
      const err = expectMigrationError(() => planMigrations(THREE_FILES, applied), "migration.gap");
      expect(err.details).toMatchObject({ version: 4, name: "ghost_migration" });
    });

    test("throws MigrationError('migration.gap') when applied references a version with no files at all", () => {
      const applied: AppliedMigration[] = [{ version: 1, name: "a", checksum: "x".repeat(64) }];
      expectMigrationError(() => planMigrations([], applied), "migration.gap");
    });
  });

  describe("checksum mismatch", () => {
    test("throws MigrationError('migration.checksumMismatch') when a file's contents changed since it was applied", () => {
      const original = file(1, "extensions_enums_functions", "CREATE EXTENSION pg_trgm;");
      const edited = file(1, "extensions_enums_functions", "CREATE EXTENSION pg_trgm; -- edited");
      const applied: AppliedMigration[] = [appliedFrom(original)];

      const err = expectMigrationError(
        () => planMigrations([edited], applied),
        "migration.checksumMismatch",
      );
      expect(err.details).toMatchObject({
        filename: edited.filename,
        recordedChecksum: checksumOf(original.sql),
        currentChecksum: checksumOf(edited.sql),
      });
    });

    test("does not throw when the file's contents are byte-identical to what was applied", () => {
      const applied: AppliedMigration[] = [appliedFrom(THREE_FILES[0] as MigrationFile)];
      expect(() => planMigrations(THREE_FILES, applied)).not.toThrow();
    });
  });
});
