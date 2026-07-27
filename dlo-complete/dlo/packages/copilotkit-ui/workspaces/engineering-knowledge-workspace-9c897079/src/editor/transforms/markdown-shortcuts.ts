// src/editor/transforms/markdown-shortcuts.ts — typed markdown shortcuts, built directly on
// `editor.registerNodeTransform(TextNode, ...)` rather than `@lexical/markdown`'s own
// `registerMarkdownShortcuts` (which drives off an update-listener/composition-end heuristic).
// A node transform is simpler to reason about and to test headlessly: it runs synchronously
// whenever a `TextNode` is dirtied, so a test can mutate a paragraph's text inside
// `editor.update(..., { discrete: true })` and read the resulting tree immediately after.
//
// Every shortcut requires the matched text node to be the *sole* child of a plain
// `ParagraphNode` — that is what "typing a shortcut at the start of an empty paragraph" means
// structurally, and it is also what stops a shortcut from re-firing once the paragraph has
// already been converted into a heading/list/quote/code-block (none of those are
// `ParagraphNode`, so the guard rejects them without needing a separate "already converted"
// flag).
import {
  $createParagraphNode,
  $createTextNode,
  $isParagraphNode,
  TextNode,
  type ElementNode,
  type LexicalEditor,
} from "lexical";
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { $createListItemNode, $createListNode } from "@lexical/list";
import { $createCodeBlockNode } from "../nodes/code-block-node";
import { $createDividerNode } from "../nodes/divider-node";

interface MarkdownShortcut {
  /** Human-readable id, used only for debugging/log messages. */
  readonly id: string;
  readonly regExp: RegExp;
  readonly apply: (parent: ElementNode, node: TextNode, match: RegExpMatchArray) => void;
}

function replaceWithRemainder(
  parent: ElementNode,
  node: TextNode,
  matchedLength: number,
  build: (remainder: string) => ElementNode,
): void {
  const remainder = node.getTextContent().slice(matchedLength);
  const block = build(remainder);
  parent.replace(block);
}

function headingShortcut(level: 1 | 2 | 3 | 4 | 5 | 6): MarkdownShortcut {
  const hashes = "#".repeat(level);
  const tag = `h${level}` as HeadingTagType;
  return {
    id: `heading-${level}`,
    regExp: new RegExp(`^${hashes}\\s`),
    apply: (parent, node, match) => {
      replaceWithRemainder(parent, node, match[0].length, (remainder) => {
        const heading = $createHeadingNode(tag);
        if (remainder.length > 0) {
          heading.append($createTextNode(remainder));
        }
        heading.selectEnd();
        return heading;
      });
    },
  };
}

function listShortcut(id: string, regExp: RegExp, listType: "bullet" | "number"): MarkdownShortcut {
  return {
    id,
    regExp,
    apply: (parent, node, match) => {
      replaceWithRemainder(parent, node, match[0].length, (remainder) => {
        const list = $createListNode(listType);
        const item = $createListItemNode();
        if (remainder.length > 0) {
          item.append($createTextNode(remainder));
        }
        list.append(item);
        item.selectEnd();
        return list;
      });
    },
  };
}

const QUOTE_SHORTCUT: MarkdownShortcut = {
  id: "quote",
  regExp: /^>\s/,
  apply: (parent, node, match) => {
    replaceWithRemainder(parent, node, match[0].length, (remainder) => {
      const quote = $createQuoteNode();
      if (remainder.length > 0) {
        quote.append($createTextNode(remainder));
      }
      quote.selectEnd();
      return quote;
    });
  },
};

const CODE_FENCE_SHORTCUT: MarkdownShortcut = {
  id: "code-fence",
  regExp: /^```([A-Za-z0-9_+-]*)\s$/,
  apply: (parent, _node, match) => {
    const language = match[1] && match[1].length > 0 ? match[1] : "plaintext";
    const codeBlock = $createCodeBlockNode("", language);
    parent.replace(codeBlock);
    const after = $createParagraphNode();
    codeBlock.insertAfter(after);
  },
};

const DIVIDER_SHORTCUT: MarkdownShortcut = {
  id: "divider",
  regExp: /^(?:---|\*\*\*|___)$/,
  apply: (parent) => {
    const divider = $createDividerNode();
    parent.replace(divider);
    const after = $createParagraphNode();
    divider.insertAfter(after);
    after.selectStart();
  },
};

const SHORTCUTS: readonly MarkdownShortcut[] = [
  headingShortcut(1),
  headingShortcut(2),
  headingShortcut(3),
  headingShortcut(4),
  headingShortcut(5),
  headingShortcut(6),
  listShortcut("unordered-dash", /^-\s/, "bullet"),
  listShortcut("unordered-star", /^\*\s/, "bullet"),
  listShortcut("ordered", /^1\.\s/, "number"),
  QUOTE_SHORTCUT,
  CODE_FENCE_SHORTCUT,
  DIVIDER_SHORTCUT,
];

function $transformTextNode(node: TextNode): void {
  const parent = node.getParent();
  if (!$isParagraphNode(parent) || parent.getChildrenSize() !== 1) {
    return;
  }

  const text = node.getTextContent();
  for (const shortcut of SHORTCUTS) {
    const match = text.match(shortcut.regExp);
    if (match) {
      shortcut.apply(parent, node, match);
      return;
    }
  }
}

/**
 * Registers the markdown-shortcut node transform on `editor`. Returns the unregister function
 * `editor.registerNodeTransform` itself returns — calling it detaches the transform and no
 * further typed markdown is converted.
 */
export function registerMarkdownShortcuts(editor: LexicalEditor): () => void {
  return editor.registerNodeTransform(TextNode, $transformTextNode);
}
