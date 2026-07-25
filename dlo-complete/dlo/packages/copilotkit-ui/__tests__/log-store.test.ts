/**
 * __tests__/log-store.test.ts
 * The live log buffer behind /api/pipelines/[id]/logs.
 *
 * The sharing tests are the point of this file. Next.js compiles every route
 * handler into its own bundle, so a module-scoped Map is created once per
 * route: the phase code appended into the gate-resolve route's copy while the
 * logs route streamed from its own empty copy, and the console showed nothing
 * for an entire pipeline run. `vi.resetModules()` + a second import reproduces
 * that second bundle, and the store must still be the same one.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const BUFFER_KEY = Symbol.for("dlo.orchestrator.logBuffer");
const SUBSCRIBERS_KEY = Symbol.for("dlo.orchestrator.logSubscribers");

type Store = typeof import("../src/lib/orchestrator/logStore");

/** Import a fresh module instance, as a separate route bundle would. */
async function freshInstance(): Promise<Store> {
  vi.resetModules();
  return import("../src/lib/orchestrator/logStore");
}

beforeEach(() => {
  const holder = globalThis as Record<symbol, unknown>;
  delete holder[BUFFER_KEY];
  delete holder[SUBSCRIBERS_KEY];
  vi.resetModules();
});

describe("appendLog / getLogs", () => {
  test("buffers a line and returns it verbatim", async () => {
    const store = await freshInstance();
    store.appendLog("p1", "[Design] Starting Design Analyst");
    expect(store.getLogs("p1")).toEqual(["[Design] Starting Design Analyst"]);
  });

  test("splits a multi-line chunk into one entry per line", async () => {
    const store = await freshInstance();
    store.appendLog("p1", "line one\nline two\r\nline three");
    expect(store.getLogs("p1")).toEqual(["line one", "line two", "line three"]);
  });

  test("drops the empty splits a trailing newline produces", async () => {
    const store = await freshInstance();
    store.appendLog("p1", "only line\n");
    expect(store.getLogs("p1")).toEqual(["only line"]);
  });

  test("keeps a single empty write as an empty line", async () => {
    const store = await freshInstance();
    store.appendLog("p1", "");
    expect(store.getLogs("p1")).toEqual([""]);
  });

  test("keeps pipelines separate", async () => {
    const store = await freshInstance();
    store.appendLog("p1", "for one");
    store.appendLog("p2", "for two");
    expect(store.getLogs("p1")).toEqual(["for one"]);
    expect(store.getLogs("p2")).toEqual(["for two"]);
  });

  test("returns an empty array for a pipeline that never logged", async () => {
    const store = await freshInstance();
    expect(store.getLogs("never-seen")).toEqual([]);
  });

  test("returns a copy — mutating the result cannot corrupt the buffer", async () => {
    const store = await freshInstance();
    store.appendLog("p1", "keep me");
    store.getLogs("p1").push("injected");
    expect(store.getLogs("p1")).toEqual(["keep me"]);
  });

  test("keeps only the last 500 lines", async () => {
    const store = await freshInstance();
    for (let i = 0; i < 520; i++) store.appendLog("p1", `line ${i}`);
    const lines = store.getLogs("p1");
    expect(lines).toHaveLength(500);
    expect(lines[0]).toBe("line 20");
    expect(lines[499]).toBe("line 519");
  });

  test("clearLogs empties one pipeline and leaves the others", async () => {
    const store = await freshInstance();
    store.appendLog("p1", "a");
    store.appendLog("p2", "b");
    store.clearLogs("p1");
    expect(store.getLogs("p1")).toEqual([]);
    expect(store.getLogs("p2")).toEqual(["b"]);
  });
});

describe("subscribeToLogs", () => {
  test("delivers each new line to the subscriber", async () => {
    const store = await freshInstance();
    const seen: string[] = [];
    store.subscribeToLogs("p1", (line) => seen.push(line));
    store.appendLog("p1", "first\nsecond");
    expect(seen).toEqual(["first", "second"]);
  });

  test("does not replay lines buffered before subscribing", async () => {
    const store = await freshInstance();
    store.appendLog("p1", "before");
    const seen: string[] = [];
    store.subscribeToLogs("p1", (line) => seen.push(line));
    expect(seen).toEqual([]);
  });

  test("delivers to every subscriber of that pipeline only", async () => {
    const store = await freshInstance();
    const a: string[] = [];
    const b: string[] = [];
    const other: string[] = [];
    store.subscribeToLogs("p1", (l) => a.push(l));
    store.subscribeToLogs("p1", (l) => b.push(l));
    store.subscribeToLogs("p2", (l) => other.push(l));
    store.appendLog("p1", "shared");
    expect(a).toEqual(["shared"]);
    expect(b).toEqual(["shared"]);
    expect(other).toEqual([]);
  });

  test("unsubscribing stops delivery", async () => {
    const store = await freshInstance();
    const seen: string[] = [];
    const unsub = store.subscribeToLogs("p1", (l) => seen.push(l));
    store.appendLog("p1", "delivered");
    unsub();
    store.appendLog("p1", "not delivered");
    expect(seen).toEqual(["delivered"]);
  });
});

describe("cross-bundle sharing (the console's live log panel)", () => {
  test("a second module instance reads what the first appended", async () => {
    const writer = await freshInstance();
    writer.appendLog("p1", "[Fleet] Dispatching 22 modules");

    const reader = await freshInstance();
    expect(reader).not.toBe(writer);
    expect(reader.getLogs("p1")).toEqual(["[Fleet] Dispatching 22 modules"]);
  });

  test("a subscriber registered in one instance receives writes from another", async () => {
    const readerBundle = await freshInstance();
    const seen: string[] = [];
    readerBundle.subscribeToLogs("p1", (line) => seen.push(line));

    const writerBundle = await freshInstance();
    writerBundle.appendLog("p1", "[Module] \"Test harness\" — PASSED ✓");

    expect(seen).toEqual(['[Module] "Test harness" — PASSED ✓']);
  });

  test("clearLogs in one instance is visible in another", async () => {
    const first = await freshInstance();
    first.appendLog("p1", "gone soon");
    const second = await freshInstance();
    second.clearLogs("p1");
    expect(first.getLogs("p1")).toEqual([]);
  });
});
