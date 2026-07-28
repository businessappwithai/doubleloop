// tests/search-query-builder.test.ts — module m12 (search). Covers query-builder.ts's exact SQL
// text and parameter arrays for text-only, containment-only and combined queries, the always-
// present bundle_id scope, empty/whitespace-only rejection, the term-count limit, and
// splitSearchTerms's own boundaries. Pure function under test — no Db, no I/O.
import { describe, expect, test } from "vitest";
import {
  MAX_SEARCH_TERMS,
  buildSearchQuery,
  splitSearchTerms,
  type ContainmentFragment,
} from "../src/modules/search/query-builder";
import { asBundleId } from "../src/core/ids";
import { ValidationError } from "../src/core/errors";

const BUNDLE_ID = asBundleId("f47ac10b-58cc-4372-a567-0e02b2c3d479");

function expectValidation(thunk: () => unknown, message: string, details: Record<string, unknown>): void {
  expect(thunk).toThrow(ValidationError);
  try {
    thunk();
    throw new Error("expected buildSearchQuery to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    const validationError = err as ValidationError;
    expect(validationError.message).toBe(message);
    expect(validationError.code).toBe("validation");
    expect(validationError.details).toEqual(details);
  }
}

describe("buildSearchQuery — text-only", () => {
  test("builds ranked title/body/trigram predicate scoped by bundle_id", () => {
    const built = buildSearchQuery({ bundleId: BUNDLE_ID, text: "kubernetes ingress" });

    expect(built.sql).toBe(
      [
        "SELECT c.id AS id, c.path AS path, c.title AS title, d.body_markdown AS body_markdown,",
        "       ts_rank_cd(c.title_tsv || d.body_tsv, websearch_to_tsquery('okf_english', $2)) AS rank",
        "  FROM concepts c",
        "  JOIN concept_documents d ON d.concept_id = c.id",
        " WHERE c.bundle_id = $1",
        "   AND c.deleted_at IS NULL",
        "   AND (c.title_tsv @@ websearch_to_tsquery('okf_english', $2) OR d.body_tsv @@ websearch_to_tsquery('okf_english', $2) OR c.title ILIKE '%' || $2 || '%')",
        " ORDER BY rank DESC, c.path",
      ].join("\n"),
    );
    expect(built.params).toEqual([BUNDLE_ID, "kubernetes ingress"]);
  });

  test("trims surrounding whitespace from the text parameter", () => {
    const built = buildSearchQuery({ bundleId: BUNDLE_ID, text: "  ingress  " });
    expect(built.params).toEqual([BUNDLE_ID, "ingress"]);
  });

  test("no @> containment clause appears when containment is absent", () => {
    const built = buildSearchQuery({ bundleId: BUNDLE_ID, text: "ingress" });
    expect(built.sql).not.toContain("@>");
    expect(built.params).toHaveLength(2);
  });
});

describe("buildSearchQuery — containment-only", () => {
  const fragment: ContainmentFragment = {
    root: { children: [{ type: "code", language: "typescript" }] },
  };

  test("builds a plain @> predicate scoped by bundle_id with rank 0", () => {
    const built = buildSearchQuery({ bundleId: BUNDLE_ID, containment: fragment });

    expect(built.sql).toBe(
      [
        "SELECT c.id AS id, c.path AS path, c.title AS title, d.body_markdown AS body_markdown,",
        "       0 AS rank",
        "  FROM concepts c",
        "  JOIN concept_documents d ON d.concept_id = c.id",
        " WHERE c.bundle_id = $1",
        "   AND c.deleted_at IS NULL",
        "   AND d.content_blocks @> $2::jsonb",
        " ORDER BY rank DESC, c.path",
      ].join("\n"),
    );
    expect(built.params).toEqual([BUNDLE_ID, JSON.stringify(fragment)]);
  });

  test("no websearch_to_tsquery/ILIKE clause appears when text is absent", () => {
    const built = buildSearchQuery({ bundleId: BUNDLE_ID, containment: fragment });
    expect(built.sql).not.toContain("websearch_to_tsquery");
    expect(built.sql).not.toContain("ILIKE");
  });
});

describe("buildSearchQuery — combined", () => {
  const fragment: ContainmentFragment = { root: { children: [{ type: "callout" }] } };

  test("ANDs the text predicate ($2) and the containment predicate ($3)", () => {
    const built = buildSearchQuery({ bundleId: BUNDLE_ID, text: "runbook", containment: fragment });

    expect(built.sql).toBe(
      [
        "SELECT c.id AS id, c.path AS path, c.title AS title, d.body_markdown AS body_markdown,",
        "       ts_rank_cd(c.title_tsv || d.body_tsv, websearch_to_tsquery('okf_english', $2)) AS rank",
        "  FROM concepts c",
        "  JOIN concept_documents d ON d.concept_id = c.id",
        " WHERE c.bundle_id = $1",
        "   AND c.deleted_at IS NULL",
        "   AND (c.title_tsv @@ websearch_to_tsquery('okf_english', $2) OR d.body_tsv @@ websearch_to_tsquery('okf_english', $2) OR c.title ILIKE '%' || $2 || '%')",
        "   AND d.content_blocks @> $3::jsonb",
        " ORDER BY rank DESC, c.path",
      ].join("\n"),
    );
    expect(built.params).toEqual([BUNDLE_ID, "runbook", JSON.stringify(fragment)]);
  });
});

describe("buildSearchQuery — bundle_id scope", () => {
  test.each([
    ["text-only", { bundleId: BUNDLE_ID, text: "a" }],
    ["containment-only", { bundleId: BUNDLE_ID, containment: { root: {} } }],
    ["combined", { bundleId: BUNDLE_ID, text: "a", containment: { root: {} } }],
  ])("%s query scopes WHERE by bundle_id as the first parameter", (_name, input) => {
    const built = buildSearchQuery(input);
    expect(built.sql).toContain("WHERE c.bundle_id = $1");
    expect(built.params[0]).toBe(BUNDLE_ID);
  });
});

describe("buildSearchQuery — empty/whitespace-only rejection", () => {
  test("throws search.emptyQuery when both text and containment are absent", () => {
    expectValidation(() => buildSearchQuery({ bundleId: BUNDLE_ID }), "search.emptyQuery", { text: null });
  });

  test("throws search.emptyQuery for an empty string text with no containment", () => {
    expectValidation(() => buildSearchQuery({ bundleId: BUNDLE_ID, text: "" }), "search.emptyQuery", {
      text: "",
    });
  });

  test("throws search.emptyQuery for whitespace-only text with no containment", () => {
    expectValidation(() => buildSearchQuery({ bundleId: BUNDLE_ID, text: "   " }), "search.emptyQuery", {
      text: "   ",
    });
  });

  test("whitespace-only text alongside containment is treated as containment-only, not rejected", () => {
    const built = buildSearchQuery({ bundleId: BUNDLE_ID, text: "   ", containment: { root: {} } });
    expect(built.sql).not.toContain("websearch_to_tsquery");
    expect(built.params).toEqual([BUNDLE_ID, JSON.stringify({ root: {} })]);
  });
});

describe("buildSearchQuery — term limit", () => {
  test(`accepts exactly ${MAX_SEARCH_TERMS} terms`, () => {
    const text = Array.from({ length: MAX_SEARCH_TERMS }, (_, i) => `term${i}`).join(" ");
    expect(() => buildSearchQuery({ bundleId: BUNDLE_ID, text })).not.toThrow();
  });

  test(`rejects ${MAX_SEARCH_TERMS + 1} terms with search.tooManyTerms`, () => {
    const text = Array.from({ length: MAX_SEARCH_TERMS + 1 }, (_, i) => `term${i}`).join(" ");
    expectValidation(() => buildSearchQuery({ bundleId: BUNDLE_ID, text }), "search.tooManyTerms", {
      termCount: MAX_SEARCH_TERMS + 1,
      limit: MAX_SEARCH_TERMS,
    });
  });
});

describe("splitSearchTerms", () => {
  test("splits on whitespace", () => {
    expect(splitSearchTerms("kubernetes ingress controller")).toEqual([
      "kubernetes",
      "ingress",
      "controller",
    ]);
  });

  test("collapses repeated internal whitespace", () => {
    expect(splitSearchTerms("kubernetes   ingress")).toEqual(["kubernetes", "ingress"]);
  });

  test("trims leading/trailing whitespace", () => {
    expect(splitSearchTerms("  ingress  ")).toEqual(["ingress"]);
  });

  test("returns [] for an empty string", () => {
    expect(splitSearchTerms("")).toEqual([]);
  });

  test("returns [] for whitespace-only input", () => {
    expect(splitSearchTerms("   ")).toEqual([]);
  });

  test("returns a single-element array for one word", () => {
    expect(splitSearchTerms("ingress")).toEqual(["ingress"]);
  });
});
