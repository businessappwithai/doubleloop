/**
 * __tests__/smoke-check.test.ts — orchestrator/smoke.ts.
 *
 * The regression these tests guard is the most expensive one this pipeline has produced: a run
 * finished with all 21 modules PASSED, 1296 unit tests green and `tsc --noEmit` clean, and the
 * generated application was unusable. Its GraphQL route was never mounted, so every request for it
 * fell through to the page router and came back as the SPA's HTML shell. The launch phase's
 * readiness probe asked for `/`, got the shell with a 200, and reported a successful deploy.
 *
 * So the case that matters most below is the one that looks healthy: an API path answering 200
 * with an HTML body. Every unit was correct in isolation; only the assembled system was wrong,
 * which is exactly the class of failure unit tests cannot see and this check must.
 */

import { describe, expect, test } from "vitest";
import {
  buildSmokeTargets,
  discoverApiRoutes,
  looksLikeHtmlDocument,
  probeTarget,
  runSmokeCheck,
  summarizeSmokeResults,
  type FetchLike,
  type SmokeProbeResult,
  type SmokeTarget,
} from "../src/lib/orchestrator/smoke";

const HTML_SHELL = '<!DOCTYPE html><html lang="en"><head><title>App</title></head><body></body></html>';

/** A `fetch` stand-in driven by a path → response table, recording every request it saw. */
function fakeFetch(
  routes: Record<string, { status: number; body: string }>,
  fallback: { status: number; body: string } = { status: 404, body: HTML_SHELL },
): FetchLike & { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  const impl = (async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const path = new URL(url).pathname;
    const hit = routes[path] ?? fallback;
    return {
      status: hit.status,
      headers: { get: () => null },
      text: async () => hit.body,
    };
  }) as unknown as FetchLike & { calls: Array<{ url: string; method: string }> };
  impl.calls = calls;
  return impl;
}

describe("looksLikeHtmlDocument", () => {
  test("recognises a doctype-prefixed document", () => {
    expect(looksLikeHtmlDocument(HTML_SHELL)).toBe(true);
  });

  test("recognises a bare <html> document", () => {
    expect(looksLikeHtmlDocument("<html><body>hi</body></html>")).toBe(true);
  });

  test("ignores leading whitespace and is case-insensitive", () => {
    expect(looksLikeHtmlDocument("\n\n   <!doctype HTML><html></html>")).toBe(true);
    expect(looksLikeHtmlDocument("  <HTML>")).toBe(true);
  });

  test("does not flag a JSON payload", () => {
    expect(looksLikeHtmlDocument('{"data":{"bundles":{"totalCount":2}}}')).toBe(false);
  });

  test("does not flag a GraphQL error envelope", () => {
    expect(looksLikeHtmlDocument('{"errors":[{"message":"boom"}]}')).toBe(false);
  });

  test("does not flag an empty body", () => {
    expect(looksLikeHtmlDocument("")).toBe(false);
  });

  test("does not flag JSON that merely contains HTML somewhere inside it", () => {
    expect(looksLikeHtmlDocument('{"html":"<!doctype html><html></html>"}')).toBe(false);
  });
});

describe("discoverApiRoutes", () => {
  test("maps each route file to its path", async () => {
    const list = async () => ["graphql.ts", "health.ts"];
    await expect(discoverApiRoutes("/ws", list)).resolves.toEqual(["/api/graphql", "/api/health"]);
  });

  test("maps index to the bare /api path", async () => {
    const list = async () => ["index.ts"];
    await expect(discoverApiRoutes("/ws", list)).resolves.toEqual(["/api"]);
  });

  test("accepts every JS/TS extension the router does", async () => {
    const list = async () => ["a.ts", "b.tsx", "c.js", "d.jsx"];
    await expect(discoverApiRoutes("/ws", list)).resolves.toEqual([
      "/api/a",
      "/api/b",
      "/api/c",
      "/api/d",
    ]);
  });

  test("excludes '-' prefixed files, the router's own opt-out convention", async () => {
    const list = async () => ["graphql.ts", "-helper.ts"];
    await expect(discoverApiRoutes("/ws", list)).resolves.toEqual(["/api/graphql"]);
  });

  test("excludes dotfiles and non-source files", async () => {
    const list = async () => ["graphql.ts", ".DS_Store", "README.md", "schema.graphql"];
    await expect(discoverApiRoutes("/ws", list)).resolves.toEqual(["/api/graphql"]);
  });

  test("returns [] when the directory does not exist — a project may declare no API routes", async () => {
    const list = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(discoverApiRoutes("/ws", list)).resolves.toEqual([]);
  });

  test("returns [] for an empty directory", async () => {
    await expect(discoverApiRoutes("/ws", async () => [])).resolves.toEqual([]);
  });

  test("sorts the result so the probe order is deterministic", async () => {
    const list = async () => ["zeta.ts", "alpha.ts"];
    await expect(discoverApiRoutes("/ws", list)).resolves.toEqual(["/api/alpha", "/api/zeta"]);
  });
});

describe("buildSmokeTargets", () => {
  test("always probes the root page", async () => {
    const targets = await buildSmokeTargets("/ws", async () => []);
    expect(targets).toEqual([{ path: "/", kind: "page" }]);
  });

  test("probes every declared API route as an api target", async () => {
    const targets = await buildSmokeTargets("/ws", async () => ["graphql.ts"]);
    expect(targets).toEqual([
      { path: "/", kind: "page" },
      { path: "/api/graphql", kind: "api", method: "POST" },
    ]);
  });

  test("uses POST for API routes, since a GraphQL route answers GET with 405 by design", async () => {
    const targets = await buildSmokeTargets("/ws", async () => ["graphql.ts"]);
    expect(targets.find((t) => t.kind === "api")?.method).toBe("POST");
  });
});

describe("probeTarget", () => {
  const API: SmokeTarget = { path: "/api/graphql", kind: "api", method: "POST" };
  const PAGE: SmokeTarget = { path: "/", kind: "page" };

  test("passes an API route that answers with JSON", async () => {
    const impl = fakeFetch({ "/api/graphql": { status: 200, body: '{"data":{}}' } });
    const result = await probeTarget("http://localhost:3000", API, impl);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.detail).toBeNull();
  });

  test("FAILS an API route that answers 200 with an HTML document", async () => {
    // The exact shape of the failure this module exists for: the route was never mounted, the
    // request fell through to the page router, and the status line looks perfect.
    const impl = fakeFetch({ "/api/graphql": { status: 200, body: HTML_SHELL } });

    const result = await probeTarget("http://localhost:3000", API, impl);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.detail).toContain("never");
    expect(result.detail).toContain("mounted");
  });

  test("fails an API route that answers 404", async () => {
    const impl = fakeFetch({ "/api/graphql": { status: 404, body: "not found" } });
    const result = await probeTarget("http://localhost:3000", API, impl);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not mounted");
  });

  test("fails an API route that answers 5xx", async () => {
    const impl = fakeFetch({ "/api/graphql": { status: 500, body: '{"errors":[]}' } });
    const result = await probeTarget("http://localhost:3000", API, impl);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("server error 500");
  });

  test("passes an API route answering a 4xx that is not 404 — the handler ran and rejected", async () => {
    // 400 for a malformed body means the route IS mounted, which is what this check asks.
    const impl = fakeFetch({ "/api/graphql": { status: 400, body: '{"errors":[{"message":"bad"}]}' } });
    const result = await probeTarget("http://localhost:3000", API, impl);
    expect(result.ok).toBe(true);
  });

  test("passes a page that answers with HTML — that is what a page is supposed to do", async () => {
    const impl = fakeFetch({ "/": { status: 200, body: HTML_SHELL } });
    const result = await probeTarget("http://localhost:3000", PAGE, impl);
    expect(result.ok).toBe(true);
  });

  test("fails a page that answers 5xx", async () => {
    const impl = fakeFetch({ "/": { status: 503, body: "" } });
    const result = await probeTarget("http://localhost:3000", PAGE, impl);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("server error 503");
  });

  test("fails, rather than throwing, when the request itself cannot be made", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;

    const result = await probeTarget("http://localhost:3000", PAGE, impl);

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.detail).toContain("ECONNREFUSED");
  });

  test("requests the target's own method and path", async () => {
    const impl = fakeFetch({ "/api/graphql": { status: 200, body: "{}" } });
    await probeTarget("http://localhost:3000", API, impl);
    expect(impl.calls).toEqual([{ url: "http://localhost:3000/api/graphql", method: "POST" }]);
  });
});

describe("runSmokeCheck", () => {
  test("passes when every target passes", async () => {
    const impl = fakeFetch({
      "/": { status: 200, body: HTML_SHELL },
      "/api/graphql": { status: 200, body: '{"data":{}}' },
    });

    const report = await runSmokeCheck(
      "http://localhost:3000",
      [
        { path: "/", kind: "page" },
        { path: "/api/graphql", kind: "api", method: "POST" },
      ],
      impl,
    );

    expect(report.ok).toBe(true);
    expect(report.summary).toContain("passed");
  });

  test("fails the run when the page is fine but the API is not mounted", async () => {
    // This is the exact state the pipeline previously reported as a successful deploy.
    const impl = fakeFetch({
      "/": { status: 200, body: HTML_SHELL },
      "/api/graphql": { status: 404, body: HTML_SHELL },
    });

    const report = await runSmokeCheck(
      "http://localhost:3000",
      [
        { path: "/", kind: "page" },
        { path: "/api/graphql", kind: "api", method: "POST" },
      ],
      impl,
    );

    expect(report.ok).toBe(false);
    expect(report.summary).toContain("/api/graphql");
  });

  test("probes sequentially, so a freshly started server is not hit with a burst", async () => {
    const order: string[] = [];
    const impl = (async (url: string) => {
      order.push(`start ${new URL(url).pathname}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(`end ${new URL(url).pathname}`);
      return { status: 200, headers: { get: () => null }, text: async () => "{}" };
    }) as unknown as FetchLike;

    await runSmokeCheck(
      "http://localhost:3000",
      [
        { path: "/a", kind: "api", method: "POST" },
        { path: "/b", kind: "api", method: "POST" },
      ],
      impl,
    );

    expect(order).toEqual(["start /a", "end /a", "start /b", "end /b"]);
  });

  test("reports every failure, not just the first", async () => {
    const impl = fakeFetch({}, { status: 404, body: HTML_SHELL });

    const report = await runSmokeCheck(
      "http://localhost:3000",
      [
        { path: "/api/a", kind: "api", method: "POST" },
        { path: "/api/b", kind: "api", method: "POST" },
      ],
      impl,
    );

    expect(report.ok).toBe(false);
    expect(report.summary).toContain("/api/a");
    expect(report.summary).toContain("/api/b");
  });
});

describe("summarizeSmokeResults", () => {
  const passing: SmokeProbeResult = {
    target: { path: "/", kind: "page" },
    ok: true,
    status: 200,
    detail: null,
  };
  const failing: SmokeProbeResult = {
    target: { path: "/api/graphql", kind: "api", method: "POST" },
    ok: false,
    status: 404,
    detail: "404 — the route is declared but not mounted",
  };

  test("passes when every result passed", () => {
    const report = summarizeSmokeResults([passing]);
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("/");
  });

  test("fails when any result failed, even alongside passes", () => {
    const report = summarizeSmokeResults([passing, failing]);
    expect(report.ok).toBe(false);
    expect(report.summary).toContain("/api/graphql");
    expect(report.summary).toContain("not mounted");
  });

  test("treats an empty result set as a failure, not as health", () => {
    // "Nothing was checked" must never read the same as "everything passed".
    const report = summarizeSmokeResults([]);
    expect(report.ok).toBe(false);
    expect(report.summary).toContain("no targets");
  });

  test("carries the results through unchanged for callers that want detail", () => {
    const report = summarizeSmokeResults([passing, failing]);
    expect(report.results).toEqual([passing, failing]);
  });
});
