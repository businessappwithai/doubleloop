// tests/git-sync-exporter.test.ts — module m14 (git-sync). Exercises the pure OKF file-plan
// builder in `src/modules/git-sync/exporter.ts`: `exportedFilePath`'s index-vs-leaf branches, an
// empty bundle producing zero files, a flat bundle, a nested bundle producing `index.md` at
// branches and `<slug>.md` at leaves, deterministic path-sorted output, cross-link rewriting
// integrated end-to-end through the built `pathToFile` map, a link to a missing concept surfaced
// in `ExportPlan.brokenLinks` without dropping it from the body, and that broken links are
// aggregated across every input, not just the first (Implementation.md m14 acceptance).
import { describe, expect, test } from "vitest";
import { exportedFilePath, planExport, type ExportConcept, type ExportConceptInput } from "../src/modules/git-sync/exporter";
import type { OkfFrontmatter } from "../src/core/okf/schema";

function makeConcept(overrides: Partial<ExportConcept> = {}): ExportConcept {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    slug: "getting-started",
    path: "getting-started",
    isIndex: false,
    childCount: 0,
    ...overrides,
  };
}

function makeFrontmatter(overrides: Partial<OkfFrontmatter> = {}): OkfFrontmatter {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    title: "Getting Started",
    trust: "unverified",
    lifecycle: "draft",
    provenance: { source: "editor", author: "editor", retrievedAt: "2026-01-01T00:00:00.000Z" },
    tags: [],
    links: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeInput(overrides: {
  concept?: Partial<ExportConcept>;
  frontmatter?: Partial<OkfFrontmatter>;
  bodyMarkdown?: string;
} = {}): ExportConceptInput {
  return {
    concept: makeConcept(overrides.concept),
    frontmatter: makeFrontmatter(overrides.frontmatter),
    bodyMarkdown: overrides.bodyMarkdown ?? "Hello world.",
  };
}

describe("exportedFilePath", () => {
  test("a leaf concept (not is_index, no children) exports to <slug>.md", () => {
    expect(exportedFilePath(makeConcept({ path: "runtime/scheduler", isIndex: false, childCount: 0 }))).toBe(
      "runtime/scheduler.md",
    );
  });

  test("a concept with children exports to index.md even when is_index is false", () => {
    expect(exportedFilePath(makeConcept({ path: "runtime", isIndex: false, childCount: 2 }))).toBe(
      "runtime/index.md",
    );
  });

  test("an author-flagged is_index concept with no children still exports to index.md", () => {
    expect(exportedFilePath(makeConcept({ path: "runtime", isIndex: true, childCount: 0 }))).toBe(
      "runtime/index.md",
    );
  });

  test("a root-level leaf has no leading slash", () => {
    expect(exportedFilePath(makeConcept({ path: "readme", isIndex: false, childCount: 0 }))).toBe("readme.md");
  });
});

describe("planExport — empty bundle", () => {
  test("zero inputs produce zero files and zero broken links", () => {
    const plan = planExport([]);
    expect(plan).toEqual({ files: [], brokenLinks: [] });
  });
});

describe("planExport — flat bundle", () => {
  test("two root-level leaves export as two sorted .md files with joined frontmatter+body", () => {
    const inputs = [
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000002", slug: "zebra", path: "zebra" },
        frontmatter: { id: "10000000-0000-4000-8000-000000000002", title: "Zebra" },
        bodyMarkdown: "Zebra body.",
      }),
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000001", slug: "alpha", path: "alpha" },
        frontmatter: { id: "10000000-0000-4000-8000-000000000001", title: "Alpha" },
        bodyMarkdown: "Alpha body.",
      }),
    ];

    const plan = planExport(inputs);
    expect(plan.files.map((f) => f.path)).toEqual(["alpha.md", "zebra.md"]);
    expect(plan.brokenLinks).toEqual([]);

    const alpha = plan.files[0]!;
    expect(alpha.contents.startsWith("---\n")).toBe(true);
    expect(alpha.contents).toContain("title: Alpha");
    expect(alpha.contents).toContain("Alpha body.");
  });
});

describe("planExport — nested bundle", () => {
  test("a branch with children exports to index.md and its leaf exports to <slug>.md", () => {
    const inputs = [
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000001", slug: "runtime", path: "runtime", childCount: 1 },
        frontmatter: { id: "10000000-0000-4000-8000-000000000001", title: "Runtime" },
        bodyMarkdown: "Runtime overview.",
      }),
      makeInput({
        concept: {
          id: "10000000-0000-4000-8000-000000000002",
          slug: "scheduler",
          path: "runtime/scheduler",
          childCount: 0,
        },
        frontmatter: { id: "10000000-0000-4000-8000-000000000002", title: "Scheduler" },
        bodyMarkdown: "Scheduler details.",
      }),
    ];

    const plan = planExport(inputs);
    expect(plan.files.map((f) => f.path)).toEqual(["runtime/index.md", "runtime/scheduler.md"]);
  });

  test("a three-level hierarchy produces index.md at every branch and a leaf .md at the bottom", () => {
    const inputs = [
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000001", slug: "docs", path: "docs", childCount: 1 },
      }),
      makeInput({
        concept: {
          id: "10000000-0000-4000-8000-000000000002",
          slug: "guides",
          path: "docs/guides",
          childCount: 1,
        },
      }),
      makeInput({
        concept: {
          id: "10000000-0000-4000-8000-000000000003",
          slug: "quickstart",
          path: "docs/guides/quickstart",
          childCount: 0,
        },
      }),
    ];

    const plan = planExport(inputs);
    expect(plan.files.map((f) => f.path)).toEqual([
      "docs/guides/index.md",
      "docs/guides/quickstart.md",
      "docs/index.md",
    ]);
  });
});

describe("planExport — cross-link rewriting", () => {
  test("rewrites an absolute link between two exported concepts to a relative path", () => {
    const inputs = [
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000001", slug: "scheduler", path: "runtime/scheduler" },
        bodyMarkdown: "See [the executor](/runtime/executor.md).",
      }),
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000002", slug: "executor", path: "runtime/executor" },
        bodyMarkdown: "The executor.",
      }),
    ];

    const plan = planExport(inputs);
    const scheduler = plan.files.find((f) => f.path === "runtime/scheduler.md")!;
    expect(scheduler.contents).toContain("[the executor](./executor.md)");
    expect(plan.brokenLinks).toEqual([]);
  });

  test("a link to a missing concept is left intact in the body and reported in brokenLinks", () => {
    const inputs = [
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000001", slug: "scheduler", path: "runtime/scheduler" },
        bodyMarkdown: "See [the ghost](/runtime/ghost.md).",
      }),
    ];

    const plan = planExport(inputs);
    expect(plan.files[0]!.contents).toContain("[the ghost](/runtime/ghost.md)");
    expect(plan.brokenLinks).toEqual([{ fromPath: "runtime/scheduler.md", href: "/runtime/ghost.md" }]);
  });

  test("aggregates broken links across every input, not just the first", () => {
    const inputs = [
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000001", slug: "a", path: "a" },
        bodyMarkdown: "[ghost-one](/missing/one.md)",
      }),
      makeInput({
        concept: { id: "10000000-0000-4000-8000-000000000002", slug: "b", path: "b" },
        bodyMarkdown: "[ghost-two](/missing/two.md)",
      }),
    ];

    const plan = planExport(inputs);
    expect(plan.brokenLinks).toEqual([
      { fromPath: "a.md", href: "/missing/one.md" },
      { fromPath: "b.md", href: "/missing/two.md" },
    ]);
  });
});
