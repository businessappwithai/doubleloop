// tests/collab-server.test.ts — module m13 (collaboration). Exercises `createCollabServer` from
// `src/server/collab-server.ts` end-to-end against an in-memory `WebSocketServerFactory`, fake
// sockets and a fake timer — never a real socket or a real `setTimeout`. Uses a real
// `createCollabModule` (with a stubbed `CollabDocumentPort`) as the collaboration backend, so the
// relay's authorization/room-lifecycle behaviour is exercised through its real dependency rather
// than a hand-rolled double. Covers: binary sync-frame fan-out excluding the sender, an
// unauthorised room closing the connection instead of relaying, a malformed frame discarded
// without disposing the room, and debounced snapshot persistence firing once per burst.
import { describe, test, expect, vi } from "vitest";
import { createFakeClock } from "./helpers/fake-ports";
import { createCollabModule, type CollabDocumentPort, type CollabModule } from "../src/modules/collab/collab-module";
import {
  COLLAB_SOCKET_OPEN,
  createCollabServer,
  type CollabServer,
  type CollabServerRequest,
  type CollabServerTimer,
  type CollabSocket,
  type CollabTimerHandle,
  type CollabWebSocketServer,
  type WebSocketServerFactory,
} from "../src/server/collab-server";
import type { Logger } from "../src/server/ports";

const ROOM = "concept:30000000-0000-4000-8000-000000000001";

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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSocket extends CollabSocket {
  readyState: number;
  readonly sent: Uint8Array[];
  closed: { code: number | undefined; reason: string | undefined } | null;
  emitMessage(data: unknown, isBinary: boolean): void;
  emitClose(): void;
  emitError(err: Error): void;
}

function createFakeSocket(): FakeSocket {
  const messageListeners: Array<(data: unknown, isBinary: boolean) => void> = [];
  const closeListeners: Array<() => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const sent: Uint8Array[] = [];

  const socket: FakeSocket = {
    readyState: COLLAB_SOCKET_OPEN,
    sent,
    closed: null,
    send(data) {
      sent.push(data);
    },
    close(code, reason) {
      socket.closed = { code, reason };
      socket.readyState = 3; // CLOSED
    },
    on(event, listener) {
      if (event === "message") {
        messageListeners.push(listener as (data: unknown, isBinary: boolean) => void);
      } else if (event === "close") {
        closeListeners.push(listener as () => void);
      } else {
        errorListeners.push(listener as (err: Error) => void);
      }
    },
    emitMessage(data, isBinary) {
      messageListeners.forEach((listener) => listener(data, isBinary));
    },
    emitClose() {
      closeListeners.forEach((listener) => listener());
    },
    emitError(err) {
      errorListeners.forEach((listener) => listener(err));
    },
  };
  return socket;
}

interface FakeWsHarness {
  readonly factory: WebSocketServerFactory;
  readonly closeCalls: number[];
  connect(socket: CollabSocket, request: CollabServerRequest): void;
}

function createFakeWsFactory(): FakeWsHarness {
  const connectionListeners: Array<(socket: CollabSocket, request: CollabServerRequest) => void> = [];
  const closeCalls: number[] = [];
  let created = 0;

  const factory: WebSocketServerFactory = {
    create({ port }) {
      created += 1;
      const server: CollabWebSocketServer = {
        on(event, listener) {
          if (event === "connection") {
            connectionListeners.push(listener);
          }
        },
        close(callback) {
          closeCalls.push(port);
          callback();
        },
      };
      return server;
    },
  };

  return {
    factory,
    closeCalls,
    connect(socket, request) {
      connectionListeners.forEach((listener) => listener(socket, request));
    },
  };
}

interface FakeTimer {
  readonly timer: CollabServerTimer;
  pendingCount(): number;
  fireAll(): void;
}

function createFakeTimer(): FakeTimer {
  let nextId = 1;
  const pending = new Map<number, () => void>();

  const timer: CollabServerTimer = {
    setTimeout(handler) {
      const id = nextId;
      nextId += 1;
      pending.set(id, handler);
      return id as unknown as CollabTimerHandle;
    },
    clearTimeout(handle) {
      pending.delete(handle as unknown as number);
    },
  };

  return {
    timer,
    pendingCount: () => pending.size,
    fireAll() {
      const handlers = Array.from(pending.values());
      pending.clear();
      handlers.forEach((handler) => handler());
    },
  };
}

function connectionRequest(room: string, actorId: string, displayName: string, color: string): CollabServerRequest {
  const params = new URLSearchParams({ actorId, displayName, color });
  return { url: `/collab/${encodeURIComponent(room)}?${params.toString()}` };
}

function createDocumentPortStub(): CollabDocumentPort {
  return { applyCollabUpdate: vi.fn().mockResolvedValue(undefined) };
}

interface Harness {
  readonly server: CollabServer;
  readonly collab: CollabModule;
  readonly documents: CollabDocumentPort;
  readonly ws: FakeWsHarness;
  readonly timer: FakeTimer;
}

function createHarness(overrides: { snapshotDebounceMs?: number } = {}): Harness {
  const documents = createDocumentPortStub();
  const clock = createFakeClock();
  const logger = createSilentLogger();
  const collab = createCollabModule({ documents, clock, logger });
  const ws = createFakeWsFactory();
  const timer = createFakeTimer();
  const server = createCollabServer({
    collab,
    wsFactory: ws.factory,
    timer: timer.timer,
    logger,
    port: 1234,
    ...(overrides.snapshotDebounceMs !== undefined ? { snapshotDebounceMs: overrides.snapshotDebounceMs } : {}),
  });
  return { server, collab, documents, ws, timer };
}

const SYNC_FRAME = new Uint8Array([0, 1, 2, 3]);
const AWARENESS_FRAME = new Uint8Array([1, 9, 9]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCollabServer — relay fan-out", () => {
  test("relays a binary frame from one peer to every other peer in the room, never back to the sender", () => {
    const { server, ws } = createHarness();
    server.start();

    const socketA = createFakeSocket();
    const socketB = createFakeSocket();
    const socketC = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketB, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000002", "Bob", "green"));
    ws.connect(socketC, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000003", "Cy", "blue"));

    socketA.emitMessage(SYNC_FRAME, true);

    expect(socketA.sent).toEqual([]);
    expect(socketB.sent).toEqual([SYNC_FRAME]);
    expect(socketC.sent).toEqual([SYNC_FRAME]);
  });

  test("never relays into a different room", () => {
    const { server, ws } = createHarness();
    server.start();
    const otherRoom = "concept:30000000-0000-4000-8000-000000000009";

    const socketA = createFakeSocket();
    const socketOther = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketOther, connectionRequest(otherRoom, "20000000-0000-4000-8000-000000000002", "Bob", "green"));

    socketA.emitMessage(SYNC_FRAME, true);

    expect(socketOther.sent).toEqual([]);
  });

  test("does not relay to a peer whose socket is no longer open", () => {
    const { server, ws } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    const socketB = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketB, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000002", "Bob", "green"));
    socketB.readyState = 3; // CLOSED, but no "close" event fired yet

    socketA.emitMessage(SYNC_FRAME, true);

    expect(socketB.sent).toEqual([]);
  });
});

describe("createCollabServer — authorization", () => {
  test("closes the connection for an unauthorised room instead of relaying", () => {
    const { server, ws, collab } = createHarness();
    server.start();

    const socket = createFakeSocket();
    ws.connect(socket, connectionRequest("not-a-real-room", "20000000-0000-4000-8000-000000000001", "Ada", "red"));

    expect(socket.closed).not.toBeNull();
    expect(socket.closed?.code).toBe(4400);
    expect(collab.roomCount()).toBe(0);
  });

  test("closes the connection when a required connection parameter is missing", () => {
    const { server, ws } = createHarness();
    server.start();

    const socket = createFakeSocket();
    ws.connect(socket, { url: `/collab/${encodeURIComponent(ROOM)}` });

    expect(socket.closed).not.toBeNull();
    expect(socket.closed?.code).toBe(4400);
  });
});

describe("createCollabServer — malformed frames", () => {
  test("a text frame is discarded without being relayed or disposing the room", () => {
    const { server, ws, collab } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    const socketB = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketB, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000002", "Bob", "green"));

    socketA.emitMessage("not binary", false);

    expect(socketB.sent).toEqual([]);
    expect(collab.roomCount()).toBe(1);

    // the room still works for a well-formed frame afterwards
    socketA.emitMessage(SYNC_FRAME, true);
    expect(socketB.sent).toEqual([SYNC_FRAME]);
  });

  test("an empty binary frame is discarded", () => {
    const { server, ws } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    const socketB = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketB, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000002", "Bob", "green"));

    socketA.emitMessage(new Uint8Array(), true);

    expect(socketB.sent).toEqual([]);
  });

  test("a frame with an unrecognised message-type byte is discarded", () => {
    const { server, ws } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    const socketB = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketB, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000002", "Bob", "green"));

    socketA.emitMessage(new Uint8Array([99]), true);

    expect(socketB.sent).toEqual([]);
  });
});

describe("createCollabServer — debounced snapshot persistence", () => {
  test("a burst of sync frames flushes persistSnapshot exactly once, with the last update", async () => {
    const { server, ws, timer, documents } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));

    const first = new Uint8Array([0, 1]);
    const second = new Uint8Array([0, 2]);
    const third = new Uint8Array([0, 3]);
    socketA.emitMessage(first, true);
    socketA.emitMessage(second, true);
    socketA.emitMessage(third, true);

    expect(timer.pendingCount()).toBe(1);
    timer.fireAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(documents.applyCollabUpdate).toHaveBeenCalledTimes(1);
    expect(documents.applyCollabUpdate).toHaveBeenCalledWith({
      conceptId: "30000000-0000-4000-8000-000000000001",
      update: third,
      actorId: "20000000-0000-4000-8000-000000000001",
    });
  });

  test("awareness frames are relayed but never scheduled for persistence", () => {
    const { server, ws, timer } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    const socketB = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketB, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000002", "Bob", "green"));

    socketA.emitMessage(AWARENESS_FRAME, true);

    expect(socketB.sent).toEqual([AWARENESS_FRAME]);
    expect(timer.pendingCount()).toBe(0);
  });

  test("separate rooms debounce independently", () => {
    const { server, ws, timer } = createHarness();
    server.start();
    const otherRoom = "concept:30000000-0000-4000-8000-000000000009";
    const socketA = createFakeSocket();
    const socketOther = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketOther, connectionRequest(otherRoom, "20000000-0000-4000-8000-000000000002", "Bob", "green"));

    socketA.emitMessage(SYNC_FRAME, true);
    socketOther.emitMessage(SYNC_FRAME, true);

    expect(timer.pendingCount()).toBe(2);
  });
});

describe("createCollabServer — socket close", () => {
  test("closing a socket removes it from the relay set and leaves the collab room", () => {
    const { server, ws, collab } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    expect(collab.roomCount()).toBe(1);

    socketA.emitClose();

    expect(collab.roomCount()).toBe(0);
  });

  test("a socket error is logged, not thrown, and does not affect other peers", () => {
    const { server, ws } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    const socketB = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    ws.connect(socketB, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000002", "Bob", "green"));

    expect(() => socketA.emitError(new Error("boom"))).not.toThrow();

    socketA.emitMessage(SYNC_FRAME, true);
    expect(socketB.sent).toEqual([SYNC_FRAME]);
  });
});

describe("createCollabServer — start/stop", () => {
  test("stop() clears pending debounce timers and closes the websocket server", async () => {
    const { server, ws, timer } = createHarness();
    server.start();
    const socketA = createFakeSocket();
    ws.connect(socketA, connectionRequest(ROOM, "20000000-0000-4000-8000-000000000001", "Ada", "red"));
    socketA.emitMessage(SYNC_FRAME, true);
    expect(timer.pendingCount()).toBe(1);

    await server.stop();

    expect(timer.pendingCount()).toBe(0);
    expect(ws.closeCalls).toEqual([1234]);
  });

  test("stop() before start() resolves without error", async () => {
    const { server } = createHarness();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
