// scripts/seed.ts — applies sql/seed/*.sql, the `npm run db:seed` entry point.
//
// sql/seed/001_dev_seed.sql's own header promised this: "Guarded by the runner, not by anything in
// this file: the caller (a later module's `pnpm db:seed` script) refuses to run when
// NODE_ENV === 'production'". No module ever built that runner, so a freshly migrated database had
// no workspace, no users and no bundles — the bundle picker could only ever render its empty state
// even when everything underneath it worked.
//
// Split the same way scripts/emit-schema.ts is: pure functions (`readSeedFiles`, `assertSeedable`)
// that tests exercise against fixtures with no filesystem and no database, and an I/O shell
// (`runSeed`) the .mjs entry point calls. A development tool, not application code — nothing under
// src/ imports it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../src/core/errors";

/** One seed file: the order it runs in, its filename, and its SQL. */
export interface SeedFile {
  readonly filename: string;
  readonly sql: string;
}

/** The subset of `Db` this runner needs — so tests pass a fake instead of a pool. */
export interface SeedDb {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
}

/**
 * Throws `ConfigError('seed.refusedInProduction')` unless `env` is a non-production environment.
 *
 * Deliberately an allow-list on "not production" being *explicit*: an unset NODE_ENV is refused
 * too. Seeding writes fixture users and fixture content, and the one situation where that is
 * catastrophic — a production database — is also the one where an environment variable is most
 * likely to be missing rather than wrong. Defaulting to "probably development" here would make the
 * dangerous case the default.
 */
export function assertSeedable(env: string | undefined): void {
  if (env === undefined || env === "" || env === "production") {
    throw new ConfigError(
      "seed.refusedInProduction",
      `Refusing to seed: NODE_ENV is ${env === undefined || env === "" ? "not set" : `"${env}"`}. ` +
        `Seeding is only permitted with NODE_ENV explicitly set to a non-production value.`,
      { details: { env: env ?? null } },
    );
  }
}

/**
 * Reads every `.sql` file in `dir`, sorted by filename so the numeric prefixes define the order.
 * Throws `ConfigError('seed.noSeedFiles')` when the directory holds none — an empty seed run that
 * reported success would look identical to a working one.
 */
export function readSeedFiles(dir: string, read = readFileSync, list = readdirSync): SeedFile[] {
  const filenames = (list(dir) as string[]).filter((name) => name.endsWith(".sql")).sort();
  if (filenames.length === 0) {
    throw new ConfigError("seed.noSeedFiles", `No .sql files found in ${dir}`, {
      details: { dir },
    });
  }
  return filenames.map((filename) => ({
    filename,
    sql: read(join(dir, filename), "utf8") as string,
  }));
}

/**
 * Applies each seed file in order. Every file is expected to manage its own transaction (they open
 * with `BEGIN` and end with `COMMIT`) and to be idempotent via `ON CONFLICT ... DO NOTHING`, so a
 * re-run is a no-op rather than a duplicate-key failure.
 */
export async function applySeedFiles(db: SeedDb, files: readonly SeedFile[]): Promise<string[]> {
  const applied: string[] = [];
  for (const file of files) {
    await db.query(file.sql);
    applied.push(file.filename);
  }
  return applied;
}

export interface RunSeedOptions {
  readonly db: SeedDb;
  readonly seedDir: string;
  readonly env: string | undefined;
  /** Injectable for tests; defaults to the real filesystem. */
  readonly read?: typeof readFileSync;
  /** Injectable for tests; defaults to the real filesystem. */
  readonly list?: typeof readdirSync;
}

/**
 * Guard, read, apply — the whole runner, with every dependency injected.
 *
 * The guard runs before anything is read or executed, so a production run fails without having
 * touched the database at all.
 */
export async function runSeed(opts: RunSeedOptions): Promise<string[]> {
  assertSeedable(opts.env);
  const files = readSeedFiles(opts.seedDir, opts.read ?? readFileSync, opts.list ?? readdirSync);
  return applySeedFiles(opts.db, files);
}
