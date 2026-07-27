// src/editor/nodes/code-block-node.tsx — a block-level, language-tagged code block. Modeled as a
// DecoratorNode (not @lexical/code's CodeNode/CodeHighlightNode pair) so its persisted payload is
// a single plain value pair: code text + language.
//
// `__language` is ALWAYS assigned a concrete string (defaulting to "plaintext") directly in the
// constructor, never left for a later `setLanguage()` call to be its first assignment. This
// matters specifically for `@lexical/yjs`: the Yjs binding snapshots a decorator node's own
// properties into its shared type at the moment the node is first bound. A property that is
// `undefined` at that moment is simply absent from the snapshot, and a later local assignment to
// it does not retroactively appear in the shared document for peers who joined before that
// assignment — the field silently desyncs. Always constructing with a real string closes that
// window; there is no code path in this class that can produce an uninitialised `__language`.
import type { ChangeEvent, JSX } from "react";
import { useCallback, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  $getNodeByKey,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

export type SerializedCodeBlockNode = Spread<
  {
    type: "code-block";
    version: 1;
    code: string;
    language: string;
  },
  SerializedLexicalNode
>;

const styles = stylex.create({
  wrapper: {
    display: "block",
    width: "100%",
  },
  languageInput: {
    display: "block",
    width: "100%",
    fontSize: "0.75rem",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "light-dark(#4E606F, #AAAFB5)",
    background: "transparent",
    border: "none",
    padding: "0 0 4px 0",
  },
  codeArea: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.875rem",
    lineHeight: 1.6,
    borderRadius: "8px",
    backgroundColor: "light-dark(#F3F5F7, #1B1C1E)",
    color: "light-dark(#0A1317, #DFE2E5)",
    padding: "12px 14px",
    border: "none",
    resize: "vertical",
  },
});

function $getCodeBlockNodeOrThrow(nodeKey: NodeKey): CodeBlockNode {
  const node = $getNodeByKey(nodeKey);
  if (!$isCodeBlockNode(node)) {
    throw new Error(`CodeBlockNode: node "${nodeKey}" is missing or not a CodeBlockNode`);
  }
  return node;
}

function CodeBlockComponent({ nodeKey }: { nodeKey: NodeKey }): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [code, setCode] = useState(() =>
    editor.getEditorState().read(() => $getCodeBlockNodeOrThrow(nodeKey).getCode()),
  );
  const [language, setLanguage] = useState(() =>
    editor.getEditorState().read(() => $getCodeBlockNodeOrThrow(nodeKey).getLanguage()),
  );

  const handleCodeChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      setCode(value);
      editor.update(() => {
        $getCodeBlockNodeOrThrow(nodeKey).setCode(value);
      });
    },
    [editor, nodeKey],
  );

  const handleLanguageChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setLanguage(value);
      editor.update(() => {
        $getCodeBlockNodeOrThrow(nodeKey).setLanguage(value);
      });
    },
    [editor, nodeKey],
  );

  return (
    <div {...stylex.props(styles.wrapper)}>
      <input
        aria-label="Code block language"
        value={language}
        onChange={handleLanguageChange}
        {...stylex.props(styles.languageInput)}
      />
      <textarea
        aria-label="Code block content"
        value={code}
        onChange={handleCodeChange}
        spellCheck={false}
        {...stylex.props(styles.codeArea)}
      />
    </div>
  );
}

/** A language-tagged code block. See module header for the constructor-initialisation rule. */
export class CodeBlockNode extends DecoratorNode<JSX.Element> {
  __code: string;
  __language: string;

  constructor(code: string = "", language: string = "plaintext", key?: NodeKey) {
    super(key);
    this.__code = code;
    this.__language = language;
  }

  static getType(): string {
    return "code-block";
  }

  static clone(node: CodeBlockNode): CodeBlockNode {
    return new CodeBlockNode(node.__code, node.__language, node.__key);
  }

  static importJSON(serializedNode: SerializedCodeBlockNode): CodeBlockNode {
    return $createCodeBlockNode(serializedNode.code, serializedNode.language);
  }

  exportJSON(): SerializedCodeBlockNode {
    return {
      type: "code-block",
      version: 1,
      code: this.getCode(),
      language: this.getLanguage(),
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement("div");
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = this.getCode();
    code.setAttribute("data-language", this.getLanguage());
    pre.appendChild(code);
    return { element: pre };
  }

  isInline(): false {
    return false;
  }

  getCode(): string {
    return this.getLatest().__code;
  }

  setCode(code: string): void {
    this.getWritable().__code = code;
  }

  getLanguage(): string {
    return this.getLatest().__language;
  }

  setLanguage(language: string): void {
    this.getWritable().__language = language;
  }

  decorate(): JSX.Element {
    return <CodeBlockComponent nodeKey={this.__key} />;
  }
}

export function $createCodeBlockNode(code: string = "", language: string = "plaintext"): CodeBlockNode {
  return new CodeBlockNode(code, language);
}

export function $isCodeBlockNode(node: LexicalNode | null | undefined): node is CodeBlockNode {
  return node instanceof CodeBlockNode;
}
