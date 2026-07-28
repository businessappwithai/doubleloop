// tests/editor-markdown-shortcuts.test.ts — module m18 (Lexical block editor). Covers every
// `registerMarkdownShortcuts` arm ('# ' through '###### ', '- ', '* ', '1. ', '> ', a code
// fence, and '---'), a near-miss per shortcut family that must NOT transform, the "sole child of
// a plain paragraph" guard, and the unregister function returned by
// `editor.registerNodeTransform`. Each test builds its own headless `LexicalEditor` (see the
// module header on `editor-nodes.test.tsx` for why node construction/reads need one), so no
// editor instance is shared between tests. A node transform fires synchronously as soon as its
// `TextNode` is dirtied, so simply creating the paragraph+text inside a `{ discrete: true }`
// update — after registering the transform — is equivalent to "typing" the shortcut.
import { describe, test, expect, beforeEach } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { $isHeadingNode, $isQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { $isListNode } from "@lexical/list";
import { registerMarkdownShortcuts } from "../src/editor/transforms/markdown-shortcuts";
import { $isCodeBlockNode } from "../src/editor/nodes/code-block-node";
import { $isDividerNode } from "../src/editor/nodes/divider-node";
import { editorNodes, editorOnError, editorTheme } from "../src/editor/config/editor-config";

function createTestEditor(namespace: string): LexicalEditor {
  return createEditor({
    namespace,
    nodes: editorNodes,
    onError: editorOnError,
    theme: editorTheme,
  });
}

/** Replaces the root with a single paragraph containing one text node, and returns its type/text after reconciliation. */
function typeInFreshParagraph(
  editor: LexicalEditor,
  text: string,
): { rootChildCount: number; firstChildType: string } {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      root.append(paragraph);
    },
    { discrete: true },
  );

  let rootChildCount = 0;
  let firstChildType = "";
  editor.getEditorState().read(() => {
    const children = $getRoot().getChildren();
    rootChildCount = children.length;
    firstChildType = children[0]?.getType() ?? "";
  });
  return { rootChildCount, firstChildType };
}

let editor: LexicalEditor;

beforeEach(() => {
  editor = createTestEditor(`shortcuts-${Math.random().toString(36).slice(2)}`);
  registerMarkdownShortcuts(editor);
});

describe("heading shortcuts", () => {
  const levels: ReadonlyArray<{ hashes: string; tag: HeadingTagType }> = [
    { hashes: "#", tag: "h1" },
    { hashes: "##", tag: "h2" },
    { hashes: "###", tag: "h3" },
    { hashes: "####", tag: "h4" },
    { hashes: "#####", tag: "h5" },
    { hashes: "######", tag: "h6" },
  ];

  for (const { hashes, tag } of levels) {
    test(`'${hashes} ' converts the paragraph to a ${tag} heading with the remainder as text`, () => {
      typeInFreshParagraph(editor, `${hashes} Title`);

      let resultTag = "";
      let resultText = "";
      let isHeading = false;
      editor.getEditorState().read(() => {
        const node = $getRoot().getFirstChild();
        isHeading = $isHeadingNode(node);
        if ($isHeadingNode(node)) {
          resultTag = node.getTag();
          resultText = node.getTextContent();
        }
      });

      expect(isHeading).toBe(true);
      expect(resultTag).toBe(tag);
      expect(resultText).toBe("Title");
    });
  }

  test("'#Title' (no space) does not transform — heading near-miss", () => {
    typeInFreshParagraph(editor, "#Title");

    let isParagraph = false;
    let text = "";
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      isParagraph = node?.getType() === "paragraph";
      text = node?.getTextContent() ?? "";
    });

    expect(isParagraph).toBe(true);
    expect(text).toBe("#Title");
  });

  test("seven hashes ('####### ') does not match any heading level — near-miss", () => {
    typeInFreshParagraph(editor, "####### Title");

    let isParagraph = false;
    editor.getEditorState().read(() => {
      isParagraph = $getRoot().getFirstChild()?.getType() === "paragraph";
    });

    expect(isParagraph).toBe(true);
  });
});

describe("list shortcuts", () => {
  test("'- ' converts the paragraph to a bulleted list with the remainder as the item text", () => {
    typeInFreshParagraph(editor, "- Buy milk");

    let isList = false;
    let listType = "";
    let itemText = "";
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      isList = $isListNode(node);
      if ($isListNode(node)) {
        listType = node.getListType();
        const item = node.getFirstChild();
        itemText = item?.getTextContent() ?? "";
      }
    });

    expect(isList).toBe(true);
    expect(listType).toBe("bullet");
    expect(itemText).toBe("Buy milk");
  });

  test("'* ' also converts the paragraph to a bulleted list", () => {
    typeInFreshParagraph(editor, "* Buy eggs");

    let isList = false;
    let listType = "";
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      isList = $isListNode(node);
      if ($isListNode(node)) {
        listType = node.getListType();
      }
    });

    expect(isList).toBe(true);
    expect(listType).toBe("bullet");
  });

  test("'1. ' converts the paragraph to a numbered list", () => {
    typeInFreshParagraph(editor, "1. First step");

    let isList = false;
    let listType = "";
    let itemText = "";
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      isList = $isListNode(node);
      if ($isListNode(node)) {
        listType = node.getListType();
        itemText = node.getFirstChild()?.getTextContent() ?? "";
      }
    });

    expect(isList).toBe(true);
    expect(listType).toBe("number");
    expect(itemText).toBe("First step");
  });

  test("'2. ' does not trigger the ordered-list shortcut (only '1. ' is registered) — near-miss", () => {
    typeInFreshParagraph(editor, "2. Second step");

    let isParagraph = false;
    editor.getEditorState().read(() => {
      isParagraph = $getRoot().getFirstChild()?.getType() === "paragraph";
    });

    expect(isParagraph).toBe(true);
  });

  test("'-item' (no space) does not transform — list near-miss", () => {
    typeInFreshParagraph(editor, "-item");

    let isParagraph = false;
    editor.getEditorState().read(() => {
      isParagraph = $getRoot().getFirstChild()?.getType() === "paragraph";
    });

    expect(isParagraph).toBe(true);
  });
});

describe("quote shortcut", () => {
  test("'> ' converts the paragraph to a QuoteNode with the remainder as text", () => {
    typeInFreshParagraph(editor, "> Wise words");

    let isQuote = false;
    let text = "";
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      isQuote = $isQuoteNode(node);
      text = node?.getTextContent() ?? "";
    });

    expect(isQuote).toBe(true);
    expect(text).toBe("Wise words");
  });

  test("'>text' (no space) does not transform — quote near-miss", () => {
    typeInFreshParagraph(editor, ">text");

    let isParagraph = false;
    editor.getEditorState().read(() => {
      isParagraph = $getRoot().getFirstChild()?.getType() === "paragraph";
    });

    expect(isParagraph).toBe(true);
  });
});

describe("code fence shortcut", () => {
  test("'```ts ' converts the paragraph into an empty CodeBlockNode tagged with the language, followed by a new paragraph", () => {
    typeInFreshParagraph(editor, "```ts ");

    let firstIsCodeBlock = false;
    let language = "";
    let code = "unset";
    let secondIsParagraph = false;
    let childCount = 0;
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      childCount = children.length;
      const first = children[0];
      firstIsCodeBlock = $isCodeBlockNode(first);
      if ($isCodeBlockNode(first)) {
        language = first.getLanguage();
        code = first.getCode();
      }
      secondIsParagraph = children[1]?.getType() === "paragraph";
    });

    expect(childCount).toBe(2);
    expect(firstIsCodeBlock).toBe(true);
    expect(language).toBe("ts");
    expect(code).toBe("");
    expect(secondIsParagraph).toBe(true);
  });

  test("'``` ' with no language defaults the CodeBlockNode's language to 'plaintext'", () => {
    typeInFreshParagraph(editor, "``` ");

    let language = "";
    editor.getEditorState().read(() => {
      const first = $getRoot().getFirstChild();
      if ($isCodeBlockNode(first)) {
        language = first.getLanguage();
      }
    });

    expect(language).toBe("plaintext");
  });

  test("'```ts' with no trailing space does not transform — code fence near-miss", () => {
    typeInFreshParagraph(editor, "```ts");

    let isParagraph = false;
    editor.getEditorState().read(() => {
      isParagraph = $getRoot().getFirstChild()?.getType() === "paragraph";
    });

    expect(isParagraph).toBe(true);
  });
});

describe("divider shortcut", () => {
  const variants = ["---", "***", "___"];

  for (const variant of variants) {
    test(`'${variant}' converts the paragraph into a DividerNode followed by a new paragraph`, () => {
      typeInFreshParagraph(editor, variant);

      let firstIsDivider = false;
      let secondIsParagraph = false;
      let childCount = 0;
      editor.getEditorState().read(() => {
        const children = $getRoot().getChildren();
        childCount = children.length;
        firstIsDivider = $isDividerNode(children[0]);
        secondIsParagraph = children[1]?.getType() === "paragraph";
      });

      expect(childCount).toBe(2);
      expect(firstIsDivider).toBe(true);
      expect(secondIsParagraph).toBe(true);
    });
  }

  test("'----' (four dashes) does not transform — divider near-miss", () => {
    typeInFreshParagraph(editor, "----");

    let isParagraph = false;
    editor.getEditorState().read(() => {
      isParagraph = $getRoot().getFirstChild()?.getType() === "paragraph";
    });

    expect(isParagraph).toBe(true);
  });
});

describe("transform guards", () => {
  test("does not transform when the text node is not the sole child of its paragraph", () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("# "), $createTextNode("Title"));
        root.append(paragraph);
      },
      { discrete: true },
    );

    let isParagraph = false;
    let text = "";
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      isParagraph = node?.getType() === "paragraph";
      text = node?.getTextContent() ?? "";
    });

    expect(isParagraph).toBe(true);
    expect(text).toBe("# Title");
  });

  test("a heading already converted from a shortcut does not re-trigger on further edits", () => {
    typeInFreshParagraph(editor, "# Title");

    editor.update(() => {
      const heading = $getRoot().getFirstChild();
      const text = heading?.getChildren()[0];
      if (text && "setTextContent" in text) {
        (text as { setTextContent: (value: string) => void }).setTextContent("# Title -");
      }
    }, { discrete: true });

    let isHeading = false;
    let finalText = "";
    editor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      isHeading = $isHeadingNode(node);
      finalText = node?.getTextContent() ?? "";
    });

    expect(isHeading).toBe(true);
    expect(finalText).toBe("# Title -");
  });
});

describe("registerMarkdownShortcuts unregister", () => {
  test("returns a function that detaches the transform, after which shortcuts no longer fire", () => {
    const freshEditor = createTestEditor(`unregister-${Math.random().toString(36).slice(2)}`);
    const unregister = registerMarkdownShortcuts(freshEditor);

    unregister();

    typeInFreshParagraph(freshEditor, "# Title");

    let isParagraph = false;
    let text = "";
    freshEditor.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      isParagraph = node?.getType() === "paragraph";
      text = node?.getTextContent() ?? "";
    });

    expect(isParagraph).toBe(true);
    expect(text).toBe("# Title");
  });

  test("shortcuts still fire before unregister is called", () => {
    const freshEditor = createTestEditor(`still-registered-${Math.random().toString(36).slice(2)}`);
    registerMarkdownShortcuts(freshEditor);

    typeInFreshParagraph(freshEditor, "> Quoted");

    let isQuote = false;
    freshEditor.getEditorState().read(() => {
      isQuote = $isQuoteNode($getRoot().getFirstChild());
    });

    expect(isQuote).toBe(true);
  });
});
