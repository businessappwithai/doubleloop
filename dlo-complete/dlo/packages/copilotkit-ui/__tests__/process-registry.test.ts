/**
 * __tests__/process-registry.test.ts
 * The live-subprocess registry behind /stdin and /abort.
 *
 * Three behaviors are pinned down here because each one failed on a real run:
 *  - the store must be shared across Next route bundles (a per-bundle Map made
 *    /stdin answer {"running":false} for a subagent that was running);
 *  - a pipeline holds MANY children (maxConcurrent builders), so registering a
 *    second one must not evict the first;
 *  - abort must actually signal them.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";

const REGISTRY_KEY = Symbol.for("dlo.orchestrator.processRegistry");

type Registry = typeof import("../src/lib/orchestrator/processRegistry");

async function freshInstance(): Promise<Registry> {
  vi.resetModules();
  return import("../src/lib/orchestrator/processRegistry");
}

interface FakeChild {
  kill: ReturnType<typeof vi.fn>;
  stdin: { write: ReturnType<typeof vi.fn>; writable: boolean } | null;
}

function fakeChild(opts: { writable?: boolean; stdin?: boolean; killThrows?: boolean } = {}): FakeChild {
  const child: FakeChild = {
    kill: vi.fn(() => {
      if (opts.killThrows) throw new Error("ESRCH");
      return true;
    }),
    stdin:
      opts.stdin === false
        ? null
        : { write: vi.fn(), writable: opts.writable ?? true },
  };
  return child;
}

/** The registry only ever touches .kill and .stdin. */
const asChild = (c: FakeChild) => c as unknown as ChildProcess;

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
  vi.resetModules();
});

describe("registerProcess / hasProcess", () => {
  test("an unregistered pipeline has no process", async () => {
    const reg = await freshInstance();
    expect(reg.hasProcess("p1")).toBe(false);
    expect(reg.processCount("p1")).toBe(0);
  });

  test("a registered child is visible", async () => {
    const reg = await freshInstance();
    reg.registerProcess("p1", asChild(fakeChild()));
    expect(reg.hasProcess("p1")).toBe(true);
    expect(reg.processCount("p1")).toBe(1);
  });

  test("concurrent fleet builders all stay registered", async () => {
    // maxConcurrent defaults to 4: keying one child per pipeline used to let
    // each new builder evict the previous one from the registry.
    const reg = await freshInstance();
    for (let i = 0; i < 4; i++) reg.registerProcess("p1", asChild(fakeChild()));
    expect(reg.processCount("p1")).toBe(4);
  });

  test("registering the same child twice does not double-count it", async () => {
    const reg = await freshInstance();
    const child = asChild(fakeChild());
    reg.registerProcess("p1", child);
    reg.registerProcess("p1", child);
    expect(reg.processCount("p1")).toBe(1);
  });

  test("pipelines are isolated from each other", async () => {
    const reg = await freshInstance();
    reg.registerProcess("p1", asChild(fakeChild()));
    expect(reg.hasProcess("p2")).toBe(false);
  });
});

describe("unregisterProcess", () => {
  test("removes only the child that exited", async () => {
    const reg = await freshInstance();
    const first = asChild(fakeChild());
    const second = asChild(fakeChild());
    reg.registerProcess("p1", first);
    reg.registerProcess("p1", second);

    reg.unregisterProcess("p1", first);

    expect(reg.processCount("p1")).toBe(1);
    expect(reg.hasProcess("p1")).toBe(true);
  });

  test("the pipeline is gone once its last child exits", async () => {
    const reg = await freshInstance();
    const child = asChild(fakeChild());
    reg.registerProcess("p1", child);
    reg.unregisterProcess("p1", child);
    expect(reg.hasProcess("p1")).toBe(false);
  });

  test("omitting the child drops every child of the pipeline", async () => {
    const reg = await freshInstance();
    reg.registerProcess("p1", asChild(fakeChild()));
    reg.registerProcess("p1", asChild(fakeChild()));
    reg.unregisterProcess("p1");
    expect(reg.processCount("p1")).toBe(0);
  });

  test("unregistering an unknown pipeline is a no-op", async () => {
    const reg = await freshInstance();
    expect(() => reg.unregisterProcess("never-seen", asChild(fakeChild()))).not.toThrow();
  });

  test("unregistering a child that was never registered leaves the others", async () => {
    const reg = await freshInstance();
    reg.registerProcess("p1", asChild(fakeChild()));
    reg.unregisterProcess("p1", asChild(fakeChild()));
    expect(reg.processCount("p1")).toBe(1);
  });
});

describe("sendStdin", () => {
  test("writes the text with a trailing newline", async () => {
    const reg = await freshInstance();
    const child = fakeChild();
    reg.registerProcess("p1", asChild(child));

    expect(reg.sendStdin("p1", "yes")).toBe(true);
    expect(child.stdin!.write).toHaveBeenCalledWith("yes\n");
  });

  test("returns false when the pipeline has no process", async () => {
    const reg = await freshInstance();
    expect(reg.sendStdin("p1", "yes")).toBe(false);
  });

  test("goes to the most recently registered child", async () => {
    const reg = await freshInstance();
    const older = fakeChild();
    const newer = fakeChild();
    reg.registerProcess("p1", asChild(older));
    reg.registerProcess("p1", asChild(newer));

    reg.sendStdin("p1", "2");

    expect(newer.stdin!.write).toHaveBeenCalledWith("2\n");
    expect(older.stdin!.write).not.toHaveBeenCalled();
  });

  test("falls back to an older child when the newest stdin is closed", async () => {
    const reg = await freshInstance();
    const usable = fakeChild();
    const closed = fakeChild({ writable: false });
    reg.registerProcess("p1", asChild(usable));
    reg.registerProcess("p1", asChild(closed));

    expect(reg.sendStdin("p1", "input")).toBe(true);
    expect(usable.stdin!.write).toHaveBeenCalledWith("input\n");
  });

  test("returns false when a child has no stdin at all", async () => {
    const reg = await freshInstance();
    reg.registerProcess("p1", asChild(fakeChild({ stdin: false })));
    expect(reg.sendStdin("p1", "input")).toBe(false);
  });

  test("a throwing write does not report success", async () => {
    const reg = await freshInstance();
    const child = fakeChild();
    child.stdin!.write = vi.fn(() => {
      throw new Error("EPIPE");
    });
    reg.registerProcess("p1", asChild(child));
    expect(reg.sendStdin("p1", "input")).toBe(false);
  });
});

describe("killProcesses", () => {
  test("signals every child and reports how many", async () => {
    const reg = await freshInstance();
    const a = fakeChild();
    const b = fakeChild();
    reg.registerProcess("p1", asChild(a));
    reg.registerProcess("p1", asChild(b));

    expect(reg.killProcesses("p1")).toBe(2);
    expect(a.kill).toHaveBeenCalledWith("SIGTERM");
    expect(b.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("clears the pipeline afterwards", async () => {
    const reg = await freshInstance();
    reg.registerProcess("p1", asChild(fakeChild()));
    reg.killProcesses("p1");
    expect(reg.hasProcess("p1")).toBe(false);
  });

  test("returns 0 for a pipeline with nothing running", async () => {
    const reg = await freshInstance();
    expect(reg.killProcesses("p1")).toBe(0);
  });

  test("a child that is already gone does not abort the sweep", async () => {
    const reg = await freshInstance();
    const dead = fakeChild({ killThrows: true });
    const alive = fakeChild();
    reg.registerProcess("p1", asChild(dead));
    reg.registerProcess("p1", asChild(alive));

    expect(reg.killProcesses("p1")).toBe(1);
    expect(alive.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("leaves other pipelines running", async () => {
    const reg = await freshInstance();
    const mine = fakeChild();
    const theirs = fakeChild();
    reg.registerProcess("p1", asChild(mine));
    reg.registerProcess("p2", asChild(theirs));

    reg.killProcesses("p1");

    expect(theirs.kill).not.toHaveBeenCalled();
    expect(reg.hasProcess("p2")).toBe(true);
  });
});

describe("cross-bundle sharing (/stdin and /abort see the phase code's children)", () => {
  test("a second module instance sees a child registered by the first", async () => {
    const spawner = await freshInstance();
    spawner.registerProcess("p1", asChild(fakeChild()));

    const routeBundle = await freshInstance();
    expect(routeBundle).not.toBe(spawner);
    expect(routeBundle.hasProcess("p1")).toBe(true);
  });

  test("killing from one instance is visible in the other", async () => {
    const spawner = await freshInstance();
    const child = fakeChild();
    spawner.registerProcess("p1", asChild(child));

    const abortRoute = await freshInstance();
    expect(abortRoute.killProcesses("p1")).toBe(1);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawner.hasProcess("p1")).toBe(false);
  });

  test("stdin written through one instance reaches the other's child", async () => {
    const spawner = await freshInstance();
    const child = fakeChild();
    spawner.registerProcess("p1", asChild(child));

    const stdinRoute = await freshInstance();
    expect(stdinRoute.sendStdin("p1", "1")).toBe(true);
    expect(child.stdin!.write).toHaveBeenCalledWith("1\n");
  });
});
