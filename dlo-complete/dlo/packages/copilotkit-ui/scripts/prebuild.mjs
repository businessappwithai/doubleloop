/**
 * prebuild.mjs — run before `next dev` and `next build`.
 *
 * 1. Installs all workspace dependencies from monorepo root.
 * 2. Builds workspace packages that copilotkit-ui depends on, in order:
 *      @dlo/language  →  @dlo/erd  →  @dlo/core  →  @dlo/adapters-pi
 *
 * Skips a package's build if dist/ is already newer than src/.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../../../");

function run(argv, cwd = root) {
  console.log(`  › ${argv.join(" ")}`);
  const result = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let t = 0;
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) {
      const p = join(f.parentPath ?? f.path, f.name);
      const m = statSync(p).mtimeMs;
      if (m > t) t = m;
    }
  }
  return t;
}

function needsBuild(pkgDir) {
  const dist = join(pkgDir, "dist");
  if (!existsSync(dist)) return true;
  const srcMtime = newestMtime(join(pkgDir, "src")) || newestMtime(pkgDir);
  const distMtime = newestMtime(dist);
  return srcMtime > distMtime;
}

const workspacePackages = [
  { name: "@dlo/language",    dir: join(root, "language") },
  { name: "@dlo/erd",         dir: join(root, "packages/erd") },
  { name: "@dlo/core",        dir: join(root, "packages/core") },
  { name: "@dlo/adapters-pi", dir: join(root, "packages/adapters-pi") },
];

console.log("\nDLO prebuild\n");

console.log("Installing workspace dependencies...");
run(["pnpm", "install", "--frozen-lockfile=false"]);

for (const pkg of workspacePackages) {
  if (!existsSync(pkg.dir)) {
    console.log(`  ${pkg.name} not found at ${pkg.dir} — skipping`);
    continue;
  }
  if (needsBuild(pkg.dir)) {
    console.log(`Building ${pkg.name}...`);
    run(["pnpm", "build"], pkg.dir);
  } else {
    console.log(`  ${pkg.name} already up-to-date`);
  }
}

console.log("\nPrebuild complete\n");
