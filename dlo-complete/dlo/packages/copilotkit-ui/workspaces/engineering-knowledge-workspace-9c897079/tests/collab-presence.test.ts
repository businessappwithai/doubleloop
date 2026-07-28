// tests/collab-presence.test.ts — module m13 (collaboration). Exercises `createPresenceTracker`
// from `src/modules/collab/presence.ts` in isolation: touch/list/remove, sorted output, and idle
// eviction against a fake clock at exactly the threshold and one millisecond past it.
import { describe, test, expect } from "vitest";
import { createFakeClock } from "./helpers/fake-ports";
import { asActorId } from "../src/core/ids";
import { createPresenceTracker, DEFAULT_IDLE_THRESHOLD_MS } from "../src/modules/collab/presence";

const ACTOR_A = asActorId("20000000-0000-4000-8000-000000000001");
const ACTOR_B = asActorId("20000000-0000-4000-8000-000000000002");

describe("createPresenceTracker.touch/list", () => {
  test("list is empty for a freshly created tracker", () => {
    const clock = createFakeClock();
    const tracker = createPresenceTracker(clock);
    expect(tracker.list()).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  test("returns the touched entry with actorId, displayName, color and lastSeenAt", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const tracker = createPresenceTracker(clock);

    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "hsl(10, 65%, 45%)" });

    expect(tracker.list()).toEqual([
      { actorId: ACTOR_A, displayName: "Ada", color: "hsl(10, 65%, 45%)", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(tracker.size).toBe(1);
  });

  test("re-touching the same actorId refreshes displayName, color and lastSeenAt instead of duplicating", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const tracker = createPresenceTracker(clock);

    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "red" });
    clock.advance(1_000);
    tracker.touch({ actorId: ACTOR_A, displayName: "Ada Lovelace", color: "blue" });

    const list = tracker.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      actorId: ACTOR_A,
      displayName: "Ada Lovelace",
      color: "blue",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
    });
  });

  test("lists multiple actors sorted by actorId", () => {
    const clock = createFakeClock();
    const tracker = createPresenceTracker(clock);

    tracker.touch({ actorId: ACTOR_B, displayName: "Bob", color: "green" });
    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "red" });

    expect(tracker.list().map((entry) => entry.actorId)).toEqual([ACTOR_A, ACTOR_B]);
  });
});

describe("createPresenceTracker.remove", () => {
  test("removes a present actor", () => {
    const clock = createFakeClock();
    const tracker = createPresenceTracker(clock);
    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "red" });

    tracker.remove(ACTOR_A);

    expect(tracker.list()).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  test("removing an actor that was never touched is a no-op", () => {
    const clock = createFakeClock();
    const tracker = createPresenceTracker(clock);
    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "red" });

    tracker.remove(ACTOR_B);

    expect(tracker.list().map((entry) => entry.actorId)).toEqual([ACTOR_A]);
  });
});

describe("createPresenceTracker — idle eviction", () => {
  test("an entry exactly at the idle threshold is still live", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const tracker = createPresenceTracker(clock, 60_000);
    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "red" });

    clock.advance(60_000);

    expect(tracker.list().map((entry) => entry.actorId)).toEqual([ACTOR_A]);
    expect(tracker.size).toBe(1);
  });

  test("an entry one millisecond past the idle threshold is evicted", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const tracker = createPresenceTracker(clock, 60_000);
    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "red" });

    clock.advance(60_001);

    expect(tracker.list()).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  test("eviction only removes the idle actor, leaving a recently-touched peer live", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const tracker = createPresenceTracker(clock, 60_000);
    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "red" });

    clock.advance(59_000);
    tracker.touch({ actorId: ACTOR_B, displayName: "Bob", color: "green" });
    clock.advance(1_001);

    expect(tracker.list().map((entry) => entry.actorId)).toEqual([ACTOR_B]);
  });

  test("uses DEFAULT_IDLE_THRESHOLD_MS when no threshold is supplied", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const tracker = createPresenceTracker(clock);
    tracker.touch({ actorId: ACTOR_A, displayName: "Ada", color: "red" });

    clock.advance(DEFAULT_IDLE_THRESHOLD_MS + 1);

    expect(tracker.list()).toEqual([]);
  });
});
