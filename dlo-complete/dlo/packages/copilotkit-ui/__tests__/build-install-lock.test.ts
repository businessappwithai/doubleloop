/**
 * __tests__/build-install-lock.test.ts
 * The build fleet runs modules in parallel inside ONE workspace directory, so
 * their `npm install` calls must not overlap — concurrent installs corrupt
 * node_modules and the module that happens to lose the race gets blamed.
 */

import { describe, test, expect } from "vitest";
import { withInstallLock } from "../src/lib/orchestrator/npm";

/** Resolves after `ms`, recording when it entered and left the critical section. */
function tracked(log: string[], label: string, ms: number) {
  return async () => {
    log.push(`enter:${label}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`exit:${label}`);
    return label;
  };
}

describe("withInstallLock", () => {
  test("runs a single task and returns its value", async () => {
    await expect(withInstallLock("/ws/solo", async () => 42)).resolves.toBe(42);
  });

  test("never interleaves two tasks holding the same key", async () => {
    const log: string[] = [];
    await Promise.all([
      withInstallLock("/ws/a", tracked(log, "one", 30)),
      withInstallLock("/ws/a", tracked(log, "two", 5)),
      withInstallLock("/ws/a", tracked(log, "three", 1)),
    ]);
    expect(log).toEqual([
      "enter:one", "exit:one",
      "enter:two", "exit:two",
      "enter:three", "exit:three",
    ]);
  });

  test("preserves each caller's own return value under contention", async () => {
    const results = await Promise.all([
      withInstallLock("/ws/b", async () => "first"),
      withInstallLock("/ws/b", async () => "second"),
    ]);
    expect(results).toEqual(["first", "second"]);
  });

  test("lets tasks on different keys overlap", async () => {
    const log: string[] = [];
    await Promise.all([
      withInstallLock("/ws/c", tracked(log, "c", 30)),
      withInstallLock("/ws/d", tracked(log, "d", 5)),
    ]);
    // d starts before c finishes — separate workspaces install concurrently.
    expect(log).toEqual(["enter:c", "enter:d", "exit:d", "exit:c"]);
  });

  test("a rejecting task rejects only its own caller", async () => {
    const boom = withInstallLock("/ws/e", async () => {
      throw new Error("npm install failed");
    });
    await expect(boom).rejects.toThrow("npm install failed");
  });

  test("a rejecting task does not poison the queue behind it", async () => {
    const log: string[] = [];
    const failing = withInstallLock("/ws/f", async () => {
      log.push("enter:bad");
      throw new Error("EEXIST");
    });
    const following = withInstallLock("/ws/f", tracked(log, "good", 1));

    await expect(failing).rejects.toThrow("EEXIST");
    await expect(following).resolves.toBe("good");
    expect(log).toEqual(["enter:bad", "enter:good", "exit:good"]);
  });

  test("a synchronously throwing task still releases the lock", async () => {
    const bad = withInstallLock("/ws/g", () => {
      throw new Error("sync boom");
    });
    await expect(bad).rejects.toThrow("sync boom");
    await expect(withInstallLock("/ws/g", async () => "after")).resolves.toBe("after");
  });

  test("serialises a burst the size of a real fleet dispatch", async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withInstallLock("/ws/h", async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
        })
      )
    );
    expect(peak).toBe(1);
  });
});
