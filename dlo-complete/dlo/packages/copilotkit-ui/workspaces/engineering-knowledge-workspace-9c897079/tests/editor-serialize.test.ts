// tests/editor-serialize.test.ts — module m18 (Lexical block editor). Covers
// `editorStateToMarkdown`/`markdownToEditorState`/`$populateFromMarkdown` and the two custom
// transformers (`CODE_BLOCK_TRANSFORMER`, `DIVIDER_TRANSFORMER`) that make `CodeBlockNode` and
// `DividerNode` round-trip through markdown at all. A markdown-to-editor-state-to-markdown round
// trip is exercised for every block type this editor supports, plus the empty-document,
// whitespace-only, and malformed-markdown edge cases the module header on `serialize.ts`
// documents. Each test builds its own headless `LexicalEditor`, per the "fresh editor per test"
// requirement — no editor instance is shared between tests.
import { describe, test, expect, beforeEach } from "vitest";
import { createEditor, $getRoot, type LexicalEditor } from "lexical";
import { TRANSFORMERS } from "@lexical/markdown";
import {
  editorStateToMarkdown,
  markdownToEditorState,
  $populateFromMarkdown,
} from "../src/editor/markdown/serialize";
import {
  EDITOR_TRANSFORMERS,
  CODE_BLOCK_TRANSFORMER,
  DIVIDER_TRANSFORMER,
} from "../src/editor/markdown/transformers";
import { $createCodeBlockNode, $isCodeBlockNode } from "../src/editor/nodes/code-block-node";
import { $createDividerNode } from "../src/editor/nodes/divider-node";
import { editorNodes, editorOnError, editorTheme } from "../src/editor/config/editor-config";

function createTestEditor(namespace: string): LexicalEditor {
  return createEditor({
    namespace,
    nodes: editorNodes,
    onError: editorOnError,
    theme: editorTheme,
  });
}

let editor: LexicalEditor;

beforeEach(() => {
  editor = createTestEditor(`serialize-${Math.random().toString(36).slice(2)}`);
});

describe("EDITOR_TRANSFORMERS", () => {
  test("prepends the custom code-block and divider transformers ahead of @lexical/markdown's own set", () => {
    expect(EDITOR_TRANSFORMERS.length).toBe(TRANSFORMERS.length + 2);
    expect(EDITOR_TRANSFORMERS[0]).toBe(CODE_BLOCK_TRANSFORMER);
    expect(EDITOR_TRANSFORMERS[1]).toBe(DIVIDER_TRANSFORMER);
  });
});

describe("CODE_BLOCK_TRANSFORMER.export", () => {
  test("returns null for a non-CodeBlockNode", () => {
    let result: string | null = "unset";
    editor.update(
      () => {
        const root = $getRoot();
        result = CODE_BLOCK_TRANSFORMER.export(root, () => "");
      },
      { discrete: true },
    );
    expect(result).toBeNull();
  });

  test("fences with the language when it is not 'plaintext'", () => {
    let result: string | null = null;
    editor.update(
      () => {
        const node = $createCodeBlockNode("const x = 1;", "typescript");
        result = CODE_BLOCK_TRANSFORMER.export(node, () => "");
      },
      { discrete: true },
    );
    expect(result).toBe("```typescript\nconst x = 1;\n```");
  });

  test("omits the language tag on the fence when language is 'plaintext'", () => {
    let result: string | null = null;
    editor.update(
      () => {
        const node = $createCodeBlockNode("hello", "plaintext");
        result = CODE_BLOCK_TRANSFORMER.export(node, () => "");
      },
      { discrete: true },
    );
    expect(result).toBe("```\nhello\n```");
  });
});

describe("DIVIDER_TRANSFORMER.export", () => {
  test("returns null for a non-DividerNode", () => {
    let result: string | null = "unset";
    editor.update(
      () => {
        const root = $getRoot();
        result = DIVIDER_TRANSFORMER.export(root);
      },
      { discrete: true },
    );
    expect(result).toBeNull();
  });

  test("returns '---' for a DividerNode", () => {
    let result: string | null = null;
    editor.update(
      () => {
        result = DIVIDER_TRANSFORMER.export($createDividerNode());
      },
      { discrete: true },
    );
    expect(result).toBe("---");
  });
});

describe("markdown round trip over every block type", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly markdown: string }> = [
    { name: "paragraph", markdown: "Just a plain paragraph." },
    { name: "h1", markdown: "# Heading one" },
    { name: "h2", markdown: "## Heading two" },
    { name: "h3", markdown: "### Heading three" },
    { name: "h4", markdown: "#### Heading four" },
    { name: "h5", markdown: "##### Heading five" },
    { name: "h6", markdown: "###### Heading six" },
    { name: "quote", markdown: "> A quoted line" },
    { name: "bullet list", markdown: "-   Item one\n-   Item two" },
    { name: "ordered list", markdown: "1. Item one\n2. Item two" },
    { name: "code block with language", markdown: "```typescript\nconst x = 1;\n```" },
    { name: "code block without language", markdown: "```\nplain text code\n```" },
    { name: "divider", markdown: "---" },
    { name: "bold text", markdown: "**bold**" },
    // @lexical/markdown's default TRANSFORMERS export italic with '*', even though '_italic_'
    // parses on import — so '*italic*' is the one that round-trips byte-for-byte.
    { name: "italic text", markdown: "*italic*" },
    { name: "inline code", markdown: "`code`" },
    { name: "link", markdown: "[label](https://example.com)" },
  ];

  for (const { name, markdown } of cases) {
    test(`round-trips ${name}`, () => {
      markdownToEditorState(editor, markdown);
      const result = editorStateToMarkdown(editor);
      expect(result).toBe(markdown);
    });
  }

  test("round-trips a document containing every block type together, in order", () => {
    const markdown = [
      "# Title",
      "",
      "Some intro text.",
      "",
      "## Section",
      "",
      "> A callout",
      "",
      "-   First",
      "-   Second",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "---",
      "",
      "Closing paragraph.",
    ].join("\n");

    markdownToEditorState(editor, markdown);
    const result = editorStateToMarkdown(editor);
    expect(result).toBe(markdown);
  });
});

describe("empty and whitespace-only documents", () => {
  test("an empty string produces a single empty paragraph and serializes back to an empty string", () => {
    markdownToEditorState(editor, "");

    let childCount = 0;
    let firstChildType = "";
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      childCount = children.length;
      firstChildType = children[0]?.getType() ?? "";
    });

    expect(childCount).toBe(1);
    expect(firstChildType).toBe("paragraph");
    expect(editorStateToMarkdown(editor)).toBe("");
  });

  test("a whitespace-only string also leaves the root with a non-empty child list", () => {
    markdownToEditorState(editor, "   \n\t  \n");

    let childCount = 0;
    editor.getEditorState().read(() => {
      childCount = $getRoot().getChildrenSize();
    });

    expect(childCount).toBeGreaterThanOrEqual(1);
  });

  test("root never ends up with zero children even when re-populated from empty markdown", () => {
    markdownToEditorState(editor, "# First populate this");
    markdownToEditorState(editor, "");

    let childCount = 0;
    editor.getEditorState().read(() => {
      childCount = $getRoot().getChildrenSize();
    });

    expect(childCount).toBeGreaterThanOrEqual(1);
  });
});

describe("malformed markdown", () => {
  test("an unterminated code fence does not throw, and consumes the rest of the document as code", () => {
    expect(() => markdownToEditorState(editor, "```ts\nconst x = 1;")).not.toThrow();

    let hasCodeBlock = false;
    let code = "";
    let language = "";
    editor.getEditorState().read(() => {
      const node = $getRoot()
        .getChildren()
        .find((n) => $isCodeBlockNode(n));
      hasCodeBlock = node !== undefined;
      if ($isCodeBlockNode(node)) {
        code = node.getCode();
        language = node.getLanguage();
      }
    });
    expect(hasCodeBlock).toBe(true);
    expect(code).toBe("const x = 1;");
    expect(language).toBe("ts");
  });

  test("an unmatched inline bold marker does not throw and is preserved as literal text", () => {
    expect(() => markdownToEditorState(editor, "**bold without closing")).not.toThrow();

    let text = "";
    editor.getEditorState().read(() => {
      text = $getRoot().getTextContent();
    });
    expect(text).toBe("**bold without closing");
  });

  test("a lone '>' with no following space does not throw and is preserved as literal text", () => {
    expect(() => markdownToEditorState(editor, ">no space")).not.toThrow();

    let isQuote = false;
    let text = "";
    editor.getEditorState().read(() => {
      const first = $getRoot().getFirstChild();
      isQuote = first?.getType() === "quote";
      text = first?.getTextContent() ?? "";
    });
    expect(isQuote).toBe(false);
    expect(text).toBe(">no space");
  });
});

describe("$populateFromMarkdown", () => {
  test("callable directly inside an already-active editor.update, without its own wrapper update", () => {
    editor.update(
      () => {
        $populateFromMarkdown("# From inside an active update");
      },
      { discrete: true },
    );

    expect(editorStateToMarkdown(editor)).toBe("# From inside an active update");
  });
});
