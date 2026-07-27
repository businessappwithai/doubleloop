// tests/frontmatter-form-state.test.ts — module m20 (OKF frontmatter editing panel). Covers the
// pure reducer in src/features/frontmatter/form-state.ts: init from a complete and a minimal
// frontmatter, every mutator asserted on the resulting state, duplicate/empty tag rejection,
// removing the last tag, every TrustLevel/Lifecycle selectable, validate() producing one issue
// per invalid field, toFrontmatter() refusing while invalid, and dirty-state transitions
// (including the revert-via-init(state.initial) pattern the panel uses).
import { describe, test, expect } from "vitest";
import {
  addTag,
  init,
  isDirty,
  removeTag,
  setField,
  setLifecycle,
  setTrust,
  toFrontmatter,
  validate,
  type FrontmatterFormState,
  type FrontmatterTextFieldKey,
} from "../src/features/frontmatter/form-state";
import type { OkfFrontmatter } from "../src/core/okf/schema";
import type { Lifecycle, TrustLevel } from "../src/core/types";

const COMPLETE: OkfFrontmatter = {
  id: "concept-1",
  title: "Deployment Runbook",
  trust: "human-reviewed",
  lifecycle: "active",
  provenance: {
    source: "https://example.com/doc",
    author: "jane@example.com",
    retrievedAt: "2026-01-15T10:00:00.000Z",
    checksum: "sha256:abc123",
  },
  tags: ["ops", "runbook"],
  links: ["concept-2"],
  updatedAt: "2026-01-15T10:00:00.000Z",
};

const MINIMAL: OkfFrontmatter = {
  id: "concept-2",
  title: "Untitled Concept",
  trust: "unverified",
  lifecycle: "draft",
  provenance: {
    source: "manual",
    author: "unknown",
    retrievedAt: "2026-01-15T10:00:00.000Z",
  },
  tags: [],
  links: [],
  updatedAt: "2026-01-15T10:00:00.000Z",
};

describe("init", () => {
  test("builds a draft from a complete frontmatter, copying the checksum and reporting no issues", () => {
    const state = init(COMPLETE);
    expect(state.initial).toBe(COMPLETE);
    expect(state.title).toBe("Deployment Runbook");
    expect(state.trust).toBe("human-reviewed");
    expect(state.lifecycle).toBe("active");
    expect(state.tags).toEqual(["ops", "runbook"]);
    expect(state.provenance).toEqual({
      source: "https://example.com/doc",
      author: "jane@example.com",
      retrievedAt: "2026-01-15T10:00:00.000Z",
      checksum: "sha256:abc123",
    });
    expect(state.issues).toEqual([]);
  });

  test("builds a draft from a minimal frontmatter, defaulting the absent checksum to an empty string", () => {
    const state = init(MINIMAL);
    expect(state.title).toBe("Untitled Concept");
    expect(state.tags).toEqual([]);
    expect(state.provenance.checksum).toBe("");
    expect(state.issues).toEqual([]);
  });
});

describe("setField", () => {
  const CASES: ReadonlyArray<{
    field: FrontmatterTextFieldKey;
    get: (state: FrontmatterFormState) => string;
  }> = [
    { field: "title", get: (s) => s.title },
    { field: "provenance.source", get: (s) => s.provenance.source },
    { field: "provenance.author", get: (s) => s.provenance.author },
    { field: "provenance.retrievedAt", get: (s) => s.provenance.retrievedAt },
    { field: "provenance.checksum", get: (s) => s.provenance.checksum },
  ];

  test.each(CASES)("sets $field to the given value and keeps the state valid", ({ field, get }) => {
    const state = init(COMPLETE);
    const next = setField(state, field, "updated value");
    expect(get(next)).toBe("updated value");
    expect(next.issues).toEqual([]);
  });

  test("setting title does not touch provenance", () => {
    const state = init(COMPLETE);
    const next = setField(state, "title", "New Title");
    expect(next.title).toBe("New Title");
    expect(next.provenance).toEqual(state.provenance);
  });

  test("setting one provenance field leaves the other provenance fields untouched", () => {
    const state = init(COMPLETE);
    const next = setField(state, "provenance.author", "new-author@example.com");
    expect(next.provenance.author).toBe("new-author@example.com");
    expect(next.provenance.source).toBe(state.provenance.source);
    expect(next.provenance.retrievedAt).toBe(state.provenance.retrievedAt);
    expect(next.provenance.checksum).toBe(state.provenance.checksum);
  });

  test("clearing the title produces a title issue and blocks toFrontmatter", () => {
    const state = init(COMPLETE);
    const next = setField(state, "title", "");
    expect(next.issues).toEqual([{ field: "title", message: "title must not be empty" }]);
    expect(toFrontmatter(next)).toBeNull();
  });

  test("clearing the checksum omits it from validation instead of failing as an empty string", () => {
    const state = init(COMPLETE);
    const next = setField(state, "provenance.checksum", "");
    expect(next.provenance.checksum).toBe("");
    expect(next.issues).toEqual([]);
  });
});

describe("setTrust", () => {
  const TRUST_LEVELS: readonly TrustLevel[] = ["unverified", "machine-confirmed", "human-reviewed"];

  test.each(TRUST_LEVELS)("selects trust level %s with no validation issues", (trust) => {
    const state = init(MINIMAL);
    const next = setTrust(state, trust);
    expect(next.trust).toBe(trust);
    expect(next.issues).toEqual([]);
  });
});

describe("setLifecycle", () => {
  const LIFECYCLES: readonly Lifecycle[] = ["draft", "active", "deprecated", "archived"];

  test.each(LIFECYCLES)("selects lifecycle %s with no validation issues", (lifecycle) => {
    const state = init(MINIMAL);
    const next = setLifecycle(state, lifecycle);
    expect(next.lifecycle).toBe(lifecycle);
    expect(next.issues).toEqual([]);
  });
});

describe("addTag", () => {
  test("adds a trimmed tag to an empty list", () => {
    const state = init(MINIMAL);
    const next = addTag(state, "  new-tag  ");
    expect(next.tags).toEqual(["new-tag"]);
  });

  test("appends a distinct tag after existing tags, preserving order", () => {
    const state = init(COMPLETE);
    const next = addTag(state, "platform");
    expect(next.tags).toEqual(["ops", "runbook", "platform"]);
  });

  test("rejects an empty tag, leaving the state unchanged", () => {
    const state = init(COMPLETE);
    const next = addTag(state, "");
    expect(next).toBe(state);
  });

  test("rejects a whitespace-only tag, leaving the state unchanged", () => {
    const state = init(COMPLETE);
    const next = addTag(state, "   ");
    expect(next).toBe(state);
  });

  test("rejects a case-insensitive duplicate tag, leaving the tag list unchanged", () => {
    const state = init(COMPLETE);
    const next = addTag(state, "OPS");
    expect(next.tags).toEqual(["ops", "runbook"]);
  });
});

describe("removeTag", () => {
  test("removes an existing tag", () => {
    const state = init(COMPLETE);
    const next = removeTag(state, "ops");
    expect(next.tags).toEqual(["runbook"]);
  });

  test("removing the last tag results in an empty tag list", () => {
    const state = init(MINIMAL);
    const withTag = addTag(state, "solo");
    const next = removeTag(withTag, "solo");
    expect(next.tags).toEqual([]);
  });

  test("removing a tag that is not present is a no-op", () => {
    const state = init(COMPLETE);
    const next = removeTag(state, "does-not-exist");
    expect(next.tags).toEqual(state.tags);
  });
});

describe("validate", () => {
  test("returns no issues for a fully valid state", () => {
    expect(validate(init(COMPLETE))).toEqual([]);
  });

  test("returns one issue per invalid field, and none for the empty-but-optional checksum", () => {
    const invalid: FrontmatterFormState = {
      initial: MINIMAL,
      title: "",
      trust: "unverified",
      lifecycle: "draft",
      tags: [],
      provenance: { source: "", author: "", retrievedAt: "", checksum: "" },
      issues: [],
    };

    const issues = validate(invalid);
    const fields = issues.map((issue) => issue.field).sort();
    expect(fields).toEqual(["provenance.author", "provenance.retrievedAt", "provenance.source", "title"]);
  });
});

describe("toFrontmatter", () => {
  test("returns the frontmatter unchanged when the draft was never edited", () => {
    expect(toFrontmatter(init(COMPLETE))).toEqual(COMPLETE);
    expect(toFrontmatter(init(MINIMAL))).toEqual(MINIMAL);
  });

  test("returns an updated frontmatter reflecting edited fields and tags", () => {
    let state = init(COMPLETE);
    state = setField(state, "title", "Updated Runbook");
    state = addTag(state, "platform");
    const result = toFrontmatter(state);
    expect(result).toEqual({
      ...COMPLETE,
      title: "Updated Runbook",
      tags: ["ops", "runbook", "platform"],
    });
  });

  test("refuses to produce a value while issues exist", () => {
    const state = setField(init(COMPLETE), "provenance.source", "");
    expect(state.issues.length).toBeGreaterThan(0);
    expect(toFrontmatter(state)).toBeNull();
  });
});

describe("isDirty", () => {
  test("is false immediately after init", () => {
    expect(isDirty(init(COMPLETE))).toBe(false);
  });

  test("becomes true after a text field changes, and false again once reverted to the original value", () => {
    const state = init(COMPLETE);
    const edited = setField(state, "title", "Different Title");
    expect(isDirty(edited)).toBe(true);
    const reverted = setField(edited, "title", "Deployment Runbook");
    expect(isDirty(reverted)).toBe(false);
  });

  test("becomes true after adding a tag", () => {
    const state = init(COMPLETE);
    expect(isDirty(addTag(state, "platform"))).toBe(true);
  });

  test("returns to false when a removed tag is re-added in the same position", () => {
    const state = init(COMPLETE);
    const withoutTag = removeTag(state, "runbook");
    expect(isDirty(withoutTag)).toBe(true);
    const restored = addTag(withoutTag, "runbook");
    expect(isDirty(restored)).toBe(false);
  });

  test("becomes true after changing trust or lifecycle, and false again once reverted", () => {
    const state = init(COMPLETE);
    const trustChanged = setTrust(state, "unverified");
    expect(isDirty(trustChanged)).toBe(true);
    expect(isDirty(setTrust(trustChanged, "human-reviewed"))).toBe(false);

    const lifecycleChanged = setLifecycle(state, "archived");
    expect(isDirty(lifecycleChanged)).toBe(true);
    expect(isDirty(setLifecycle(lifecycleChanged, "active"))).toBe(false);
  });
});

describe("revert (init(state.initial))", () => {
  test("restores every edited field, tag, and dirty status to the initial value", () => {
    const original = init(COMPLETE);
    let edited = setField(original, "title", "Changed Title");
    edited = setField(edited, "provenance.author", "someone-else@example.com");
    edited = addTag(edited, "extra-tag");
    edited = setTrust(edited, "unverified");
    expect(isDirty(edited)).toBe(true);

    const reverted = init(edited.initial);
    expect(reverted).toEqual(original);
    expect(isDirty(reverted)).toBe(false);
  });
});
