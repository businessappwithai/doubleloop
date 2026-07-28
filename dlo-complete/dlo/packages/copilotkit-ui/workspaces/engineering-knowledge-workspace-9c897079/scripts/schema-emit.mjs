// scripts/schema-emit.mjs — the `npm run schema:emit` entry point (Implementation.md m15: "m15
// also emits schema.graphql, which the client's Relay compiler consumes"). package.json's
// `schema:emit` script has named this exact file since m1/m2 scaffolded the workspace; m7 built
// the merge logic in scripts/emit-schema.ts (`emitSchema`/`mergeSchemaDocuments`) but that file is
// TypeScript with extensionless relative imports (`../src/core/errors`), which only resolve under
// a bundler-aware loader — plain `node --experimental-strip-types` (the convention the `collab`
// script uses) cannot load it directly: Node's ESM resolver requires an explicit extension on
// every relative specifier, and there is no Node 22 flag left that relaxes that. Vite's own SSR
// module loader (`ssrLoadModule`) is the one loader already in this project's devDependencies that
// resolves `emit-schema.ts`'s imports exactly the way `tsc`/`vitest` do (tsconfig's
// `moduleResolution: "bundler"`), so this file is a thin plain-JS shell: boot a middleware-mode
// Vite server, load `emit-schema.ts` through it, and call the real `emitSchema`. This file itself
// stays plain `.mjs` (no TypeScript) so it needs no loader to start the bootstrap.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const server = await createServer({
    root: workspaceRoot,
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const mod = await server.ssrLoadModule("/scripts/emit-schema.ts");
    const sdl = mod.emitSchema({
      rootPath: join(workspaceRoot, "src", "graphql", "schema.root.graphql"),
      modulesDir: join(workspaceRoot, "src", "modules"),
      outputPath: join(workspaceRoot, "schema.graphql"),
    });
    process.stdout.write(`schema.graphql written (${sdl.length} bytes)\n`);
  } finally {
    await server.close();
  }
}

await main();
