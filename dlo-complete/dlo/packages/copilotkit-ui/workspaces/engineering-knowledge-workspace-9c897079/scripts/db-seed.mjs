// scripts/db-seed.mjs — the `npm run db:seed` entry point.
//
// A thin plain-JS shell for exactly the reason scripts/schema-emit.mjs is one: scripts/seed.ts
// imports `../src/core/errors` with an extensionless relative specifier, which only resolves under
// a bundler-aware loader — plain `node --experimental-strip-types` cannot load it, because Node's
// ESM resolver requires an explicit extension on every relative import. Vite's SSR module loader is
// already in this project's devDependencies and resolves those specifiers exactly the way
// tsc/vitest do, so this file boots a middleware-mode Vite server, loads seed.ts through it, and
// calls the real `runSeed`. Staying plain .mjs means it needs no loader to start the bootstrap.
//
// The connection is built here rather than through PgDb because seeding predates the app: the seed
// files are one multi-statement script each, which the `pg` simple-query protocol runs fine, and
// borrowing the app's adapter would drag in the orchestrator and its migration check.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
    const mod = await server.ssrLoadModule("/scripts/seed.ts");
    await client.connect();
    const applied = await mod.runSeed({
      db: { query: (sql, params) => client.query(sql, params ? [...params] : undefined) },
      seedDir: join(workspaceRoot, "sql", "seed"),
      env: process.env.NODE_ENV,
    });
    process.stdout.write(`seeded: ${applied.join(", ")}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
    await server.close();
  }
}

await main();
