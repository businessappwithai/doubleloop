import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { ClauseEvaluatorRegistry } from "../src/registry.js";
import { ClauseRunner } from "../src/runner.js";
import { CommandClauseEvaluator } from "../src/evaluators/command.js";
import { FileAssertionClauseEvaluator } from "../src/evaluators/file.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = join(process.cwd(), "tmp-test-exit-clauses");

describe("Exit Clauses", () => {
  let registry: ClauseEvaluatorRegistry;
  let runner: ClauseRunner;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });

    registry = new ClauseEvaluatorRegistry();
    registry.register(new CommandClauseEvaluator());
    registry.register(new FileAssertionClauseEvaluator());
    runner = new ClauseRunner(registry);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("evaluates command exit clause successfully", async () => {
    const clauses: any[] = [
      {
        kind: "command",
        clauseId: "command-check",
        description: "Checks command works",
        argv: ["npm", "--version"],
        cwd: "workspace",
        expect: { exitCode: 0 },
        timeoutMs: 10000,
      },
    ];

    const results = await runner.runAll(clauses, { workspace: TEST_DIR });
    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
  });

  test("rejects forbidden commands not on allowlist", async () => {
    const clauses: any[] = [
      {
        kind: "command",
        clauseId: "forbidden-cmd",
        description: "Should fail allowlist check",
        argv: ["cat", "/etc/passwd"],
        cwd: "workspace",
        expect: { exitCode: 0 },
        timeoutMs: 10000,
      },
    ];

    const results = await runner.runAll(clauses, { workspace: TEST_DIR });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.observed).toContain("Forbidden command");
  });

  test("file assertion mustExist fails if file is missing", async () => {
    const clauses: any[] = [
      {
        kind: "fileAssertion",
        clauseId: "must-exist-fail",
        description: "Should fail as file does not exist",
        glob: "missing.txt",
        mustExist: true,
      },
    ];

    const results = await runner.runAll(clauses, { workspace: TEST_DIR });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.observed).toContain("no files matched glob");
  });

  test("file assertion passes if file exists and contents match rules", async () => {
    // Write test files
    await writeFile(join(TEST_DIR, "test.txt"), "hello world secrets here", "utf-8");

    const clauses: any[] = [
      {
        kind: "fileAssertion",
        clauseId: "file-rules-check",
        description: "Checks matches and forbids",
        glob: "test.txt",
        mustExist: true,
        contentMatches: "hello.*world",
        contentForbids: "forbidden-token",
      },
    ];

    const results = await runner.runAll(clauses, { workspace: TEST_DIR });
    expect(results[0]?.passed).toBe(true);
  });

  test("file assertion fails if forbidden content is present", async () => {
    await writeFile(join(TEST_DIR, "bad.txt"), "contains forbidden-token here", "utf-8");

    const clauses: any[] = [
      {
        kind: "fileAssertion",
        clauseId: "forbids-fail",
        description: "Should fail due to forbidden token",
        glob: "bad.txt",
        mustExist: true,
        contentForbids: "forbidden-token",
      },
    ];

    const results = await runner.runAll(clauses, { workspace: TEST_DIR });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.observed).toContain("Forbidden content detected");
  });
});
