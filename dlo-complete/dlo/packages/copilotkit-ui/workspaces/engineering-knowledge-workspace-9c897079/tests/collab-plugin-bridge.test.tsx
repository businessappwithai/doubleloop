// tests/collab-plugin-bridge.test.tsx — module m19 (Yjs collaboration client). Covers
// `isRoomEmpty` directly against real Yjs `Doc`s, and that `CollaborationPluginBridge` computes
// `shouldBootstrap` from it, forwards `initialEditorState` only when bootstrapping with
// `initialMarkdown` given, and wires its `providerFactory` to `createCollabProvider` with the
// room's own Doc and options. `@lexical/react`'s `CollaborationPlugin` and this module's own
// `createCollabProvider` are both mocked: the real Yjs binding/sync machinery is `@lexical/react`'s
// own tested concern (and provider.ts has its own dedicated test file), not this bridge's.
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { Doc, XmlText } from "yjs";
import type { LexicalEditor } from "lexical";
import type { CreateCollabProviderOptions, WebSocketPolyfillCtor } from "../src/collab/provider";
import { CollaborationPluginBridge, isRoomEmpty } from "../src/collab/CollaborationPluginBridge";

vi.mock("@lexical/react/LexicalCollaborationPlugin", () => ({
  CollaborationPlugin: vi.fn((props: { id: string; providerFactory: (id: string, map: Map<string, Doc>) => unknown }) => {
    props.providerFactory(props.id, new Map());
    return null;
  }),
}));

vi.mock("../src/collab/provider", () => ({
  createCollabProvider: vi.fn(() => ({
    awareness: {
      getStates: () => new Map(),
      getLocalState: () => null,
      setLocalState: () => {},
      setLocalStateField: () => {},
      on: () => {},
      off: () => {},
    },
    status: "disconnected",
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  })),
}));

import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { createCollabProvider } from "../src/collab/provider";

interface CapturedPluginProps {
  readonly id: string;
  readonly username?: string;
  readonly rootName?: string;
  readonly shouldBootstrap: boolean;
  readonly initialEditorState?: unknown;
  readonly cursorColor?: string;
  readonly awarenessData?: unknown;
  readonly providerFactory: (id: string, yjsDocMap: Map<string, Doc>) => unknown;
}

const mockCollaborationPlugin = CollaborationPlugin as unknown as ReturnType<typeof vi.fn>;
const mockCreateCollabProvider = createCollabProvider as unknown as ReturnType<typeof vi.fn>;

function latestPluginProps(): CapturedPluginProps {
  const call = mockCollaborationPlugin.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected CollaborationPlugin to have been rendered");
  }
  return call[0] as CapturedPluginProps;
}

function latestProviderOptions(): CreateCollabProviderOptions {
  const call = mockCreateCollabProvider.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected createCollabProvider to have been called");
  }
  return call[0];
}

const fakeEditor = {} as unknown as LexicalEditor;
const FakeWebSocketPolyfill = class {} as unknown as WebSocketPolyfillCtor;

beforeEach(() => {
  mockCollaborationPlugin.mockClear();
  mockCreateCollabProvider.mockClear();
});

describe("isRoomEmpty", () => {
  test("is true for a freshly created Doc", () => {
    expect(isRoomEmpty(new Doc())).toBe(true);
  });

  test("is false once the root XmlText has content", () => {
    const doc = new Doc();
    doc.get("root", XmlText).insert(0, "hello");
    expect(isRoomEmpty(doc)).toBe(false);
  });

  test("honors a custom rootName independently of the default 'root'", () => {
    const doc = new Doc();
    doc.get("custom-root", XmlText).insert(0, "hello");
    expect(isRoomEmpty(doc, "custom-root")).toBe(false);
    expect(isRoomEmpty(doc, "root")).toBe(true);
  });
});

describe("CollaborationPluginBridge", () => {
  test("mounts CollaborationPlugin with shouldBootstrap true for a fresh room", () => {
    render(
      <CollaborationPluginBridge
        editor={fakeEditor}
        room="room-1"
        wsUrl="ws://localhost:1234"
        WebSocketPolyfill={FakeWebSocketPolyfill}
        username="Ada"
      />,
    );

    expect(mockCollaborationPlugin).toHaveBeenCalledTimes(1);
    const props = latestPluginProps();
    expect(props.id).toBe("room-1");
    expect(props.username).toBe("Ada");
    expect(props.rootName).toBe("root");
    expect(props.shouldBootstrap).toBe(true);
  });

  test("forwards initialEditorState when bootstrapping with initialMarkdown given", () => {
    render(
      <CollaborationPluginBridge
        editor={fakeEditor}
        room="room-2"
        wsUrl="ws://localhost:1234"
        WebSocketPolyfill={FakeWebSocketPolyfill}
        username="Ada"
        initialMarkdown="# Hello"
      />,
    );

    const props = latestPluginProps();
    expect(props.shouldBootstrap).toBe(true);
    expect(typeof props.initialEditorState).toBe("function");
  });

  test("omits initialEditorState when no initialMarkdown is given", () => {
    render(
      <CollaborationPluginBridge
        editor={fakeEditor}
        room="room-3"
        wsUrl="ws://localhost:1234"
        WebSocketPolyfill={FakeWebSocketPolyfill}
        username="Ada"
      />,
    );

    expect(latestPluginProps().initialEditorState).toBeUndefined();
  });

  test("omits cursorColor and awarenessData when not provided", () => {
    render(
      <CollaborationPluginBridge
        editor={fakeEditor}
        room="room-4"
        wsUrl="ws://localhost:1234"
        WebSocketPolyfill={FakeWebSocketPolyfill}
        username="Ada"
      />,
    );

    const props = latestPluginProps();
    expect(props.cursorColor).toBeUndefined();
    expect(props.awarenessData).toBeUndefined();
  });

  test("forwards cursorColor and awarenessData when provided", () => {
    render(
      <CollaborationPluginBridge
        editor={fakeEditor}
        room="room-5"
        wsUrl="ws://localhost:1234"
        WebSocketPolyfill={FakeWebSocketPolyfill}
        username="Ada"
        cursorColor="hsl(10, 65%, 45%)"
        awarenessData={{ role: "engineer" }}
      />,
    );

    const props = latestPluginProps();
    expect(props.cursorColor).toBe("hsl(10, 65%, 45%)");
    expect(props.awarenessData).toEqual({ role: "engineer" });
  });

  test("wires providerFactory to createCollabProvider with the room's own Doc and options", () => {
    render(
      <CollaborationPluginBridge
        editor={fakeEditor}
        room="room-6"
        wsUrl="ws://collab.example/socket"
        WebSocketPolyfill={FakeWebSocketPolyfill}
        username="Ada"
      />,
    );

    expect(mockCreateCollabProvider).toHaveBeenCalledTimes(1);
    const options = latestProviderOptions();
    expect(options.room).toBe("room-6");
    expect(options.wsUrl).toBe("ws://collab.example/socket");
    expect(options.WebSocketPolyfill).toBe(FakeWebSocketPolyfill);
    expect(options.doc).toBeInstanceOf(Doc);
  });

  test("registers the room's Doc into the yjsDocMap CollaborationPlugin was given", () => {
    let capturedMap: Map<string, Doc> | undefined;
    mockCollaborationPlugin.mockImplementationOnce((props: CapturedPluginProps) => {
      capturedMap = new Map();
      props.providerFactory(props.id, capturedMap);
      return null;
    });

    render(
      <CollaborationPluginBridge
        editor={fakeEditor}
        room="room-7"
        wsUrl="ws://localhost:1234"
        WebSocketPolyfill={FakeWebSocketPolyfill}
        username="Ada"
      />,
    );

    expect(capturedMap?.get("room-7")).toBeInstanceOf(Doc);
  });
});
