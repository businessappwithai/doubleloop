// @vitest-environment node
//
// Runs in the node environment, not jsdom: this suite reads real files off disk via
// `fileURLToPath(new URL(..., import.meta.url))`, and under the jsdom environment wrapper
// import.meta.url is not resolved to a file: URL, so fileURLToPath throws
// ERR_INVALID_URL_SCHEME before any assertion runs. There is nothing DOM-dependent here.
// tests/migrations-sql.test.ts — module m6 (SQL migrations and the migration runner). A static
// scan of the real files under sql/migrations/ and sql/seed/: real disk reads only (no database,
// no network, no child process spawned), so this stays part of the hermetic `pnpm test` suite.
// Verifies the seven migration files exist and are contiguously numbered, that
// parseMigrationFilename/planMigrations accept them as a valid gap-free plan, that none of them
// contain a DROP TABLE (migrations are forward-only per Database.md "Migration approach"), and
// that the dev seed is idempotent (every INSERT paired with its own ON CONFLICT ... DO NOTHING)
// and uses only the reserved deterministic UUID namespace. `scripts/verify-schema.ts` (not part of
// `pnpm test`) is the separate, non-hermetic check that the DDL is actually valid PostgreSQL —
// this file only proves the *shape* of what ships, not that Postgres accepts it.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadMigrationFile, planMigrations, type MigrationFile } from "../src/server/migrate";

const MIGRATIONS_DIR = fileURLToPath(new URL("../sql/migrations", import.meta.url));
const SEED_FILE = fileURLToPath(new URL("../sql/seed/001_dev_seed.sql", import.meta.url));

const EXPECTED_FILENAMES = [
  "001_extensions_enums_functions.sql",
  "002_identity_and_workspaces.sql",
  "003_bundles_and_concepts.sql",
  "004_concept_documents_and_crdt.sql",
  "005_frontmatter_links_revisions.sql",
  "006_search_indexes.sql",
  "007_collaboration_and_git_sync.sql",
];

/** Strips `-- ...` line comments so a substring/count check reflects statements, not prose that
 * happens to mention a SQL keyword (this file's own seed header is a real example: it explains
 * the `ON CONFLICT ... DO NOTHING` convention in English, which would otherwise inflate a naive
 * occurrence count). */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

async function listSqlFilenames(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

async function readMigrationFiles(): Promise<MigrationFile[]> {
  const filenames = await listSqlFilenames();
  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(`${MIGRATIONS_DIR}/${filename}`, "utf8");
      return loadMigrationFile(filename, sql);
    }),
  );
}

describe("sql/migrations — static scan", () => {
  test("contains exactly the seven expected files, nothing more and nothing fewer", async () => {
    expect(await listSqlFilenames()).toEqual(EXPECTED_FILENAMES);
  });

  test("every filename parses to a contiguous NNN_name.sql version/name pair", async () => {
    const files = await readMigrationFiles();
    expect(files.map((f) => f.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(files.map((f) => f.name)).toEqual([
      "extensions_enums_functions",
      "identity_and_workspaces",
      "bundles_and_concepts",
      "concept_documents_and_crdt",
      "frontmatter_links_revisions",
      "search_indexes",
      "collaboration_and_git_sync",
    ]);
  });

  test("planMigrations accepts the real files as a gap-free plan with nothing yet applied", async () => {
    const files = await readMigrationFiles();
    const plan = planMigrations(files, []);
    expect(plan.pending).toHaveLength(7);
    expect(plan.pending.map((f) => f.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("no migration file contains a DROP TABLE statement — migrations are forward-only", async () => {
    const files = await readMigrationFiles();
    for (const file of files) {
      expect(stripSqlComments(file.sql).toUpperCase()).not.toContain("DROP TABLE");
    }
  });

  test("no migration file is empty", async () => {
    const files = await readMigrationFiles();
    for (const file of files) {
      expect(file.sql.trim().length).toBeGreaterThan(0);
    }
  });

  test("every CREATE TABLE statement is guarded with IF NOT EXISTS", async () => {
    const files = await readMigrationFiles();
    for (const file of files) {
      const createTableLines = stripSqlComments(file.sql)
        .split("\n")
        .filter((line) => /\bCREATE TABLE\b/i.test(line));
      for (const line of createTableLines) {
        expect(line).toMatch(/CREATE TABLE IF NOT EXISTS/i);
      }
    }
  });

  test("every CREATE TYPE is guarded by a pg_type existence check (no bare CREATE TYPE)", async () => {
    const files = await readMigrationFiles();
    for (const file of files) {
      const body = stripSqlComments(file.sql);
      const createTypeCount = (body.match(/CREATE TYPE/gi) ?? []).length;
      const guardCount = (body.match(/SELECT 1 FROM pg_type WHERE typname/gi) ?? []).length;
      if (createTypeCount > 0) {
        expect(guardCount).toBe(createTypeCount);
      }
    }
  });
});

describe("sql/seed/001_dev_seed.sql — static scan", () => {
  test("exists and is non-empty", async () => {
    const sql = await readFile(SEED_FILE, "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
  });

  test("contains no DROP TABLE statement", async () => {
    const sql = await readFile(SEED_FILE, "utf8");
    expect(stripSqlComments(sql).toUpperCase()).not.toContain("DROP TABLE");
  });

  test("every INSERT is paired with its own ON CONFLICT ... DO NOTHING (idempotent re-seed)", async () => {
    const sql = stripSqlComments(await readFile(SEED_FILE, "utf8"));
    const insertCount = (sql.match(/INSERT INTO/gi) ?? []).length;
    const onConflictDoNothingCount = (sql.match(/ON CONFLICT[^;]*DO NOTHING/gis) ?? []).length;
    expect(insertCount).toBeGreaterThan(0);
    expect(onConflictDoNothingCount).toBe(insertCount);
  });

  test("uses only the reserved deterministic UUID namespace for every literal id", async () => {
    const sql = stripSqlComments(await readFile(SEED_FILE, "utf8"));
    const uuidLiterals = sql.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/gi) ?? [];
    expect(uuidLiterals.length).toBeGreaterThan(0);
    for (const literal of uuidLiterals) {
      expect(literal).toMatch(/^'00000000-0000-4000-8000-[0-9a-f]{12}'$/);
    }
  });
});
