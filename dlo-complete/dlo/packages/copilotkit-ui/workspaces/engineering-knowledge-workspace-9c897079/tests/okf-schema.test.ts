// tests/okf-schema.test.ts — module m8 (OKF core). `okfFrontmatterSchema` and
// `okfProvenanceSchema`: every valid trust/lifecycle value, an invalid value for each, missing
// required fields, and unknown-key preservation at both the top level and inside `provenance`.
import { describe, test, expect } from "vitest";
import { okfFrontmatterSchema, okfProvenanceSchema } from "../src/core/okf/schema";

const VALID_PROVENANCE = {
  source: "https://example.com/doc",
  author: "jane@example.com",
  retrievedAt: "2026-01-15T10:00:00.000Z",
};

function validFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "concept-1",
    title: "Concept One",
    trust: "unverified",
    lifecycle: "draft",
    provenance: VALID_PROVENANCE,
    tags: ["runtime"],
    links: ["concept-2"],
    updatedAt: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("okfFrontmatterSchema", () => {
  const VALID_TRUST_LEVELS = ["unverified", "machine-confirmed", "human-reviewed"] as const;
  const VALID_LIFECYCLES = ["draft", "active", "deprecated", "archived"] as const;

  describe.each(VALID_TRUST_LEVELS)("trust = %s", (trust) => {
    test("is accepted", () => {
      const result = okfFrontmatterSchema.safeParse(validFrontmatter({ trust }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.trust).toBe(trust);
      }
    });
  });

  describe.each(VALID_LIFECYCLES)("lifecycle = %s", (lifecycle) => {
    test("is accepted", () => {
      const result = okfFrontmatterSchema.safeParse(validFrontmatter({ lifecycle }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lifecycle).toBe(lifecycle);
      }
    });
  });

  test("rejects an invalid trust value", () => {
    const result = okfFrontmatterSchema.safeParse(validFrontmatter({ trust: "gold-standard" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "trust")).toBe(true);
    }
  });

  test("rejects an invalid lifecycle value", () => {
    const result = okfFrontmatterSchema.safeParse(validFrontmatter({ lifecycle: "retired" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "lifecycle")).toBe(true);
    }
  });

  const REQUIRED_FIELDS = ["id", "title", "trust", "lifecycle", "provenance", "updatedAt"] as const;

  describe.each(REQUIRED_FIELDS)("missing required field: %s", (field) => {
    test("fails validation", () => {
      const input = validFrontmatter();
      delete input[field];
      const result = okfFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
      }
    });
  });

  test("defaults tags and links to an empty array when absent", () => {
    const input = validFrontmatter();
    delete input["tags"];
    delete input["links"];
    const result = okfFrontmatterSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
      expect(result.data.links).toEqual([]);
    }
  });

  test("preserves an empty tags/links array", () => {
    const result = okfFrontmatterSchema.safeParse(validFrontmatter({ tags: [], links: [] }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
      expect(result.data.links).toEqual([]);
    }
  });

  test("preserves unknown top-level keys instead of stripping them", () => {
    const result = okfFrontmatterSchema.safeParse(
      validFrontmatter({ customField: "kept", nested: { a: 1 } }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)["customField"]).toBe("kept");
      expect((result.data as Record<string, unknown>)["nested"]).toEqual({ a: 1 });
    }
  });

  test("rejects a non-object root", () => {
    expect(okfFrontmatterSchema.safeParse("not an object").success).toBe(false);
    expect(okfFrontmatterSchema.safeParse(null).success).toBe(false);
    expect(okfFrontmatterSchema.safeParse(undefined).success).toBe(false);
    expect(okfFrontmatterSchema.safeParse(["a", "list"]).success).toBe(false);
  });
});

describe("okfProvenanceSchema", () => {
  test("accepts a provenance object without checksum", () => {
    const result = okfProvenanceSchema.safeParse(VALID_PROVENANCE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_PROVENANCE);
    }
  });

  test("accepts a provenance object with checksum", () => {
    const withChecksum = { ...VALID_PROVENANCE, checksum: "sha256:abc123" };
    const result = okfProvenanceSchema.safeParse(withChecksum);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checksum).toBe("sha256:abc123");
    }
  });

  const REQUIRED_PROVENANCE_FIELDS = ["source", "author", "retrievedAt"] as const;

  describe.each(REQUIRED_PROVENANCE_FIELDS)("missing required field: %s", (field) => {
    test("fails validation", () => {
      const input: Record<string, unknown> = { ...VALID_PROVENANCE };
      delete input[field];
      const result = okfProvenanceSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
      }
    });
  });

  test("preserves unknown keys instead of stripping them", () => {
    const result = okfProvenanceSchema.safeParse({
      ...VALID_PROVENANCE,
      generator: "gemini-ensemble",
      commit: "abc1234",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)["generator"]).toBe("gemini-ensemble");
      expect((result.data as Record<string, unknown>)["commit"]).toBe("abc1234");
    }
  });

  test("rejects an empty source", () => {
    expect(okfProvenanceSchema.safeParse({ ...VALID_PROVENANCE, source: "" }).success).toBe(false);
  });

  test("rejects a non-object root", () => {
    expect(okfProvenanceSchema.safeParse("not an object").success).toBe(false);
    expect(okfProvenanceSchema.safeParse(null).success).toBe(false);
  });
});
