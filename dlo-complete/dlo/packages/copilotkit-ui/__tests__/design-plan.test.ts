/**
 * __tests__/design-plan.test.ts
 * Phase II plan handling: extracting the machine-readable implementation plan
 * out of a free-form markdown document, validating its DAG, and auditing the
 * test coverage the plan promises.
 */

import { describe, test, expect } from "vitest";
import {
  parseImplementationPlan,
  validatePlanDag,
  validatePlanTestCoverage,
} from "../src/lib/orchestrator/phases/design";

/** The smallest plan that is structurally valid. */
const onePlanModule = {
  planVersion: 1,
  modules: [{ moduleId: "m1", title: "Scaffold", prompt: "…", dependsOn: [] }],
};

function fence(tag: string, body: unknown): string {
  return "```json" + (tag ? ` ${tag}` : "") + "\n" + JSON.stringify(body, null, 2) + "\n```";
}

describe("parseImplementationPlan", () => {
  test("extracts the block tagged implementation-plan", () => {
    const md = `# Implementation Plan\n\n## Machine-Readable Plan\n\n${fence("implementation-plan", onePlanModule)}\n`;
    expect(parseImplementationPlan(md)).toEqual(onePlanModule);
  });

  test("extracts an untagged json block that carries a modules array", () => {
    const md = `# Implementation Plan\n\n${fence("", onePlanModule)}\n`;
    expect(parseImplementationPlan(md)).toEqual(onePlanModule);
  });

  test("prefers the tagged block over an earlier decoy json block", () => {
    // The regression this guards: Implementation.md routinely opens with an
    // example package.json, and taking the first json fence picked THAT up.
    const decoy = { name: "generated-app", scripts: { test: "vitest run" } };
    const md = [
      "# Implementation Plan",
      "The scaffold module writes this package.json:",
      fence("", decoy),
      "## Machine-Readable Plan",
      fence("implementation-plan", onePlanModule),
    ].join("\n\n");
    expect(parseImplementationPlan(md)).toEqual(onePlanModule);
  });

  test("skips an untagged decoy block and finds the one with modules", () => {
    const decoy = { name: "generated-app", dependencies: { react: "^19.0.0" } };
    const md = [fence("", decoy), fence("", onePlanModule)].join("\n\n");
    expect(parseImplementationPlan(md)).toEqual(onePlanModule);
  });

  test("skips an unparseable earlier block rather than failing on it", () => {
    const md = ["```json\n{ this is not json }\n```", fence("implementation-plan", onePlanModule)].join("\n\n");
    expect(parseImplementationPlan(md)).toEqual(onePlanModule);
  });

  test("throws when the tagged block is invalid JSON", () => {
    const md = "```json implementation-plan\n{ \"modules\": [ }\n```";
    expect(() => parseImplementationPlan(md)).toThrow(/invalid JSON/i);
  });

  test("throws when every json block is invalid JSON", () => {
    const md = ["```json\n{ nope }\n```", "```json\n{ also nope }\n```"].join("\n\n");
    expect(() => parseImplementationPlan(md)).toThrow(/invalid JSON/i);
  });

  test("throws when the document has no json block at all", () => {
    expect(() => parseImplementationPlan("# Implementation Plan\n\nProse only.")).toThrow(
      /missing the ```json implementation-plan block/
    );
  });

  test("throws when json blocks parse but none contains modules", () => {
    const md = [fence("", { name: "a" }), fence("", { name: "b" })].join("\n\n");
    expect(() => parseImplementationPlan(md)).toThrow(/missing the ```json implementation-plan block/);
  });

  test("throws on an empty document", () => {
    expect(() => parseImplementationPlan("")).toThrow(/missing/i);
  });
});

describe("validatePlanDag", () => {
  const cases: Array<{ name: string; plan: unknown; expected: RegExp[] }> = [
    {
      name: "accepts a linear DAG",
      plan: { modules: [{ moduleId: "a", dependsOn: [] }, { moduleId: "b", dependsOn: ["a"] }] },
      expected: [],
    },
    {
      name: "accepts a diamond DAG",
      plan: {
        modules: [
          { moduleId: "a", dependsOn: [] },
          { moduleId: "b", dependsOn: ["a"] },
          { moduleId: "c", dependsOn: ["a"] },
          { moduleId: "d", dependsOn: ["b", "c"] },
        ],
      },
      expected: [],
    },
    {
      name: "rejects an empty module list",
      plan: { modules: [] },
      expected: [/no modules/i],
    },
    {
      name: "rejects a missing modules key",
      plan: {},
      expected: [/no modules/i],
    },
    {
      name: "rejects a module without a moduleId",
      plan: { modules: [{ title: "nameless" }] },
      expected: [/missing moduleId/i],
    },
    {
      // The duplicate collapses to one node, so Kahn also cannot visit every
      // module — both errors are reported, and both are true.
      name: "rejects duplicate moduleIds",
      plan: { modules: [{ moduleId: "a" }, { moduleId: "a" }] },
      expected: [/Duplicate moduleId: a/, /cycle/],
    },
    {
      // A dependency on a module that does not exist leaves the dependent with
      // an in-degree that never drops, so it is also unschedulable.
      name: "rejects a dependency on an unknown module",
      plan: { modules: [{ moduleId: "a", dependsOn: ["ghost"] }] },
      expected: [/depends on unknown module ghost/, /cycle/],
    },
    {
      name: "rejects a two-node cycle",
      plan: { modules: [{ moduleId: "a", dependsOn: ["b"] }, { moduleId: "b", dependsOn: ["a"] }] },
      expected: [/cycle/],
    },
    {
      name: "rejects a self-dependency",
      plan: { modules: [{ moduleId: "a", dependsOn: ["a"] }] },
      expected: [/cycle/],
    },
  ];

  for (const { name, plan, expected } of cases) {
    test(name, () => {
      const errors = validatePlanDag(plan);
      expect(errors).toHaveLength(expected.length);
      expected.forEach((re, i) => expect(errors[i]).toMatch(re));
    });
  }
});

describe("validatePlanTestCoverage", () => {
  const scaffold = {
    moduleId: "m1",
    title: "Project scaffold",
    prompt: "Create the project",
    touches: ["package.json", "tsconfig.json"],
  };
  const harness = {
    moduleId: "m2",
    title: "Test harness setup",
    prompt: "Install vitest and configure it",
    touches: ["vitest.config.ts", "vitest.setup.ts"],
  };
  const tested = {
    moduleId: "m3",
    title: "Concept service",
    prompt: "Build the concept service and its tests",
    touches: ["src/services/concept.ts", "tests/concept.test.ts"],
    exitClauses: [{ clauseId: "c1", description: "tests", kind: "command", argv: ["npx", "vitest", "run", "tests/concept.test.ts"] }],
  };

  test("returns no warnings when every behavior module ships tests and runs them", () => {
    expect(validatePlanTestCoverage({ modules: [scaffold, harness, tested] })).toEqual([]);
  });

  test("exempts the scaffold module, which owns package.json", () => {
    expect(validatePlanTestCoverage({ modules: [scaffold] })).toEqual([]);
  });

  test("exempts a test-harness module by its title", () => {
    expect(validatePlanTestCoverage({ modules: [harness] })).toEqual([]);
  });

  test("warns when a behavior module lists no test files", () => {
    const naked = { moduleId: "m4", title: "Editor", prompt: "Build it", touches: ["src/editor.tsx"] };
    const warnings = validatePlanTestCoverage({ modules: [naked] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/m4.*no test files in touches/);
  });

  test("warns when a module has test files but no exit clause running them", () => {
    const noClause = { ...tested, moduleId: "m5", exitClauses: [{ clauseId: "c1", description: "typecheck", kind: "command", argv: ["npx", "tsc", "--noEmit"] }] };
    const warnings = validatePlanTestCoverage({ modules: [noClause] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/m5.*no exit clause that runs them/);
  });

  test("warns when a module has test files and no exit clauses at all", () => {
    const noClauses = { moduleId: "m6", title: "Repo", prompt: "x", touches: ["src/a.ts", "src/a.test.ts"] };
    expect(validatePlanTestCoverage({ modules: [noClauses] })).toHaveLength(1);
  });

  test.each([
    ["tests/foo.test.ts", true],
    ["src/__tests__/foo.ts", true],
    ["src/foo.spec.tsx", true],
    ["test/foo.ts", true],
    ["src/foo.ts", false],
    ["src/latest/thing.ts", false],
    ["src/contest.ts", false],
  ])("recognises %s as a test path: %s", (path, isTest) => {
    const mod = { moduleId: "mx", title: "M", prompt: "x", touches: ["src/main.ts", path] };
    const warnings = validatePlanTestCoverage({ modules: [mod] });
    const missingTests = warnings.some((w) => /no test files in touches/.test(w));
    expect(missingTests).toBe(!isTest);
  });

  test("returns no warnings for an empty plan", () => {
    expect(validatePlanTestCoverage({ modules: [] })).toEqual([]);
    expect(validatePlanTestCoverage({})).toEqual([]);
  });

  test("reports one warning per offending module", () => {
    const a = { moduleId: "a", title: "A", prompt: "x", touches: ["src/a.ts"] };
    const b = { moduleId: "b", title: "B", prompt: "x", touches: ["src/b.ts"] };
    expect(validatePlanTestCoverage({ modules: [scaffold, a, b] })).toHaveLength(2);
  });
});
