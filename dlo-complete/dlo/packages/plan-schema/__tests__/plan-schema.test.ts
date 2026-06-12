import { test, describe, expect } from "vitest";
import { EngineeringPlanSchema } from "../src/engineering-plan.js";

describe("Plan Schema Validation", () => {
  test("accepts a valid plan", () => {
    const plan = {
      planVersion: 1,
      generatedBy: "test-model",
      modules: [
        {
          moduleId: "module-a",
          title: "Module A",
          stackTarget: "rust-axum",
          prompt: "Implement a basic HTTP route handler that returns 200 OK",
          dependsOn: [],
          estimatedComplexity: "trivial",
          maxAttempts: 3,
          exitClauses: [
            {
              kind: "command",
              clauseId: "cargo-check",
              description: "Cargo check passes",
              argv: ["cargo", "check"],
              cwd: "workspace",
              expect: { exitCode: 0 },
              timeoutMs: 10000,
            },
          ],
          touches: ["src/**/*.rs"],
        },
        {
          moduleId: "module-b",
          title: "Module B",
          stackTarget: "tanstack-start",
          prompt: "Implement a dashboard page calling module-a endpoints",
          dependsOn: ["module-a"],
          estimatedComplexity: "standard",
          maxAttempts: 4,
          exitClauses: [
            {
              kind: "fileAssertion",
              clauseId: "dashboard-exists",
              description: "Dashboard component is present",
              glob: "src/routes/dashboard.tsx",
              mustExist: true,
            },
          ],
          touches: ["src/routes/dashboard.tsx"],
        },
      ],
    };

    const parsed = EngineeringPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });

  test("rejects duplicate module IDs", () => {
    const plan = {
      planVersion: 1,
      generatedBy: "test-model",
      modules: [
        {
          moduleId: "module-a",
          title: "Module A",
          stackTarget: "rust-axum",
          prompt: "Implement a basic HTTP route handler that returns 200 OK",
          dependsOn: [],
          estimatedComplexity: "trivial",
          maxAttempts: 3,
          exitClauses: [
            {
              kind: "fileAssertion",
              clauseId: "a-exists",
              description: "A exists",
              glob: "a.rs",
              mustExist: true,
            },
          ],
          touches: ["a.rs"],
        },
        {
          moduleId: "module-a", // duplicate
          title: "Module A duplicate",
          stackTarget: "rust-axum",
          prompt: "Implement a basic HTTP route handler that returns 200 OK",
          dependsOn: [],
          estimatedComplexity: "trivial",
          maxAttempts: 3,
          exitClauses: [
            {
              kind: "fileAssertion",
              clauseId: "a-exists-2",
              description: "A exists",
              glob: "a.rs",
              mustExist: true,
            },
          ],
          touches: ["a.rs"],
        },
      ],
    };

    const parsed = EngineeringPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.errors[0]?.message).toContain("Duplicate moduleId found");
    }
  });

  test("rejects cyclic dependencies and reports full path", () => {
    const plan = {
      planVersion: 1,
      generatedBy: "test-model",
      modules: [
        {
          moduleId: "module-a",
          title: "Module A",
          stackTarget: "rust-axum",
          prompt: "Implement module A with full specifications, interfaces, and comprehensive test suites.",
          dependsOn: ["module-b"], // depends on B
          estimatedComplexity: "trivial",
          maxAttempts: 3,
          exitClauses: [
            {
              kind: "fileAssertion",
              clauseId: "a-exists",
              description: "A exists",
              glob: "a.rs",
              mustExist: true,
            },
          ],
          touches: ["a.rs"],
        },
        {
          moduleId: "module-b",
          title: "Module B",
          stackTarget: "rust-axum",
          prompt: "Implement module B with full specifications, interfaces, and comprehensive test suites.",
          dependsOn: ["module-c"], // depends on C
          estimatedComplexity: "trivial",
          maxAttempts: 3,
          exitClauses: [
            {
              kind: "fileAssertion",
              clauseId: "b-exists",
              description: "B exists",
              glob: "b.rs",
              mustExist: true,
            },
          ],
          touches: ["b.rs"],
        },
        {
          moduleId: "module-c",
          title: "Module C",
          stackTarget: "rust-axum",
          prompt: "Implement module C with full specifications, interfaces, and comprehensive test suites.",
          dependsOn: ["module-a"], // depends on A (creates cycle: A -> B -> C -> A)
          estimatedComplexity: "trivial",
          maxAttempts: 3,
          exitClauses: [
            {
              kind: "fileAssertion",
              clauseId: "c-exists",
              description: "C exists",
              glob: "c.rs",
              mustExist: true,
            },
          ],
          touches: ["c.rs"],
        },
      ],
    };

    const parsed = EngineeringPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.errors[0]?.message).toContain("Cyclic dependencies detected");
      expect(parsed.error.errors[0]?.message).toContain("module-a -> module-b -> module-c -> module-a");
    }
  });
});
