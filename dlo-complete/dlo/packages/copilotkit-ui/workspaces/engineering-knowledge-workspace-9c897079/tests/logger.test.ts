// tests/logger.test.ts — module m4 (Configuration and structured logging). Covers one-JSON-
// object-per-line emission, every level-filtering boundary, child() binding inheritance (including
// nested children and per-call overrides), redaction of each secret key and of URL-embedded
// credentials, and the default stdout sink.
import { describe, test, expect, vi, afterEach } from "vitest";
import { createLogger, type Clock, type Level } from "../src/lib/logger";

const FIXED_ISO = "2026-01-01T00:00:00.000Z";
const clock: Clock = { now: () => new Date(FIXED_ISO) };

function createSink(): { sink: (line: string) => void; lines: string[]; records: () => unknown[] } {
  const lines: string[] = [];
  return {
    sink: (line: string) => lines.push(line),
    lines,
    records: () => lines.map((line) => JSON.parse(line)),
  };
}

describe("createLogger — line shape", () => {
  test("emits exactly one JSON object per call, with ts/level/msg and merged fields", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.info("bundle created", { bundleId: "abc-123", conceptCount: 3 });

    expect(records()).toEqual([
      { ts: FIXED_ISO, level: "info", msg: "bundle created", bundleId: "abc-123", conceptCount: 3 },
    ]);
  });

  test("omits fields entirely when none are supplied", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.warn("no fields here");

    expect(records()).toEqual([{ ts: FIXED_ISO, level: "warn", msg: "no fields here" }]);
  });
});

describe("createLogger — level filtering boundaries", () => {
  const ALL_LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

  test.each(ALL_LEVELS)("at level=%s, only levels at or above it are emitted", (configuredLevel) => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: configuredLevel, clock, sink });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    const emittedLevels = records().map((r) => (r as { level: string }).level);
    const expectedLevels = ALL_LEVELS.slice(ALL_LEVELS.indexOf(configuredLevel));
    expect(emittedLevels).toEqual(expectedLevels);
  });

  test("a message exactly at the configured level is emitted, not suppressed", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "warn", clock, sink });

    logger.warn("boundary case");

    expect(records()).toHaveLength(1);
  });
});

describe("createLogger — child bindings", () => {
  test("a child logger merges its bindings into every subsequent line", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });
    const child = logger.child({ requestId: "req-1" });

    child.info("handled request");

    expect(records()).toEqual([
      { ts: FIXED_ISO, level: "info", msg: "handled request", requestId: "req-1" },
    ]);
  });

  test("grandchild loggers inherit and extend ancestor bindings", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });
    const child = logger.child({ requestId: "req-1" });
    const grandchild = child.child({ bundleId: "bundle-1" });

    grandchild.info("nested");

    expect(records()).toEqual([
      { ts: FIXED_ISO, level: "info", msg: "nested", requestId: "req-1", bundleId: "bundle-1" },
    ]);
  });

  test("a per-call field overrides an inherited binding of the same name", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });
    const child = logger.child({ requestId: "req-1" });

    child.info("overridden", { requestId: "req-2" });

    expect(records()).toEqual([{ ts: FIXED_ISO, level: "info", msg: "overridden", requestId: "req-2" }]);
  });

  test("the parent logger is unaffected by a child's bindings", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });
    logger.child({ requestId: "req-1" });

    logger.info("still on the parent");

    expect(records()).toEqual([{ ts: FIXED_ISO, level: "info", msg: "still on the parent" }]);
  });

  test("a child logger still filters by the configured level", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "error", clock, sink });
    const child = logger.child({ requestId: "req-1" });

    child.warn("suppressed");
    child.error("kept");

    expect(records()).toEqual([
      { ts: FIXED_ISO, level: "error", msg: "kept", requestId: "req-1" },
    ]);
  });
});

describe("createLogger — redaction", () => {
  const SENSITIVE_KEY_CASES = [
    { key: "password", value: "hunter2" },
    { key: "token", value: "tok_live_abc123" },
    { key: "apiKey", value: "sk-abc123" },
    { key: "authorization", value: "Bearer abc123" },
    { key: "credentials", value: { user: "root", pass: "hunter2" } },
  ];

  test.each(SENSITIVE_KEY_CASES)("redacts a top-level $key field", ({ key, value }) => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.info("secret field", { [key]: value });

    expect((records()[0] as Record<string, unknown>)[key]).toBe("[REDACTED]");
  });

  test("redaction is case-insensitive on the key name", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.info("secret field", { ApiKey: "sk-abc123", PASSWORD: "hunter2" });

    const record = records()[0] as Record<string, unknown>;
    expect(record["ApiKey"]).toBe("[REDACTED]");
    expect(record["PASSWORD"]).toBe("[REDACTED]");
  });

  test("redacts a sensitive key nested inside an object field", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.info("nested secret", { auth: { token: "tok_live_abc123", scope: "read" } });

    const record = records()[0] as { auth: { token: string; scope: string } };
    expect(record.auth.token).toBe("[REDACTED]");
    expect(record.auth.scope).toBe("read");
  });

  test("redacts a sensitive key inside array elements", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.info("array of secrets", { actors: [{ id: "a1", token: "t1" }, { id: "a2", token: "t2" }] });

    const record = records()[0] as { actors: Array<{ id: string; token: string }> };
    expect(record.actors).toEqual([
      { id: "a1", token: "[REDACTED]" },
      { id: "a2", token: "[REDACTED]" },
    ]);
  });

  test("leaves non-sensitive fields untouched", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.info("ordinary fields", { bundleId: "abc-123", count: 3, active: true });

    expect(records()).toEqual([
      { ts: FIXED_ISO, level: "info", msg: "ordinary fields", bundleId: "abc-123", count: 3, active: true },
    ]);
  });

  test("redacts credentials embedded in a URL field, preserving the rest of the URL", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.info("connecting", { databaseUrl: "postgres://ekw:s3cret@localhost:5432/ekw" });

    const record = records()[0] as { databaseUrl: string };
    expect(record.databaseUrl).toBe("postgres://[REDACTED]@localhost:5432/ekw");
  });

  test("redacts URL credentials embedded in the log message itself", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.error("failed to connect to postgres://ekw:s3cret@localhost:5432/ekw");

    const record = records()[0] as { msg: string };
    expect(record.msg).toBe("failed to connect to postgres://[REDACTED]@localhost:5432/ekw");
  });

  test("does not alter a URL field that carries no credentials", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });

    logger.info("connecting", { wsUrl: "ws://localhost:1234" });

    const record = records()[0] as { wsUrl: string };
    expect(record.wsUrl).toBe("ws://localhost:1234");
  });

  test("child bindings are redacted the same as per-call fields", () => {
    const { sink, records } = createSink();
    const logger = createLogger({ level: "debug", clock, sink });
    const child = logger.child({ token: "tok_live_abc123" });

    child.info("bound secret");

    expect((records()[0] as Record<string, unknown>)["token"]).toBe("[REDACTED]");
  });
});

describe("createLogger — default sink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("writes a newline-terminated JSON line to process.stdout when no sink is supplied", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger({ level: "debug", clock });

    logger.info("no sink supplied");

    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0]?.[0];
    expect(typeof written).toBe("string");
    expect(written as string).toMatch(/\n$/);
    expect(JSON.parse((written as string).trimEnd())).toEqual({
      ts: FIXED_ISO,
      level: "info",
      msg: "no sink supplied",
    });
  });
});
