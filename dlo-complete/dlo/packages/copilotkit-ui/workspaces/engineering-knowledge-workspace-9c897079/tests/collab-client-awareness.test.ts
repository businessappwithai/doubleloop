// tests/collab-client-awareness.test.ts — module m19 (Yjs collaboration client). Covers
// `setLocalPresence`, `computePresence`/`subscribePresence` (add/update/remove and stale-peer
// eviction judged against an injected clock, never `Date.now()`), and `colorForActor`'s
// determinism/distinctness. `FakeAwareness` is a minimal, hermetic stand-in for the
// `ProviderAwareness` map — no real Yjs `Awareness`/network involved.
import { describe, test, expect } from "vitest";
import type { ProviderAwareness } from "@lexical/yjs";
import {
  setLocalPresence,
  subscribePresence,
  computePresence,
  colorForActor,
  STALE_PEER_THRESHOLD_MS,
  type PresenceClock,
} from "../src/collab/awareness";

// ---------------------------------------------------------------------------
// FakeAwareness
// ---------------------------------------------------------------------------

class FakeAwareness implements ProviderAwareness {
  private readonly states = new Map<number, unknown>();
  private readonly listeners = new Set<() => void>();
  private localState: unknown = null;

  constructor(private readonly localClientId: number = 1) {}

  getLocalState() {
    return this.localState as unknown as ReturnType<ProviderAwareness["getLocalState"]>;
  }

  getStates() {
    return this.states as unknown as ReturnType<ProviderAwareness["getStates"]>;
  }

  setLocalState(state: unknown): void {
    this.localState = state;
    if (state === null) {
      this.states.delete(this.localClientId);
    } else {
      this.states.set(this.localClientId, state);
    }
    this.emit();
  }

  setLocalStateField(): void {
    throw new Error("FakeAwareness: setLocalStateField is not used by this module");
  }

  on(_type: "update", cb: () => void): void {
    this.listeners.add(cb);
  }

  off(_type: "update", cb: () => void): void {
    this.listeners.delete(cb);
  }

  /** Test-only helper: writes a remote peer's raw state directly, bypassing setLocalState. */
  setRemoteState(clientId: number, state: unknown): void {
    if (state === null) {
      this.states.delete(clientId);
    } else {
      this.states.set(clientId, state);
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

interface FakeClock extends PresenceClock {
  set(value: number): void;
}

function createFakeClock(initial = 0): FakeClock {
  let now = initial;
  return {
    now: () => now,
    set: (value: number) => {
      now = value;
    },
  };
}

// ---------------------------------------------------------------------------
// colorForActor
// ---------------------------------------------------------------------------

describe("colorForActor", () => {
  test("is deterministic for the same id", () => {
    expect(colorForActor("actor-1")).toBe(colorForActor("actor-1"));
    expect(colorForActor("actor-1")).toBe(colorForActor("actor-1"));
  });

  test("is distinct across different ids", () => {
    const ids = ["actor-1", "actor-2", "actor-3", "actor-4", "actor-5"];
    const colors = new Set(ids.map(colorForActor));
    expect(colors.size).toBe(ids.length);
  });

  test("returns an hsl() string with the fixed saturation/lightness", () => {
    expect(colorForActor("actor-1")).toMatch(/^hsl\(\d+, 65%, 45%\)$/);
  });

  test("the hue is always within [0, 360)", () => {
    for (const id of ["a", "bb", "ccc", "engineer-42", ""]) {
      const match = /^hsl\((\d+), 65%, 45%\)$/.exec(colorForActor(id));
      expect(match).not.toBeNull();
      const hue = Number(match?.[1]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

// ---------------------------------------------------------------------------
// setLocalPresence
// ---------------------------------------------------------------------------

describe("setLocalPresence", () => {
  test("writes actorId, name, a derived color, and lastSeen from the clock", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(1_000);

    setLocalPresence(awareness, { actorId: "actor-1", name: "Ada" }, clock);

    const [[, state]] = [...awareness.getStates()];
    expect(state).toMatchObject({
      actorId: "actor-1",
      name: "Ada",
      color: colorForActor("actor-1"),
      lastSeen: 1_000,
    });
  });

  test("honors an explicit color instead of deriving one", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(0);

    setLocalPresence(awareness, { actorId: "actor-1", name: "Ada", color: "hsl(10, 65%, 45%)" }, clock);

    const [[, state]] = [...awareness.getStates()];
    expect(state).toMatchObject({ color: "hsl(10, 65%, 45%)" });
  });

  test("defaults to the real clock when none is injected", () => {
    const awareness = new FakeAwareness();
    const before = Date.now();

    setLocalPresence(awareness, { actorId: "actor-1", name: "Ada" });

    const [[, state]] = [...awareness.getStates()];
    const lastSeen = (state as unknown as { lastSeen: number }).lastSeen;
    expect(lastSeen).toBeGreaterThanOrEqual(before);
    expect(lastSeen).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// computePresence
// ---------------------------------------------------------------------------

describe("computePresence", () => {
  function peerState(actorId: string, lastSeen: number, overrides: Partial<Record<string, unknown>> = {}) {
    return { actorId, name: actorId, color: colorForActor(actorId), lastSeen, ...overrides };
  }

  test("returns an empty list for an empty states map", () => {
    expect(computePresence(new Map(), 0)).toEqual([]);
  });

  test("includes every well-formed peer", () => {
    const states = new Map<number, unknown>([
      [1, peerState("actor-1", 0)],
      [2, peerState("actor-2", 0)],
    ]);
    const peers = computePresence(states, 0);
    expect(peers.map((p) => p.actorId).sort()).toEqual(["actor-1", "actor-2"]);
  });

  test("excludes the peer matching excludeActorId", () => {
    const states = new Map<number, unknown>([
      [1, peerState("local", 0)],
      [2, peerState("remote", 0)],
    ]);
    const peers = computePresence(states, 0, { excludeActorId: "local" });
    expect(peers).toHaveLength(1);
    expect(peers[0]?.actorId).toBe("remote");
  });

  test("silently skips a state that isn't a well-formed presence record", () => {
    const states = new Map<number, unknown>([
      [1, peerState("actor-1", 0)],
      [2, { unrelated: "consumer-data" }],
      [3, null],
      [4, "not-an-object"],
    ]);
    const peers = computePresence(states, 0);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.actorId).toBe("actor-1");
  });

  test("excludes a peer exactly at the stale threshold", () => {
    const states = new Map<number, unknown>([[1, peerState("actor-1", 0)]]);
    expect(computePresence(states, STALE_PEER_THRESHOLD_MS)).toEqual([]);
  });

  test("includes a peer one millisecond under the stale threshold", () => {
    const states = new Map<number, unknown>([[1, peerState("actor-1", 0)]]);
    const peers = computePresence(states, STALE_PEER_THRESHOLD_MS - 1);
    expect(peers).toHaveLength(1);
  });

  test("honors a custom staleThresholdMs", () => {
    const states = new Map<number, unknown>([[1, peerState("actor-1", 0)]]);
    expect(computePresence(states, 500, { staleThresholdMs: 1_000 })).toHaveLength(1);
    expect(computePresence(states, 1_000, { staleThresholdMs: 1_000 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// subscribePresence
// ---------------------------------------------------------------------------

describe("subscribePresence", () => {
  test("emits immediately with the current peer list on subscribe", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(0);
    awareness.setRemoteState(2, { actorId: "actor-2", name: "Bob", color: colorForActor("actor-2"), lastSeen: 0 });

    const emissions: Array<readonly { actorId: string }[]> = [];
    subscribePresence(awareness, (peers) => emissions.push(peers), { clock });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.map((p) => p.actorId)).toEqual(["actor-2"]);
  });

  test("re-emits with an added peer", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(0);
    const emissions: Array<readonly { actorId: string }[]> = [];
    subscribePresence(awareness, (peers) => emissions.push(peers), { clock });

    awareness.setRemoteState(2, { actorId: "actor-2", name: "Bob", color: colorForActor("actor-2"), lastSeen: 0 });

    expect(emissions).toHaveLength(2);
    expect(emissions[1]?.map((p) => p.actorId)).toEqual(["actor-2"]);
  });

  test("re-emits with an updated peer's new fields", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(0);
    awareness.setRemoteState(2, { actorId: "actor-2", name: "Bob", color: colorForActor("actor-2"), lastSeen: 0 });
    const emissions: Array<readonly { name: string }[]> = [];
    subscribePresence(awareness, (peers) => emissions.push(peers), { clock });

    clock.set(10);
    awareness.setRemoteState(2, { actorId: "actor-2", name: "Bobby", color: colorForActor("actor-2"), lastSeen: 10 });

    expect(emissions.at(-1)?.[0]?.name).toBe("Bobby");
  });

  test("re-emits without a removed peer", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(0);
    awareness.setRemoteState(2, { actorId: "actor-2", name: "Bob", color: colorForActor("actor-2"), lastSeen: 0 });
    const emissions: Array<readonly unknown[]> = [];
    subscribePresence(awareness, (peers) => emissions.push(peers), { clock });

    awareness.setRemoteState(2, null);

    expect(emissions.at(-1)).toEqual([]);
  });

  test("evicts a peer once it crosses the stale threshold on the next recomputation", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(0);
    awareness.setRemoteState(2, { actorId: "actor-2", name: "Bob", color: colorForActor("actor-2"), lastSeen: 0 });
    const emissions: Array<readonly { actorId: string }[]> = [];
    subscribePresence(awareness, (peers) => emissions.push(peers), { clock });
    expect(emissions[0]).toHaveLength(1);

    clock.set(STALE_PEER_THRESHOLD_MS);
    // A second peer joining forces a recomputation at the new clock time, which is when
    // subscribePresence would naturally notice actor-2 has gone stale (there is no polling timer).
    awareness.setRemoteState(3, { actorId: "actor-3", name: "Carol", color: colorForActor("actor-3"), lastSeen: STALE_PEER_THRESHOLD_MS });

    const latest = emissions.at(-1) ?? [];
    expect(latest.map((p) => p.actorId)).toEqual(["actor-3"]);
  });

  test("unsubscribe stops further emissions", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(0);
    const emissions: Array<readonly unknown[]> = [];
    const unsubscribe = subscribePresence(awareness, (peers) => emissions.push(peers), { clock });
    const countAfterSubscribe = emissions.length;

    unsubscribe();
    awareness.setRemoteState(2, { actorId: "actor-2", name: "Bob", color: colorForActor("actor-2"), lastSeen: 0 });

    expect(emissions).toHaveLength(countAfterSubscribe);
  });

  test("excludes the local actor via excludeActorId", () => {
    const awareness = new FakeAwareness();
    const clock = createFakeClock(0);
    setLocalPresence(awareness, { actorId: "local", name: "Me" }, clock);
    awareness.setRemoteState(2, { actorId: "remote", name: "Them", color: colorForActor("remote"), lastSeen: 0 });

    const emissions: Array<readonly { actorId: string }[]> = [];
    subscribePresence(awareness, (peers) => emissions.push(peers), { clock, excludeActorId: "local" });

    expect(emissions.at(-1)?.map((p) => p.actorId)).toEqual(["remote"]);
  });
});
