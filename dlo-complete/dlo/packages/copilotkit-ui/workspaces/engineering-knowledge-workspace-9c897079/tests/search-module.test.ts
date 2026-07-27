// tests/search-module.test.ts — module m12 (search). Covers search-module.ts against a faked
// SearchRepository (vi.fn(), per Architecture.md's "service tests inject a fake repo" testing
// strategy — never a real Db): row-to-SearchHit mapping for text-only/containment-only/combined
// queries, the SearchHitConnection built over zero results and past the last page, and the
// highlightSnippet pure function's boundaries — a match at position 0, a match at the end of the
// body, no match, and no terms at all.
import { describe, expect, test, vi } from "vitest";
import {
  SNIPPET_CONTEXT_CHARS,
  createSearchModule,
  highlightSnippet,
  type SearchHit,
} from "../src/modules/search/search-module";
import type { SearchRepository, SearchRow } from "../src/modules/search/search-repository";
import { encodeCursor } from "../src/core/connection";
import { asBundleId } from "../src/core/ids";

const BUNDLE_ID = asBundleId("f47ac10b-58cc-4372-a567-0e02b2c3d479");

function row(overrides: Partial<SearchRow> = {}): SearchRow {
  return {
    id: "id-1",
    path: "a/b",
    title: "Ingress controllers",
    bodyMarkdown: "Configuring an ingress controller for the cluster.",
    rank: 0.5,
    ...overrides,
  };
}

function fakeRepo(rows: readonly SearchRow[]): SearchRepository {
  return { search: vi.fn().mockResolvedValue(rows) };
}

describe("createSearchModule — search", () => {
  test("text-only: maps rows to SearchHit and highlights the matched term", async () => {
    const rows = [row()];
    const repo = fakeRepo(rows);
    const module_ = createSearchModule(repo);

    const result = await module_.search({ bundleId: BUNDLE_ID, text: "ingress" }, {});

    expect(repo.search).toHaveBeenCalledWith({ bundleId: BUNDLE_ID, text: "ingress" });
    expect(result.totalCount).toBe(1);
    const hit = result.edges[0]?.node as SearchHit;
    expect(hit.id).toBe("id-1");
    expect(hit.sortKey).toBe("a/b");
    expect(hit.title).toBe("Ingress controllers");
    expect(hit.path).toBe("a/b");
    expect(hit.rank).toBe(0.5);
    expect(hit.snippet).toBe("Configuring an **ingress** controller for the cluster.");
  });

  test("containment-only: no terms to highlight, snippet is a plain truncation", async () => {
    const shortBody = "A short body with no query text to highlight.";
    const rows = [row({ bodyMarkdown: shortBody })];
    const repo = fakeRepo(rows);
    const module_ = createSearchModule(repo);

    const result = await module_.search({ bundleId: BUNDLE_ID, containment: { root: {} } }, {});

    expect(repo.search).toHaveBeenCalledWith({ bundleId: BUNDLE_ID, containment: { root: {} } });
    const hit = result.edges[0]?.node as SearchHit;
    expect(hit.snippet).toBe(shortBody);
    expect(hit.snippet).not.toContain("**");
  });

  test("combined query: highlights using the text terms alongside the containment predicate", async () => {
    const rows = [row({ bodyMarkdown: "The cluster runs an ingress controller." })];
    const repo = fakeRepo(rows);
    const module_ = createSearchModule(repo);

    const result = await module_.search(
      { bundleId: BUNDLE_ID, text: "ingress", containment: { root: {} } },
      {},
    );

    const hit = result.edges[0]?.node as SearchHit;
    expect(hit.snippet).toContain("**ingress**");
  });

  test("zero results produce an empty connection with null cursors", async () => {
    const repo = fakeRepo([]);
    const module_ = createSearchModule(repo);

    const result = await module_.search({ bundleId: BUNDLE_ID, text: "nonexistent" }, {});

    expect(result.edges).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    });
  });

  test("pagination past the end returns no further edges", async () => {
    const rows = [row({ id: "id-1", path: "a" }), row({ id: "id-2", path: "b" })];
    const repo = fakeRepo(rows);
    const module_ = createSearchModule(repo);
    const lastCursor = encodeCursor("b", "id-2");

    const result = await module_.search({ bundleId: BUNDLE_ID, text: "cluster" }, { after: lastCursor });

    expect(result.edges).toEqual([]);
    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(result.totalCount).toBe(2);
  });
});

describe("highlightSnippet", () => {
  test("highlights a match at position 0 with no leading ellipsis", () => {
    const body = "Ingress is the front door for cluster traffic.";
    const snippet = highlightSnippet(body, ["ingress"]);
    expect(snippet.startsWith("**Ingress**")).toBe(true);
    expect(snippet).not.toMatch(/^…/);
  });

  test("highlights a match ending exactly at the end of the body with no trailing ellipsis", () => {
    const body = `${"x".repeat(SNIPPET_CONTEXT_CHARS)}ingress`;
    const snippet = highlightSnippet(body, ["ingress"]);
    expect(snippet.endsWith("**ingress**")).toBe(true);
    expect(snippet).not.toMatch(/…$/);
  });

  test("adds leading and trailing ellipsis when the window is truncated on both sides", () => {
    const body = `${"a".repeat(200)}ingress${"b".repeat(200)}`;
    const snippet = highlightSnippet(body, ["ingress"]);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("**ingress**");
  });

  test("matches case-insensitively", () => {
    const body = "The INGRESS controller routes traffic.";
    const snippet = highlightSnippet(body, ["ingress"]);
    expect(snippet).toContain("**INGRESS**");
  });

  test("picks the leftmost match across multiple terms", () => {
    const body = "alpha then beta then gamma";
    const snippet = highlightSnippet(body, ["gamma", "beta"]);
    expect(snippet).toContain("**beta**");
    expect(snippet).not.toContain("**gamma**");
  });

  test("with no terms, returns a plain truncation with no highlight", () => {
    const body = "a".repeat(200);
    const snippet = highlightSnippet(body, []);
    expect(snippet).not.toContain("**");
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBe(SNIPPET_CONTEXT_CHARS * 2 + 1);
  });

  test("with terms that do not occur in the body, returns a plain truncation with no highlight", () => {
    const body = "a".repeat(200);
    const snippet = highlightSnippet(body, ["nonexistent"]);
    expect(snippet).not.toContain("**");
    expect(snippet.endsWith("…")).toBe(true);
  });

  test("a body shorter than the truncation window is returned whole with no ellipsis", () => {
    const body = "short body";
    const snippet = highlightSnippet(body, []);
    expect(snippet).toBe("short body");
  });

  test("an empty body with terms returns an empty snippet", () => {
    expect(highlightSnippet("", ["ingress"])).toBe("");
  });
});
