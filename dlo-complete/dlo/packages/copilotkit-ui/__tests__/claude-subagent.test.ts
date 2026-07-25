/**
 * __tests__/claude-subagent.test.ts
 * The single place `claude` is spawned: auth handling, permission-mode
 * resolution, argv construction and failure propagation.
 *
 * The permission-mode cases exist because `bypassPermissions` maps to
 * --dangerously-skip-permissions, which the CLI rejects outright under
 * root — the failure mode that kills a pipeline inside any root container.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: vi.fn(),
}));

const {
  resolveHostPermissionMode,
  claudeAuthFromConfig,
  claudePermissionModeFromConfig,
  spawnClaudeAgent,
  checkClaudeCli,
} = await import("../src/lib/orchestrator/subagents/claude");

function fakeChild(opts: { code?: number; stdout?: string; stderr?: string; error?: Error } = {}) {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.code ?? 0);
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild({ stdout: JSON.stringify({ result: "done" }) }));
});

describe("resolveHostPermissionMode", () => {
  test.each([
    ["bypassPermissions as root", "bypassPermissions", { isRoot: true }, "acceptEdits", true],
    ["bypassPermissions as a normal user", "bypassPermissions", { isRoot: false }, "bypassPermissions", false],
    ["acceptEdits as root", "acceptEdits", { isRoot: true }, "acceptEdits", false],
    ["plan as root", "plan", { isRoot: true }, "plan", false],
    ["default as root", "default", { isRoot: true }, "default", false],
  ] as const)("%s", (_name, requested, host, expectedMode, expectedAdjusted) => {
    expect(resolveHostPermissionMode(requested, host)).toEqual({
      mode: expectedMode,
      adjusted: expectedAdjusted,
    });
  });

  test("leaves an unspecified mode alone", () => {
    expect(resolveHostPermissionMode(undefined, { isRoot: true })).toEqual({
      mode: undefined,
      adjusted: false,
    });
  });

  test("IS_SANDBOX does not lift the root restriction", () => {
    // The CLI refuses --dangerously-skip-permissions under root regardless of
    // IS_SANDBOX; honoring that env var here reintroduced the exact failure.
    expect(resolveHostPermissionMode("bypassPermissions", { isRoot: true }).mode).toBe("acceptEdits");
  });
});

describe("claudeAuthFromConfig", () => {
  test("subscription auth carries no api key", () => {
    expect(claudeAuthFromConfig({ providers: { planner: { auth: "subscription" } } })).toEqual({
      auth: "subscription",
    });
  });

  test("api-key auth carries the configured key", () => {
    const result = claudeAuthFromConfig({ providers: { planner: { auth: "api-key", apiKey: "sk-1" } } });
    expect(result).toEqual({ auth: "api-key", apiKey: "sk-1" });
  });

  test("defaults to api-key when nothing is configured", () => {
    expect(claudeAuthFromConfig({}).auth).toBe("api-key");
    expect(claudeAuthFromConfig(undefined).auth).toBe("api-key");
  });

  test("omits apiKey entirely when there is none to supply", () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(claudeAuthFromConfig({})).toEqual({ auth: "api-key" });
      expect("apiKey" in claudeAuthFromConfig({})).toBe(false);
    } finally {
      if (prior !== undefined) process.env.ANTHROPIC_API_KEY = prior;
    }
  });
});

describe("claudePermissionModeFromConfig", () => {
  test.each(["plan", "bypassPermissions", "acceptEdits", "default"] as const)("accepts %s", (mode) => {
    expect(claudePermissionModeFromConfig({ providers: { planner: { permissionMode: mode } } }, "planner")).toBe(mode);
  });

  test("falls back when the configured value is not a real mode", () => {
    const config = { providers: { executor: { permissionMode: "yolo" } } };
    expect(claudePermissionModeFromConfig(config, "executor", "acceptEdits")).toBe("acceptEdits");
  });

  test("reads the provider it was asked for, not another", () => {
    const config = { providers: { planner: { permissionMode: "plan" }, executor: { permissionMode: "acceptEdits" } } };
    expect(claudePermissionModeFromConfig(config, "planner", "default")).toBe("plan");
    expect(claudePermissionModeFromConfig(config, "executor", "default")).toBe("acceptEdits");
  });

  test("uses the supplied fallback when the provider is absent", () => {
    expect(claudePermissionModeFromConfig({}, "reviewer", "plan")).toBe("plan");
  });
});

describe("spawnClaudeAgent", () => {
  const base = { prompt: "hello", model: "claude-sonnet-5", cwd: "/tmp/dlo-spawn-test" };

  test("builds the headless argv the CLI expects", async () => {
    await spawnClaudeAgent(base);
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "hello", "--model", "claude-sonnet-5", "--output-format", "json"]);
  });

  test("closes stdin immediately — the prompt comes from argv", async () => {
    let child: any;
    spawnMock.mockImplementation(() => {
      child = fakeChild({ stdout: JSON.stringify({ result: "x" }) });
      return child;
    });
    await spawnClaudeAgent(base);
    expect(child.stdin.end).toHaveBeenCalled();
  });

  test("omits --permission-mode for the default mode", async () => {
    await spawnClaudeAgent({ ...base, permissionMode: "default" });
    expect(spawnMock.mock.calls[0]![1]).not.toContain("--permission-mode");
  });

  test("passes plan mode through", async () => {
    await spawnClaudeAgent({ ...base, permissionMode: "plan" });
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  test("never sends bypassPermissions to a CLI that would reject it as root", async () => {
    await spawnClaudeAgent({ ...base, permissionMode: "bypassPermissions" });
    const args = spawnMock.mock.calls[0]![1] as string[];
    const sent = args[args.indexOf("--permission-mode") + 1];
    const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
    expect(sent).toBe(runningAsRoot ? "acceptEdits" : "bypassPermissions");
  });

  test("appends each requested plugin directory", async () => {
    await spawnClaudeAgent({ ...base, pluginDirs: ["/a", "/b"] });
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.filter((a) => a === "--plugin-dir")).toHaveLength(2);
    expect(args).toContain("/a");
    expect(args).toContain("/b");
  });

  test("strips ANTHROPIC_API_KEY in subscription mode", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-be-removed";
    try {
      await spawnClaudeAgent({ ...base, auth: "subscription" });
      const opts = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("injects the api key in api-key mode", async () => {
    await spawnClaudeAgent({ ...base, auth: "api-key", apiKey: "sk-inject" });
    const opts = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-inject");
  });

  test("returns the parsed result field of the JSON payload", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: JSON.stringify({ result: "the answer" }) }));
    await expect(spawnClaudeAgent(base)).resolves.toBe("the answer");
  });

  test("returns raw stdout when the payload is not JSON", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: "plain text output" }));
    await expect(spawnClaudeAgent(base)).resolves.toBe("plain text output");
  });

  test("rejects with both streams on a non-zero exit", async () => {
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 1, stdout: "partial work", stderr: "fatal: boom" })
    );
    await expect(spawnClaudeAgent(base)).rejects.toThrow(/claude exited 1[\s\S]*fatal: boom/);
  });

  test("drops the noisy stdin warning from the reported failure", async () => {
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 1, stderr: "Warning: no stdin data received\nreal problem here" })
    );
    await expect(spawnClaudeAgent(base)).rejects.toThrow(/real problem here/);
  });

  test("propagates a spawn error", async () => {
    spawnMock.mockImplementation(() => fakeChild({ error: new Error("spawn claude ENOENT") }));
    await expect(spawnClaudeAgent(base)).rejects.toThrow(/ENOENT/);
  });
});

describe("checkClaudeCli", () => {
  test("reports available with the version string", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: "2.1.220 (Claude Code)" }));
    await expect(checkClaudeCli()).resolves.toEqual({ available: true, detail: "2.1.220 (Claude Code)" });
  });

  test("reports unavailable when the binary is missing", async () => {
    spawnMock.mockImplementation(() => fakeChild({ error: new Error("ENOENT") }));
    await expect(checkClaudeCli()).resolves.toEqual({
      available: false,
      detail: "claude CLI not found in PATH",
    });
  });

  test("reports unavailable on a non-zero exit", async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 127 }));
    const result = await checkClaudeCli();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/exited 127/);
  });
});

/**
 * The observability wiring: an invocation is only visible in the console's log
 * panel, and only killable from /abort, when it was told which pipeline it
 * belongs to. Several fleet call sites omitted `pipelineId`, which is why the
 * longest phase of a run produced no log output and no stoppable process.
 */
const logStore = await import("../src/lib/orchestrator/logStore");
const registry = await import("../src/lib/orchestrator/processRegistry");

/** A child the test drives by hand — it exits only when told to. */
function manualChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** spawnClaudeAgent awaits mkdir(cwd) before spawning, so registration lands a tick later. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("spawnClaudeAgent — log streaming and process registration", () => {
  const base = { prompt: "hello", model: "claude-sonnet-5", cwd: "/tmp/dlo-spawn-test" };

  beforeEach(() => {
    logStore.clearLogs("p1");
    registry.unregisterProcess("p1");
  });

  test("streams stdout and stderr to the pipeline's log buffer", async () => {
    spawnMock.mockImplementation(() =>
      fakeChild({ stdout: "building the block editor\n", stderr: "npm warn deprecated\n" })
    );

    await spawnClaudeAgent({ ...base, pipelineId: "p1" });

    expect(logStore.getLogs("p1")).toEqual(["building the block editor", "npm warn deprecated"]);
  });

  test("logs nothing when no pipeline is named", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: "orphaned output\n" }));

    await spawnClaudeAgent(base);

    expect(logStore.getLogs("p1")).toEqual([]);
  });

  test("registers the child while it runs and releases it on exit", async () => {
    const child = manualChild();
    spawnMock.mockImplementation(() => child);

    const run = spawnClaudeAgent({ ...base, pipelineId: "p1" });
    await settle();
    expect(registry.hasProcess("p1")).toBe(true);

    child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok" })));
    child.emit("close", 0);

    await expect(run).resolves.toBe("ok");
    expect(registry.hasProcess("p1")).toBe(false);
  });

  test("releases the child after a failed run too", async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 1, stderr: "boom" }));

    await expect(spawnClaudeAgent({ ...base, pipelineId: "p1" })).rejects.toThrow(/claude exited 1/);

    expect(registry.hasProcess("p1")).toBe(false);
  });

  test("releases the child when the spawn itself errors", async () => {
    spawnMock.mockImplementation(() => fakeChild({ error: new Error("ENOENT") }));

    await expect(spawnClaudeAgent({ ...base, pipelineId: "p1" })).rejects.toThrow("ENOENT");

    expect(registry.hasProcess("p1")).toBe(false);
  });

  test("registers nothing when no pipeline is named", async () => {
    await spawnClaudeAgent(base);
    expect(registry.hasProcess("p1")).toBe(false);
  });

  test("concurrent invocations of one pipeline are all registered", async () => {
    const children: any[] = [];
    spawnMock.mockImplementation(() => {
      const child = manualChild();
      children.push(child);
      return child;
    });

    const runs = [
      spawnClaudeAgent({ ...base, pipelineId: "p1" }),
      spawnClaudeAgent({ ...base, pipelineId: "p1" }),
      spawnClaudeAgent({ ...base, pipelineId: "p1" }),
    ];
    await settle();
    expect(registry.processCount("p1")).toBe(3);

    // One finishing must not deregister the other two.
    children[0]!.emit("close", 0);
    await runs[0];
    expect(registry.processCount("p1")).toBe(2);

    children[1]!.emit("close", 0);
    children[2]!.emit("close", 0);
    await Promise.all(runs);
    expect(registry.hasProcess("p1")).toBe(false);
  });
});
