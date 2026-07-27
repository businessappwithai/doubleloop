// src/editor/index.ts — public surface of the Lexical block editor module.
export { BlockEditor, type BlockEditorProps } from "./BlockEditor";
export { Toolbar } from "./Toolbar";
export { createEditorInitialConfig, editorNodes, editorOnError, editorTheme } from "./config/editor-config";
export type { CreateEditorInitialConfigOptions } from "./config/editor-config";
export { registerMarkdownShortcuts } from "./transforms/markdown-shortcuts";
export { EDITOR_TRANSFORMERS, CODE_BLOCK_TRANSFORMER, DIVIDER_TRANSFORMER } from "./markdown/transformers";
export { editorStateToMarkdown, markdownToEditorState } from "./markdown/serialize";
export {
  CodeBlockNode,
  $createCodeBlockNode,
  $isCodeBlockNode,
  type SerializedCodeBlockNode,
} from "./nodes/code-block-node";
export { DividerNode, $createDividerNode, $isDividerNode, type SerializedDividerNode } from "./nodes/divider-node";
