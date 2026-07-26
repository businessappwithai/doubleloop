// tests/okf-markdown-document.test.ts — module m8 (OKF core). `splitDocument`/`joinDocument`:
// no frontmatter, an unterminated fence, CRLF, a leading BOM, and an empty body; plus
// `conceptFileName` for a leaf and a parent concept.
import { describe, test, expect } from "vitest";
import { splitDocument, joinDocument, conceptFileName } from "../src/core/okf/markdown-document";
import { ValidationError } from "../src/core/errors";
import type { Concept } from "../src/core/types";

describe("splitDocument", () => {
  test("returns null frontmatter and the whole text as body when there is no opening fence", () => {
    const text = "# Just a heading\n\nSome body text.\n";
    expect(splitDocument(text)).toEqual({ frontmatter: null, body: text });
  });

  test("treats an empty string as a bodyless, frontmatter-less document", () => {
    expect(splitDocument("")).toEqual({ frontmatter: null, body: "" });
  });

  test("treats a lone '---' with no trailing newline as body, not an opening fence", () => {
    expect(splitDocument("---")).toEqual({ frontmatter: null, body: "---" });
  });

  test("splits a well-formed document into frontmatter and body", () => {
    const text = "---\nfoo: bar\n---\nBody line one.\nBody line two.\n";
    expect(splitDocument(text)).toEqual({
      frontmatter: "foo: bar",
      body: "Body line one.\nBody line two.\n",
    });
  });

  test("supports an empty frontmatter block", () => {
    const text = "---\n---\nBody.\n";
    expect(splitDocument(text)).toEqual({ frontmatter: "", body: "Body.\n" });
  });

  test("supports an empty body", () => {
    const text = "---\nfoo: bar\n---\n";
    expect(splitDocument(text)).toEqual({ frontmatter: "foo: bar", body: "" });
  });

  test("supports an empty body with no trailing newline after the closing fence", () => {
    const text = "---\nfoo: bar\n---";
    expect(splitDocument(text)).toEqual({ frontmatter: "foo: bar", body: "" });
  });

  test("handles CRLF line endings around both fences", () => {
    const text = "---\r\nfoo: bar\r\n---\r\nBody text\r\n";
    expect(splitDocument(text)).toEqual({
      frontmatter: "foo: bar",
      body: "Body text\r\n",
    });
  });

  test("strips a leading UTF-8 BOM before looking for the opening fence", () => {
    const text = "﻿---\nfoo: bar\n---\nBody\n";
    expect(splitDocument(text)).toEqual({ frontmatter: "foo: bar", body: "Body\n" });
  });

  test("throws document.unterminatedFrontmatter when the fence is opened but never closed", () => {
    const text = "---\nfoo: bar\nno closing fence here\n";
    expect(() => splitDocument(text)).toThrow(ValidationError);
    try {
      splitDocument(text);
      throw new Error("expected splitDocument to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details["reason"]).toBe(
        "document.unterminatedFrontmatter",
      );
    }
  });

  test("throws document.unterminatedFrontmatter for an opening fence with nothing after it", () => {
    expect(() => splitDocument("---\n")).toThrow(ValidationError);
  });
});

describe("joinDocument", () => {
  test("reassembles frontmatter and body with '---' fences and LF line endings", () => {
    expect(joinDocument({ frontmatter: "foo: bar", body: "Hello.\n" })).toBe(
      "---\nfoo: bar\n---\nHello.\n",
    );
  });

  test("emits no fences when frontmatter is null", () => {
    expect(joinDocument({ frontmatter: null, body: "Just a body.\n" })).toBe("Just a body.\n");
  });

  test("round-trips through splitDocument", () => {
    const doc = { frontmatter: "foo: bar", body: "Body content.\n" };
    expect(splitDocument(joinDocument(doc))).toEqual(doc);
  });

  test("round-trips a frontmatter-less document through splitDocument", () => {
    const doc = { frontmatter: null, body: "No frontmatter here.\n" };
    expect(splitDocument(joinDocument(doc))).toEqual(doc);
  });

  test("round-trips an empty frontmatter block", () => {
    const doc = { frontmatter: "", body: "Body.\n" };
    expect(splitDocument(joinDocument(doc))).toEqual(doc);
  });

  test("round-trips an empty body", () => {
    const doc = { frontmatter: "foo: bar", body: "" };
    expect(splitDocument(joinDocument(doc))).toEqual(doc);
  });
});

describe("conceptFileName", () => {
  function concept(overrides: Partial<Pick<Concept, "slug" | "isIndex" | "childCount">>) {
    return { slug: "my-concept", isIndex: false, childCount: 0, ...overrides };
  }

  test("returns '<slug>.md' for a leaf concept", () => {
    expect(conceptFileName(concept({ slug: "leaf-concept" }))).toBe("leaf-concept.md");
  });

  test("returns 'index.md' for a concept with children", () => {
    expect(conceptFileName(concept({ slug: "parent-concept", childCount: 3 }))).toBe("index.md");
  });

  test("returns 'index.md' when isIndex is true even with no children", () => {
    expect(conceptFileName(concept({ slug: "forced-index", isIndex: true, childCount: 0 }))).toBe(
      "index.md",
    );
  });

  test("returns 'index.md' when both isIndex and childCount indicate an index", () => {
    expect(
      conceptFileName(concept({ slug: "both", isIndex: true, childCount: 5 })),
    ).toBe("index.md");
  });
});
