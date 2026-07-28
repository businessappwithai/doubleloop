// tests/collab-module.test.ts — module m13 (collaboration). Exercises `createCollabModule` from
// `src/modules/collab/collab-module.ts` against a hand-stubbed `CollabDocumentPort` (never the
// real `DocumentModule`) and the fake clock: room creation/reuse/disposal, presence propagation,
// an unauthorised room raising `ForbiddenError('collab.roomForbidden')`, `roomNameFor`/
// `conceptIdFor` round-tripping, and `persistSnapshot` delegating to the injected port.
import { describe, test, expect, vi } from "vitest";
import { createFakeClock } from "./helpers/fake-ports";
import { asActorId, asConceptId } from "../src/core/ids";
import { ForbiddenError } from "../src/core/errors";
import {
  conceptIdFor,
  createCollabModule,
  roomNameFor,
  type CollabDocumentPort,
  type CollabModuleDeps,
} from "../src/modules/collab/collab-module";
import type { Logger } from "../src/server/ports";

const CONCEPT_ID = asConceptId("30000000-0000-4000-8000-000000000001");
const OTHER_CONCEPT_ID = asConceptId("30000000-0000-4000-8000-000000000002");
const ROOM = roomNameFor(CONCEPT_ID);
const ACTOR_A = asActorId("20000000-0000-4000-8000-000000000001");
const ACTOR_B = asActorId("20000000-0000-4000-8000-000000000002");

function createSilentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

function createDocumentPortStub(): CollabDocumentPort {
  return { applyCollabUpdate: vi.fn().mockResolvedValue(undefined) };
}

function createModule(overrides: Partial<CollabModuleDeps> = {}) {
  const documents = overrides.documents ?? createDocumentPortStub();
  const clock = overrides.clock ?? createFakeClock();
  const logger = overrides.logger ?? createSilentLogger();
  const deps: CollabModuleDeps = {
    documents,
    clock,
    logger,
    ...(overrides.idleThresholdMs !== undefined ? { idleThresholdMs: overrides.idleThresholdMs } : {}),
  };
  return { module: createCollabModule(deps), documents, clock, logger };
}

describe("roomNameFor / conceptIdFor", () => {
  test("roomNameFor produces a 'concept:<uuid>' room name", () => {
    expect(roomNameFor(CONCEPT_ID)).toBe(`concept:${CONCEPT_ID}`);
  });

  test("conceptIdFor round-trips a room produced by roomNameFor", () => {
    expect(conceptIdFor(roomNameFor(CONCEPT_ID))).toBe(CONCEPT_ID);
  });

  test("conceptIdFor throws ForbiddenError('collab.roomForbidden') for a room missing the prefix", () => {
    try {
      conceptIdFor(CONCEPT_ID);
      throw new Error("expected conceptIdFor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details["reason"]).toBe("collab.roomForbidden");
    }
  });

  test("conceptIdFor throws ForbiddenError('collab.roomForbidden') for a malformed local id", () => {
    try {
      conceptIdFor("concept:not-a-uuid");
      throw new Error("expected conceptIdFor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details["reason"]).toBe("collab.roomForbidden");
    }
  });

  test("conceptIdFor throws ForbiddenError('collab.roomForbidden') for an empty room", () => {
    expect(() => conceptIdFor("")).toThrow(ForbiddenError);
  });
});

describe("createCollabModule.joinRoom / roomCount", () => {
  test("the first join creates a room", () => {
    const { module } = createModule();
    expect(module.roomCount()).toBe(0);

    module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });

    expect(module.roomCount()).toBe(1);
  });

  test("a second join to the same room reuses it rather than creating another", () => {
    const { module } = createModule();

    module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });
    module.joinRoom({ room: ROOM, actorId: ACTOR_B, displayName: "Bob", color: "green" });

    expect(module.roomCount()).toBe(1);
    expect(module.listPresence(ROOM)).toHaveLength(2);
  });

  test("joining returns the resolved conceptId and the current presence list", () => {
    const { module } = createModule();

    const first = module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });
    expect(first.conceptId).toBe(CONCEPT_ID);
    expect(first.presence.map((entry) => entry.actorId)).toEqual([ACTOR_A]);

    const second = module.joinRoom({ room: ROOM, actorId: ACTOR_B, displayName: "Bob", color: "green" });
    expect(second.presence.map((entry) => entry.actorId).sort()).toEqual([ACTOR_A, ACTOR_B].sort());
  });

  test("joining an unauthorised room raises ForbiddenError('collab.roomForbidden') without creating a room", () => {
    const { module } = createModule();

    try {
      module.joinRoom({ room: "not-a-room", actorId: ACTOR_A, displayName: "Ada", color: "red" });
      throw new Error("expected joinRoom to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details["reason"]).toBe("collab.roomForbidden");
    }
    expect(module.roomCount()).toBe(0);
  });

  test("joining distinct rooms is tracked independently", () => {
    const { module } = createModule();
    const otherRoom = roomNameFor(OTHER_CONCEPT_ID);

    module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });
    module.joinRoom({ room: otherRoom, actorId: ACTOR_B, displayName: "Bob", color: "green" });

    expect(module.roomCount()).toBe(2);
  });
});

describe("createCollabModule.leaveRoom", () => {
  test("leaving while another peer remains keeps the room open", () => {
    const { module } = createModule();
    module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });
    module.joinRoom({ room: ROOM, actorId: ACTOR_B, displayName: "Bob", color: "green" });

    module.leaveRoom(ROOM, ACTOR_A);

    expect(module.roomCount()).toBe(1);
    expect(module.listPresence(ROOM).map((entry) => entry.actorId)).toEqual([ACTOR_B]);
  });

  test("the last leave disposes the room", () => {
    const { module } = createModule();
    module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });
    module.joinRoom({ room: ROOM, actorId: ACTOR_B, displayName: "Bob", color: "green" });

    module.leaveRoom(ROOM, ACTOR_A);
    module.leaveRoom(ROOM, ACTOR_B);

    expect(module.roomCount()).toBe(0);
    expect(module.listPresence(ROOM)).toEqual([]);
  });

  test("leaving a room nobody joined, or an actor never joined, is a no-op", () => {
    const { module } = createModule();
    module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });

    expect(() => module.leaveRoom(ROOM, ACTOR_B)).not.toThrow();
    expect(() => module.leaveRoom(roomNameFor(OTHER_CONCEPT_ID), ACTOR_A)).not.toThrow();
    expect(module.roomCount()).toBe(1);
  });

  test("a room re-created after disposal starts with empty presence", () => {
    const { module } = createModule();
    module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });
    module.leaveRoom(ROOM, ACTOR_A);
    expect(module.roomCount()).toBe(0);

    const rejoin = module.joinRoom({ room: ROOM, actorId: ACTOR_B, displayName: "Bob", color: "green" });

    expect(rejoin.presence.map((entry) => entry.actorId)).toEqual([ACTOR_B]);
    expect(module.roomCount()).toBe(1);
  });
});

describe("createCollabModule.listPresence", () => {
  test("returns [] for a valid room nobody has joined", () => {
    const { module } = createModule();
    expect(module.listPresence(ROOM)).toEqual([]);
  });

  test("throws ForbiddenError('collab.roomForbidden') for an unrecognised room even when nobody is present", () => {
    const { module } = createModule();
    expect(() => module.listPresence("nonsense")).toThrow(ForbiddenError);
  });

  test("no longer lists a peer evicted by idle eviction", () => {
    const clock = createFakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const { module } = createModule({ clock, idleThresholdMs: 1_000 });
    module.joinRoom({ room: ROOM, actorId: ACTOR_A, displayName: "Ada", color: "red" });

    clock.advance(1_001);

    expect(module.listPresence(ROOM)).toEqual([]);
  });
});

describe("createCollabModule.persistSnapshot", () => {
  test("delegates to the injected CollabDocumentPort with the resolved conceptId", async () => {
    const { module, documents } = createModule();
    const update = new Uint8Array([1, 2, 3]);

    await module.persistSnapshot({ room: ROOM, update, actorId: ACTOR_A });

    expect(documents.applyCollabUpdate).toHaveBeenCalledWith({ conceptId: CONCEPT_ID, update, actorId: ACTOR_A });
  });

  test("rejects with ForbiddenError('collab.roomForbidden') for an unauthorised room without calling the port", async () => {
    const { module, documents } = createModule();

    await expect(module.persistSnapshot({ room: "bad-room", update: new Uint8Array(), actorId: ACTOR_A })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(documents.applyCollabUpdate).not.toHaveBeenCalled();
  });

  test("propagates a port failure unchanged", async () => {
    const failure = new Error("db unreachable");
    const documents: CollabDocumentPort = { applyCollabUpdate: vi.fn().mockRejectedValue(failure) };
    const { module } = createModule({ documents });

    await expect(
      module.persistSnapshot({ room: ROOM, update: new Uint8Array([9]), actorId: ACTOR_A }),
    ).rejects.toBe(failure);
  });
});
