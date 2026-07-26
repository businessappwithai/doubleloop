// tests/okf-frontmatter.test.ts — module m8 (OKF core). `parseFrontmatter`/`serializeFrontmatter`:
// valid parse, duplicate keys, malformed YAML, schema-validation failure with per-field issues,
// unknown-key preservation, and a serialize→parse→serialize byte-identical round trip.
import { describe, test, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/okf/frontmatter";
import { ValidationError } from "../src/core/errors";
import type { OkfFrontmatter } from "../src/core/okf/schema";

const VALID_YAML = `id: concept-1
title: Concept One
trust: unverified
lifecycle: draft
provenance:
  source: https://example.com/doc
  author: jane@example.com
  retrievedAt: "2026-01-15T10:00:00.000Z"
tags:
  - runtime
links:
  - concept-2
updatedAt: "2026-01-15T10:00:00.000Z"
`;

function expectValidationError(fn: () => unknown, reason: string): ValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    const validationError = err as ValidationError;
    expect(validationError.details["reason"]).toBe(reason);
    return validationError;
  }
  throw new Error("expected fn() to throw");
}

describe("parseFrontmatter", () => {
  test("parses valid frontmatter YAML into a typed value", () => {
    const fm = parseFrontmatter(VALID_YAML);
    expect(fm).toEqual({
      id: "concept-1",
      title: "Concept One",
      trust: "unverified",
      lifecycle: "draft",
      provenance: {
        source: "https://example.com/doc",
        author: "jane@example.com",
        retrievedAt: "2026-01-15T10:00:00.000Z",
      },
      tags: ["runtime"],
      links: ["concept-2"],
      updatedAt: "2026-01-15T10:00:00.000Z",
    });
  });

  test("throws frontmatter.duplicateKey for a duplicate top-level key", () => {
    const raw = `id: concept-1\nid: concept-1-duplicate\ntitle: X\n`;
    expectValidationError(() => parseFrontmatter(raw), "frontmatter.duplicateKey");
  });

  test("throws frontmatter.duplicateKey for a duplicate nested key", () => {
    const raw = VALID_YAML.replace(
      "  source: https://example.com/doc\n",
      "  source: https://example.com/doc\n  source: https://example.com/duplicate\n",
    );
    expectValidationError(() => parseFrontmatter(raw), "frontmatter.duplicateKey");
  });

  test("throws frontmatter.malformedYaml for broken YAML syntax", () => {
    const raw = "id: [unclosed\ntitle: broken";
    const err = expectValidationError(() => parseFrontmatter(raw), "frontmatter.malformedYaml");
    expect(typeof err.details["yamlMessage"]).toBe("string");
  });

  test("throws frontmatter.invalid with per-field issues for a missing required field", () => {
    const raw = `title: Concept One\ntrust: unverified\nlifecycle: draft\nprovenance:\n  source: s\n  author: a\n  retrievedAt: "2026-01-15T10:00:00.000Z"\nupdatedAt: "2026-01-15T10:00:00.000Z"\n`;
    const err = expectValidationError(() => parseFrontmatter(raw), "frontmatter.invalid");
    const issues = err.details["issues"] as Array<{ path: string; message: string }>;
    expect(issues.some((issue) => issue.path === "id")).toBe(true);
  });

  test("throws frontmatter.invalid for an invalid trust value", () => {
    const raw = VALID_YAML.replace("trust: unverified", "trust: gold-standard");
    const err = expectValidationError(() => parseFrontmatter(raw), "frontmatter.invalid");
    const issues = err.details["issues"] as Array<{ path: string; message: string }>;
    expect(issues.some((issue) => issue.path === "trust")).toBe(true);
  });

  test("throws frontmatter.invalid when the document root is not a mapping", () => {
    expectValidationError(() => parseFrontmatter("- just\n- a\n- list\n"), "frontmatter.invalid");
  });

  test("throws frontmatter.invalid for an empty document", () => {
    expectValidationError(() => parseFrontmatter(""), "frontmatter.invalid");
  });

  test("preserves unknown top-level and provenance keys", () => {
    const raw = VALID_YAML.replace(
      "updatedAt:",
      "customField: kept\nupdatedAt:",
    ).replace(
      "  retrievedAt: \"2026-01-15T10:00:00.000Z\"\n",
      "  retrievedAt: \"2026-01-15T10:00:00.000Z\"\n  generator: gemini-ensemble\n",
    );
    const fm = parseFrontmatter(raw) as OkfFrontmatter & Record<string, unknown>;
    expect(fm["customField"]).toBe("kept");
    expect((fm.provenance as Record<string, unknown>)["generator"]).toBe("gemini-ensemble");
  });
});

describe("serializeFrontmatter", () => {
  test("produces YAML that reparses to an equal value", () => {
    const fm = parseFrontmatter(VALID_YAML);
    const serialized = serializeFrontmatter(fm);
    expect(parseFrontmatter(serialized)).toEqual(fm);
  });

  test("orders known keys first, in a fixed order", () => {
    const fm = parseFrontmatter(VALID_YAML);
    const serialized = serializeFrontmatter(fm);
    const topLevelKeys = Object.keys(parseYamlLikeOrder(serialized));
    expect(topLevelKeys).toEqual([
      "id",
      "title",
      "trust",
      "lifecycle",
      "provenance",
      "tags",
      "links",
      "updatedAt",
    ]);
  });

  test("produces byte-identical output regardless of the source key order", () => {
    const canonicalOrder = parseFrontmatter(VALID_YAML);

    const shuffledYaml = `title: Concept One
id: concept-1
lifecycle: draft
trust: unverified
tags:
  - runtime
provenance:
  retrievedAt: "2026-01-15T10:00:00.000Z"
  author: jane@example.com
  source: https://example.com/doc
updatedAt: "2026-01-15T10:00:00.000Z"
links:
  - concept-2
`;
    const shuffledOrder = parseFrontmatter(shuffledYaml);

    expect(serializeFrontmatter(shuffledOrder)).toBe(serializeFrontmatter(canonicalOrder));
  });

  test("byte-identical across repeated serialize-parse-serialize cycles", () => {
    const fm = parseFrontmatter(VALID_YAML);
    const once = serializeFrontmatter(fm);
    const twice = serializeFrontmatter(parseFrontmatter(once));
    expect(twice).toBe(once);
  });

  test("omits checksum when absent and includes it, in order, when present", () => {
    const withoutChecksum = parseFrontmatter(VALID_YAML);
    expect(serializeFrontmatter(withoutChecksum)).not.toContain("checksum");

    const raw = VALID_YAML.replace(
      "  retrievedAt: \"2026-01-15T10:00:00.000Z\"\n",
      "  retrievedAt: \"2026-01-15T10:00:00.000Z\"\n  checksum: sha256:abc123\n",
    );
    const withChecksum = parseFrontmatter(raw);
    const serialized = serializeFrontmatter(withChecksum);
    expect(serialized).toContain("checksum: sha256:abc123");
  });

  test("sorts passthrough keys alphabetically after the modelled fields", () => {
    const raw = VALID_YAML.replace("updatedAt:", "zKey: z\naKey: a\nupdatedAt:");
    const fm = parseFrontmatter(raw);
    const serialized = serializeFrontmatter(fm);
    const keys = Object.keys(parseYamlLikeOrder(serialized));
    const aIndex = keys.indexOf("aKey");
    const zIndex = keys.indexOf("zKey");
    const updatedAtIndex = keys.indexOf("updatedAt");
    expect(aIndex).toBeGreaterThan(updatedAtIndex);
    expect(zIndex).toBeGreaterThan(aIndex);
  });
});

/** Minimal top-level-key-order reader for a flat/nested YAML mapping, for ordering assertions. */
function parseYamlLikeOrder(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of yamlText.split("\n")) {
    const match = /^([A-Za-z0-9_]+):/.exec(line);
    if (match && match[1]) {
      result[match[1]] = true;
    }
  }
  return result;
}
