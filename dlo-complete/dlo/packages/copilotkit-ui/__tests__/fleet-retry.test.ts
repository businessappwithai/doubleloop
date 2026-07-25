/**
 * __tests__/fleet-retry.test.ts
 * What the build fleet remembers between full-fleet retries.
 *
 * From a real run: module 1 got one step further on each of its three attempts
 * (unpublished dependency version → production-build error → typecheck error),
 * then the fleet reset discarded the recorded failure and the next fleet attempt
 * started from zero knowledge and reproduced the same sequence.
 */

import { describe, test, expect } from "vitest";
import { resetBoardForFleetRetry } from "../src/lib/orchestrator/phases/build";

type Entry = { moduleId: string; status: string; attempts: number; failure?: string };

describe("resetBoardForFleetRetry", () => {
  test("requeues a FAILED module and keeps its failure as the next critique", () => {
    const modules: Entry[] = [
      { moduleId: "m1", status: "FAILED", attempts: 3, failure: "tsc: src/router.tsx(4,10) TS2307" },
    ];

    resetBoardForFleetRetry(modules);

    expect(modules[0]).toEqual({
      moduleId: "m1",
      status: "PENDING",
      attempts: 0,
      failure: "tsc: src/router.tsx(4,10) TS2307",
    });
  });

  test("requeues a BLOCKED module but drops its dependency note", () => {
    // "Dependency failed: m1" describes another module, so feeding it back as a
    // code critique would send the builder chasing a problem it does not own.
    const modules: Entry[] = [
      { moduleId: "m5", status: "BLOCKED", attempts: 0, failure: "Dependency failed: m1" },
    ];

    resetBoardForFleetRetry(modules);

    expect(modules[0]!.status).toBe("PENDING");
    expect(modules[0]!.attempts).toBe(0);
    expect(modules[0]).not.toHaveProperty("failure");
  });

  test("leaves PASSED modules completely untouched so work is not redone", () => {
    const modules: Entry[] = [{ moduleId: "m2", status: "PASSED", attempts: 1 }];

    resetBoardForFleetRetry(modules);

    expect(modules[0]).toEqual({ moduleId: "m2", status: "PASSED", attempts: 1 });
  });

  test("leaves an EXECUTING module alone", () => {
    const modules: Entry[] = [{ moduleId: "m3", status: "EXECUTING", attempts: 0 }];
    resetBoardForFleetRetry(modules);
    expect(modules[0]!.status).toBe("EXECUTING");
  });

  test("leaves a PENDING module alone", () => {
    const modules: Entry[] = [{ moduleId: "m4", status: "PENDING", attempts: 0 }];
    resetBoardForFleetRetry(modules);
    expect(modules[0]!.status).toBe("PENDING");
  });

  test("handles a FAILED module that recorded no failure text", () => {
    const modules: Entry[] = [{ moduleId: "m6", status: "FAILED", attempts: 3 }];
    resetBoardForFleetRetry(modules);
    expect(modules[0]).toEqual({ moduleId: "m6", status: "PENDING", attempts: 0 });
  });

  test("handles an empty board", () => {
    const modules: Entry[] = [];
    expect(() => resetBoardForFleetRetry(modules)).not.toThrow();
    expect(modules).toEqual([]);
  });

  test("applies the right rule to each module of a mixed board", () => {
    const modules: Entry[] = [
      { moduleId: "m1", status: "FAILED", attempts: 3, failure: "real code problem" },
      { moduleId: "m2", status: "PASSED", attempts: 1 },
      { moduleId: "m3", status: "BLOCKED", attempts: 0, failure: "Dependency failed: m1" },
      { moduleId: "m4", status: "PENDING", attempts: 0 },
    ];

    resetBoardForFleetRetry(modules);

    expect(modules.map((m) => m.status)).toEqual(["PENDING", "PASSED", "PENDING", "PENDING"]);
    expect(modules[0]!.failure).toBe("real code problem");
    expect(modules[2]).not.toHaveProperty("failure");
  });

  test("is idempotent — a second reset changes nothing further", () => {
    const modules: Entry[] = [
      { moduleId: "m1", status: "FAILED", attempts: 3, failure: "keep me" },
      { moduleId: "m3", status: "BLOCKED", attempts: 0, failure: "Dependency failed: m1" },
    ];

    resetBoardForFleetRetry(modules);
    const afterFirst = JSON.parse(JSON.stringify(modules));
    resetBoardForFleetRetry(modules);

    expect(modules).toEqual(afterFirst);
  });
});
