import { test, describe, expect, beforeAll, afterAll } from "vitest";
import { checkBinaries, checkAndInstallBinaries, PiHarnessSession } from "../src/harness.js";

describe("Pi Harness (no mock shims)", () => {
  beforeAll(() => {
    process.env.DLO_TEST_SKIP_INSTALL = "true";
  });

  afterAll(() => {
    delete process.env.DLO_TEST_SKIP_INSTALL;
  });

  test("checkBinaries reports real PATH state and never fabricates executables", async () => {
    const statuses = await checkBinaries();
    expect(statuses.map((s) => s.name).sort()).toEqual(["claude", "codewhale", "ocr"]);
    for (const s of statuses) {
      expect(typeof s.available).toBe("boolean");
      expect(s.detail).toContain(s.name);
    }
  });

  test("checkAndInstallBinaries with skip-install returns status without side effects", async () => {
    const statuses = await checkAndInstallBinaries();
    expect(statuses).toHaveLength(3);
  });

  test("session lifecycle: fork, steer, checkpoint semantics", async () => {
    const harness = new PiHarnessSession();
    const ref = await harness.forkContext(null, []);
    expect(String(ref)).toMatch(/session-/);
    await harness.steerSession(ref, "focus on the data layer");
    await harness.compact(ref);
    await expect(harness.steerSession("bogus" as any, "x")).rejects.toThrow(/Unknown session/);
    await expect(harness.rewindTo(ref, "nonexistent")).rejects.toThrow(/Unknown checkpoint/);
  });
});
