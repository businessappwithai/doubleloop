// src/modules/collab/collab-module.ts — the `CollabModule` domain service (Implementation.md
// m13). Owns room lifecycle keyed by concept global id — `joinRoom`, `leaveRoom`, `listPresence`
// and `persistSnapshot` — for the `ws` relay in `src/server/collab-server.ts`, which calls only
// this interface and holds no domain logic of its own.
//
// `CollabDocumentPort` below is this module's own, deliberately minimal, port for the one thing
// it needs from the documents module: merging a raw Yjs update into a concept's persisted CRDT
// state. It is declared here rather than imported from `../documents/document-module` — modules
// never import each other directly (Implementation.md "Build Order": m9-m14 build in parallel
// waves and must not depend on each other's internals). It is also deliberately *not* shaped like
// `DocumentModule.applyCrdtUpdate` (which requires a `title` and an `expectedVersion` for its
// optimistic-concurrency `save`/non-CRDT path): a Yjs CRDT merge is commutative and idempotent by
// construction (applying the same, or an out-of-order, update twice is a no-op or a safe merge),
// so the version gate that path needs would only ever reject a background flush that was safe to
// apply. Whatever wires a concrete `DocumentModule` into this port (the future `src/server/
// registry.ts`, or `collab-server.ts`'s own standalone bootstrap) is responsible for bridging the
// two shapes; that bridge is composition-root code, not this module's.
import { ForbiddenError, ValidationError } from "../../core/errors";
import { asConceptId, type ActorId, type ConceptId } from "../../core/ids";
import type { Clock, Logger } from "../../server/ports";
import {
  createPresenceTracker,
  DEFAULT_IDLE_THRESHOLD_MS,
  type PresenceEntry,
  type PresenceTracker,
} from "./presence";

const ROOM_PREFIX = "concept:";

/** Pure: the room name a concept's collaboration session is addressed by. */
export function roomNameFor(conceptId: ConceptId): string {
  return `${ROOM_PREFIX}${conceptId}`;
}

/**
 * Pure: the reverse of {@link roomNameFor}. A room name is presented over an unauthenticated
 * websocket URL by the client, so a malformed or unrecognised one is treated as an authorization
 * failure, not a validation failure — there is nothing else standing between "any string" and "a
 * real concept". Throws `ForbiddenError('collab.roomForbidden')`.
 */
export function conceptIdFor(room: string): ConceptId {
  if (!room.startsWith(ROOM_PREFIX)) {
    throw roomForbidden(room);
  }
  try {
    return asConceptId(room.slice(ROOM_PREFIX.length));
  } catch (err) {
    if (err instanceof ValidationError) {
      throw roomForbidden(room);
    }
    throw err;
  }
}

function roomForbidden(room: string): ForbiddenError {
  return new ForbiddenError(`room "${room}" is not a recognised collaboration room`, {
    details: { reason: "collab.roomForbidden", room },
  });
}

export interface PresenceActor {
  readonly actorId: ActorId;
  readonly displayName: string;
  readonly color: string;
}

export interface JoinRoomInput extends PresenceActor {
  readonly room: string;
}

export interface JoinRoomResult {
  readonly conceptId: ConceptId;
  readonly presence: readonly PresenceEntry[];
}

export interface PersistSnapshotInput {
  readonly room: string;
  readonly update: Uint8Array;
  readonly actorId: ActorId;
}

/** See the module header for why this is not `DocumentModule` itself. */
export interface CollabDocumentPort {
  applyCollabUpdate(input: { conceptId: ConceptId; update: Uint8Array; actorId: ActorId }): Promise<void>;
}

export interface CollabModule {
  /** Throws `ForbiddenError('collab.roomForbidden')` for an unrecognised room. */
  joinRoom(input: JoinRoomInput): JoinRoomResult;
  /** A no-op if `actorId` was never joined to `room`, or `room` is not currently open. */
  leaveRoom(room: string, actorId: ActorId): void;
  /**
   * Pure read of in-memory presence. An open room with no idle peers returns its live list; a
   * room nobody has joined (yet, or any more) returns `[]`. Still throws
   * `ForbiddenError('collab.roomForbidden')` for an unrecognised room, open or not.
   */
  listPresence(room: string): readonly PresenceEntry[];
  /**
   * Merges `update` into `room`'s concept via the injected {@link CollabDocumentPort}. Called on
   * each debounced flush by `collab-server.ts` — never called per-frame. Throws
   * `ForbiddenError('collab.roomForbidden')` for an unrecognised room.
   */
  persistSnapshot(input: PersistSnapshotInput): Promise<void>;
  /** Diagnostic: the number of rooms currently open (at least one non-idle peer joined). */
  roomCount(): number;
}

export interface CollabModuleDeps {
  readonly documents: CollabDocumentPort;
  readonly clock: Clock;
  readonly logger: Logger;
  /** @default DEFAULT_IDLE_THRESHOLD_MS */
  readonly idleThresholdMs?: number;
}

interface Room {
  readonly conceptId: ConceptId;
  readonly presence: PresenceTracker;
}

export function createCollabModule(deps: CollabModuleDeps): CollabModule {
  const idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const rooms = new Map<string, Room>();

  function getOpenRoom(room: string): Room | undefined {
    const entry = rooms.get(room);
    if (entry && entry.presence.size === 0) {
      rooms.delete(room);
      return undefined;
    }
    return entry;
  }

  function getOrCreateRoom(room: string): Room {
    const conceptId = conceptIdFor(room);
    const existing = getOpenRoom(room);
    if (existing) {
      return existing;
    }
    const created: Room = { conceptId, presence: createPresenceTracker(deps.clock, idleThresholdMs) };
    rooms.set(room, created);
    deps.logger.info("collab.roomOpened", { room });
    return created;
  }

  function disposeIfEmpty(room: string, entry: Room): void {
    if (entry.presence.size === 0) {
      rooms.delete(room);
      deps.logger.info("collab.roomClosed", { room });
    }
  }

  return {
    joinRoom(input) {
      const entry = getOrCreateRoom(input.room);
      entry.presence.touch({ actorId: input.actorId, displayName: input.displayName, color: input.color });
      return { conceptId: entry.conceptId, presence: entry.presence.list() };
    },

    leaveRoom(room, actorId) {
      const entry = rooms.get(room);
      if (!entry) {
        return;
      }
      entry.presence.remove(actorId);
      disposeIfEmpty(room, entry);
    },

    listPresence(room) {
      const entry = getOpenRoom(room);
      if (!entry) {
        conceptIdFor(room);
        return [];
      }
      return entry.presence.list();
    },

    async persistSnapshot({ room, update, actorId }) {
      const conceptId = conceptIdFor(room);
      await deps.documents.applyCollabUpdate({ conceptId, update, actorId });
      deps.logger.debug("collab.snapshotPersisted", { room, bytes: update.byteLength });
    },

    roomCount() {
      let count = 0;
      for (const room of Array.from(rooms.keys())) {
        if (getOpenRoom(room)) {
          count += 1;
        }
      }
      return count;
    },
  };
}
