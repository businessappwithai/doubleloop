// tests/core-types.test.ts — module m3 (Core domain). Every TrustLevel/Lifecycle guard arm,
// plus the isProvenance shape guard. Deliberately asserts that Database.md's differently-spelled
// enum members (`machine_confirmed`, `review`, `published`) are NOT accepted by these guards —
// that mismatch is documented in src/core/types.ts and locked in here so a future edit can't
// silently "fix" it by widening the domain union to match the DB enum without a decision.
import { describe, test, expect } from "vitest";
import { isLifecycle, isProvenance, isTrustLevel, type Lifecycle, type TrustLevel } from "../src/core/types";

describe("isTrustLevel", () => {
  const VALID: readonly TrustLevel[] = ["unverified", "machine-confirmed", "human-reviewed"];

  test.each(VALID)("accepts %s", (value) => {
    expect(isTrustLevel(value)).toBe(true);
  });

  test("rejects the Database.md enum spelling (underscore instead of hyphen)", () => {
    expect(isTrustLevel("machine_confirmed")).toBe(false);
    expect(isTrustLevel("human_reviewed")).toBe(false);
  });

  test("rejects an unrelated string", () => {
    expect(isTrustLevel("active")).toBe(false);
  });

  test("rejects the empty string", () => {
    expect(isTrustLevel("")).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isTrustLevel(null)).toBe(false);
    expect(isTrustLevel(undefined)).toBe(false);
    expect(isTrustLevel(42)).toBe(false);
    expect(isTrustLevel({ level: "unverified" })).toBe(false);
  });
});

describe("isLifecycle", () => {
  const VALID: readonly Lifecycle[] = ["draft", "active", "deprecated", "archived"];

  test.each(VALID)("accepts %s", (value) => {
    expect(isLifecycle(value)).toBe(true);
  });

  test("rejects Database.md's lifecycle_state members that are not in this domain union", () => {
    expect(isLifecycle("review")).toBe(false);
    expect(isLifecycle("published")).toBe(false);
  });

  test("rejects an unrelated string", () => {
    expect(isLifecycle("unverified")).toBe(false);
  });

  test("rejects the empty string", () => {
    expect(isLifecycle("")).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isLifecycle(null)).toBe(false);
    expect(isLifecycle(undefined)).toBe(false);
    expect(isLifecycle(7)).toBe(false);
    expect(isLifecycle(["draft"])).toBe(false);
  });
});

describe("isProvenance", () => {
  test("accepts a fully populated provenance object", () => {
    expect(
      isProvenance({
        source: "git_import",
        author: "jane@example.com",
        generatedBy: "gpt-5",
        reviewedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  test("accepts null generatedBy and null reviewedAt", () => {
    expect(
      isProvenance({
        source: "editor",
        author: "jane@example.com",
        generatedBy: null,
        reviewedAt: null,
      }),
    ).toBe(true);
  });

  test("rejects a missing source", () => {
    expect(
      isProvenance({ author: "jane@example.com", generatedBy: null, reviewedAt: null }),
    ).toBe(false);
  });

  test("rejects a non-string author", () => {
    expect(
      isProvenance({ source: "editor", author: 123, generatedBy: null, reviewedAt: null }),
    ).toBe(false);
  });

  test("rejects a non-string, non-null generatedBy", () => {
    expect(
      isProvenance({ source: "editor", author: "jane", generatedBy: 42, reviewedAt: null }),
    ).toBe(false);
  });

  test("rejects a non-string, non-null reviewedAt", () => {
    expect(
      isProvenance({ source: "editor", author: "jane", generatedBy: null, reviewedAt: true }),
    ).toBe(false);
  });

  test("rejects non-object values", () => {
    expect(isProvenance(null)).toBe(false);
    expect(isProvenance(undefined)).toBe(false);
    expect(isProvenance("provenance")).toBe(false);
    expect(isProvenance(42)).toBe(false);
  });

  test("rejects an empty object", () => {
    expect(isProvenance({})).toBe(false);
  });
});
