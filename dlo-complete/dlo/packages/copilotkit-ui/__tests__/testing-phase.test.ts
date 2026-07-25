/**
 * __tests__/testing-phase.test.ts
 * The TESTING_RUNNING phase end-to-end, with every process mocked.
 *
 * The rule these tests pin down: a generated application only passes its test
 * phase when tests actually executed. Zero tests is a failure the pipeline
 * repairs (Test Author subagent) — never a pass, and never something the
 * supervisor may override.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Process mocks (no real npm, no real claude, no real test runner) ────────

const spawnMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  // promisify() falls back to the callback contract for a plain mock, so the
  // callback must resolve with the {stdout, stderr} shape the code destructures.
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

// ─── State mock: the pipeline record lives in memory for the test ────────────

let pipelineState: any;
const savedStates: any[] = [];

vi.mock("../src/lib/orchestrator/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/orchestrator/state")>();
  return {
    ...actual,
    getPipeline: vi.fn(async () => pipelineState),
    savePipeline: vi.fn(async (s: any) => {
      savedStates.push(JSON.parse(JSON.stringify(s)));
    }),
  };
});

const { runTestingBackground } = await import("../src/lib/orchestrator/phases/finalize");

// ─── Helpers ─────────────────────────────────────────────────────────────────

let workspace: string;

/** A `claude` child process that succeeds, returning `result` as its payload. */
function claudeChild(result: string) {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({ result })));
    child.emit("close", 0);
  });
  return child;
}

/** The prompt text a mocked spawn call was given. */
function promptOf(call: any[]): string {
  const args = call[1] as string[];
  return args[args.indexOf("-p") + 1] ?? "";
}

function isTestAuthorCall(call: any[]): boolean {
  return promptOf(call).includes("Test Author subagent");
}

/** Queue of results for the test-runner command, consumed in order. */
let runnerResults: Array<{ stdout: string; fail?: boolean }> = [];

function installExecFileMock(): void {
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const callback = typeof _opts === "function" ? (_opts as Function) : cb;
    const isRunner = cmd === "npm" && args[0] === "test";
    if (!isRunner) {
      // npm install and friends always succeed and produce nothing interesting.
      callback(null, { stdout: "", stderr: "" });
      return;
    }
    const next = runnerResults.shift() ?? { stdout: "      Tests  0 passed (0)\n" };
    if (next.fail) {
      const err: any = new Error("test run failed");
      err.stdout = next.stdout;
      err.stderr = "";
      callback(err);
    } else {
      callback(null, { stdout: next.stdout, stderr: "" });
    }
  });
}

async function writePkg(pkg: Record<string, unknown>): Promise<void> {
  await writeFile(join(workspace, "package.json"), JSON.stringify(pkg), "utf-8");
}

function stateFixture(): any {
  return {
    pipelineId: "p-testing",
    projectName: "Knowledge Workspace",
    objectivesMarkdown: "build it",
    workspaceDir: workspace,
    config: { providers: { executor: { model: "claude-sonnet-5" } } },
    phase: "TESTING_RUNNING",
    createdAt: new Date().toISOString(),
    lastTransitionAt: new Date().toISOString(),
    phaseHistory: [],
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dlo-phase-"));
  pipelineState = stateFixture();
  savedStates.length = 0;
  runnerResults = [];
  spawnMock.mockReset();
  execFileMock.mockReset();
  installExecFileMock();
  // Default: any claude invocation is the supervisor, approving nothing.
  spawnMock.mockImplementation(() => claudeChild(JSON.stringify({ passed: true, override: false, reasoning: "ok" })));
});

afterEach(async () => {
  // The testing phase hands off to the deploy phase with `void`, and that
  // fire-and-forget continuation writes HANDOFF.md into the workspace. Let it
  // drain before removing the directory, or cleanup races it and throws
  // ENOTEMPTY after the assertions have already passed.
  await new Promise((r) => setTimeout(r, 150));
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runTestingBackground — permission gate", () => {
  test("raises a TERMINAL_PERMISSION gate instead of running anything", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    await runTestingBackground("p-testing", false);

    expect(pipelineState.activeGate?.kind).toBe("TERMINAL_PERMISSION");
    expect(pipelineState.activeGate?.context?.nextAction).toBe("run-tests");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("warns in the gate exhibit when the suite does not exist yet", async () => {
    await writePkg({ name: "app", scripts: { build: "vite build" } });
    await runTestingBackground("p-testing", false);

    expect(String(pipelineState.activeGate.exhibits[1])).toContain("Test Author subagent");
  });

  test("the gate exhibit shows the real command when a suite exists", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    await runTestingBackground("p-testing", false);

    const exhibit = String(pipelineState.activeGate.exhibits[1]);
    expect(exhibit).toContain("npm test");
    expect(exhibit).not.toContain("passWithNoTests");
  });
});

describe("runTestingBackground — a real suite", () => {
  test("passes and records how many tests executed", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    runnerResults = [{ stdout: " Test Files  3 passed (3)\n      Tests  27 passed (27)\n" }];

    await runTestingBackground("p-testing", true);

    expect(pipelineState.testResults.passed).toBe(true);
    expect(pipelineState.testResults.testsRun).toBe(27);
    expect(pipelineState.testResults.testAuthorRounds).toBe(0);
    // No Test Author needed when the suite is genuinely there.
    expect(spawnMock.mock.calls.filter(isTestAuthorCall)).toHaveLength(0);
  });

  test("advances the pipeline past testing", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    runnerResults = [{ stdout: "      Tests  5 passed (5)\n" }];

    await runTestingBackground("p-testing", true);

    expect(pipelineState.phaseHistory.map((p: any) => p.phase)).toContain("DEPLOY_RUNNING");
  });
});

describe("runTestingBackground — empty suite enforcement", () => {
  test("calls the Test Author when the runner executes zero tests, then passes on the rebuilt suite", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    runnerResults = [
      { stdout: "No test files found, exiting with code 0\n" },
      { stdout: "      Tests  8 passed (8)\n" },
    ];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      return prompt.includes("Test Author subagent")
        ? claudeChild("added 3 test files")
        : claudeChild(JSON.stringify({ passed: true, override: false, reasoning: "ok" }));
    });

    await runTestingBackground("p-testing", true);

    expect(spawnMock.mock.calls.filter(isTestAuthorCall)).toHaveLength(1);
    expect(pipelineState.testResults.passed).toBe(true);
    expect(pipelineState.testResults.testsRun).toBe(8);
    expect(pipelineState.testResults.testAuthorRounds).toBe(1);
  });

  test("tells the Test Author the suite is empty, not that the command is missing", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    runnerResults = [{ stdout: "No test files found\n" }, { stdout: "      Tests  2 passed (2)\n" }];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      return prompt.includes("Test Author subagent")
        ? claudeChild("done")
        : claudeChild(JSON.stringify({ passed: true, override: false, reasoning: "ok" }));
    });

    await runTestingBackground("p-testing", true);

    const authorPrompt = promptOf(spawnMock.mock.calls.find(isTestAuthorCall)!);
    expect(authorPrompt).toContain("ZERO tests");
  });

  test("records FAILED when the suite is still empty after every Test Author round", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    // Always empty, however many times the author runs.
    runnerResults = Array.from({ length: 6 }, () => ({ stdout: "No test files found\n" }));
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      return prompt.includes("Test Author subagent")
        ? claudeChild("could not add tests")
        : claudeChild(JSON.stringify({ passed: true, override: false, reasoning: "ok" }));
    });

    await runTestingBackground("p-testing", true);

    expect(pipelineState.testResults.passed).toBe(false);
    expect(pipelineState.testResults.testsRun).toBe(0);
    // Bounded: it does not retry forever.
    expect(pipelineState.testResults.testAuthorRounds).toBe(2);
  });

  test("the supervisor may NOT override a run in which zero tests executed", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    runnerResults = Array.from({ length: 6 }, () => ({ stdout: "No test files found\n" }));
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      return prompt.includes("Test Author subagent")
        ? claudeChild("no luck")
        : claudeChild(JSON.stringify({ passed: false, override: true, reasoning: "just missing fixtures" }));
    });

    await runTestingBackground("p-testing", true);

    expect(pipelineState.testResults.passed).toBe(false);
  });

  test("the supervisor MAY override a genuine failure once tests actually ran", async () => {
    await writePkg({ name: "app", scripts: { test: "vitest run" } });
    runnerResults = Array.from({ length: 4 }, () => ({
      stdout: "      Tests  1 failed | 9 passed (10)\n",
      fail: true,
    }));
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      return prompt.includes("Test Author subagent")
        ? claudeChild("n/a")
        : claudeChild(JSON.stringify({ passed: false, override: true, reasoning: "DB fixture missing in CI" }));
    });

    await runTestingBackground("p-testing", true);

    expect(pipelineState.testResults.passed).toBe(true);
    expect(pipelineState.testResults.testsRun).toBe(10);
    expect(pipelineState.testResults.supervisorReasoning).toContain("DB fixture");
  });
});

describe("runTestingBackground — no test command at all", () => {
  test("authors a suite instead of skipping the phase", async () => {
    await writePkg({ name: "app", scripts: { build: "vite build" } });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      if (prompt.includes("Test Author subagent")) {
        // The author installs the runner and writes the script.
        void writeFile(
          join(workspace, "package.json"),
          JSON.stringify({ name: "app", scripts: { test: "vitest run", build: "vite build" } }),
          "utf-8"
        );
        return claudeChild("created vitest.config.ts and 5 test files");
      }
      return claudeChild(JSON.stringify({ passed: true, override: false, reasoning: "ok" }));
    });
    runnerResults = [{ stdout: "      Tests  12 passed (12)\n" }];

    await runTestingBackground("p-testing", true);

    const authorCalls = spawnMock.mock.calls.filter(isTestAuthorCall);
    expect(authorCalls).toHaveLength(1);
    expect(promptOf(authorCalls[0]!)).toContain("NO usable test command");
    expect(pipelineState.testResults.passed).toBe(true);
    expect(pipelineState.testResults.testsRun).toBe(12);
  });

  test("records an honest failure when no suite can be created, and still advances", async () => {
    await writePkg({ name: "app", scripts: { build: "vite build" } });
    // The author runs but leaves package.json without a test script.
    await runTestingBackground("p-testing", true);

    expect(spawnMock.mock.calls.filter(isTestAuthorCall)).toHaveLength(1);
    expect(pipelineState.testResults.passed).toBe(false);
    expect(pipelineState.testResults.output).toMatch(/No test suite exists/);
    expect(pipelineState.phaseHistory.map((p: any) => p.phase)).toContain("DEPLOY_RUNNING");
  });

  test("survives a Test Author crash and still reports the shortfall", async () => {
    await writePkg({ name: "app", scripts: { build: "vite build" } });
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, any>;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn claude ENOENT")));
      return child;
    });

    await runTestingBackground("p-testing", true);

    expect(pipelineState.testResults.passed).toBe(false);
    expect(pipelineState.phase).not.toBe("FAILED");
  });
});
