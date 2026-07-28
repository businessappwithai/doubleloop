// src/editor/BlockEditor.tsx — composes the Lexical editor from editor-config.ts's node
// registry/theme, this module's markdown shortcuts, and the Astryx-shelled Toolbar. `namespace`
// and `initialMarkdown` are read once (Lexical's own "initial config is read on mount" contract
// — see InitialConfigType.editorState's doc comment in `@lexical/react/LexicalComposer`), so a
// change to either after first render does not reset the document; callers that need to swap
// documents should remount with a new `key`.
import { useCallback, useEffect, useMemo, type ReactElement } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  LexicalComposer,
  type InitialConfigType,
} from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import type { LexicalEditor } from "lexical";
import { createEditorInitialConfig } from "./config/editor-config";
import { registerMarkdownShortcuts } from "./transforms/markdown-shortcuts";
import { editorStateToMarkdown, markdownToEditorState } from "./markdown/serialize";
import { Toolbar } from "./Toolbar";

const styles = stylex.create({
  shell: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "light-dark(#E4E7EB, #2C2D30)",
    borderRadius: "8px",
    overflow: "hidden",
  },
  editorWrapper: {
    position: "relative",
    width: "100%",
  },
  contentEditable: {
    display: "block",
    width: "100%",
    minHeight: "240px",
    boxSizing: "border-box",
    padding: "16px",
    outline: "none",
  },
  placeholder: {
    position: "absolute",
    top: "16px",
    insetInlineStart: "16px",
    color: "light-dark(#A4B0BC, #6F747C)",
    pointerEvents: "none",
    userSelect: "none",
  },
});

/** Registers this editor's typed markdown shortcuts for the lifetime of the composed editor. */
function MarkdownShortcutsPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerMarkdownShortcuts(editor), [editor]);
  return null;
}

export interface BlockEditorProps {
  /** Unique per independently-mounted editor on a page — see `createEditorInitialConfig`. */
  readonly namespace: string;
  /** Markdown seeded into the editor on mount. Read once; see the module header. */
  readonly initialMarkdown?: string;
  readonly editable?: boolean;
  readonly placeholder?: string;
  /** Called with the serialised markdown whenever the document content changes. */
  readonly onMarkdownChange?: (markdown: string) => void;
  /** Called once the underlying `LexicalEditor` is mounted, for imperative access. */
  readonly onEditorReady?: (editor: LexicalEditor) => void;
}

/** The composed Lexical block editor: node registry, markdown shortcuts, and its toolbar. */
export function BlockEditor({
  namespace,
  initialMarkdown,
  editable,
  placeholder = "Start writing…",
  onMarkdownChange,
  onEditorReady,
}: BlockEditorProps): ReactElement {
  const initialConfig = useMemo<InitialConfigType>(
    () =>
      createEditorInitialConfig(namespace, {
        ...(editable !== undefined ? { editable } : {}),
        ...(initialMarkdown !== undefined
          ? { editorState: () => markdownToEditorState(initialMarkdown) }
          : {}),
      }),
    // Read once on mount, matching Lexical's InitialConfigType contract — see module header.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namespace],
  );

  const handleChange = useCallback(
    (_editorState: unknown, editor: LexicalEditor) => {
      if (onMarkdownChange) {
        onMarkdownChange(editorStateToMarkdown(editor));
      }
    },
    [onMarkdownChange],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div {...stylex.props(styles.shell)}>
        <Toolbar />
        <div {...stylex.props(styles.editorWrapper)}>
          <RichTextPlugin
            contentEditable={<ContentEditable aria-label="Document content" {...stylex.props(styles.contentEditable)} />}
            placeholder={<div {...stylex.props(styles.placeholder)}>{placeholder}</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <MarkdownShortcutsPlugin />
        <OnChangePlugin onChange={handleChange} />
        {onEditorReady ? (
          <EditorRefPlugin
            editorRef={(editor) => {
              if (editor) {
                onEditorReady(editor);
              }
            }}
          />
        ) : null}
      </div>
    </LexicalComposer>
  );
}
