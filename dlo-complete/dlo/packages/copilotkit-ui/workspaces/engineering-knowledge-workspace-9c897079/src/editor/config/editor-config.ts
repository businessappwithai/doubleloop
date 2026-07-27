// src/editor/config/editor-config.ts — the editor's node registry and theme, and the
// `InitialConfigType` factory every editor host (`BlockEditor.tsx`, and tests that need a real
// or headless editor) builds from. `onError` throws rather than swallowing: a reconciliation
// error left to Lexical's default (console.error and carry on) leaves the editor silently
// diverged from its own state, which is worse than crashing loudly and closer to home for the
// operator to diagnose than a corrupted document discovered later.
import type { EditorThemeClasses, Klass, LexicalEditor, LexicalNode } from "lexical";
import type { InitialConfigType, InitialEditorStateType } from "@lexical/react/LexicalComposer";
import * as stylex from "@stylexjs/stylex";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListItemNode, ListNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { CodeBlockNode } from "../nodes/code-block-node";
import { DividerNode } from "../nodes/divider-node";

const styles = stylex.create({
  paragraph: {
    margin: "0 0 0.75em 0",
  },
  h1: {
    fontSize: "1.75rem",
    fontWeight: 700,
    margin: "1.2em 0 0.5em 0",
  },
  h2: {
    fontSize: "1.375rem",
    fontWeight: 700,
    margin: "1.1em 0 0.5em 0",
  },
  h3: {
    fontSize: "1.125rem",
    fontWeight: 600,
    margin: "1em 0 0.4em 0",
  },
  h4: {
    fontSize: "1rem",
    fontWeight: 600,
    margin: "1em 0 0.4em 0",
  },
  h5: {
    fontSize: "0.9375rem",
    fontWeight: 600,
    margin: "1em 0 0.4em 0",
  },
  h6: {
    fontSize: "0.875rem",
    fontWeight: 600,
    margin: "1em 0 0.4em 0",
  },
  quote: {
    margin: "0 0 0.75em 0",
    padding: "0 0 0 12px",
    borderInlineStartWidth: "3px",
    borderInlineStartStyle: "solid",
    borderInlineStartColor: "light-dark(#E4E7EB, #2C2D30)",
    color: "light-dark(#4E606F, #AAAFB5)",
  },
  ul: {
    margin: "0 0 0.75em 0",
    paddingInlineStart: "1.5em",
  },
  ol: {
    margin: "0 0 0.75em 0",
    paddingInlineStart: "1.5em",
  },
  listItem: {
    margin: "0.15em 0",
  },
  link: {
    color: "light-dark(#0064E0, #2694FE)",
    textDecorationLine: "underline",
  },
  textBold: {
    fontWeight: 700,
  },
  textItalic: {
    fontStyle: "italic",
  },
  textUnderline: {
    textDecorationLine: "underline",
  },
  textStrikethrough: {
    textDecorationLine: "line-through",
  },
  textCode: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.875em",
    backgroundColor: "light-dark(#F3F5F7, #1B1C1E)",
    borderRadius: "4px",
    padding: "0.1em 0.3em",
  },
});

function className(style: (typeof styles)[keyof typeof styles]): string {
  return stylex.props(style).className ?? "";
}

/** The nodes registered beyond Lexical's built-in root/paragraph/text/line-break/tab set. */
export const editorNodes: ReadonlyArray<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  CodeBlockNode,
  DividerNode,
];

/** The StyleX-token-driven theme, mapped to Lexical's `EditorThemeClasses` class-name slots. */
export const editorTheme: EditorThemeClasses = {
  paragraph: className(styles.paragraph),
  heading: {
    h1: className(styles.h1),
    h2: className(styles.h2),
    h3: className(styles.h3),
    h4: className(styles.h4),
    h5: className(styles.h5),
    h6: className(styles.h6),
  },
  quote: className(styles.quote),
  list: {
    ul: className(styles.ul),
    ol: className(styles.ol),
    listitem: className(styles.listItem),
  },
  link: className(styles.link),
  text: {
    bold: className(styles.textBold),
    italic: className(styles.textItalic),
    underline: className(styles.textUnderline),
    strikethrough: className(styles.textStrikethrough),
    code: className(styles.textCode),
  },
};

/** Throws rather than swallowing — see module header. */
export function editorOnError(error: Error, _editor: LexicalEditor): never {
  throw error;
}

export interface CreateEditorInitialConfigOptions {
  readonly editable?: boolean;
  readonly editorState?: InitialEditorStateType;
}

/**
 * Builds the `InitialConfigType` consumed by `LexicalComposer` (and by tests that mount a real
 * composer). `namespace` must be unique per independently-instantiated editor on a page.
 */
export function createEditorInitialConfig(
  namespace: string,
  options: CreateEditorInitialConfigOptions = {},
): InitialConfigType {
  return {
    namespace,
    nodes: editorNodes,
    theme: editorTheme,
    onError: editorOnError,
    ...(options.editable !== undefined ? { editable: options.editable } : {}),
    ...(options.editorState !== undefined ? { editorState: options.editorState } : {}),
  };
}
