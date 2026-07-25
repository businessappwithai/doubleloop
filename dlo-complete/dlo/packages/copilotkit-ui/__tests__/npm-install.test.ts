/**
 * __tests__/npm-install.test.ts
 * Dependency installation for generated workspaces.
 *
 * The behavior pinned here comes from a real pipeline failure: `npm install
 * --prefer-offline` reported ETARGET for hasown@^2.0.3 — a version that exists
 * on the registry — because the container's cached packument predated it. The
 * module was blamed and retried with the same flag, so it could never recover
 * and the whole 21-module fleet died on module 1.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: vi.fn(),
}));

const { installDependencies, isStaleRegistryMetadataError } = await import("../src/lib/orchestrator/npm");

/** npm failure carrying output on stderr, the way execFile surfaces it. */
function npmFailure(stderr: string) {
  const err: any = new Error("Command failed: npm install");
  err.stderr = stderr;
  err.stdout = "";
  return err;
}

const ETARGET_OUTPUT = [
  "npm error code ETARGET",
  "npm error notarget No matching version found for hasown@^2.0.3.",
  "npm error notarget In most cases you or one of your dependencies are requesting",
].join("\n");

/** Record the npm argv of each call, and drive outcomes from a queue. */
let calls: string[][] = [];
let outcomes: Array<{ fail?: any }> = [];

beforeEach(() => {
  calls = [];
  outcomes = [];
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const callback = typeof _opts === "function" ? (_opts as Function) : cb;
    calls.push(args);
    const next = outcomes.shift() ?? {};
    if (next.fail) callback(next.fail);
    else callback(null, { stdout: "added 503 packages", stderr: "" });
  });
});

describe("isStaleRegistryMetadataError", () => {
  test.each([
    ["ETARGET", "npm error code ETARGET"],
    ["notarget", "npm error notarget No matching version found for hasown@^2.0.3."],
    ["prose form", "No matching version found for foo@^1.2.3"],
    ["E404", "npm error code E404"],
    ["ENOTFOUND", "npm error code ENOTFOUND registry.npmjs.org"],
  ])("recognises %s as a registry-metadata failure", (_name, output) => {
    expect(isStaleRegistryMetadataError(output)).toBe(true);
  });

  test.each([
    ["peer conflict", "npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree"],
    ["build failure", "npm error code 1\nnode-gyp rebuild failed"],
    ["disk full", "npm error code ENOSPC\nnpm error nospc There appears to be insufficient space"],
    ["empty output", ""],
  ])("does not misread %s as a metadata failure", (_name, output) => {
    expect(isStaleRegistryMetadataError(output)).toBe(false);
  });
});

describe("installDependencies", () => {
  test("installs offline-first and reports success without a refetch", async () => {
    const result = await installDependencies("/ws/happy");

    expect(result).toEqual({ ok: true, detail: "", refetchedMetadata: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--prefer-offline");
  });

  test("retries with --prefer-online when the cached metadata is stale", async () => {
    outcomes = [{ fail: npmFailure(ETARGET_OUTPUT) }];

    const result = await installDependencies("/ws/stale");

    expect(result.ok).toBe(true);
    expect(result.refetchedMetadata).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--prefer-offline");
    expect(calls[1]).toContain("--prefer-online");
    expect(calls[1]).not.toContain("--prefer-offline");
  });

  test("reports failure when even the online refetch cannot resolve it", async () => {
    outcomes = [
      { fail: npmFailure(ETARGET_OUTPUT) },
      { fail: npmFailure("npm error code ETARGET\nnpm error notarget No matching version found for ghost@^9.9.9.") },
    ];

    const result = await installDependencies("/ws/really-missing");

    expect(result.ok).toBe(false);
    expect(result.refetchedMetadata).toBe(true);
    expect(result.detail).toMatch(/after refetching registry metadata/);
    expect(result.detail).toMatch(/ghost@\^9\.9\.9/);
    expect(calls).toHaveLength(2);
  });

  test("does NOT retry a failure that is not about registry metadata", async () => {
    outcomes = [{ fail: npmFailure("npm error code ERESOLVE\nunable to resolve dependency tree") }];

    const result = await installDependencies("/ws/eresolve");

    expect(result.ok).toBe(false);
    expect(result.refetchedMetadata).toBe(false);
    expect(calls).toHaveLength(1);
    expect(result.detail).toMatch(/ERESOLVE/);
  });

  test("surfaces npm output from stdout when stderr is empty", async () => {
    const err: any = new Error("Command failed");
    err.stdout = "npm error code ERESOLVE";
    err.stderr = "";
    outcomes = [{ fail: err }];

    const result = await installDependencies("/ws/stdout-only");
    expect(result.detail).toMatch(/ERESOLVE/);
  });

  test("falls back to the error message when npm produced no output at all", async () => {
    outcomes = [{ fail: new Error("spawn npm ENOENT") }];

    const result = await installDependencies("/ws/no-npm");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/ENOENT/);
  });

  test("runs in the requested workspace with the supplied environment", async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], opts: any, cb: Function) => {
      calls.push(args);
      expect(opts.cwd).toBe("/ws/env-check");
      expect(opts.env.DATABASE_URL).toBe("postgresql://x");
      cb(null, { stdout: "", stderr: "" });
    });

    await installDependencies("/ws/env-check", { ...process.env, DATABASE_URL: "postgresql://x" });
    expect(calls).toHaveLength(1);
  });

  test("never audits or funds — those slow the fleet down for no benefit", async () => {
    await installDependencies("/ws/flags");
    expect(calls[0]).toEqual(expect.arrayContaining(["install", "--no-audit", "--no-fund"]));
  });

  test("serialises concurrent installs of the same workspace", async () => {
    let active = 0;
    let peak = 0;
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        cb(null, { stdout: "", stderr: "" });
      }, 5);
    });

    await Promise.all(Array.from({ length: 5 }, () => installDependencies("/ws/parallel")));
    expect(peak).toBe(1);
  });

  test("a stale-metadata failure in one caller does not break the next", async () => {
    outcomes = [{ fail: npmFailure(ETARGET_OUTPUT) }];
    const [first, second] = await Promise.all([
      installDependencies("/ws/queue"),
      installDependencies("/ws/queue"),
    ]);
    expect(first!.ok).toBe(true);
    expect(first!.refetchedMetadata).toBe(true);
    expect(second!.ok).toBe(true);
    expect(second!.refetchedMetadata).toBe(false);
  });
});
