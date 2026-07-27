// src/editor/nodes/divider-node.tsx — a themed horizontal-rule block, inserted by the `---`
// markdown shortcut and by markdown import. Modeled as a DecoratorNode rather than an
// ElementNode: it has no editable children and no markdown content beyond its own presence, so
// there is nothing for Lexical's text reconciliation to manage — the rule itself is rendered by
// a StyleX-styled React component so its color/thickness stay on the design system's tokens
// instead of a browser UA `<hr>` style.
import type { JSX } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";

export type SerializedDividerNode = Spread<
  {
    type: "divider";
    version: 1;
  },
  SerializedLexicalNode
>;

const styles = stylex.create({
  rule: {
    display: "block",
    border: "none",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: "light-dark(#E4E7EB, #2C2D30)",
    margin: "0",
    width: "100%",
  },
});

function DividerComponent(): JSX.Element {
  return <hr {...stylex.props(styles.rule)} />;
}

/** A themed horizontal rule block. See module header for why it is a `DecoratorNode`. */
export class DividerNode extends DecoratorNode<JSX.Element> {
  static getType(): string {
    return "divider";
  }

  static clone(node: DividerNode): DividerNode {
    return new DividerNode(node.__key);
  }

  static importJSON(_serializedNode: SerializedDividerNode): DividerNode {
    return $createDividerNode();
  }

  exportJSON(): SerializedDividerNode {
    return {
      type: "divider",
      version: 1,
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement("div");
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    return { element: document.createElement("hr") };
  }

  isInline(): false {
    return false;
  }

  decorate(): JSX.Element {
    return <DividerComponent />;
  }
}

export function $createDividerNode(): DividerNode {
  return new DividerNode();
}

export function $isDividerNode(node: LexicalNode | null | undefined): node is DividerNode {
  return node instanceof DividerNode;
}
