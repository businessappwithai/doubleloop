/**
 * orchestrator/npm.ts
 * Dependency installation for generated application workspaces.
 *
 * Two hazards this module exists to handle, both of which failed real pipeline
 * runs by blaming the generated code for problems it did not cause:
 *
 *  1. CONCURRENCY. The build fleet runs modules in parallel inside ONE workspace
 *     directory. Concurrent `npm install` calls race on node_modules and
 *     package-lock.json (ENOTEMPTY/EEXIST, or a silently corrupted tree), and
 *     whichever module loses the race is marked FAILED. Installs are therefore
 *     serialized per directory.
 *
 *  2. STALE REGISTRY METADATA. `--prefer-offline` reuses npm's cached packument,
 *     so a container whose cache predates a transitive dependency's latest
 *     release fails with ETARGET ("No matching version found for hasown@^2.0.3")
 *     for a version that does exist. No amount of rewriting the application can
 *     fix that, and retrying with the same flag reproduces it forever — so the
 *     install is retried once with `--prefer-online` to refetch metadata.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const INSTALL_TIMEOUT_MS = 300_000;

// ─── Per-workspace install lock ──────────────────────────────────────────────

const installLocks = new Map<string, Promise<unknown>>();

export function withInstallLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = installLocks.get(key) ?? Promise.resolve();
  // Chain onto the previous holder, ignoring its outcome: one module's failed
  // install must not reject the next module's turn.
  const run = previous.then(fn, fn);
  // The queue tail must never be a rejected promise, or it becomes an unhandled
  // rejection that the next waiter inherits.
  installLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

// ─── Failure classification ──────────────────────────────────────────────────

/**
 * Does this npm failure come from the registry metadata rather than the
 * project's own dependency list?
 *
 * These are the codes npm reports when it cannot resolve a version or package
 * it believes does not exist — the signature of a stale cached packument.
 */
export function isStaleRegistryMetadataError(output: string): boolean {
  return /\bETARGET\b|\bE404\b|\bENOTFOUND\b|\bnotarget\b|No matching version found/i.test(output);
}

function errorText(e: any): string {
  return ((e?.stderr ?? "") + (e?.stdout ?? "")) || e?.message || String(e);
}

// ─── Naming the version that does not exist ──────────────────────────────────

/**
 * Pull the package specs npm could not resolve out of its error output.
 *
 * When a build subagent invents a version ("@stylexjs/unplugin": "0.20.5" when
 * 0.19.0 is the newest), npm says only "No matching version found for
 * @stylexjs/unplugin@0.20.5". Handing that straight back to the retry produces
 * another guess, so the spec is extracted here and checked against the registry.
 */
export function parseMissingPackageSpecs(output: string): Array<{ name: string; range: string }> {
  const specs = new Map<string, string>();
  const notarget = /No matching version found for\s+((?:@[^/\s]+\/)?[^@\s]+)@([^\s.]+(?:\.[^\s.]+)*?)\.?(?:\s|$)/gi;
  for (const m of output.matchAll(notarget)) {
    if (m[1] && m[2]) specs.set(m[1], m[2]);
  }
  const notFound = /404\s+'?((?:@[^/\s]+\/)?[^@'\s]+)@([^'\s]+)'?\s+is not in this registry/gi;
  for (const m of output.matchAll(notFound)) {
    if (m[1] && m[2]) specs.set(m[1], m[2]);
  }
  return [...specs].map(([name, range]) => ({ name, range }));
}

/** Registry lookup seam — replaced in tests so no unit test hits the network. */
export type VersionLookup = (name: string) => Promise<{ latest: string; versions: string[] } | null>;

const registryLookup: VersionLookup = async (name) => {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const latest = body?.["dist-tags"]?.latest;
    if (!latest) return null;
    return { latest, versions: Object.keys(body.versions ?? {}) };
  } catch {
    return null;
  }
};

/**
 * Turn "No matching version found for X@Y" into an instruction the retrying
 * build subagent can act on, by naming the versions that DO exist.
 *
 * Failure to reach the registry is not fatal — the caller still reports the
 * original npm error, just without the hint.
 */
export async function explainMissingVersions(
  output: string,
  lookup: VersionLookup = registryLookup
): Promise<string> {
  const specs = parseMissingPackageSpecs(output);
  if (specs.length === 0) return "";

  const lines: string[] = [];
  for (const spec of specs) {
    const info = await lookup(spec.name);
    if (!info) {
      lines.push(`- "${spec.name}": "${spec.range}" could not be resolved, and the registry could not be queried for the real versions.`);
      continue;
    }
    const recent = info.versions.filter((v) => !/-/.test(v)).slice(-5).join(", ");
    lines.push(
      `- "${spec.name}": "${spec.range}" DOES NOT EXIST. The latest published version is ${info.latest}` +
        (recent ? ` (recent releases: ${recent})` : "") +
        `. Set this dependency to a version that exists — do not guess a higher one.`
    );
  }
  return `The package.json pins versions that are not published:\n${lines.join("\n")}`;
}

// ─── Install ─────────────────────────────────────────────────────────────────

export interface InstallResult {
  ok: boolean;
  detail: string;
  /** True when the offline attempt failed and the online refetch was used. */
  refetchedMetadata: boolean;
}

/**
 * Install a workspace's dependencies. Serialized per directory, and retried
 * once against the live registry when the first failure is a metadata problem.
 */
export async function installDependencies(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<InstallResult> {
  return withInstallLock(workspaceDir, async () => {
    const base = ["install", "--no-audit", "--no-fund"];
    try {
      await execFileAsync("npm", [...base, "--prefer-offline"], {
        cwd: workspaceDir,
        timeout: INSTALL_TIMEOUT_MS,
        env,
      });
      return { ok: true, detail: "", refetchedMetadata: false };
    } catch (offlineError: any) {
      const offlineDetail = errorText(offlineError);
      if (!isStaleRegistryMetadataError(offlineDetail)) {
        return {
          ok: false,
          detail: `npm install failed: ${offlineDetail.slice(-1200)}`,
          refetchedMetadata: false,
        };
      }

      // The cached packument is stale — refetch it rather than blaming the app.
      try {
        await execFileAsync("npm", [...base, "--prefer-online"], {
          cwd: workspaceDir,
          timeout: INSTALL_TIMEOUT_MS,
          env,
        });
        return { ok: true, detail: "", refetchedMetadata: true };
      } catch (onlineError: any) {
        // Still unresolvable against live metadata → the pinned version really
        // does not exist. Name it, so the retry corrects it instead of guessing.
        const onlineDetail = errorText(onlineError);
        const hint = await explainMissingVersions(onlineDetail);
        return {
          ok: false,
          detail:
            `npm install failed (after refetching registry metadata): ${onlineDetail.slice(-1200)}` +
            (hint ? `\n\n${hint}` : ""),
          refetchedMetadata: true,
        };
      }
    }
  });
}
