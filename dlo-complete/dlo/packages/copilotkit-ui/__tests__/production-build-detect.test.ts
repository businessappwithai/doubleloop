/**
 * __tests__/production-build-detect.test.ts — `detectProductionBuild`.
 *
 * Found by running the full BUILD → DB → TEST → DEPLOY pipeline against the generated app. The
 * build phase produced a complete 2.7 MB production bundle in 45 s, and the deploy phase then
 * failed to recognise it and silently launched the dev server instead — because it looked only for
 * `dist/server/server.js`, while TanStack Start names the emitted bundle after the project's
 * configured `server.entry`. That project's entry is `ssr.tsx`, so the build emitted
 * `dist/server/ssr.js`.
 *
 * Nothing reported the mismatch. The gate told the operator it was "starting the dev server", with
 * no hint that a production build existed and was being ignored.
 */

import { describe, expect, test } from "vitest";
import { detectProductionBuild } from "../src/lib/orchestrator/phases/finalize";

/** Builds `exists`/`list` stand-ins from a set of paths and a directory listing table. */
function fakeFs(paths: string[], listings: Record<string, string[]> = {}) {
  const set = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  const exists = (p: string) => set.has(p.replace(/\\/g, "/"));
  const list = (p: string) => {
    const key = p.replace(/\\/g, "/");
    if (!(key in listings)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return listings[key]!;
  };
  return { exists, list };
}

const WS = "/ws";
const SERVER_DIR = "/ws/dist/server";

describe("detectProductionBuild — srvx target", () => {
  test("finds the default server.js entry", () => {
    const { exists, list } = fakeFs([SERVER_DIR], { [SERVER_DIR]: ["server.js", "assets"] });

    expect(detectProductionBuild(WS, exists, list)).toEqual({
      kind: "srvx",
      entry: "dist/server/server.js",
    });
  });

  test("finds an entry named after the project's own server.entry", () => {
    // The regression: entry `ssr.tsx` emits `dist/server/ssr.js`, which used to go unrecognised.
    const { exists, list } = fakeFs([SERVER_DIR], { [SERVER_DIR]: ["ssr.js"] });

    expect(detectProductionBuild(WS, exists, list)).toEqual({
      kind: "srvx",
      entry: "dist/server/ssr.js",
    });
  });

  test("prefers server.js when several candidates exist", () => {
    const { exists, list } = fakeFs([SERVER_DIR], { [SERVER_DIR]: ["ssr.js", "server.js"] });

    expect(detectProductionBuild(WS, exists, list)).toEqual({
      kind: "srvx",
      entry: "dist/server/server.js",
    });
  });

  test("ignores non-.js files and subdirectories when choosing", () => {
    const { exists, list } = fakeFs([SERVER_DIR], {
      [SERVER_DIR]: ["assets", "ssr.js", "ssr.js.map", "manifest.json"],
    });

    expect(detectProductionBuild(WS, exists, list)).toEqual({
      kind: "srvx",
      entry: "dist/server/ssr.js",
    });
  });

  test("refuses to guess between two non-default candidates", () => {
    // Serving the wrong entry would look deployed and be broken — worse than falling back.
    const { exists, list } = fakeFs([SERVER_DIR], { [SERVER_DIR]: ["ssr.js", "edge.js"] });

    expect(detectProductionBuild(WS, exists, list)).toBeNull();
  });

  test("is not a srvx build when dist/server holds no .js at all", () => {
    const { exists, list } = fakeFs([SERVER_DIR], { [SERVER_DIR]: ["assets"] });

    expect(detectProductionBuild(WS, exists, list)).toBeNull();
  });

  test("survives an unreadable dist/server without throwing", () => {
    const { exists } = fakeFs([SERVER_DIR]);
    const list = () => {
      throw new Error("EACCES");
    };

    expect(detectProductionBuild(WS, exists, list)).toBeNull();
  });
});

describe("detectProductionBuild — other targets", () => {
  test("falls through to a nitro build", () => {
    const { exists, list } = fakeFs(["/ws/.output/server/index.mjs"]);

    expect(detectProductionBuild(WS, exists, list)).toEqual({
      kind: "nitro",
      entry: ".output/server/index.mjs",
    });
  });

  test("falls through to a static build", () => {
    const { exists, list } = fakeFs(["/ws/dist/index.html"]);

    expect(detectProductionBuild(WS, exists, list)).toEqual({ kind: "static", dir: "dist" });
  });

  test("prefers a srvx build over a static index.html in the same dist", () => {
    const { exists, list } = fakeFs([SERVER_DIR, "/ws/dist/index.html"], {
      [SERVER_DIR]: ["ssr.js"],
    });

    expect(detectProductionBuild(WS, exists, list)).toEqual({
      kind: "srvx",
      entry: "dist/server/ssr.js",
    });
  });

  test("prefers a srvx build over a nitro output", () => {
    const { exists, list } = fakeFs([SERVER_DIR, "/ws/.output/server/index.mjs"], {
      [SERVER_DIR]: ["server.js"],
    });

    expect(detectProductionBuild(WS, exists, list)?.kind).toBe("srvx");
  });

  test("prefers a nitro output over a static index.html", () => {
    const { exists, list } = fakeFs(["/ws/.output/server/index.mjs", "/ws/dist/index.html"]);

    expect(detectProductionBuild(WS, exists, list)?.kind).toBe("nitro");
  });
});

describe("detectProductionBuild — no build", () => {
  test("returns null for an empty workspace", () => {
    const { exists, list } = fakeFs([]);

    expect(detectProductionBuild(WS, exists, list)).toBeNull();
  });

  test("returns null when only source exists, with no dist or .output", () => {
    const { exists, list } = fakeFs(["/ws/src", "/ws/package.json"]);

    expect(detectProductionBuild(WS, exists, list)).toBeNull();
  });
});
