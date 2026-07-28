// src/server/collab-server.ts — the standalone collaboration relay (Implementation.md m13,
// `npm run collab`). A dumb `ws` relay: it authorises a room through `CollabModule.joinRoom`,
// forwards binary y-protocols sync/awareness frames to every other peer in the room but never
// back to the sender, and debounces persistence through `CollabModule.persistSnapshot`. It
// contains no domain logic and no SQL of its own — everything domain-shaped goes through
// `CollabModule`, per Architecture.md's "the `ws` server ... calls only this interface".
//
// The websocket server and every timer are injected (`WebSocketServerFactory`, `CollabServerTimer`)
// so `createCollabServer` never touches a real socket or a real clock on its own; `tests/
// collab-server.test.ts` drives it entirely with in-memory fakes. Only `main()`, gated by
// `isMainModule()`, assembles the real `ws`/Node adapters, and is never invoked by a test.
//
// `main()` is also the one place in this file allowed to import another feature module
// (`../modules/documents`): `collab-module.ts` depends only on its own minimal `CollabDocumentPort`
// (see that file's header for why), and something has to bridge a real `DocumentModule` into that
// port. That bridge is composition-root work — the same role `documents/index.ts` plays for its
// own module's repository — not something `collab-module.ts` itself may do.
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig } from "../config/config";
import { createLogger } from "../lib/logger";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../core/errors";
import type { ActorId, ConceptId } from "../core/ids";
import { asActorId } from "../core/ids";
import { createNodeClock } from "./adapters/node-clock";
import { createRandomIds } from "./adapters/random-ids";
import { PgDb } from "./adapters/pg-db";
import type { Db, Logger } from "./ports";
import { createCollabModule, type CollabDocumentPort, type CollabModule } from "../modules/collab/collab-module";
import { createDocumentModule, createDocumentRepository, type DocumentModule } from "../modules/documents";

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

export type CollabTimerHandle = ReturnType<typeof setTimeout>;

/** Injectable timer for debounced snapshot flushes, so tests assert debounce behaviour deterministically. */
export interface CollabServerTimer {
  setTimeout(handler: () => void, delayMs: number): CollabTimerHandle;
  clearTimeout(handle: CollabTimerHandle): void;
}

/** Matches the standard `WebSocket.OPEN` value shared by `ws` and the browser `WebSocket`. */
export const COLLAB_SOCKET_OPEN = 1;

/**
 * The minimal slice of a `ws` `WebSocket` this relay needs. Structurally compatible with the real
 * thing, so the production adapter below is a plain cast, not a wrapper class — but a test fake
 * only has to implement this, never open a real socket.
 */
export interface CollabSocket {
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

/** The minimal slice of `http.IncomingMessage` this relay reads: the raw request path/query. */
export interface CollabServerRequest {
  readonly url: string | undefined;
}

/** The minimal slice of a `ws` `WebSocketServer` this relay needs. */
export interface CollabWebSocketServer {
  on(event: "connection", listener: (socket: CollabSocket, request: CollabServerRequest) => void): void;
  close(callback: (err?: Error) => void): void;
}

/** Constructs the (possibly real) websocket server. Injected so tests never bind a real port. */
export interface WebSocketServerFactory {
  create(options: { port: number }): CollabWebSocketServer;
}

// ---------------------------------------------------------------------------
// y-protocols frame validation
// ---------------------------------------------------------------------------

/** y-protocols message-type byte values this relay recognises (`y-websocket`'s `utils.js`). */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;
const VALID_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  MESSAGE_AUTH,
  MESSAGE_QUERY_AWARENESS,
]);

/**
 * Validates and narrows an incoming `ws` message to a non-empty binary y-protocols frame. Returns
 * `null` for anything else — a text frame, an empty frame, or an unrecognised message-type byte —
 * which the caller discards without touching the room.
 */
function toValidFrame(data: unknown, isBinary: boolean): Uint8Array | null {
  if (!isBinary || !(data instanceof Uint8Array) || data.byteLength === 0) {
    return null;
  }
  const messageType = data[0];
  if (messageType === undefined || !VALID_MESSAGE_TYPES.has(messageType)) {
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Connection parameters
// ---------------------------------------------------------------------------

interface ConnectionParams {
  readonly room: string;
  readonly actorId: ActorId;
  readonly displayName: string;
  readonly color: string;
}

const COLLAB_PATH_PREFIX = "/collab/";

function requireParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null || value.trim().length === 0) {
    throw new ValidationError(`missing required query parameter "${name}"`, {
      details: { reason: "collab.missingParam", name },
    });
  }
  return value;
}

/**
 * Parses `request.url` into the room + actor identity a client must supply to join. Throws
 * `ValidationError` for a missing/blank parameter, or lets `asActorId` throw the same for a
 * malformed `actorId` — both surface identically to `handleConnection`'s catch below.
 */
function parseConnectionParams(rawUrl: string | undefined): ConnectionParams {
  const url = new URL(rawUrl ?? "", "http://collab.internal");
  const room = url.pathname.startsWith(COLLAB_PATH_PREFIX)
    ? decodeURIComponent(url.pathname.slice(COLLAB_PATH_PREFIX.length))
    : "";
  const actorId = asActorId(requireParam(url.searchParams, "actorId"));
  const displayName = requireParam(url.searchParams, "displayName");
  const color = requireParam(url.searchParams, "color");
  return { room, actorId, displayName, color };
}

// ---------------------------------------------------------------------------
// createCollabServer
// ---------------------------------------------------------------------------

export interface CollabServerDeps {
  readonly collab: CollabModule;
  readonly wsFactory: WebSocketServerFactory;
  readonly timer: CollabServerTimer;
  readonly logger: Logger;
  readonly port: number;
  /** Idle window before a burst of sync frames is flushed to `persistSnapshot`. @default 250 */
  readonly snapshotDebounceMs?: number;
}

export interface CollabServer {
  start(): void;
  stop(): Promise<void>;
}

export const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 250;

function closeConnection(socket: CollabSocket, err: unknown, logger: Logger): void {
  if (err instanceof AppError) {
    logger.warn("collab.connectionRejected", { code: err.code, reason: err.details["reason"] });
    socket.close(4400, err.message.slice(0, 120));
    return;
  }
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error("collab.connectionFailed", { message: error.message });
  socket.close(1011, "internal error");
}

/** Builds the relay. Nothing here touches a real socket or a real timer until `start()` runs. */
export function createCollabServer(deps: CollabServerDeps): CollabServer {
  const debounceMs = deps.snapshotDebounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS;
  const roomSockets = new Map<string, Set<CollabSocket>>();
  const pendingFlushes = new Map<string, { timer: CollabTimerHandle }>();
  let server: CollabWebSocketServer | undefined;

  function addSocket(room: string, socket: CollabSocket): void {
    let set = roomSockets.get(room);
    if (!set) {
      set = new Set();
      roomSockets.set(room, set);
    }
    set.add(socket);
  }

  function removeSocket(room: string, socket: CollabSocket): void {
    const set = roomSockets.get(room);
    if (!set) {
      return;
    }
    set.delete(socket);
    if (set.size === 0) {
      roomSockets.delete(room);
    }
  }

  function relay(room: string, sender: CollabSocket, frame: Uint8Array): void {
    const set = roomSockets.get(room);
    if (!set) {
      return;
    }
    for (const peer of set) {
      if (peer === sender || peer.readyState !== COLLAB_SOCKET_OPEN) {
        continue;
      }
      peer.send(frame);
    }
  }

  function scheduleFlush(room: string, update: Uint8Array, actorId: ActorId): void {
    const existing = pendingFlushes.get(room);
    if (existing) {
      deps.timer.clearTimeout(existing.timer);
    }
    const timer = deps.timer.setTimeout(() => {
      pendingFlushes.delete(room);
      deps.collab.persistSnapshot({ room, update, actorId }).catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        deps.logger.error("collab.snapshotPersistFailed", { room, message: error.message });
      });
    }, debounceMs);
    pendingFlushes.set(room, { timer });
  }

  function handleConnection(socket: CollabSocket, request: CollabServerRequest): void {
    let params: ConnectionParams;
    try {
      params = parseConnectionParams(request.url);
    } catch (err) {
      closeConnection(socket, err, deps.logger);
      return;
    }

    try {
      deps.collab.joinRoom({
        room: params.room,
        actorId: params.actorId,
        displayName: params.displayName,
        color: params.color,
      });
    } catch (err) {
      closeConnection(socket, err, deps.logger);
      return;
    }

    addSocket(params.room, socket);

    socket.on("message", (data, isBinary) => {
      const frame = toValidFrame(data, isBinary);
      if (!frame) {
        deps.logger.warn("collab.malformedFrame", { room: params.room });
        return;
      }
      relay(params.room, socket, frame);
      if (frame[0] === MESSAGE_SYNC) {
        scheduleFlush(params.room, frame, params.actorId);
      }
    });

    socket.on("close", () => {
      removeSocket(params.room, socket);
      deps.collab.leaveRoom(params.room, params.actorId);
    });

    socket.on("error", (err) => {
      deps.logger.warn("collab.socketError", { room: params.room, message: err.message });
    });
  }

  return {
    start() {
      if (server) {
        return;
      }
      server = deps.wsFactory.create({ port: deps.port });
      server.on("connection", handleConnection);
      deps.logger.info("collab.serverStarted", { port: deps.port });
    },

    stop() {
      for (const pending of pendingFlushes.values()) {
        deps.timer.clearTimeout(pending.timer);
      }
      pendingFlushes.clear();
      const current = server;
      server = undefined;
      if (!current) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        current.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Production bootstrap (never invoked by a test)
// ---------------------------------------------------------------------------

async function fetchConceptTitle(db: Db, conceptId: ConceptId): Promise<string> {
  const { rows } = await db.query<{ title: string }>(
    "SELECT title FROM concepts WHERE id = $1 AND deleted_at IS NULL",
    [conceptId],
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError("concept not found", { details: { reason: "concept.notFound", conceptId } });
  }
  return row.title;
}

/**
 * Bridges a real `DocumentModule` into the minimal `CollabDocumentPort` `collab-module.ts` needs
 * (see that file's header). Retries once on a stale-version `ConflictError` — a real race between
 * two flushes on the same room — then gives up loudly rather than looping forever.
 */
function createDocumentSnapshotPort(documents: DocumentModule, db: Db): CollabDocumentPort {
  const MAX_ATTEMPTS = 2;
  return {
    async applyCollabUpdate({ conceptId, update, actorId }) {
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const [current, title] = await Promise.all([documents.load(conceptId), fetchConceptTitle(db, conceptId)]);
        try {
          await documents.applyCrdtUpdate({
            conceptId,
            title,
            update,
            expectedVersion: current.version,
            actorId,
            source: "editor",
          });
          return;
        } catch (err) {
          if (!(err instanceof ConflictError)) {
            throw err;
          }
          lastError = err;
        }
      }
      throw lastError;
    },
  };
}

function createProductionWsFactory(): WebSocketServerFactory {
  return {
    create({ port }) {
      const wss = new WebSocketServer({ port });
      return {
        on(event, listener) {
          wss.on(event, (socket, request) => {
            listener(socket as unknown as CollabSocket, { url: request.url });
          });
        },
        close(callback) {
          wss.close(callback);
        },
      };
    },
  };
}

const productionTimer: CollabServerTimer = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const clock = createNodeClock();
  const logger = createLogger({ level: config.logLevel, clock }).child({ service: "collab-server" });
  const db = new PgDb(config, logger);

  const documents = createDocumentModule({
    repo: createDocumentRepository(db),
    ids: createRandomIds(),
    logger: logger.child({ module: "documents" }),
  });

  const collab = createCollabModule({
    documents: createDocumentSnapshotPort(documents, db),
    clock,
    logger: logger.child({ module: "collab" }),
  });

  const server = createCollabServer({
    collab,
    wsFactory: createProductionWsFactory(),
    timer: productionTimer,
    logger,
    port: config.collab.port,
  });

  server.start();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.stop().finally(() => process.exit(0));
    });
  }
}

if (isMainModule()) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
