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
        return {
          ok: false,
          detail: `npm install failed (after refetching registry metadata): ${errorText(onlineError).slice(-1200)}`,
          refetchedMetadata: true,
        };
      }
    }
  });
}
