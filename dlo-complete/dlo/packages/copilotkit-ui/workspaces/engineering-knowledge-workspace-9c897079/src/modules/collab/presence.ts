// src/modules/collab/presence.ts — per-room presence bookkeeping for the collaboration module
// (Implementation.md m13). Tracks `actorId`, `displayName`, `color` and `lastSeenAt` for every
// actor currently joined to one room, stamped from the injected `Clock` (never `Date.now()`
// directly, per Architecture.md's "Central Orchestrator" rule 4), so eviction-at-threshold is
// deterministic under a fake clock in tests.
//
// Eviction is strictly-greater-than, not greater-or-equal: an entry exactly `idleThresholdMs` old
// is still live, and only becomes idle the millisecond after. `collab-module.ts`'s acceptance
// criteria distinguishes those two instants explicitly, so the comparison here has to get the
// boundary exactly right rather than "close enough".
import type { ActorId } from "../../core/ids";
import type { Clock } from "../../server/ports";

/** One actor's live presence in a room, as returned by {@link PresenceTracker.list}. */
export interface PresenceEntry {
  readonly actorId: ActorId;
  readonly displayName: string;
  readonly color: string;
  /** ISO-8601 instant this actor's presence was last refreshed. */
  readonly lastSeenAt: string;
}

/** An entry older than this (ms), measured against the injected `Clock`, is evicted. */
export const DEFAULT_IDLE_THRESHOLD_MS = 60_000;

export interface TouchPresenceInput {
  readonly actorId: ActorId;
  readonly displayName: string;
  readonly color: string;
}

export interface PresenceTracker {
  /** Number of non-idle entries currently tracked. Evicts idle entries as a side effect. */
  readonly size: number;
  /** Records (or refreshes) `input`'s presence, stamping `lastSeenAt` from the injected clock. */
  touch(input: TouchPresenceInput): void;
  /** Removes `actorId` unconditionally, regardless of idleness. A no-op if it was never present. */
  remove(actorId: ActorId): void;
  /** The current non-idle entries, sorted by `actorId` for deterministic output. Evicts idle entries first. */
  list(): readonly PresenceEntry[];
}

interface StoredPresence {
  displayName: string;
  color: string;
  lastSeenAtMs: number;
}

/** Creates an empty, per-room {@link PresenceTracker}. */
export function createPresenceTracker(
  clock: Clock,
  idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): PresenceTracker {
  const entries = new Map<ActorId, StoredPresence>();

  function evictIdle(): void {
    const nowMs = clock.now().getTime();
    for (const [actorId, entry] of entries) {
      if (nowMs - entry.lastSeenAtMs > idleThresholdMs) {
        entries.delete(actorId);
      }
    }
  }

  return {
    get size() {
      evictIdle();
      return entries.size;
    },

    touch({ actorId, displayName, color }) {
      entries.set(actorId, { displayName, color, lastSeenAtMs: clock.now().getTime() });
    },

    remove(actorId) {
      entries.delete(actorId);
    },

    list() {
      evictIdle();
      return Array.from(entries.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([actorId, entry]) => ({
          actorId,
          displayName: entry.displayName,
          color: entry.color,
          lastSeenAt: new Date(entry.lastSeenAtMs).toISOString(),
        }));
    },
  };
}
