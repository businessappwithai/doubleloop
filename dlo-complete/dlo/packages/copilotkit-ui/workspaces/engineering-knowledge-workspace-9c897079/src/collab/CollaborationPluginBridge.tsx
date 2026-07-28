// src/collab/CollaborationPluginBridge.tsx — bridges an externally-created `LexicalEditor` (e.g.
// the one `BlockEditor`, module m18, hands out via its `onEditorReady`) into `@lexical/react`'s
// Yjs collaboration plugin. `BlockEditor` owns its own `<LexicalComposer>` and this module must
// not modify it, so instead of nesting `CollaborationPlugin` inside that composer's JSX tree, we
// re-provide `LexicalComposerContext` — the same context `<LexicalComposer>` itself provides,
// carrying just `[editor, composerContext]` — so `CollaborationPlugin` (which reads the editor via
// `useLexicalComposerContext`) mounts correctly as a sibling.
//
// `shouldBootstrap` is decided once per `room`, from whether this room's Yjs doc is empty
// *before* any network sync — `@lexical/react`'s own collaboration hook applies exactly this
// heuristic internally (`shouldBootstrap && root.isEmpty()`); we compute it explicitly here so a
// client joining an existing room never seeds over it, while a client opening a genuinely fresh
// room does. This is the same best-effort convention the wider Lexical+Yjs ecosystem relies on:
// perfect "wait for first sync, then decide" semantics belong to `CollabModule.onRoomOpen` on the
// server (a different module), not this client bridge.
import { useCallback, useMemo, type ReactElement } from "react";
import { Doc, XmlText } from "yjs";
import type { LexicalEditor } from "lexical";
import {
  LexicalComposerContext,
  createLexicalComposerContext,
  type LexicalComposerContextWithEditor,
} from "@lexical/react/LexicalComposerContext";
import { LexicalCollaboration } from "@lexical/react/LexicalCollaborationContext";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import type { Provider } from "@lexical/yjs";
import { createCollabProvider, type CollabStatus, type CollabTimer, type WebSocketPolyfillCtor } from "./provider";
import { markdownToEditorState } from "../editor";

const ROOT_NAME = "root";

/** True when `doc`'s Lexical root `XmlText` has no content yet — see the module header. */
export function isRoomEmpty(doc: Doc, rootName: string = ROOT_NAME): boolean {
  return doc.get(rootName, XmlText).length === 0;
}

export interface CollaborationPluginBridgeProps {
  /** The editor mounted by `BlockEditor` (m18), obtained via its `onEditorReady`. */
  readonly editor: LexicalEditor;
  /** The Yjs room / document id. A new `Doc` is created per distinct `room`. */
  readonly room: string;
  readonly wsUrl: string;
  readonly WebSocketPolyfill: WebSocketPolyfillCtor;
  readonly username: string;
  readonly cursorColor?: string;
  /** Seeded into the document only when `room` turns out to be empty. */
  readonly initialMarkdown?: string;
  readonly onStatus?: (status: CollabStatus) => void;
  readonly awarenessData?: Record<string, unknown>;
  readonly timer?: CollabTimer;
}

/** Mounts the Yjs collaboration plugin against `editor`, bootstrapping only an empty room. */
export function CollaborationPluginBridge({
  editor,
  room,
  wsUrl,
  WebSocketPolyfill,
  username,
  cursorColor,
  initialMarkdown,
  onStatus,
  awarenessData,
  timer,
}: CollaborationPluginBridgeProps): ReactElement {
  const composerContextValue = useMemo<LexicalComposerContextWithEditor>(
    () => [editor, createLexicalComposerContext(undefined, null)],
    [editor],
  );

  // One Doc per room, created empty and inspected for emptiness before any provider connects.
  const doc = useMemo(() => new Doc(), [room]);
  const shouldBootstrap = useMemo(() => isRoomEmpty(doc), [doc]);

  const providerFactory = useCallback(
    (id: string, yjsDocMap: Map<string, Doc>): Provider => {
      yjsDocMap.set(id, doc);
      return createCollabProvider({
        room: id,
        wsUrl,
        doc,
        WebSocketPolyfill,
        ...(onStatus ? { onStatus } : {}),
        ...(timer ? { timer } : {}),
      });
    },
    [doc, wsUrl, WebSocketPolyfill, onStatus, timer],
  );

  return (
    <LexicalComposerContext.Provider value={composerContextValue}>
      <LexicalCollaboration>
        <CollaborationPlugin
          id={room}
          providerFactory={providerFactory}
          shouldBootstrap={shouldBootstrap}
          username={username}
          rootName={ROOT_NAME}
          {...(cursorColor !== undefined ? { cursorColor } : {})}
          {...(shouldBootstrap && initialMarkdown !== undefined
            ? { initialEditorState: (e: LexicalEditor) => markdownToEditorState(e, initialMarkdown) }
            : {})}
          {...(awarenessData !== undefined ? { awarenessData } : {})}
        />
      </LexicalCollaboration>
    </LexicalComposerContext.Provider>
  );
}
