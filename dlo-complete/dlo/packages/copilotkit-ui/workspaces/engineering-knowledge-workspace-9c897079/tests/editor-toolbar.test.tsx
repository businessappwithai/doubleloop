// tests/editor-toolbar.test.tsx — module m18 (Lexical block editor). Covers `Toolbar`: reading
// live selection state via `editor.registerUpdateListener` into pressed/active button state (the
// `$isRangeSelection` formats+blockType path, the `$isNodeSelection` code-block/fallback path,
// and the default `INITIAL_STATE` path), and every button's click action — inline text formats,
// block-type conversions, list toggle on/off, code-block conversion, and divider insertion —
// including each action's `$isRangeSelection` guard against a non-range selection.
//
// Mounted through `BlockEditor` (which composes `Toolbar` inside a real `LexicalComposer` +
// `RichTextPlugin`, so `FORMAT_TEXT_COMMAND` and the list commands are registered exactly as in
// production) rather than a bare headless editor, matching `editor-block-editor.test.tsx`'s
// mount/flush pattern — see that file's header for why a microtask flush wrapped in `act()` is
// required after mount and after every click (both the initial non-discrete seed commit and a
// clicked command's non-discrete `editor.update()` are scheduled on a microtask). Every test
// mounts its own `BlockEditor` with a unique namespace; none is shared across tests.
//
// One implementation branch is not separately tested here: `formatCodeBlock`'s
// `!$isElementNode(topLevel)` guard. Lexical's own dev-mode point invariant (`PointType.set`)
// throws when constructing an "element" type selection point on a non-`ElementNode`, so a
// `RangeSelection` anchored inside a `DecoratorNode` (`CodeBlockNode`/`DividerNode`) cannot be
// produced through the public selection API — the guard is unreachable defensive code.
import { describe, test, expect } from "vitest";
import { render, screen, act, fireEvent, type RenderResult } from "@testing-library/react";
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
} from "lexical";
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import { $createListNode, $createListItemNode, $isListNode } from "@lexical/list";
import { BlockEditor } from "../src/editor/BlockEditor";
import { $createCodeBlockNode, $isCodeBlockNode } from "../src/editor/nodes/code-block-node";
import { $createDividerNode, $isDividerNode } from "../src/editor/nodes/divider-node";

function uniqueNamespace(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

async function mountToolbar(): Promise<{ editor: LexicalEditor; result: RenderResult }> {
  let captured: LexicalEditor | undefined;
  const result = render(
    <BlockEditor
      namespace={uniqueNamespace("toolbar")}
      onEditorReady={(e) => {
        captured = e;
      }}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { editor: captured as LexicalEditor, result };
}

/** Runs `run` inside a discrete update, so its effect (and the toolbar's re-render) is committed synchronously. */
function updateSync(editor: LexicalEditor, run: () => void): void {
  editor.update(run, { discrete: true });
}

function readState<T>(editor: LexicalEditor, run: () => T): T {
  return editor.getEditorState().read(run);
}

/** Clicks a toolbar button by its accessible name and flushes the resulting non-discrete update. */
async function clickToggle(name: string): Promise<void> {
  const button = screen.getByRole("button", { name });
  fireEvent.click(button);
  await act(async () => {
    await Promise.resolve();
  });
}

function isPressed(name: string): boolean {
  return screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true";
}

describe("Toolbar — reflects selection state", () => {
  test("shows Paragraph active and no formats pressed for the default empty selection", async () => {
    await mountToolbar();
    expect(isPressed("Paragraph")).toBe(true);
    expect(isPressed("Bold")).toBe(false);
    expect(isPressed("Heading 1")).toBe(false);
    expect(isPressed("Quote")).toBe(false);
    expect(isPressed("Bullet list")).toBe(false);
    expect(isPressed("Numbered list")).toBe(false);
    expect(isPressed("Code block")).toBe(false);
  });

  test("shows Heading 1 pressed when the selection's top-level block is an h1", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const heading = $createHeadingNode("h1");
      heading.append($createTextNode("Title"));
      root.append(heading);
      heading.selectStart();
    });
    expect(isPressed("Heading 1")).toBe(true);
    expect(isPressed("Paragraph")).toBe(false);
    expect(isPressed("Heading 2")).toBe(false);
  });

  test("shows Heading 2 pressed when the selection's top-level block is an h2", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const heading = $createHeadingNode("h2");
      heading.append($createTextNode("Subtitle"));
      root.append(heading);
      heading.selectStart();
    });
    expect(isPressed("Heading 2")).toBe(true);
    expect(isPressed("Heading 1")).toBe(false);
  });

  test("shows Heading 3 pressed when the selection's top-level block is an h3", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const heading = $createHeadingNode("h3");
      heading.append($createTextNode("Section"));
      root.append(heading);
      heading.selectStart();
    });
    expect(isPressed("Heading 3")).toBe(true);
    expect(isPressed("Heading 2")).toBe(false);
  });

  test("shows Quote pressed when the selection's top-level block is a QuoteNode", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const quote = $createQuoteNode();
      quote.append($createTextNode("A remark"));
      root.append(quote);
      quote.selectStart();
    });
    expect(isPressed("Quote")).toBe(true);
    expect(isPressed("Paragraph")).toBe(false);
  });

  test("shows Bullet list pressed when the selection is inside a bullet ListNode", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const list = $createListNode("bullet");
      const item = $createListItemNode();
      item.append($createTextNode("First item"));
      list.append(item);
      root.append(list);
      list.selectStart();
    });
    expect(isPressed("Bullet list")).toBe(true);
    expect(isPressed("Numbered list")).toBe(false);
  });

  test("shows Numbered list pressed when the selection is inside a numbered ListNode", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const list = $createListNode("number");
      const item = $createListItemNode();
      item.append($createTextNode("Step one"));
      list.append(item);
      root.append(list);
      list.selectStart();
    });
    expect(isPressed("Numbered list")).toBe(true);
    expect(isPressed("Bullet list")).toBe(false);
  });

  test("shows Code block pressed with no formats for a node selection of a single CodeBlockNode", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const codeBlock = $createCodeBlockNode("const x = 1;", "typescript");
      root.append(codeBlock);
      const selection = $createNodeSelection();
      selection.add(codeBlock.getKey());
      $setSelection(selection);
    });
    expect(isPressed("Code block")).toBe(true);
    expect(isPressed("Bold")).toBe(false);
    expect(isPressed("Paragraph")).toBe(false);
  });

  test("falls back to the default state for a node selection of a single non-code-block node", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const divider = $createDividerNode();
      root.append(divider);
      const selection = $createNodeSelection();
      selection.add(divider.getKey());
      $setSelection(selection);
    });
    expect(isPressed("Code block")).toBe(false);
    expect(isPressed("Paragraph")).toBe(true);
  });

  test("falls back to the default state for a node selection spanning more than one node", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const codeBlock = $createCodeBlockNode("const x = 1;", "typescript");
      const divider = $createDividerNode();
      root.append(codeBlock);
      root.append(divider);
      const selection = $createNodeSelection();
      selection.add(codeBlock.getKey());
      selection.add(divider.getKey());
      $setSelection(selection);
    });
    expect(isPressed("Code block")).toBe(false);
    expect(isPressed("Paragraph")).toBe(true);
  });
});

describe("Toolbar — inline text-format actions", () => {
  test("clicking Bold toggles the bold format on and off, on both the button and the text node", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      const text = $createTextNode("hello world");
      paragraph.append(text);
      root.append(paragraph);
      text.select(0, text.getTextContentSize());
    });
    expect(isPressed("Bold")).toBe(false);

    await clickToggle("Bold");
    expect(isPressed("Bold")).toBe(true);
    expect(
      readState(editor, () => {
        const node = $getRoot().getFirstChild()?.getFirstChild() ?? null;
        return $isTextNode(node) && node.hasFormat("bold");
      }),
    ).toBe(true);

    await clickToggle("Bold");
    expect(isPressed("Bold")).toBe(false);
    expect(
      readState(editor, () => {
        const node = $getRoot().getFirstChild()?.getFirstChild() ?? null;
        return $isTextNode(node) && node.hasFormat("bold");
      }),
    ).toBe(false);
  });

  test("clicking Italic, Underline, Strikethrough and Inline code in sequence leaves all of them pressed simultaneously", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      const text = $createTextNode("hello world");
      paragraph.append(text);
      root.append(paragraph);
      text.select(0, text.getTextContentSize());
    });

    await clickToggle("Italic");
    await clickToggle("Underline");
    await clickToggle("Strikethrough");
    await clickToggle("Inline code");

    expect(isPressed("Italic")).toBe(true);
    expect(isPressed("Underline")).toBe(true);
    expect(isPressed("Strikethrough")).toBe(true);
    expect(isPressed("Inline code")).toBe(true);
    expect(isPressed("Bold")).toBe(false);
    // The block-type buttons are unaffected by inline formats.
    expect(isPressed("Paragraph")).toBe(true);
  });
});

describe("Toolbar — block-type actions", () => {
  test("clicking Heading 1 converts the current paragraph into an h1, preserving its text", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("Title text"));
      root.append(paragraph);
      paragraph.selectStart();
    });

    await clickToggle("Heading 1");

    expect(isPressed("Heading 1")).toBe(true);
    expect(
      readState(editor, () => {
        const first = $getRoot().getFirstChild();
        return $isHeadingNode(first) ? [first.getTag(), first.getTextContent()] : null;
      }),
    ).toEqual(["h1", "Title text"]);
  });

  test("clicking Paragraph converts the current heading block back into a paragraph", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const heading = $createHeadingNode("h2");
      heading.append($createTextNode("Was a heading"));
      root.append(heading);
      heading.selectStart();
    });

    await clickToggle("Paragraph");

    expect(isPressed("Paragraph")).toBe(true);
    expect(isPressed("Heading 2")).toBe(false);
    expect(
      readState(editor, () => {
        const first = $getRoot().getFirstChild();
        return $isParagraphNode(first) ? first.getTextContent() : null;
      }),
    ).toBe("Was a heading");
  });

  test("clicking Quote converts the current block into a QuoteNode, preserving its text", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("Notable remark"));
      root.append(paragraph);
      paragraph.selectStart();
    });

    await clickToggle("Quote");

    expect(isPressed("Quote")).toBe(true);
    expect(
      readState(editor, () => {
        const first = $getRoot().getFirstChild();
        return $isQuoteNode(first) ? first.getTextContent() : null;
      }),
    ).toBe("Notable remark");
  });

  test("clicking Bullet list inserts a bullet list when none is active", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("A list item"));
      root.append(paragraph);
      paragraph.selectStart();
    });

    await clickToggle("Bullet list");

    expect(isPressed("Bullet list")).toBe(true);
    expect(
      readState(editor, () => {
        const first = $getRoot().getFirstChild();
        return $isListNode(first) ? [first.getListType(), first.getTextContent()] : null;
      }),
    ).toEqual(["bullet", "A list item"]);
  });

  test("clicking Bullet list removes the list when a bullet list is already active", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const list = $createListNode("bullet");
      const item = $createListItemNode();
      item.append($createTextNode("A list item"));
      list.append(item);
      root.append(list);
      list.selectStart();
    });
    expect(isPressed("Bullet list")).toBe(true);

    await clickToggle("Bullet list");

    expect(isPressed("Bullet list")).toBe(false);
    expect(readState(editor, () => $isListNode($getRoot().getFirstChild()))).toBe(false);
    expect(readState(editor, () => $getRoot().getTextContent())).toBe("A list item");
  });

  test("clicking Numbered list inserts a numbered list when none is active", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("Step one"));
      root.append(paragraph);
      paragraph.selectStart();
    });

    await clickToggle("Numbered list");

    expect(isPressed("Numbered list")).toBe(true);
    expect(
      readState(editor, () => {
        const first = $getRoot().getFirstChild();
        return $isListNode(first) ? first.getListType() : null;
      }),
    ).toBe("number");
  });

  test("clicking Numbered list removes the list when a numbered list is already active", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const list = $createListNode("number");
      const item = $createListItemNode();
      item.append($createTextNode("Step one"));
      list.append(item);
      root.append(list);
      list.selectStart();
    });
    expect(isPressed("Numbered list")).toBe(true);

    await clickToggle("Numbered list");

    expect(isPressed("Numbered list")).toBe(false);
    expect(readState(editor, () => $isListNode($getRoot().getFirstChild()))).toBe(false);
  });

  test("clicking Code block converts the current paragraph into a CodeBlockNode carrying its text as code", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("console.log(1);"));
      root.append(paragraph);
      paragraph.selectStart();
    });

    await clickToggle("Code block");

    expect(isPressed("Code block")).toBe(true);
    expect(
      readState(editor, () => {
        const first = $getRoot().getFirstChild();
        return $isCodeBlockNode(first) ? [first.getCode(), first.getLanguage()] : null;
      }),
    ).toEqual(["console.log(1);", "plaintext"]);
  });

  test("clicking Divider inserts a DividerNode after the current block and moves selection into a new trailing paragraph", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("Above the rule"));
      root.append(paragraph);
      paragraph.selectStart();
    });

    await clickToggle("Divider");

    const children = readState(editor, () => $getRoot().getChildren());
    expect(children).toHaveLength(3);
    expect(readState(editor, () => $isDividerNode(children[1]))).toBe(true);
    expect(readState(editor, () => $isParagraphNode(children[2]) && children[2].getTextContent() === "")).toBe(
      true,
    );
    expect(
      readState(editor, () => {
        const selection = $getSelection();
        return $isParagraphNode(children[2]) && selection !== null && selection.getNodes().at(0)?.is(children[2]);
      }),
    ).toBe(true);
    // The Divider button itself is never shown as pressed.
    expect(isPressed("Divider")).toBe(false);
  });
});

describe("Toolbar — non-range selection guards", () => {
  test("clicking Code block does nothing when the current selection is a node selection", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const codeBlock = $createCodeBlockNode("const x = 1;", "typescript");
      root.append(codeBlock);
      const selection = $createNodeSelection();
      selection.add(codeBlock.getKey());
      $setSelection(selection);
    });

    await clickToggle("Code block");

    expect(readState(editor, () => $getRoot().getChildrenSize())).toBe(1);
    expect(
      readState(editor, () => {
        const first = $getRoot().getFirstChild();
        return $isCodeBlockNode(first) ? [first.getCode(), first.getLanguage()] : null;
      }),
    ).toEqual(["const x = 1;", "typescript"]);
  });

  test("clicking Divider does nothing when the current selection is a node selection", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const codeBlock = $createCodeBlockNode("const x = 1;", "typescript");
      root.append(codeBlock);
      const selection = $createNodeSelection();
      selection.add(codeBlock.getKey());
      $setSelection(selection);
    });

    await clickToggle("Divider");

    expect(readState(editor, () => $getRoot().getChildrenSize())).toBe(1);
  });

  test("clicking Heading 1 does nothing when the current selection is a node selection", async () => {
    const { editor } = await mountToolbar();
    updateSync(editor, () => {
      const root = $getRoot().clear();
      const codeBlock = $createCodeBlockNode("const x = 1;", "typescript");
      root.append(codeBlock);
      const selection = $createNodeSelection();
      selection.add(codeBlock.getKey());
      $setSelection(selection);
    });

    await clickToggle("Heading 1");

    expect(readState(editor, () => $getRoot().getChildrenSize())).toBe(1);
    expect(readState(editor, () => $isCodeBlockNode($getRoot().getFirstChild()))).toBe(true);
  });
});
