import { test, describe, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { checkAndInstallBinaries, PiHarnessSession } from "../src/harness.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const tmpDir = join(__dirname, "../.test-tmp");

describe("Pi Harness Binary Checker and Installer", () => {
  beforeAll(async () => {
    process.env.DLO_TEST_SKIP_INSTALL = "true";
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterAll(async () => {
    delete process.env.DLO_TEST_SKIP_INSTALL;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creates shims in workspace when binaries are not present", async () => {
    // We pass the temp directory as the workspaceDir.
    // Since 'claude' and 'codewhale' are probably not in the test environment PATH
    // (or we can temporarily mock PATH to ensure they are not found),
    // it should fall back to creating the local shims in targetDir/.dlo/bin.
    
    // Backup PATH and remove global paths just in case to force fallback, keeping node executable directory
    const originalPath = process.env.PATH;
    const { dirname } = await import("node:path");
    process.env.PATH = dirname(process.execPath);

    try {
      await checkAndInstallBinaries(tmpDir);

      const localBinDir = join(tmpDir, ".dlo/bin");
      const claudeShim = join(localBinDir, "claude");
      const codeWhaleShim = join(localBinDir, "codewhale");

      expect(existsSync(claudeShim)).toBe(true);
      expect(existsSync(codeWhaleShim)).toBe(true);

      // Verify that they are executable node scripts and work
      const claudeRes = await execAsync(`node ${claudeShim}`);
      const parsedClaude = JSON.parse(claudeRes.stdout.trim());
      expect(parsedClaude).toEqual({ kind: "PASS", critique: "" });

      const codewhaleRes = await execAsync(`node ${codeWhaleShim}`);
      expect(codewhaleRes.stdout.trim()).toContain("Mock CodeWhale Swarm CLI");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("PiHarnessSession.forkContext automatically checks/installs binaries", async () => {
    const session = new PiHarnessSession();
    // Setting CWD to tmpDir or just executing it
    const sessionRef = await session.forkContext(null, []);
    expect(sessionRef).toBeDefined();
    expect(sessionRef.startsWith("pi-session-")).toBe(true);
  });
});
