// src/collab/provider.ts — wraps y-websocket's WebsocketProvider for the Lexical/Yjs
// collaboration plugin. The socket constructor is always injected as `WebSocketPolyfill` (never
// the ambient `WebSocket` global), so this module never opens a real network connection on its
// own and tests can supply a fake. y-websocket has its own exponential-backoff reconnect loop,
// but it drives it off the bare global `setTimeout` with no way to observe or inject it, which
// makes its timing untestable. We cancel that loop and replace it with our own, driven by an
// injectable `CollabTimer`, so backoff growth/cap is deterministic under `vi.useFakeTimers()`.
//
// The cancellation has to be a direct `shouldConnect = false` field write, not a call to the
// provider's own `disconnect()` method: y-websocket's `closeWebsocketConnection` emits
// `'connection-close'` *before* it nulls out `provider.ws` (see its source), so a synchronous
// `disconnect()` call from inside our `'connection-close'` handler would see `provider.ws` still
// set to the very socket being closed and re-enter `closeWebsocketConnection` on it — infinite
// recursion. Writing the field directly has the same cancelling effect with no re-entrancy.
//
// `'connection-close'` (not `'status'`) is the hook for reconnection: `'status':'disconnected'`
// only fires when a *previously open* connection drops, never for a connection attempt that fails
// before it ever opens — exactly the case a reconnect loop most needs to handle. `'connection-close'`
// fires unconditionally in both cases.
import { WebsocketProvider } from "y-websocket";
import type { Doc } from "yjs";
import type { Provider, ProviderAwareness } from "@lexical/yjs";

export type CollabStatus = "connecting" | "connected" | "disconnected" | "error";

/**
 * Structurally matches y-websocket's `WebSocketPolyfill` constructor option: a `WebSocket`-shaped
 * class. Production code passes the ambient `WebSocket`; tests pass a fake that never touches
 * the network.
 */
export interface WebSocketPolyfillCtor {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
  readonly CLOSED: number;
  readonly CLOSING: number;
  readonly CONNECTING: number;
  readonly OPEN: number;
}

export type CollabTimerHandle = ReturnType<typeof setTimeout>;

/** Injectable timer for reconnect scheduling, so tests can assert backoff delays deterministically. */
export interface CollabTimer {
  setTimeout(handler: () => void, delayMs: number): CollabTimerHandle;
  clearTimeout(handle: CollabTimerHandle): void;
}

const defaultTimer: CollabTimer = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface CreateCollabProviderOptions {
  /** The Yjs room / document name, appended to `wsUrl` by y-websocket. */
  readonly room: string;
  readonly wsUrl: string;
  readonly doc: Doc;
  readonly WebSocketPolyfill: WebSocketPolyfillCtor;
  readonly onStatus?: (status: CollabStatus) => void;
  readonly timer?: CollabTimer;
  /** First reconnect delay, in ms. Doubles on each subsequent failure. @default 500 */
  readonly initialBackoffMs?: number;
  /** Reconnect delay ceiling, in ms. @default 10_000 */
  readonly maxBackoffMs?: number;
}

/** The `Provider` shape the `@lexical/react` collaboration plugin binds to, plus our own status. */
export interface CollabProvider extends Provider {
  readonly awareness: ProviderAwareness;
  readonly status: CollabStatus;
  connect(): void;
  disconnect(): void;
}

/**
 * Creates a `Provider` for a single Yjs room over `y-websocket`, with our own capped/growing
 * reconnect backoff (see module header for why we don't use y-websocket's built-in one).
 */
export function createCollabProvider(options: CreateCollabProviderOptions): CollabProvider {
  const {
    room,
    wsUrl,
    doc,
    WebSocketPolyfill,
    onStatus,
    timer = defaultTimer,
    initialBackoffMs = 500,
    maxBackoffMs = 10_000,
  } = options;

  const wsProvider = new WebsocketProvider(wsUrl, room, doc, {
    connect: false,
    WebSocketPolyfill,
    disableBc: true,
  });

  let status: CollabStatus = "disconnected";
  let shouldStayConnected = false;
  let reconnectAttempt = 0;
  let pendingReconnect: CollabTimerHandle | null = null;

  function setStatus(next: CollabStatus): void {
    status = next;
    onStatus?.(next);
  }

  function clearPendingReconnect(): void {
    if (pendingReconnect !== null) {
      timer.clearTimeout(pendingReconnect);
      pendingReconnect = null;
    }
  }

  /** Schedules the next reconnect attempt at the current backoff delay, then grows it. */
  function scheduleReconnect(): void {
    if (!shouldStayConnected || pendingReconnect !== null) {
      return;
    }
    const delay = Math.min(initialBackoffMs * 2 ** reconnectAttempt, maxBackoffMs);
    reconnectAttempt += 1;
    pendingReconnect = timer.setTimeout(() => {
      pendingReconnect = null;
      if (shouldStayConnected) {
        wsProvider.connect();
      }
    }, delay);
  }

  wsProvider.on("status", ({ status: wsStatus }) => {
    if (wsStatus === "connected") {
      reconnectAttempt = 0;
      clearPendingReconnect();
      setStatus("connected");
    } else if (wsStatus === "connecting") {
      setStatus("connecting");
    }
    // "disconnected" is handled uniformly by the 'connection-close' listener below, which also
    // covers the "never got to open" case this event does not (see module header).
  });

  // Fires for every socket close, whether or not it ever reached "connected" — see module header.
  wsProvider.on("connection-close", () => {
    wsProvider.shouldConnect = false;
    setStatus("disconnected");
    scheduleReconnect();
  });

  // A socket error is surfaced through `onStatus`, never thrown; the subsequent close (real
  // sockets always close after erroring) drives reconnection via the listener above.
  wsProvider.on("connection-error", () => {
    setStatus("error");
  });

  function connect(): void {
    shouldStayConnected = true;
    reconnectAttempt = 0;
    clearPendingReconnect();
    wsProvider.connect();
  }

  function disconnect(): void {
    shouldStayConnected = false;
    clearPendingReconnect();
    wsProvider.disconnect();
    setStatus("disconnected");
  }

  return {
    awareness: wsProvider.awareness,
    get status() {
      return status;
    },
    connect,
    disconnect,
    // y-websocket's ObservableV2 accepts any event name at runtime (see lib0/observable.js) —
    // the cast below only widens the compile-time surface to the full `Provider` event union,
    // which includes 'update'/'reload' that this single-connection provider never emits.
    on: wsProvider.on.bind(wsProvider) as Provider["on"],
    off: wsProvider.off.bind(wsProvider) as Provider["off"],
  };
}
