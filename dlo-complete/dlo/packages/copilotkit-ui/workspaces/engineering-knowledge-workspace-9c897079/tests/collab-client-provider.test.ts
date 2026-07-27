// tests/collab-client-provider.test.ts — module m19 (Yjs collaboration client). Exercises the
// real `y-websocket` `WebsocketProvider` with a fake `WebSocket` polyfill injected in every test
// (per src/collab/provider.ts's own contract — the ambient `WebSocket` global is never touched),
// asserting connect/disconnect status transitions, our own capped/growing reconnect backoff
// driven entirely by an injected `CollabTimer` (never a real timer), and that a socket error
// surfaces through `onStatus` rather than being thrown.
import { describe, test, expect, beforeEach } from "vitest";
import { Doc } from "yjs";
import {
  createCollabProvider,
  type CollabStatus,
  type CollabTimer,
  type CollabTimerHandle,
  type CreateCollabProviderOptions,
  type WebSocketPolyfillCtor,
} from "../src/collab/provider";

// ---------------------------------------------------------------------------
// FakeWebSocket — a controllable stand-in for the WebSocket the provider is
// forbidden from constructing on its own. Every open/close/error transition is
// driven explicitly by the test, never by real network or timer activity.
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  triggerClose(event: unknown = { type: "close" }): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(event);
  }

  triggerError(event: unknown = { type: "error" }): void {
    this.onerror?.(event);
  }
}

const FakeWebSocketCtor = FakeWebSocket as unknown as WebSocketPolyfillCtor;

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) {
    throw new Error("expected a FakeWebSocket to have been constructed");
  }
  return socket;
}

// ---------------------------------------------------------------------------
// FakeCollabTimer — records every scheduled delay so backoff growth/cap is
// asserted directly, and fires callbacks only when the test tells it to.
// ---------------------------------------------------------------------------

function createFakeCollabTimer() {
  let nextHandle = 1;
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];

  const timer: CollabTimer = {
    setTimeout(handler, delayMs) {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.set(handle, handler);
      delays.push(delayMs);
      return handle as unknown as CollabTimerHandle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle as unknown as number);
    },
  };

  return {
    timer,
    delays,
    pendingCount: () => scheduled.size,
    /** Fires (and removes) the oldest still-pending scheduled callback. */
    fireOldest(): void {
      const oldest = [...scheduled.entries()][0];
      if (!oldest) {
        throw new Error("no pending timer to fire");
      }
      const [handle, handler] = oldest;
      scheduled.delete(handle);
      handler();
    },
  };
}

function setup(overrides: Partial<CreateCollabProviderOptions> = {}) {
  const statuses: CollabStatus[] = [];
  const fakeTimer = createFakeCollabTimer();
  const doc = new Doc();
  const provider = createCollabProvider({
    room: "room-1",
    wsUrl: "ws://localhost:1234",
    doc,
    WebSocketPolyfill: FakeWebSocketCtor,
    onStatus: (status) => statuses.push(status),
    timer: fakeTimer.timer,
    ...overrides,
  });
  return { provider, statuses, fakeTimer, doc };
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
});

describe("createCollabProvider — connect/disconnect status transitions", () => {
  test("connect() reports connecting then connected once the socket opens", () => {
    const { provider, statuses } = setup();
    provider.connect();
    expect(statuses).toEqual(["connecting"]);
    expect(provider.status).toBe("connecting");

    latestSocket().triggerOpen();
    expect(statuses).toEqual(["connecting", "connected"]);
    expect(provider.status).toBe("connected");
  });

  test("disconnect() before ever connecting reports disconnected and constructs no socket", () => {
    const { provider, statuses } = setup();
    provider.disconnect();
    expect(provider.status).toBe("disconnected");
    expect(statuses).toEqual(["disconnected"]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test("disconnect() after connecting reports disconnected and schedules no reconnect", () => {
    const { provider, statuses, fakeTimer } = setup();
    provider.connect();
    latestSocket().triggerOpen();

    provider.disconnect();

    expect(provider.status).toBe("disconnected");
    expect(statuses.at(-1)).toBe("disconnected");
    expect(fakeTimer.pendingCount()).toBe(0);
  });

  test("connect() called again while a reconnect is pending cancels the pending timer", () => {
    const { provider, fakeTimer } = setup();
    provider.connect();
    latestSocket().triggerClose();
    expect(fakeTimer.pendingCount()).toBe(1);

    provider.connect();

    expect(fakeTimer.pendingCount()).toBe(0);
  });

  test("no real WebSocket is constructed — only the injected polyfill", () => {
    const { provider } = setup();
    provider.connect();
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
    for (const socket of FakeWebSocket.instances) {
      expect(socket).toBeInstanceOf(FakeWebSocket);
    }
  });
});

describe("createCollabProvider — reconnect backoff", () => {
  test("grows exponentially, caps at maxBackoffMs, and resets after a successful connect", () => {
    const { provider, fakeTimer } = setup({ initialBackoffMs: 100, maxBackoffMs: 400 });

    provider.connect();
    latestSocket().triggerClose(); // never opened — connection attempt failed outright
    expect(fakeTimer.delays).toEqual([100]);

    fakeTimer.fireOldest(); // reconnect attempt #1
    latestSocket().triggerClose();
    expect(fakeTimer.delays).toEqual([100, 200]);

    fakeTimer.fireOldest(); // reconnect attempt #2
    latestSocket().triggerClose();
    expect(fakeTimer.delays).toEqual([100, 200, 400]);

    fakeTimer.fireOldest(); // reconnect attempt #3 — would be 800, capped to 400
    latestSocket().triggerClose();
    expect(fakeTimer.delays).toEqual([100, 200, 400, 400]);

    fakeTimer.fireOldest(); // reconnect attempt #4 — this one succeeds
    latestSocket().triggerOpen();
    expect(provider.status).toBe("connected");

    latestSocket().triggerClose(); // drops again after a successful connect
    expect(fakeTimer.delays).toEqual([100, 200, 400, 400, 100]); // backoff restarted from the base
  });

  test("uses the documented defaults (500ms initial, 10000ms cap) when not overridden", () => {
    const { provider, fakeTimer } = setup();
    provider.connect();
    latestSocket().triggerClose();
    expect(fakeTimer.delays).toEqual([500]);
  });
});

describe("createCollabProvider — socket errors", () => {
  test("a socket error surfaces through onStatus rather than being thrown", () => {
    const { provider, statuses } = setup();
    provider.connect();

    expect(() => latestSocket().triggerError()).not.toThrow();

    expect(statuses).toContain("error");
    expect(provider.status).toBe("error");
  });

  test("an error followed by the socket closing still drives reconnection", () => {
    const { provider, fakeTimer, statuses } = setup({ initialBackoffMs: 250 });
    provider.connect();

    latestSocket().triggerError();
    expect(statuses.at(-1)).toBe("error");

    latestSocket().triggerClose();
    expect(fakeTimer.delays).toEqual([250]);
  });
});

describe("createCollabProvider — awareness passthrough", () => {
  test("exposes the underlying WebsocketProvider's awareness instance", () => {
    const { provider } = setup();
    expect(provider.awareness).toBeDefined();
    expect(typeof provider.awareness.getStates).toBe("function");
    expect(typeof provider.awareness.setLocalState).toBe("function");
  });
});
