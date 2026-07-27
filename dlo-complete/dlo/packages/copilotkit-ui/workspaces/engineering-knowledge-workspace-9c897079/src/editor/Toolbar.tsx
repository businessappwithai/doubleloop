// src/editor/Toolbar.tsx — the editor's formatting toolbar: inline text-format toggles (bold,
// italic, underline, strikethrough, inline code) and block-type actions (paragraph, headings
// 1-3, quote, bullet/numbered list, code block, divider). Reads the live selection through
// `editor.registerUpdateListener` — which fires after every committed update, selection-only or
// not — rather than `SELECTION_CHANGE_COMMAND` alone, so a programmatic `$setSelection` (as
// happens right after a block-type conversion) is reflected without waiting for a DOM selection
// event that may never fire in a headless test.
import { useCallback, useEffect, useState, type ReactElement } from "react";
import * as stylex from "@stylexjs/stylex";
import { Toolbar as AstryxToolbar, ToggleButton } from "@astryxdesign/core";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
  type TextFormatType,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { $isListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, REMOVE_LIST_COMMAND } from "@lexical/list";
import { $createCodeBlockNode, $isCodeBlockNode } from "./nodes/code-block-node";
import { $createDividerNode } from "./nodes/divider-node";

type BlockType = "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote" | "bullet" | "number" | "code-block";

interface ToolbarState {
  readonly formats: ReadonlySet<TextFormatType>;
  readonly blockType: BlockType;
}

const INITIAL_STATE: ToolbarState = { formats: new Set(), blockType: "paragraph" };

const styles = stylex.create({
  divider: {
    width: "1px",
    alignSelf: "stretch",
    margin: "0 4px",
    backgroundColor: "light-dark(#E4E7EB, #2C2D30)",
  },
});

function $readToolbarState(): ToolbarState {
  const selection = $getSelection();

  if ($isNodeSelection(selection)) {
    const nodes = selection.getNodes();
    if (nodes.length === 1 && $isCodeBlockNode(nodes[0])) {
      return { formats: new Set(), blockType: "code-block" };
    }
    return INITIAL_STATE;
  }

  if (!$isRangeSelection(selection)) {
    return INITIAL_STATE;
  }

  const formats = new Set<TextFormatType>();
  for (const format of ["bold", "italic", "underline", "strikethrough", "code"] as const) {
    if (selection.hasFormat(format)) {
      formats.add(format);
    }
  }

  const anchorNode = selection.anchor.getNode();
  const topLevel = anchorNode.getTopLevelElementOrThrow();

  let blockType: BlockType = "paragraph";
  if ($isCodeBlockNode(topLevel)) {
    blockType = "code-block";
  } else if ($isHeadingNode(topLevel)) {
    blockType = topLevel.getTag();
  } else if ($isQuoteNode(topLevel)) {
    blockType = "quote";
  } else if ($isListNode(topLevel)) {
    blockType = topLevel.getListType() === "number" ? "number" : "bullet";
  }

  return { formats, blockType };
}

function formatText(editor: LexicalEditor, format: TextFormatType): void {
  editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
}

function formatParagraph(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      $setBlocksType(selection, () => $createParagraphNode());
    }
  });
}

function formatHeading(editor: LexicalEditor, tag: HeadingTagType): void {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      $setBlocksType(selection, () => $createHeadingNode(tag));
    }
  });
}

function formatQuote(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      $setBlocksType(selection, () => $createQuoteNode());
    }
  });
}

function formatCodeBlock(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return;
    }
    const topLevel = selection.anchor.getNode().getTopLevelElementOrThrow();
    if ($isCodeBlockNode(topLevel) || !$isElementNode(topLevel)) {
      return;
    }
    topLevel.replace($createCodeBlockNode(topLevel.getTextContent(), "plaintext"));
  });
}

function insertDivider(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return;
    }
    const topLevel = selection.anchor.getNode().getTopLevelElementOrThrow();
    const divider = $createDividerNode();
    topLevel.insertAfter(divider);
    const after = $createParagraphNode();
    divider.insertAfter(after);
    after.selectStart();
  });
}

function toggleBulletList(editor: LexicalEditor, isActive: boolean): void {
  editor.dispatchCommand(isActive ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND, undefined);
}

function toggleNumberList(editor: LexicalEditor, isActive: boolean): void {
  editor.dispatchCommand(isActive ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined);
}

/** The block editor's formatting toolbar. Must render inside a `LexicalComposer`. */
export function Toolbar(): ReactElement {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState<ToolbarState>(INITIAL_STATE);

  useEffect(() => {
    const update = () => {
      editor.getEditorState().read(() => {
        setState($readToolbarState());
      });
    };
    update();
    return editor.registerUpdateListener(update);
  }, [editor]);

  const onFormatText = useCallback((format: TextFormatType) => formatText(editor, format), [editor]);

  const { formats, blockType } = state;

  return (
    <AstryxToolbar
      label="Formatting"
      size="sm"
      startContent={
        <>
          <ToggleButton
            label="Bold"
            isPressed={formats.has("bold")}
            onPressedChange={() => onFormatText("bold")}
          >
            B
          </ToggleButton>
          <ToggleButton
            label="Italic"
            isPressed={formats.has("italic")}
            onPressedChange={() => onFormatText("italic")}
          >
            I
          </ToggleButton>
          <ToggleButton
            label="Underline"
            isPressed={formats.has("underline")}
            onPressedChange={() => onFormatText("underline")}
          >
            U
          </ToggleButton>
          <ToggleButton
            label="Strikethrough"
            isPressed={formats.has("strikethrough")}
            onPressedChange={() => onFormatText("strikethrough")}
          >
            S
          </ToggleButton>
          <ToggleButton
            label="Inline code"
            isPressed={formats.has("code")}
            onPressedChange={() => onFormatText("code")}
          >
            {"</>"}
          </ToggleButton>
          <div aria-hidden="true" {...stylex.props(styles.divider)} />
          <ToggleButton
            label="Paragraph"
            isPressed={blockType === "paragraph"}
            onPressedChange={() => formatParagraph(editor)}
          >
            P
          </ToggleButton>
          <ToggleButton
            label="Heading 1"
            isPressed={blockType === "h1"}
            onPressedChange={() => formatHeading(editor, "h1")}
          >
            H1
          </ToggleButton>
          <ToggleButton
            label="Heading 2"
            isPressed={blockType === "h2"}
            onPressedChange={() => formatHeading(editor, "h2")}
          >
            H2
          </ToggleButton>
          <ToggleButton
            label="Heading 3"
            isPressed={blockType === "h3"}
            onPressedChange={() => formatHeading(editor, "h3")}
          >
            H3
          </ToggleButton>
          <ToggleButton label="Quote" isPressed={blockType === "quote"} onPressedChange={() => formatQuote(editor)}>
            {"“"}
          </ToggleButton>
          <ToggleButton
            label="Bullet list"
            isPressed={blockType === "bullet"}
            onPressedChange={() => toggleBulletList(editor, blockType === "bullet")}
          >
            {"•"}
          </ToggleButton>
          <ToggleButton
            label="Numbered list"
            isPressed={blockType === "number"}
            onPressedChange={() => toggleNumberList(editor, blockType === "number")}
          >
            1.
          </ToggleButton>
          <ToggleButton
            label="Code block"
            isPressed={blockType === "code-block"}
            onPressedChange={() => formatCodeBlock(editor)}
          >
            {"{ }"}
          </ToggleButton>
          <ToggleButton label="Divider" isPressed={false} onPressedChange={() => insertDivider(editor)}>
            {"―"}
          </ToggleButton>
        </>
      }
    />
  );
}
