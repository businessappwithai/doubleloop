// tests/adapters-clock-ids.test.ts — module m5 (Ports and adapters). Covers the real Clock and
// IdGenerator adapters (node-clock.ts, random-ids.ts) plus the deterministic fakes (createFakeClock,
// createSeqIds) that every later module's tests inject instead.
import { describe, expect, test, vi } from "vitest";
import { createNodeClock } from "../src/server/adapters/node-clock";
import { createRandomIds } from "../src/server/adapters/random-ids";
import { createFakeClock, createSeqIds } from "./helpers/fake-ports";

const V4_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createNodeClock", () => {
  test("now() reflects the current system time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T09:26:53.000Z"));
    const clock = createNodeClock();
    expect(clock.now()).toEqual(new Date("2026-03-14T09:26:53.000Z"));
  });

  test("now() tracks the system clock as it advances", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const clock = createNodeClock();
    const first = clock.now();
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    const second = clock.now();
    expect(second.getTime() - first.getTime()).toBe(5000);
  });

  test("returns a distinct Date instance on every call", () => {
    const clock = createNodeClock();
    expect(clock.now()).not.toBe(clock.now());
  });
});

describe("createRandomIds", () => {
  test("returns a valid v4 UUID", () => {
    const ids = createRandomIds();
    expect(ids.uuid()).toMatch(V4_UUID_PATTERN);
  });

  test("returns a distinct id on every call", () => {
    const ids = createRandomIds();
    const first = ids.uuid();
    const second = ids.uuid();
    expect(first).not.toBe(second);
  });
});

describe("createFakeClock", () => {
  test("defaults to a fixed, deterministic instant", () => {
    const clock = createFakeClock();
    expect(clock.now()).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  test("accepts an explicit initial instant", () => {
    const clock = createFakeClock(new Date("2020-06-15T12:00:00.000Z"));
    expect(clock.now()).toEqual(new Date("2020-06-15T12:00:00.000Z"));
  });

  test("advance() moves the clock forward by the given milliseconds", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    clock.advance(90_000);
    expect(clock.now()).toEqual(new Date("2026-01-01T00:01:30.000Z"));
  });

  test("advance() can be called repeatedly, accumulating", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    clock.advance(1000);
    clock.advance(2000);
    expect(clock.now()).toEqual(new Date("2026-01-01T00:00:03.000Z"));
  });

  test("set() pins the clock to an arbitrary instant", () => {
    const clock = createFakeClock();
    clock.set(new Date("2030-12-31T23:59:59.000Z"));
    expect(clock.now()).toEqual(new Date("2030-12-31T23:59:59.000Z"));
  });

  test("now() returns a fresh Date instance immune to external mutation", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const first = clock.now();
    first.setFullYear(1970);
    expect(clock.now()).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });
});

describe("createSeqIds", () => {
  test("issues deterministic, sequential ids starting at 1", () => {
    const ids = createSeqIds();
    expect(ids.uuid()).toBe("00000000-0000-4000-8000-000000000001");
    expect(ids.uuid()).toBe("00000000-0000-4000-8000-000000000002");
  });

  test("every issued id is a valid v4 UUID a branding function would accept", () => {
    const ids = createSeqIds();
    expect(ids.uuid()).toMatch(V4_UUID_PATTERN);
  });

  test("records every issued id, in order, on .issued", () => {
    const ids = createSeqIds();
    const first = ids.uuid();
    const second = ids.uuid();
    expect(ids.issued).toEqual([first, second]);
  });

  test("two independent generators both start at 1", () => {
    const a = createSeqIds();
    const b = createSeqIds();
    a.uuid();
    expect(b.uuid()).toBe("00000000-0000-4000-8000-000000000001");
  });
});
