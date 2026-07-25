/**
 * __tests__/test-author-subagent.test.ts
 * The Test Author subagent is what makes "the generated app ships tests" true
 * rather than aspirational, so what it is actually told matters.
 *
 * `claude` is never spawned for real here — node:child_process is mocked and
 * the assertions are on the exact argv and environment handed to it.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: vi.fn(),
}));

const { runTestAuthorSubagent } = await import("../src/lib/orchestrator/phases/finalize");
type PipelineState = Parameters<typeof runTestAuthorSubagent>[0];

/** A child process that immediately succeeds with a JSON result payload. */
function fakeChild(result = "wrote 4 test files") {
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

function stateFixture(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    pipelineId: "p-1",
    projectName: "Knowledge Workspace",
    objectivesMarkdown: "build it",
    workspaceDir: "/tmp/dlo-fake-workspace",
    config: {},
    phase: "TESTING_RUNNING",
    createdAt: new Date().toISOString(),
    lastTransitionAt: new Date().toISOString(),
    ...overrides,
  } as PipelineState;
}

/** The argv array `claude` was spawned with. */
function argv(): string[] {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  return spawnMock.mock.calls[0]![1] as string[];
}

function promptArg(): string {
  const args = argv();
  return args[args.indexOf("-p") + 1]!;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
});

describe("runTestAuthorSubagent", () => {
  test("spawns the claude CLI, never another coding harness", async () => {
    await runTestAuthorSubagent(stateFixture(), "no-test-command");
    expect(spawnMock.mock.calls[0]![0]).toBe("claude");
  });

  test("runs inside the generated application's workspace", async () => {
    await runTestAuthorSubagent(stateFixture({ workspaceDir: "/tmp/dlo-fake-workspace" }), "no-test-command");
    expect((spawnMock.mock.calls[0]![2] as { cwd: string }).cwd).toBe("/tmp/dlo-fake-workspace");
  });

  test("uses the configured executor model", async () => {
    const state = stateFixture({ config: { providers: { executor: { model: "claude-sonnet-5" } } } });
    await runTestAuthorSubagent(state, "no-test-command");
    const args = argv();
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
  });

  test("defaults to the cheap fleet model when none is configured", async () => {
    await runTestAuthorSubagent(stateFixture(), "no-test-command");
    const args = argv();
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  });

  test("runs with an edit-capable permission mode — it must write files", async () => {
    await runTestAuthorSubagent(stateFixture(), "no-test-command");
    const args = argv();
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  test("strips ANTHROPIC_API_KEY under subscription auth", async () => {
    const state = stateFixture({ config: { providers: { planner: { auth: "subscription" } } } });
    await runTestAuthorSubagent(state, "no-test-command");
    const opts = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("injects the configured key under api-key auth", async () => {
    const state = stateFixture({ config: { providers: { planner: { auth: "api-key", apiKey: "sk-test" } } } });
    await runTestAuthorSubagent(state, "no-test-command");
    const opts = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  describe("the instruction it is given", () => {
    test("states the no-test-command situation when that is the reason", async () => {
      await runTestAuthorSubagent(stateFixture(), "no-test-command");
      expect(promptArg()).toContain("NO usable test command");
    });

    test("states the empty-suite situation when that is the reason", async () => {
      await runTestAuthorSubagent(stateFixture(), "empty-suite");
      expect(promptArg()).toContain("ZERO tests");
    });

    test.each([
      ["forbids a flag that greenlights an empty suite", /--passWithNoTests/],
      ["forbids skipped tests", /[Nn]ever skip a test/],
      ["demands branch and failure-mode coverage", /every branch/],
      ["demands hermetic tests", /deterministic and hermetic/],
      ["demands the suite be left passing", /leave it passing/],
      ["demands a non-zero number of tests execute", /non-zero number of tests/],
    ])("%s", async (_name, pattern) => {
      await runTestAuthorSubagent(stateFixture(), "empty-suite");
      expect(promptArg()).toMatch(pattern);
    });

    test("passes Architecture.md's Testing Strategy section through when present", async () => {
      const state = stateFixture({
        designDocs: {
          architecture: {
            markdown: "# Architecture\n## Testing Strategy\nUse vitest with jsdom.\n## Deployment Shape\nirrelevant\n",
            version: 1,
            updatedAt: new Date().toISOString(),
          },
        },
      });
      await runTestAuthorSubagent(state, "empty-suite");
      const prompt = promptArg();
      expect(prompt).toContain("Use vitest with jsdom.");
      // Only the testing section is forwarded, not the whole document.
      expect(prompt).not.toContain("irrelevant");
    });

    test("omits the testing contract when no architecture document exists", async () => {
      await runTestAuthorSubagent(stateFixture(), "empty-suite");
      expect(promptArg()).not.toContain("testing contract for this project");
    });
  });

  test("propagates a non-zero exit from the CLI to the caller", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, any>;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("context limit reached"));
        child.emit("close", 1);
      });
      return child;
    });
    await expect(runTestAuthorSubagent(stateFixture(), "empty-suite")).rejects.toThrow(/claude exited 1/);
  });

  test("propagates a spawn failure (claude CLI absent)", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, any>;
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn claude ENOENT")));
      return child;
    });
    await expect(runTestAuthorSubagent(stateFixture(), "empty-suite")).rejects.toThrow(/ENOENT/);
  });
});
