/**
 * __tests__/fleet-dispatch.test.ts
 * The build fleet's DAG dispatch, with `claude` and every process mocked.
 *
 * The pipelineId assertions are not decoration: `buildModuleWithClaude` used to
 * spawn without one, and spawnClaudeAgent only streams output to the log store
 * and registers the child for abort/stdin when it knows the pipeline. During
 * EXECUTION_RUNNING — the longest phase of a run — the console's log panel
 * therefore showed nothing and no builder could be stopped.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

// ─── Subagent mock: no real `claude`, and every call's options are captured ──

const spawnClaudeAgent = vi.fn(async (_opts: any) => "built");
vi.mock("../src/lib/orchestrator/subagents/claude", () => ({
  spawnClaudeAgent: (opts: unknown) => spawnClaudeAgent(opts),
  claudeAuthFromConfig: () => ({ auth: "api-key", apiKey: "sk-test" }),
  claudePermissionModeFromConfig: () => "acceptEdits",
}));

vi.mock("../src/lib/orchestrator/npm", () => ({
  installDependencies: vi.fn(async () => ({ ok: true, detail: "", refetchedMetadata: false })),
  withInstallLock: vi.fn(async (_dir: string, fn: () => Promise<unknown>) => fn()),
  isStaleRegistryMetadataError: vi.fn(() => false),
}));

const runBuildBackground = vi.fn(async () => {});
const runDbProvisioningBackground = vi.fn(async () => {});
const scaffoldMissingInfrastructure = vi.fn(async () => {});
vi.mock("../src/lib/orchestrator/phases/finalize", () => ({
  runBuildBackground: (...a: unknown[]) => runBuildBackground(...(a as [])),
  runDbProvisioningBackground: (...a: unknown[]) => runDbProvisioningBackground(...(a as [])),
  scaffoldMissingInfrastructure: (...a: unknown[]) => scaffoldMissingInfrastructure(...(a as [])),
}));

let pipelineState: any;
vi.mock("../src/lib/orchestrator/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/orchestrator/state")>();
  return {
    ...actual,
    getPipeline: vi.fn(async () => pipelineState),
    savePipeline: vi.fn(async () => {}),
  };
});

const { runExecutionBackground } = await import("../src/lib/orchestrator/phases/build");

// ─── Fixtures ────────────────────────────────────────────────────────────────

let workspace: string;
let gitDiffReturns: (diff: string) => void;

interface ModuleSpec {
  moduleId: string;
  title?: string;
  dependsOn?: string[];
  maxAttempts?: number;
}

function planModule(spec: ModuleSpec) {
  return {
    moduleId: spec.moduleId,
    title: spec.title ?? spec.moduleId,
    prompt: `build ${spec.moduleId}`,
    dependsOn: spec.dependsOn ?? [],
    touches: [`src/${spec.moduleId}.ts`, `tests/${spec.moduleId}.test.ts`],
    acceptance: [`unit tests in tests/${spec.moduleId}.test.ts pass`],
    ...(spec.maxAttempts !== undefined ? { maxAttempts: spec.maxAttempts } : {}),
    exitClauses: [],
  };
}

function makeState(modules: ModuleSpec[], config: Record<string, unknown> = {}) {
  const planModules = modules.map(planModule);
  return {
    pipelineId: "pipeline-under-test",
    projectName: "NoteFlow Workspace",
    objectivesMarkdown: "a Notion-like workspace",
    workspaceDir: workspace,
    phase: "EXECUTION_RUNNING",
    createdAt: "2026-07-25T10:00:00.000Z",
    lastTransitionAt: "2026-07-25T10:00:00.000Z",
    phaseHistory: [],
    config,
    plan: { ceoPlan: "", architecturePlan: "", engineeringPlan: { modules: planModules } },
    board: { modules: planModules.map((m) => ({ moduleId: m.moduleId, status: "PENDING", attempts: 0 })) },
    designDocs: {
      architecture: { markdown: "# Architecture", version: 1 },
      database: { markdown: "# Database", version: 1 },
    },
  } as any;
}

/** The module builder calls, in dispatch order. */
function builderCalls() {
  return spawnClaudeAgent.mock.calls
    .map(([opts]: any[]) => opts)
    .filter((o: any) => typeof o.prompt === "string" && o.prompt.includes("You are a build subagent"));
}

function builtModuleIds(): string[] {
  return builderCalls().map((o: any) => {
    const match = o.prompt.match(/^Module: .*\((m\d+)\)$/m);
    return match?.[1] ?? "?";
  });
}

function statusOf(moduleId: string): string {
  return pipelineState.board.modules.find((m: any) => m.moduleId === moduleId).status;
}

beforeEach(async () => {
  vi.clearAllMocks();
  workspace = await mkdtemp(join(tmpdir(), "dlo-fleet-"));
  spawnClaudeAgent.mockResolvedValue("built");
  // No `ocr` CLI on this host (the common case), and an empty `git diff` over
  // the workspace so the review step passes without a reviewer subagent.
  execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: any) => {
    if (cmd === "ocr") {
      cb?.(Object.assign(new Error("spawn ocr ENOENT"), { code: "ENOENT" }), { stdout: "", stderr: "" });
      return;
    }
    cb?.(null, { stdout: "", stderr: "" });
  });

  /** Make `git diff` report a change, which sends the reviewer subagent out. */
  gitDiffReturns = (diff: string) => {
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: any) => {
      if (cmd === "ocr") {
        cb?.(Object.assign(new Error("spawn ocr ENOENT"), { code: "ENOENT" }), { stdout: "", stderr: "" });
        return;
      }
      cb?.(null, { stdout: cmd === "git" ? diff : "", stderr: "" });
    });
  };
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("module builder invocation", () => {
  test("passes the pipelineId so output streams and the child is killable", async () => {
    pipelineState = makeState([{ moduleId: "m1" }]);

    await runExecutionBackground("pipeline-under-test");

    const calls = builderCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].pipelineId).toBe("pipeline-under-test");
  });

  test("every fleet subagent — builder, reviewer, diagnoser — carries the pipelineId", async () => {
    // A non-empty diff sends the reviewer out too; both must be attributable.
    gitDiffReturns("diff --git a/src/m1.ts b/src/m1.ts\n+code");
    spawnClaudeAgent.mockResolvedValue("everything is fine");
    pipelineState = makeState([{ moduleId: "m1" }]);

    await runExecutionBackground("pipeline-under-test");

    expect(spawnClaudeAgent.mock.calls.length).toBeGreaterThan(1);
    for (const [opts] of spawnClaudeAgent.mock.calls as any[]) {
      expect(opts.pipelineId).toBe("pipeline-under-test");
    }
  });

  test("builds in the pipeline's workspace with the fleet's cheap model", async () => {
    pipelineState = makeState([{ moduleId: "m1" }]);

    await runExecutionBackground("pipeline-under-test");

    const [opts] = builderCalls();
    expect(opts.cwd).toBe(workspace);
    expect(opts.model).toBe("claude-haiku-4-5-20251001");
  });

  test("honors a per-module agent assignment from the designer canvas", async () => {
    pipelineState = makeState([{ moduleId: "m1" }]);
    pipelineState.agentDesign = { modules: { m1: { vendor: "claude-code", model: "claude-sonnet-5" } } };

    await runExecutionBackground("pipeline-under-test");

    expect(builderCalls()[0].model).toBe("claude-sonnet-5");
  });

  test("the prompt carries the module's task, files and the test mandate", async () => {
    pipelineState = makeState([{ moduleId: "m1", title: "Block editor UI" }]);

    await runExecutionBackground("pipeline-under-test");

    const { prompt } = builderCalls()[0];
    expect(prompt).toContain("Block editor UI");
    expect(prompt).toContain("tests/m1.test.ts");
    expect(prompt).toContain("UNIT TESTS (MANDATORY");
  });
});

describe("DAG dispatch", () => {
  test("a dependent module waits for its dependency to pass", async () => {
    pipelineState = makeState([
      { moduleId: "m1" },
      { moduleId: "m2", dependsOn: ["m1"] },
      { moduleId: "m3", dependsOn: ["m2"] },
    ]);

    await runExecutionBackground("pipeline-under-test");

    expect(builtModuleIds()).toEqual(["m1", "m2", "m3"]);
    expect(statusOf("m3")).toBe("PASSED");
  });

  test("independent modules are dispatched together, up to maxConcurrent", async () => {
    let inFlight = 0;
    let peak = 0;
    spawnClaudeAgent.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return "built";
    });
    pipelineState = makeState(
      [1, 2, 3, 4, 5, 6].map((n) => ({ moduleId: `m${n}` })),
      { providers: { executor: { maxConcurrent: 2 } } }
    );

    await runExecutionBackground("pipeline-under-test");

    expect(peak).toBe(2);
    expect(builderCalls()).toHaveLength(6);
  });

  test("maxConcurrent = 1 serializes the fleet", async () => {
    let inFlight = 0;
    let peak = 0;
    spawnClaudeAgent.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return "built";
    });
    pipelineState = makeState([{ moduleId: "m1" }, { moduleId: "m2" }], {
      providers: { executor: { maxConcurrent: 1 } },
    });

    await runExecutionBackground("pipeline-under-test");

    expect(peak).toBe(1);
  });

  test("a module whose dependency failed is BLOCKED and never built", async () => {
    spawnClaudeAgent.mockRejectedValue(new Error("claude exited 1: boom"));
    pipelineState = makeState([
      { moduleId: "m1", maxAttempts: 1 },
      { moduleId: "m2", dependsOn: ["m1"] },
    ]);

    await runExecutionBackground("pipeline-under-test");

    expect(statusOf("m1")).toBe("FAILED");
    expect(statusOf("m2")).toBe("BLOCKED");
    // m1 is retried by the whole-fleet retry, but m2's builder never runs.
    expect(new Set(builtModuleIds())).toEqual(new Set(["m1"]));
  });

  test("an empty plan skips the fleet and goes straight to database provisioning", async () => {
    pipelineState = makeState([]);

    await runExecutionBackground("pipeline-under-test");

    expect(spawnClaudeAgent).not.toHaveBeenCalled();
    expect(pipelineState.phase).toBe("DB_PROVISIONING_RUNNING");
    expect(runDbProvisioningBackground).toHaveBeenCalledWith("pipeline-under-test", false);
  });

  test("a module already PASSED from an earlier run is not rebuilt", async () => {
    pipelineState = makeState([{ moduleId: "m1" }, { moduleId: "m2", dependsOn: ["m1"] }]);
    pipelineState.board.modules[0].status = "PASSED";

    await runExecutionBackground("pipeline-under-test");

    expect(builtModuleIds()).toEqual(["m2"]);
  });
});

describe("settlement", () => {
  test("a successful fleet hands off to the build phase", async () => {
    pipelineState = makeState([{ moduleId: "m1" }]);

    await runExecutionBackground("pipeline-under-test");

    expect(statusOf("m1")).toBe("PASSED");
    expect(pipelineState.phase).toBe("BUILD_RUNNING");
    expect(scaffoldMissingInfrastructure).toHaveBeenCalledWith(workspace, "NoteFlow Workspace");
    expect(runBuildBackground).toHaveBeenCalledWith("pipeline-under-test", false);
  });

  test("a partial failure still proceeds to build with the passing modules", async () => {
    spawnClaudeAgent.mockImplementation(async (opts: any) => {
      if (opts.prompt.includes("(m2)")) throw new Error("claude exited 1");
      return "built";
    });
    pipelineState = makeState([{ moduleId: "m1" }, { moduleId: "m2", maxAttempts: 1 }]);

    await runExecutionBackground("pipeline-under-test");

    expect(statusOf("m1")).toBe("PASSED");
    expect(statusOf("m2")).toBe("FAILED");
    expect(pipelineState.phase).toBe("BUILD_RUNNING");
  });

  test("a builder failure is retried up to the module's maxAttempts", async () => {
    let attempts = 0;
    spawnClaudeAgent.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error("claude exited 1: transient");
      return "built";
    });
    pipelineState = makeState([{ moduleId: "m1", maxAttempts: 3 }]);

    await runExecutionBackground("pipeline-under-test");

    expect(attempts).toBe(3);
    expect(statusOf("m1")).toBe("PASSED");
  });

  test("the recorded failure of a FAILED module is fed back as the next critique", async () => {
    spawnClaudeAgent.mockRejectedValue(new Error("claude exited 1: TS2307 cannot find module"));
    pipelineState = makeState([{ moduleId: "m1", maxAttempts: 2 }]);

    await runExecutionBackground("pipeline-under-test");

    const second = builderCalls()[1];
    expect(second.prompt).toContain("A code review found these issues in the previous attempt");
    expect(second.prompt).toContain("TS2307");
  });

  test("an aborted pipeline stops dispatching", async () => {
    pipelineState = makeState([{ moduleId: "m1" }, { moduleId: "m2" }]);
    pipelineState.phase = "ABORTED";

    await runExecutionBackground("pipeline-under-test");

    expect(spawnClaudeAgent).not.toHaveBeenCalled();
    expect(runBuildBackground).not.toHaveBeenCalled();
  });
});
