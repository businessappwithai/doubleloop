// tests/documents-blocks.test.ts — module m11 (documents). Pure zod schema + Markdown projection
// over `BlockPayload` (`src/modules/documents/blocks.ts`). No I/O, no CRDT: `blockPayloadSchema`
// accept/reject pairs, a Markdown round trip for every block type, and the `countWords` boundary
// cases the word-count column depends on.
import { describe, test, expect } from "vitest";
import {
  blockPayloadSchema,
  blockSchema,
  blocksToMarkdown,
  blockToMarkdown,
  countWords,
  EMPTY_BLOCK_PAYLOAD,
  type Block,
  type BlockPayload,
} from "../src/modules/documents/blocks";

describe("blockSchema", () => {
  test.each<[string, Block]>([
    ["paragraph", { type: "paragraph", text: "hello world" }],
    ["heading", { type: "heading", level: 2, text: "Title" }],
    ["quote", { type: "quote", text: "a witty remark" }],
    ["code with a language", { type: "code", language: "ts", code: "const x = 1;" }],
    ["code with no language", { type: "code", language: null, code: "plain" }],
    ["list", { type: "list", ordered: false, items: ["a", "b"] }],
    ["divider", { type: "divider" }],
  ])("accepts a valid %s block", (_name, block) => {
    expect(blockSchema.safeParse(block).success).toBe(true);
  });

  test.each([1, 2, 3, 4, 5, 6])("accepts heading level %d", (level) => {
    expect(blockSchema.safeParse({ type: "heading", level, text: "t" }).success).toBe(true);
  });

  test.each([0, 7, 1.5, -1])("rejects heading level %s outside 1-6", (level) => {
    expect(blockSchema.safeParse({ type: "heading", level, text: "t" }).success).toBe(false);
  });

  test("rejects an unrecognised discriminant", () => {
    const result = blockSchema.safeParse({ type: "footnote", text: "nope" });
    expect(result.success).toBe(false);
  });

  test("rejects a paragraph carrying an extra, unrecognised key", () => {
    const result = blockSchema.safeParse({ type: "paragraph", text: "hi", extra: true });
    expect(result.success).toBe(false);
  });

  test("rejects a code block missing the required language key", () => {
    const result = blockSchema.safeParse({ type: "code", code: "x" });
    expect(result.success).toBe(false);
  });

  test("rejects a code block whose language is undefined instead of null", () => {
    const result = blockSchema.safeParse({ type: "code", language: undefined, code: "x" });
    expect(result.success).toBe(false);
  });

  test("rejects a list whose items are not strings", () => {
    const result = blockSchema.safeParse({ type: "list", ordered: true, items: [1, 2] });
    expect(result.success).toBe(false);
  });
});

describe("blockPayloadSchema", () => {
  test("accepts EMPTY_BLOCK_PAYLOAD", () => {
    expect(blockPayloadSchema.safeParse(EMPTY_BLOCK_PAYLOAD).success).toBe(true);
  });

  test("accepts a payload containing every block type", () => {
    const payload: BlockPayload = {
      root: {
        type: "root",
        children: [
          { type: "heading", level: 1, text: "Doc" },
          { type: "paragraph", text: "intro" },
          { type: "list", ordered: false, items: ["a"] },
          { type: "code", language: "sql", code: "SELECT 1;" },
          { type: "quote", text: "quoted" },
          { type: "divider" },
        ],
      },
    };
    expect(blockPayloadSchema.safeParse(payload).success).toBe(true);
  });

  test("rejects a payload missing the root key", () => {
    expect(blockPayloadSchema.safeParse({}).success).toBe(false);
  });

  test("rejects a payload whose root.type is not the literal 'root'", () => {
    const result = blockPayloadSchema.safeParse({ root: { type: "not-root", children: [] } });
    expect(result.success).toBe(false);
  });

  test("rejects a payload with an unrecognised top-level key", () => {
    const result = blockPayloadSchema.safeParse({ root: { type: "root", children: [] }, extra: 1 });
    expect(result.success).toBe(false);
  });

  test("rejects a payload whose children contain an invalid block", () => {
    const result = blockPayloadSchema.safeParse({
      root: { type: "root", children: [{ type: "paragraph" }] },
    });
    expect(result.success).toBe(false);
  });

  test("rejects null and non-object input", () => {
    expect(blockPayloadSchema.safeParse(null).success).toBe(false);
    expect(blockPayloadSchema.safeParse("not-an-object").success).toBe(false);
    expect(blockPayloadSchema.safeParse(42).success).toBe(false);
  });
});

describe("blockToMarkdown", () => {
  test("renders a paragraph as text plus a blank line", () => {
    expect(blockToMarkdown({ type: "paragraph", text: "hello" })).toBe("hello\n\n");
  });

  test.each([1, 2, 3, 4, 5, 6])("renders a level-%d heading with that many leading #", (level) => {
    const block: Block = { type: "heading", level: level as 1 | 2 | 3 | 4 | 5 | 6, text: "Title" };
    expect(blockToMarkdown(block)).toBe(`${"#".repeat(level)} Title\n\n`);
  });

  test("renders a single-line quote with a leading >", () => {
    expect(blockToMarkdown({ type: "quote", text: "one liner" })).toBe("> one liner\n\n");
  });

  test("renders a multi-line quote with > on every line, and a bare > for blank lines", () => {
    expect(blockToMarkdown({ type: "quote", text: "line one\n\nline two" })).toBe(
      "> line one\n>\n> line two\n\n",
    );
  });

  test("renders a fenced code block with its language tag", () => {
    expect(blockToMarkdown({ type: "code", language: "ts", code: "const x = 1;" })).toBe(
      "```ts\nconst x = 1;\n```\n\n",
    );
  });

  test("renders a fenced code block with no language tag when language is null", () => {
    expect(blockToMarkdown({ type: "code", language: null, code: "plain" })).toBe("```\nplain\n```\n\n");
  });

  test("renders an ordered list with numbered markers", () => {
    expect(blockToMarkdown({ type: "list", ordered: true, items: ["first", "second"] })).toBe(
      "1. first\n2. second\n\n",
    );
  });

  test("renders an unordered list with dash markers", () => {
    expect(blockToMarkdown({ type: "list", ordered: false, items: ["a", "b"] })).toBe("- a\n- b\n\n");
  });

  test("renders an empty list as a bare trailing blank line", () => {
    expect(blockToMarkdown({ type: "list", ordered: false, items: [] })).toBe("\n\n");
  });

  test("renders a divider as a thematic break", () => {
    expect(blockToMarkdown({ type: "divider" })).toBe("---\n\n");
  });
});

describe("blocksToMarkdown", () => {
  test("returns the empty string for an empty children list", () => {
    expect(blocksToMarkdown(EMPTY_BLOCK_PAYLOAD)).toBe("");
  });

  test("joins multiple blocks in order with a single trailing newline", () => {
    const payload: BlockPayload = {
      root: {
        type: "root",
        children: [
          { type: "heading", level: 1, text: "Title" },
          { type: "paragraph", text: "body" },
          { type: "divider" },
        ],
      },
    };
    expect(blocksToMarkdown(payload)).toBe("# Title\n\nbody\n\n---\n");
  });

  test("does not leave trailing blank lines beyond the final newline", () => {
    const payload: BlockPayload = { root: { type: "root", children: [{ type: "paragraph", text: "only" }] } };
    const markdown = blocksToMarkdown(payload);
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("countWords", () => {
  test("returns 0 for the empty string", () => {
    expect(countWords("")).toBe(0);
  });

  test("returns 0 for whitespace-only input", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });

  test("counts words separated by single spaces", () => {
    expect(countWords("one two three")).toBe(3);
  });

  test("collapses runs of whitespace, including newlines, between words", () => {
    expect(countWords("one\n\ntwo   three\tfour")).toBe(4);
  });

  test("counts a single word with no internal whitespace as one", () => {
    expect(countWords("word")).toBe(1);
  });

  test("ignores leading and trailing whitespace when counting", () => {
    expect(countWords("  padded on both sides  ")).toBe(4);
  });
});
