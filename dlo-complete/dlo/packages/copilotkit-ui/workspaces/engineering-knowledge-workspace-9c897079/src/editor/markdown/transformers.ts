// src/editor/markdown/transformers.ts — extends `@lexical/markdown`'s built-in `TRANSFORMERS`
// set with the two custom block types this editor adds. `@lexical/markdown` only knows about
// its own `CodeNode`/`HorizontalRuleNode`; without these two entries `$convertToMarkdownString`
// silently drops `CodeBlockNode`/`DividerNode` content (every `ElementTransformer.export`
// returning `null` falls through to Lexical's default per-node markdown, which does not exist
// for nodes it does not recognise) and `$convertFromMarkdownString` never produces them.
import {
  TRANSFORMERS,
  type ElementTransformer,
  type MultilineElementTransformer,
  type Transformer,
} from "@lexical/markdown";
import { $createCodeBlockNode, $isCodeBlockNode, CodeBlockNode } from "../nodes/code-block-node";
import { $createDividerNode, $isDividerNode, DividerNode } from "../nodes/divider-node";

const CODE_FENCE_START = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const CODE_FENCE_END = /^```[ \t]*$/;

/** Round-trips `CodeBlockNode` through fenced markdown, e.g. ` ```ts\nconst x = 1;\n``` `. */
export const CODE_BLOCK_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [CodeBlockNode],
  export: (node) => {
    if (!$isCodeBlockNode(node)) {
      return null;
    }
    const language = node.getLanguage();
    const fenceLanguage = language && language !== "plaintext" ? language : "";
    return "```" + fenceLanguage + "\n" + node.getCode() + "\n```";
  },
  regExpStart: CODE_FENCE_START,
  regExpEnd: { optional: true, regExp: CODE_FENCE_END },
  replace: (rootNode, _children, startMatch, endMatch, linesInBetween) => {
    const rawLanguage = startMatch[1];
    const language = rawLanguage && rawLanguage.length > 0 ? rawLanguage : "plaintext";
    // `@lexical/markdown`'s multiline importer always includes the opening line's post-match
    // remainder as the first element of `linesInBetween`, and (only when a closing fence was
    // actually matched) the closing line's pre-match remainder as the last element. Both
    // regexes above are anchored to the full line (`^...$`), so those remainders are always
    // "" here — drop the leading one unconditionally, and the trailing one only when `endMatch`
    // is set. For an unterminated fence (`regExpEnd` is optional and never matched), the last
    // element is real code content and must be kept, not discarded as a fake remainder.
    const lines = linesInBetween ?? [];
    const codeLines = endMatch ? lines.slice(1, -1) : lines.slice(1);
    const code = codeLines.join("\n");
    rootNode.append($createCodeBlockNode(code, language));
  },
  type: "multiline-element",
};

const DIVIDER_REGEXP = /^(?:---|\*\*\*|___)\s?$/;

/** Round-trips `DividerNode` through a `---` thematic break line. */
export const DIVIDER_TRANSFORMER: ElementTransformer = {
  dependencies: [DividerNode],
  export: (node) => ($isDividerNode(node) ? "---" : null),
  regExp: DIVIDER_REGEXP,
  replace: (parentNode, _children, _match, isImport) => {
    const divider = $createDividerNode();
    if (isImport || parentNode.getNextSibling() !== null) {
      parentNode.replace(divider);
    } else {
      parentNode.insertBefore(divider);
    }
    divider.selectNext();
  },
  type: "element",
};

/** The full transformer set this editor's markdown import/export uses. */
export const EDITOR_TRANSFORMERS: readonly Transformer[] = [
  CODE_BLOCK_TRANSFORMER,
  DIVIDER_TRANSFORMER,
  ...TRANSFORMERS,
];
