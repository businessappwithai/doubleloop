// src/collab/awareness.ts — presence over a Yjs `ProviderAwareness` map: publishing the local
// actor's state, subscribing to remote peers with stale-peer eviction, and a deterministic
// per-actor color so the same person gets the same badge color in every tab and on every peer's
// screen without any server-assigned color registry. Staleness is judged against an injected
// `PresenceClock`, never `Date.now()` directly, so eviction-at-threshold is deterministic in tests
// (this backstops, but does not replace, y-protocols' own internal `outdatedTimeout` GC, which
// uses real timers and is not under our control).
import type { ProviderAwareness } from "@lexical/yjs";

/** A remote peer's presence, derived from one entry of `awareness.getStates()`. */
export interface PresencePeer {
  readonly clientId: number;
  readonly actorId: string;
  readonly name: string;
  readonly color: string;
  /** Epoch ms (per the injected clock) this peer's state was last written. */
  readonly lastSeen: number;
}

/** The local actor's presence, as passed to {@link setLocalPresence}. */
export interface LocalPresence {
  readonly actorId: string;
  readonly name: string;
  /** Defaults to {@link colorForActor}`(actorId)` when omitted. */
  readonly color?: string;
}

export interface PresenceClock {
  now(): number;
}

const defaultClock: PresenceClock = { now: () => Date.now() };

/** A peer whose last heartbeat is older than this (ms) is evicted from {@link subscribePresence}. */
export const STALE_PEER_THRESHOLD_MS = 30_000;

/**
 * Deterministic FNV-1a string hash. Used only to derive a display color — never for anything
 * security-sensitive — so 32-bit collisions are an acceptable, expected tradeoff.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A stable color for `actorId`: the same id always maps to the same color, and distinct ids
 * spread across a 360-degree hue wheel (fixed saturation/lightness) so a small handful of
 * concurrent editors gets visually distinct badges.
 */
export function colorForActor(actorId: string): string {
  const hue = hashString(actorId) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

interface AwarenessPresenceState {
  actorId: string;
  name: string;
  color: string;
  lastSeen: number;
}

function isAwarenessPresenceState(value: unknown): value is AwarenessPresenceState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["actorId"] === "string" &&
    typeof candidate["name"] === "string" &&
    typeof candidate["color"] === "string" &&
    typeof candidate["lastSeen"] === "number"
  );
}

/** Publishes the local actor's presence onto `awareness`, stamping `lastSeen` via `clock`. */
export function setLocalPresence(
  awareness: ProviderAwareness,
  presence: LocalPresence,
  clock: PresenceClock = defaultClock,
): void {
  const state: AwarenessPresenceState = {
    actorId: presence.actorId,
    name: presence.name,
    color: presence.color ?? colorForActor(presence.actorId),
    lastSeen: clock.now(),
  };
  awareness.setLocalState(state);
}

export interface ComputePresenceOptions {
  /** Excluded from the result — pass the local actor's id to list only remote peers. */
  readonly excludeActorId?: string;
  readonly staleThresholdMs?: number;
}

/**
 * Pure projection from raw awareness states to the live (non-stale, non-excluded) peer list.
 * A peer is stale once `now - lastSeen >= staleThresholdMs`. Any state that isn't a well-formed
 * presence record (e.g. written by an unrelated awareness consumer) is silently skipped.
 */
export function computePresence(
  states: ReadonlyMap<number, unknown>,
  now: number,
  options: ComputePresenceOptions = {},
): PresencePeer[] {
  const staleThresholdMs = options.staleThresholdMs ?? STALE_PEER_THRESHOLD_MS;
  const peers: PresencePeer[] = [];
  for (const [clientId, state] of states) {
    if (!isAwarenessPresenceState(state)) {
      continue;
    }
    if (options.excludeActorId !== undefined && state.actorId === options.excludeActorId) {
      continue;
    }
    if (now - state.lastSeen >= staleThresholdMs) {
      continue;
    }
    peers.push({
      clientId,
      actorId: state.actorId,
      name: state.name,
      color: state.color,
      lastSeen: state.lastSeen,
    });
  }
  return peers;
}

export interface SubscribePresenceOptions extends ComputePresenceOptions {
  readonly clock?: PresenceClock;
}

/**
 * Calls `onChange` immediately with the current peer list, then again on every awareness
 * `"update"` event (any local or remote state change re-derives the whole list — awareness
 * updates are infrequent enough, and the list small enough, that there is no value in diffing).
 * Returns an unsubscribe function.
 */
export function subscribePresence(
  awareness: ProviderAwareness,
  onChange: (peers: readonly PresencePeer[]) => void,
  options: SubscribePresenceOptions = {},
): () => void {
  const clock = options.clock ?? defaultClock;
  const emit = (): void => {
    onChange(computePresence(awareness.getStates(), clock.now(), options));
  };
  awareness.on("update", emit);
  emit();
  return () => awareness.off("update", emit);
}
