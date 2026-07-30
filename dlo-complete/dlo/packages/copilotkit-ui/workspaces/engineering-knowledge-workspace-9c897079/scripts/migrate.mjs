// scripts/migrate.mjs — the `npm run migrate` entry point.
//
// package.json has named this file since the workspace was scaffolded, but nothing ever created
// it: `npm run migrate` failed with MODULE_NOT_FOUND. Migrations do also run from the orchestrator's
// start(), but that only helps a process that can boot — it is no use for migrating a database
// ahead of a deploy, or for checking whether one is up to date without starting the app.
//
// Same plain-JS shell as scripts/schema-emit.mjs and scripts/db-seed.mjs, for the same reason:
// src/server/migrate.ts imports `../core/errors` with an extensionless relative specifier, which
// only resolves under a bundler-aware loader. Vite's SSR module loader resolves it exactly the way
// tsc/vitest do.
//
// `--check` runs runMigrations in checkOnly mode: it reports what is pending and exits 1 if
// anything is, without writing. That is the mode a deploy gate wants.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.includes("--check");

async function main() {
  const server = await createServer({
    root: workspaceRoot,
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    await server.close();
    process.stderr.write("DATABASE_URL is not set; refusing to guess a connection.\n");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });

  try {
    const mod = await server.ssrLoadModule("/src/server/migrate.ts");
    const dir = join(workspaceRoot, "sql", "migrations");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => mod.loadMigrationFile(name, readFileSync(join(dir, name), "utf8")));

    await client.connect();
    const db = {
      query: (sql, params) => client.query(sql, params ? [...params] : undefined),
      // One file per transaction, matching what runMigrations expects of a Db.
      withTransaction: async (fn) => {
        await client.query("BEGIN");
        try {
          const result = await fn(db);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      },
    };

    const result = await mod.runMigrations(db, files, {
      clock: { now: () => new Date() },
      checkOnly,
    });

    if (checkOnly) {
      if (result.pending.length === 0) {
        process.stdout.write("up to date\n");
      } else {
        process.stdout.write(`pending: ${result.pending.map((f) => f.filename).join(", ")}\n`);
        process.exitCode = 1;
      }
    } else {
      process.stdout.write(
        result.applied.length === 0
          ? "up to date\n"
          : `applied: ${result.applied.map((a) => a.name).join(", ")}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
    await server.close();
  }
}

await main();
