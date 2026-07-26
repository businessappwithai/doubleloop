/**
 * __tests__/gate-decisions.test.ts
 * resolveGateDecision — the only place a gate advances the pipeline.
 *
 * The validation tests exist because an unrecognised decision used to fall
 * through every branch and return `accepted: true` while nothing happened: the
 * console reported success and the pipeline sat on the gate. On the permission
 * gates the same typo was worse than a no-op — anything that was not "APPROVE"
 * counted as a rejection, so a malformed request silently skipped a
 * build/test/deploy step or failed the pipeline.
 *
 * Every phase module is faked: resolving a gate must never spawn a subagent.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const savePipeline = vi.fn(async () => {});
const findPipelineByGateId = vi.fn();

vi.mock("../src/lib/orchestrator/state", () => ({
  savePipeline: (...args: unknown[]) => savePipeline(...(args as [])),
  getPipeline: vi.fn(),
  saveDesignDoc: vi.fn(),
  findPipelineByGateId: (...args: unknown[]) => findPipelineByGateId(...(args as [])),
  pushPhaseHistory: (state: any, phase: string) => {
    state.phaseHistory = [...(state.phaseHistory ?? []), { phase, timestamp: "now" }];
  },
}));

const runResearchBackground = vi.fn(async () => {});
const runDesignBackground = vi.fn(async () => {});
const runExecutionBackground = vi.fn(async () => {});
const runBuildBackground = vi.fn(async () => {});
const runDbProvisioningBackground = vi.fn(async () => {});
const runTestingBackground = vi.fn(async () => {});
const runDeployBackground = vi.fn(async () => {});
const runAppLaunchBackground = vi.fn(async () => {});
const runToolInstallScript = vi.fn(async () => ({ success: true, log: "" }));

vi.mock("../src/lib/orchestrator/phases/research", () => ({
  runResearchBackground: (...a: unknown[]) => runResearchBackground(...(a as [])),
}));
vi.mock("../src/lib/orchestrator/phases/design", () => ({
  runDesignBackground: (...a: unknown[]) => runDesignBackground(...(a as [])),
  parseImplementationPlan: vi.fn(),
  validatePlanDag: vi.fn(() => []),
  validatePlanTestCoverage: vi.fn(() => []),
}));
vi.mock("../src/lib/orchestrator/phases/review", () => ({
  runCeoReviewBackground: vi.fn(),
  reviewDocument: vi.fn(),
  parseSuggestions: vi.fn(),
}));
vi.mock("../src/lib/orchestrator/phases/build", () => ({
  runExecutionBackground: (...a: unknown[]) => runExecutionBackground(...(a as [])),
}));
vi.mock("../src/lib/orchestrator/phases/finalize", () => ({
  runBuildBackground: (...a: unknown[]) => runBuildBackground(...(a as [])),
  runDbProvisioningBackground: (...a: unknown[]) => runDbProvisioningBackground(...(a as [])),
  runTestingBackground: (...a: unknown[]) => runTestingBackground(...(a as [])),
  runDeployBackground: (...a: unknown[]) => runDeployBackground(...(a as [])),
  runAppLaunchBackground: (...a: unknown[]) => runAppLaunchBackground(...(a as [])),
  runToolInstallScript: (...a: unknown[]) => runToolInstallScript(...(a as [])),
  runTestAuthorSubagent: vi.fn(),
  assessTestOutcome: vi.fn(),
  scaffoldMissingInfrastructure: vi.fn(),
  detectDatabaseNeeded: vi.fn(),
  detectTestCommand: vi.fn(),
  detectLaunchCommand: vi.fn(),
  detectBuildCommand: vi.fn(),
}));

const { resolveGateDecision } = await import("../src/lib/orchestrator/index");

interface FakeStateOptions {
  kind: string;
  phase?: string;
}

function fakeState({ kind, phase = "GATE2_PENDING" }: FakeStateOptions) {
  return {
    pipelineId: "p1",
    projectName: "NoteFlow",
    objectivesMarkdown: "objectives",
    phase,
    createdAt: "2026-07-25T10:00:00.000Z",
    lastTransitionAt: "2026-07-25T10:00:00.000Z",
    phaseHistory: [],
    activeGate: { gateId: "g1", kind, exhibits: [] },
    config: {},
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("gate lookup", () => {
  test("an unknown gate id is a 404", async () => {
    findPipelineByGateId.mockResolvedValue(null);
    expect(await resolveGateDecision({ gateId: "nope", decision: "APPROVE" })).toEqual({
      accepted: false,
      error: "Gate not found",
      status: 404,
    });
  });

  test("an unknown gate kind is a 400", async () => {
    findPipelineByGateId.mockResolvedValue(fakeState({ kind: "SOMETHING_ELSE" }));
    const result = await resolveGateDecision({ gateId: "g1", decision: "APPROVE" });
    expect(result.accepted).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Unknown gate kind");
  });
});

describe("decision validation", () => {
  test.each([
    ["DOMAIN_DOCUMENT", "MAYBE_LATER"],
    ["DESIGN_REVIEW", "maybe"],
    ["DESIGN_REVIEW", ""],
    ["TRIPARTITE_PLAN", "APPROVED"],
    ["TERMINAL_PERMISSION", "SKIP"],
    ["TOOL_INSTALL_PERMISSION", "USE_GEMINI"],
  ])("%s rejects the decision %j with a 400", async (kind, decision) => {
    const state = fakeState({ kind });
    findPipelineByGateId.mockResolvedValue(state);

    const result = await resolveGateDecision({ gateId: "g1", decision });

    expect(result.accepted).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain(`Unknown decision "${decision}"`);
  });

  test("an invalid decision changes nothing at all", async () => {
    // The permission gates used to clear activeGate before deciding, so a typo
    // dropped the gate AND skipped the step it was guarding.
    const state = fakeState({ kind: "TERMINAL_PERMISSION", phase: "TESTING_RUNNING" });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "SKIP" });

    expect(state.activeGate).not.toBeNull();
    expect(state.phase).toBe("TESTING_RUNNING");
    expect(savePipeline).not.toHaveBeenCalled();
    expect(runTestingBackground).not.toHaveBeenCalled();
    expect(runDeployBackground).not.toHaveBeenCalled();
  });

  test("decisions are case-sensitive", async () => {
    findPipelineByGateId.mockResolvedValue(fakeState({ kind: "DESIGN_REVIEW" }));
    const result = await resolveGateDecision({ gateId: "g1", decision: "approve" });
    expect(result.accepted).toBe(false);
    expect(runExecutionBackground).not.toHaveBeenCalled();
  });
});

describe("DOMAIN_DOCUMENT (Gate 1)", () => {
  test("APPROVE moves to DESIGN_RUNNING and starts the Design Analyst", async () => {
    const state = fakeState({ kind: "DOMAIN_DOCUMENT", phase: "GATE1_PENDING" });
    findPipelineByGateId.mockResolvedValue(state);

    expect(await resolveGateDecision({ gateId: "g1", decision: "APPROVE" })).toEqual({ accepted: true });
    expect(state.phase).toBe("DESIGN_RUNNING");
    expect(state.activeGate).toBeNull();
    expect(runDesignBackground).toHaveBeenCalledWith("p1");
  });

  test("STEER re-runs research and records the extra input", async () => {
    const state = fakeState({ kind: "DOMAIN_DOCUMENT", phase: "GATE1_PENDING" });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "STEER", instructions: "cover offline mode" });

    expect(state.phase).toBe("RESEARCH_RUNNING");
    expect(state.contextNotes[0].note).toContain("cover offline mode");
    expect(state.objectivesMarkdown).toContain("cover offline mode");
    expect(runResearchBackground).toHaveBeenCalledWith("p1");
  });

  test("REJECT fails the pipeline without starting anything", async () => {
    const state = fakeState({ kind: "DOMAIN_DOCUMENT", phase: "GATE1_PENDING" });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "REJECT" });

    expect(state.phase).toBe("FAILED");
    expect(runDesignBackground).not.toHaveBeenCalled();
    expect(runResearchBackground).not.toHaveBeenCalled();
  });
});

describe("DESIGN_REVIEW (Gate 2)", () => {
  test("APPROVE marks every generated document approved and starts the fleet", async () => {
    const state = fakeState({ kind: "DESIGN_REVIEW" });
    state.designDocs = {
      architecture: { markdown: "# A", version: 1 },
      database: { markdown: "# D", version: 1 },
      implementation: { version: 1 },
    };
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "APPROVE" });

    expect(state.designDocs.architecture.approvedAt).toBeTruthy();
    expect(state.designDocs.database.approvedAt).toBeTruthy();
    expect(state.phase).toBe("EXECUTION_RUNNING");
    expect(runExecutionBackground).toHaveBeenCalledWith("p1");
  });

  test("STEER regenerates the design with the instructions recorded", async () => {
    const state = fakeState({ kind: "DESIGN_REVIEW" });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "STEER", instructions: "split the block editor" });

    expect(state.phase).toBe("DESIGN_RUNNING");
    expect(state.contextNotes[0].note).toContain("split the block editor");
    expect(runDesignBackground).toHaveBeenCalledWith("p1");
  });

  test("REJECT fails the pipeline", async () => {
    const state = fakeState({ kind: "DESIGN_REVIEW" });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "REJECT" });

    expect(state.phase).toBe("FAILED");
    expect(runExecutionBackground).not.toHaveBeenCalled();
  });
});

describe("TERMINAL_PERMISSION", () => {
  test.each([
    ["BUILD_RUNNING", () => runBuildBackground],
    ["DB_PROVISIONING_RUNNING", () => runDbProvisioningBackground],
    ["TESTING_RUNNING", () => runTestingBackground],
    ["DEPLOY_RUNNING", () => runDeployBackground],
    ["APP_LAUNCH_RUNNING", () => runAppLaunchBackground],
  ] as const)("APPROVE in %s runs that step with permission", async (phase, runner) => {
    const state = fakeState({ kind: "TERMINAL_PERMISSION", phase });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "APPROVE" });

    expect(state.activeGate).toBeNull();
    expect(runner()).toHaveBeenCalledWith("p1", true);
  });

  test.each([
    ["BUILD_RUNNING", "DB_PROVISIONING_RUNNING", () => runDbProvisioningBackground],
    ["DB_PROVISIONING_RUNNING", "TESTING_RUNNING", () => runTestingBackground],
    ["TESTING_RUNNING", "DEPLOY_RUNNING", () => runDeployBackground],
  ] as const)("REJECT in %s skips ahead to %s", async (phase, nextPhase, runner) => {
    const state = fakeState({ kind: "TERMINAL_PERMISSION", phase });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "REJECT" });

    expect(state.phase).toBe(nextPhase);
    expect(runner()).toHaveBeenCalledWith("p1", false);
  });

  test("REJECT at the last step completes the pipeline", async () => {
    const state = fakeState({ kind: "TERMINAL_PERMISSION", phase: "APP_LAUNCH_RUNNING" });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "REJECT" });

    expect(state.phase).toBe("COMPLETED");
  });
});

describe("TOOL_INSTALL_PERMISSION", () => {
  test("USE_CLAUDE switches the executor to Claude Code and resumes execution", async () => {
    const state = fakeState({ kind: "TOOL_INSTALL_PERMISSION", phase: "EXECUTION_RUNNING" });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "USE_CLAUDE" });

    expect(state.config.providers.executor).toEqual({
      type: "claude",
      vendor: "claude-code",
      model: "claude-haiku-4-5-20251001",
    });
    expect(runExecutionBackground).toHaveBeenCalledWith("p1", true);
  });

  test("REJECT fails the pipeline", async () => {
    const state = fakeState({ kind: "TOOL_INSTALL_PERMISSION", phase: "EXECUTION_RUNNING" });
    findPipelineByGateId.mockResolvedValue(state);

    await resolveGateDecision({ gateId: "g1", decision: "REJECT" });

    expect(state.phase).toBe("FAILED");
    expect(runExecutionBackground).not.toHaveBeenCalled();
  });
});
