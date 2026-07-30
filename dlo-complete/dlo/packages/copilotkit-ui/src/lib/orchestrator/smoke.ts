/**
 * orchestrator/smoke.ts
 * Post-launch smoke check: does the app the pipeline just built actually work?
 *
 * This exists because of a concrete, expensive failure. A pipeline run finished with all 21
 * modules PASSED, 1296 unit tests green and `tsc --noEmit` clean — and the application was
 * non-functional. Its GraphQL route was never mounted (the framework release shipped no
 * `createServerFileRoute`, so file-based routing skipped the file), the migration runner read a
 * ledger table nothing had created, and five resolvers rejected the very global ids their own
 * client sends. Every one of those is invisible to unit tests, because each unit was correct in
 * isolation; only the assembled, running system is wrong.
 *
 * The launch phase's readiness probe did not catch it either: it asked for `/` and accepted any
 * status below 500. A single-page app answers `/` with its HTML shell whether or not anything
 * behind it works, so that probe can only detect "the process died".
 *
 * The rule this module encodes: **a declared API route that answers with an HTML document is not
 * mounted.** That is precisely what a client-side router does with an unmatched path — it renders
 * the shell, often with a 200 — and it is the single most misleading failure in this stack,
 * because it looks like success to anything that only checks the status code.
 *
 * Everything here is pure over injected inputs (a `fetch`, a directory listing) so the decision
 * logic is testable without starting a server.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** One endpoint to probe, and what a healthy answer looks like. */
export interface SmokeTarget {
  /** Path to request, e.g. `/` or `/api/graphql`. */
  readonly path: string;
  /**
   * `page` — a route meant to render HTML. Any non-5xx is acceptable.
   * `api` — a declared server route. An HTML body means it was never mounted, however healthy the
   * status line looks.
   */
  readonly kind: "page" | "api";
  /** HTTP method to use. Defaults to GET. */
  readonly method?: string;
}

export interface SmokeProbeResult {
  readonly target: SmokeTarget;
  readonly ok: boolean;
  readonly status: number | null;
  /** Why it failed, or `null` when it passed. Written for a human reading pipeline logs. */
  readonly detail: string | null;
}

export interface SmokeReport {
  readonly ok: boolean;
  readonly results: readonly SmokeProbeResult[];
  /** One-line summary suitable for `state.error` or a log line. */
  readonly summary: string;
}

/** The `fetch` shape this module needs — injected so tests never open a socket. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/**
 * True when `body` looks like an HTML document rather than an API payload.
 *
 * Checks the body, not just the content-type: a dev server may label the shell it falls back to
 * with whatever the request asked for, and it is the body that gives the fallback away. A leading
 * `<!doctype html>` or `<html` is unambiguous — no JSON or GraphQL response starts that way.
 */
export function looksLikeHtmlDocument(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/**
 * Finds the API routes a project declares, so the check probes what the app itself claims to
 * expose rather than a hardcoded guess.
 *
 * Reads `src/routes/api/*` — the file-based convention this stack uses. A file named `graphql.ts`
 * becomes `/api/graphql`; `index.ts` becomes `/api`. Files prefixed with `-` are excluded, the
 * same way the router excludes them. Returns `[]` when the directory does not exist, which simply
 * means "this project declares no API routes", not an error.
 */
export async function discoverApiRoutes(
  workspaceDir: string,
  list: (dir: string) => Promise<string[]> = (dir) => readdir(dir),
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await list(join(workspaceDir, "src", "routes", "api"));
  } catch {
    return [];
  }
  return entries
    .filter((name) => /\.(ts|tsx|js|jsx)$/.test(name) && !name.startsWith("-") && !name.startsWith("."))
    .map((name) => name.replace(/\.(ts|tsx|js|jsx)$/, ""))
    .map((base) => (base === "index" ? "/api" : `/api/${base}`))
    .sort();
}

/** Builds the target list for a project: the root page plus every declared API route. */
export async function buildSmokeTargets(
  workspaceDir: string,
  list?: (dir: string) => Promise<string[]>,
): Promise<SmokeTarget[]> {
  const apiPaths = await discoverApiRoutes(workspaceDir, list);
  return [
    { path: "/", kind: "page" },
    // POST, not GET: a GraphQL route answers GET with 405 by design, and 405 from a mounted route
    // is indistinguishable from 405 from nothing at all. A POST reaches the handler.
    ...apiPaths.map((path): SmokeTarget => ({ path, kind: "api", method: "POST" })),
  ];
}

/** Probes one target and classifies the answer. */
export async function probeTarget(
  appUrl: string,
  target: SmokeTarget,
  fetchImpl: FetchLike,
): Promise<SmokeProbeResult> {
  let status: number;
  let body: string;
  try {
    const response = await fetchImpl(`${appUrl}${target.path}`, {
      method: target.method ?? "GET",
      headers: { accept: "application/json, text/html" },
      ...(target.method === "POST" ? { body: "{}" } : {}),
    });
    status = response.status;
    body = await response.text();
  } catch (err: unknown) {
    return {
      target,
      ok: false,
      status: null,
      detail: `request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (status >= 500) {
    return { target, ok: false, status, detail: `server error ${status}` };
  }

  if (target.kind === "api") {
    if (looksLikeHtmlDocument(body)) {
      return {
        target,
        ok: false,
        status,
        detail:
          `answered with an HTML document (status ${status}) — the route is declared but never ` +
          `mounted, so the request fell through to the page router`,
      };
    }
    if (status === 404) {
      return { target, ok: false, status, detail: "404 — the route is declared but not mounted" };
    }
  }

  return { target, ok: true, status, detail: null };
}

/**
 * Probes every target and reports.
 *
 * Probes are sequential, not parallel: a freshly started server is the least able to absorb a
 * burst, and a smoke check that fails on its own concurrency would be worse than none.
 */
export async function runSmokeCheck(
  appUrl: string,
  targets: readonly SmokeTarget[],
  fetchImpl: FetchLike,
): Promise<SmokeReport> {
  const results: SmokeProbeResult[] = [];
  for (const target of targets) {
    results.push(await probeTarget(appUrl, target, fetchImpl));
  }
  return summarizeSmokeResults(results);
}

/** Turns probe results into a pass/fail verdict and a one-line human summary. */
export function summarizeSmokeResults(results: readonly SmokeProbeResult[]): SmokeReport {
  const failures = results.filter((result) => !result.ok);
  if (results.length === 0) {
    // Nothing probed is not the same as everything passing; say so rather than implying health.
    return { ok: false, results, summary: "smoke check ran with no targets" };
  }
  if (failures.length === 0) {
    return {
      ok: true,
      results,
      summary: `smoke check passed: ${results.map((r) => r.target.path).join(", ")}`,
    };
  }
  return {
    ok: false,
    results,
    summary: `smoke check failed: ${failures
      .map((failure) => `${failure.target.path} — ${failure.detail ?? "unknown failure"}`)
      .join("; ")}`,
  };
}
