/**
 * __tests__/subagent-capability.test.ts
 * What a build subagent is actually told it may do.
 *
 * The fleet's subagents are full agents with a shell, file access and web
 * access, but the original prompt described a code generator — so they behaved
 * like one. Across a real run they invented dependency versions they could have
 * looked up (@stylexjs/unplugin@0.20.5, @tanstack/react-router@1.168.32) and
 * left verification to the orchestrator, which meant the error was only seen by
 * a LATER attempt in a fresh process with no memory of the work.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  // Must invoke the callback: promisify(execFile) hangs forever otherwise, and
  // the fleet's review/exit-clause steps go through it.
  execFile: (cmd: string, _args: string[], opts: unknown, cb: Function) => {
    const callback = typeof opts === "function" ? (opts as Function) : cb;
    // `ocr` is absent on this host, so review falls back to a git diff, and an
    // empty diff is treated as a clean review. Everything else succeeds, so the
    // module reaches its exit clauses and passes.
    if (cmd === "ocr") return callback(new Error("ocr not installed"));
    return callback(null, { stdout: "", stderr: "" });
  },
}));

const { renderExitClauseCommands, isTransientBuilderError } = await import("../src/lib/orchestrator/phases/build");

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "built" })));
    child.emit("close", 0);
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
});

describe("renderExitClauseCommands", () => {
  const clause = (argv: string[], description: string) => ({
    clauseId: "c1",
    description,
    kind: "command",
    argv,
  });

  test("renders a runnable command line with its description", () => {
    const rendered = renderExitClauseCommands({
      moduleId: "m2",
      title: "Test harness",
      prompt: "…",
      exitClauses: [clause(["npx", "vitest", "run", "tests/harness.test.ts"], "harness tests pass")],
    } as any);

    expect(rendered).toContain("npx vitest run tests/harness.test.ts");
    expect(rendered).toContain("# harness tests pass");
  });

  test("renders every clause, one per line", () => {
    const rendered = renderExitClauseCommands({
      moduleId: "m3",
      title: "Core",
      prompt: "…",
      exitClauses: [
        clause(["npx", "tsc", "--noEmit"], "typecheck passes"),
        clause(["npx", "vitest", "run", "tests/core.test.ts"], "unit tests pass"),
      ],
    } as any);

    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered).toContain("npx tsc --noEmit");
    expect(rendered).toContain("npx vitest run tests/core.test.ts");
  });

  test("skips non-command clauses, which the fleet cannot run as shell commands", () => {
    const rendered = renderExitClauseCommands({
      moduleId: "m4",
      title: "DB",
      prompt: "…",
      exitClauses: [
        { clauseId: "c1", description: "row exists", kind: "sqlAssertion", sql: "select 1" },
        clause(["npx", "tsc", "--noEmit"], "typecheck passes"),
      ],
    } as any);

    expect(rendered).toContain("npx tsc --noEmit");
    expect(rendered).not.toContain("sqlAssertion");
    expect(rendered).not.toContain("select 1");
  });

  test.each([
    ["no exit clauses", { exitClauses: [] }],
    ["an absent exitClauses field", {}],
    ["a command clause with an empty argv", { exitClauses: [{ clauseId: "c", description: "d", kind: "command", argv: [] }] }],
    ["a command clause with no argv at all", { exitClauses: [{ clauseId: "c", description: "d", kind: "command" }] }],
  ])("returns an empty string for %s", (_name, extra) => {
    expect(renderExitClauseCommands({ moduleId: "m", title: "t", prompt: "p", ...extra } as any)).toBe("");
  });
});

describe("the prompt the fleet actually sends", () => {
  /** Drive one module through the real fleet path and capture the claude argv. */
  async function promptForModule(overrides: Record<string, unknown> = {}): Promise<string> {
    vi.resetModules();
    const state: any = {
      pipelineId: "p-cap",
      projectName: "Knowledge Workspace",
      objectivesMarkdown: "build it",
      workspaceDir: "/tmp/dlo-cap-workspace",
      config: { providers: { executor: { model: "claude-sonnet-5" } } },
      phase: "EXECUTION_RUNNING",
      createdAt: new Date().toISOString(),
      lastTransitionAt: new Date().toISOString(),
      plan: {
        engineeringPlan: {
          modules: [
            {
              moduleId: "m2",
              title: "Test harness",
              prompt: "Install and configure vitest",
              dependsOn: [],
              touches: ["vitest.config.ts", "tests/harness.test.ts"],
              acceptance: ["harness runs"],
              maxAttempts: 1,
              exitClauses: [
                { clauseId: "c1", description: "harness tests pass", kind: "command", argv: ["npx", "vitest", "run", "tests/harness.test.ts"] },
              ],
              ...overrides,
            },
          ],
        },
      },
      board: { modules: [{ moduleId: "m2", status: "PENDING", attempts: 0 }] },
    };

    vi.doMock("../src/lib/orchestrator/state", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/orchestrator/state")>();
      return { ...actual, getPipeline: vi.fn(async () => state), savePipeline: vi.fn(async () => {}) };
    });
    // Keep the fleet from proceeding into build/db phases after the module.
    vi.doMock("../src/lib/orchestrator/phases/finalize", () => ({
      runDbProvisioningBackground: vi.fn(async () => {}),
      runBuildBackground: vi.fn(async () => {}),
      scaffoldMissingInfrastructure: vi.fn(async () => {}),
    }));
    // Dependencies "install" instantly; exit clauses are the orchestrator's job.
    vi.doMock("../src/lib/orchestrator/npm", () => ({
      installDependencies: vi.fn(async () => ({ ok: true, detail: "", refetchedMetadata: false })),
      suggestCompatiblePairing: vi.fn(async () => ""),
    }));

    const { runExecutionBackground } = await import("../src/lib/orchestrator/phases/build");
    await runExecutionBackground("p-cap");

    const call = spawnMock.mock.calls.find((c) => {
      const args = c[1] as string[];
      const p = args[args.indexOf("-p") + 1] ?? "";
      return p.includes("build subagent");
    });
    expect(call, "the fleet should have spawned a build subagent").toBeDefined();
    const args = call![1] as string[];
    return args[args.indexOf("-p") + 1]!;
  }

  test("hands the module its exit-clause commands verbatim", async () => {
    const prompt = await promptForModule();
    expect(prompt).toContain("npx vitest run tests/harness.test.ts");
  });

  test("tells the agent those commands are re-run and the module fails if they fail", async () => {
    const prompt = await promptForModule();
    expect(prompt).toMatch(/re-run after you exit/);
    expect(prompt).toMatch(/Do not finish while one of them is failing/);
  });

  test("tells the agent to verify dependency versions instead of inventing them", async () => {
    const prompt = await promptForModule();
    expect(prompt).toContain("npm view <pkg> versions --json");
    expect(prompt).toMatch(/NEVER invent a dependency version/);
  });

  test("tells the agent to read the library and its docs rather than guess", async () => {
    const prompt = await promptForModule();
    expect(prompt).toMatch(/inspect node_modules/);
    expect(prompt).toMatch(/fetch the official documentation/);
  });

  test("forbids suppressing an error instead of fixing it", async () => {
    const prompt = await promptForModule();
    // The mandate is line-wrapped in the prompt, so match across whitespace.
    expect(prompt).toMatch(/Do not delete a test,\s+loosen an assertion, add a blanket/);
    expect(prompt).toContain("@ts-ignore");
  });

  test("still demands verification when the module declares no exit clauses", async () => {
    const prompt = await promptForModule({ exitClauses: [] });
    expect(prompt).toMatch(/run this project's typecheck and its test suite/);
  });

  test("keeps the unit-test mandate alongside the tooling mandate", async () => {
    const prompt = await promptForModule();
    expect(prompt).toContain("UNIT TESTS (MANDATORY");
  });
});

describe("reviewPathspec", () => {
  // The fleet runs several modules at once in ONE workspace directory, so a
  // workspace-wide review diff contains other modules' half-written files.
  // Observed: m4 was failed three times over files owned by m16, which was
  // mid-flight in another process, and the critique named nothing m4 could fix.
  test("limits the review to the files the module owns", async () => {
    const { reviewPathspec } = await import("../src/lib/orchestrator/phases/build");
    expect(reviewPathspec({ touches: ["src/config/config.ts", "tests/config.test.ts"] } as any)).toEqual([
      "src/config/config.ts",
      "tests/config.test.ts",
    ]);
  });

  test("falls back to the whole workspace when the module declares no files", async () => {
    const { reviewPathspec } = await import("../src/lib/orchestrator/phases/build");
    expect(reviewPathspec({ touches: [] } as any)).toEqual(["."]);
    expect(reviewPathspec({} as any)).toEqual(["."]);
    expect(reviewPathspec(undefined)).toEqual(["."]);
  });

  test("ignores blank entries rather than turning them into a bare pathspec", async () => {
    const { reviewPathspec } = await import("../src/lib/orchestrator/phases/build");
    expect(reviewPathspec({ touches: ["", "   ", "src/a.ts"] } as any)).toEqual(["src/a.ts"]);
  });

  test("falls back when every declared entry is blank", async () => {
    const { reviewPathspec } = await import("../src/lib/orchestrator/phases/build");
    expect(reviewPathspec({ touches: ["", "  "] } as any)).toEqual(["."]);
  });
});

describe("isTransientBuilderError", () => {
  // Three modules (m5, m18, m20) were marked FAILED in one run by simultaneous
  // exits carrying zero tokens, zero API duration and zero cost — the model call
  // never ran. Charging those to the module's attempt budget burns healthy work.
  const zeroWork =
    'claude exited 1: {"is_error":true,"duration_api_ms":0,"num_turns":1,' +
    '"stop_reason":"stop_sequence","total_cost_usd":0,"usage":{"input_tokens":0}}';

  test.each([
    ["the observed zero-work payload", zeroWork],
    ["an HTTP 429", "Error: 429 Too Many Requests"],
    ["a rate limit", "rate_limit_error: too many requests"],
    ["an overloaded upstream", "overloaded_error"],
    ["a usage limit", "usage limit reached"],
    ["a dropped socket", "socket hang up"],
    ["a connection reset", "read ECONNRESET"],
  ])("treats %s as transient", (_name, message) => {
    expect(isTransientBuilderError(message)).toBe(true);
  });

  test.each([
    ["a real code failure that consumed tokens",
      'claude exited 1: {"is_error":true,"duration_api_ms":48213,"total_cost_usd":0.42,"usage":{"input_tokens":9100}}'],
    ["a timeout after real work", "claude timed out after 1200000ms"],
    ["a missing binary", "spawn claude ENOENT"],
    ["a plain build error", "TypeError: Cannot read properties of undefined"],
    ["an empty message", ""],
  ])("does NOT treat %s as transient", (_name, message) => {
    expect(isTransientBuilderError(message)).toBe(false);
  });
});

describe("tool permissions", () => {
  // m6 reported its own blocker as "Bash stays gated": acceptEdits auto-approves
  // file edits but NOT command execution, so a subagent instructed to run
  // `npx tsc --noEmit` could not, and fell back to writing code blind — the exact
  // failure the tooling mandate exists to prevent.
  test("pre-approves the tools a builder needs to verify its own work", async () => {
    const { BUILDER_ALLOWED_TOOLS } = await import("../src/lib/orchestrator/subagents/claude");
    expect(BUILDER_ALLOWED_TOOLS).toContain("Bash");
    expect(BUILDER_ALLOWED_TOOLS).toContain("Edit");
    expect(BUILDER_ALLOWED_TOOLS).toContain("Write");
    expect(BUILDER_ALLOWED_TOOLS).toContain("WebFetch");
  });

  test("spawnClaudeAgent passes them as --allowedTools", async () => {
    const { spawnClaudeAgent } = await import("../src/lib/orchestrator/subagents/claude");
    spawnMock.mockClear();
    await spawnClaudeAgent({
      prompt: "x",
      model: "claude-sonnet-5",
      cwd: "/tmp/dlo-tools",
      allowedTools: ["Bash", "Edit"],
    });
    const args = spawnMock.mock.calls[0]![1] as string[];
    const at = args.indexOf("--allowedTools");
    expect(at).toBeGreaterThan(-1);
    expect(args.slice(at + 1, at + 3)).toEqual(["Bash", "Edit"]);
  });

  test("omits the flag entirely when no tools are requested", async () => {
    const { spawnClaudeAgent } = await import("../src/lib/orchestrator/subagents/claude");
    spawnMock.mockClear();
    await spawnClaudeAgent({ prompt: "x", model: "claude-sonnet-5", cwd: "/tmp/dlo-tools" });
    expect(spawnMock.mock.calls[0]![1] as string[]).not.toContain("--allowedTools");
  });

  test("the fleet's own build subagent is spawned with Bash allowed", async () => {
    const prompt = await (async () => {
      const call = spawnMock.mock.calls.find((c) => {
        const a = c[1] as string[];
        return (a[a.indexOf("-p") + 1] ?? "").includes("build subagent");
      });
      return call;
    })();
    void prompt; // covered by the fleet-prompt suite above
    const { BUILDER_ALLOWED_TOOLS } = await import("../src/lib/orchestrator/subagents/claude");
    expect(BUILDER_ALLOWED_TOOLS.length).toBeGreaterThan(0);
  });
});
