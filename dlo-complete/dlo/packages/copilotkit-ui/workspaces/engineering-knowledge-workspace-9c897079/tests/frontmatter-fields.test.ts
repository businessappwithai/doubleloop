// tests/frontmatter-fields.test.ts — module m20 (OKF frontmatter editing panel). Covers the
// declarative descriptors in src/features/frontmatter/fields.ts: the text field render order and
// optionality, the trust/lifecycle option lists (values and display labels, in domain-union
// order), and findFieldIssue's lookup/miss/empty behavior.
import { describe, test, expect } from "vitest";
import {
  findFieldIssue,
  LIFECYCLE_OPTIONS,
  TEXT_FIELDS,
  TRUST_OPTIONS,
} from "../src/features/frontmatter/fields";
import type { FieldIssue } from "../src/features/frontmatter/form-state";

describe("TEXT_FIELDS", () => {
  test("declares the five text fields in render order", () => {
    expect(TEXT_FIELDS.map((field) => field.key)).toEqual([
      "title",
      "provenance.source",
      "provenance.author",
      "provenance.retrievedAt",
      "provenance.checksum",
    ]);
  });

  test("marks only the checksum field as optional", () => {
    const optionalKeys = TEXT_FIELDS.filter((field) => field.isOptional).map((field) => field.key);
    expect(optionalKeys).toEqual(["provenance.checksum"]);
  });

  test.each(TEXT_FIELDS)("$key has a non-empty label, help text, and the 'text' kind", (field) => {
    expect(field.label.length).toBeGreaterThan(0);
    expect(field.helpText.length).toBeGreaterThan(0);
    expect(field.kind).toBe("text");
  });
});

describe("TRUST_OPTIONS", () => {
  test("declares all three trust levels, in TrustLevel order, with display labels", () => {
    expect(TRUST_OPTIONS).toEqual([
      { value: "unverified", label: "Unverified" },
      { value: "machine-confirmed", label: "Machine-confirmed" },
      { value: "human-reviewed", label: "Human-reviewed" },
    ]);
  });
});

describe("LIFECYCLE_OPTIONS", () => {
  test("declares all four lifecycle states, in Lifecycle order, with display labels", () => {
    expect(LIFECYCLE_OPTIONS).toEqual([
      { value: "draft", label: "Draft" },
      { value: "active", label: "Active" },
      { value: "deprecated", label: "Deprecated" },
      { value: "archived", label: "Archived" },
    ]);
  });
});

describe("findFieldIssue", () => {
  const ISSUES: readonly FieldIssue[] = [
    { field: "title", message: "title must not be empty" },
    { field: "provenance.source", message: "provenance.source must not be empty" },
  ];

  test("returns the issue whose field matches the given key", () => {
    expect(findFieldIssue(ISSUES, "provenance.source")).toEqual({
      field: "provenance.source",
      message: "provenance.source must not be empty",
    });
  });

  test("returns undefined when no issue matches the given key", () => {
    expect(findFieldIssue(ISSUES, "provenance.author")).toBeUndefined();
  });

  test("returns undefined for an empty issues array", () => {
    expect(findFieldIssue([], "title")).toBeUndefined();
  });

  test("returns the first match when more than one issue shares a field key", () => {
    const duplicated: readonly FieldIssue[] = [
      { field: "tags", message: "first issue" },
      { field: "tags", message: "second issue" },
    ];
    expect(findFieldIssue(duplicated, "tags")).toEqual({ field: "tags", message: "first issue" });
  });
});
