// tests/git-sync-link-rewriter.test.ts — module m14 (git-sync). Exercises the pure Markdown
// cross-link rewriter in `src/modules/git-sync/link-rewriter.ts`: href classification for all
// four `concept_links.kind` shapes, absolute and relative internal-link rewriting (same
// directory, a child directory, a sibling directory, an ancestor directory), a link to a missing
// concept left intact and reported, and that external/anchor links are never touched.
import { describe, expect, test } from "vitest";
import { classifyHref, rewriteLinks } from "../src/modules/git-sync/link-rewriter";

describe("classifyHref", () => {
  test.each([
    ["#section-two", "anchor"],
    ["https://example.com/doc", "external"],
    ["http://example.com", "external"],
    ["mailto:jane@example.com", "external"],
    ["/runtime/scheduler.md", "absolute"],
    ["/runtime/scheduler", "absolute"],
    ["./sibling.md", "relative"],
    ["../other/leaf.md", "relative"],
    ["child.md", "relative"],
  ] as const)("classifies %s as %s", (href, kind) => {
    expect(classifyHref(href)).toBe(kind);
  });
});

describe("rewriteLinks — absolute hrefs", () => {
  test("rewrites an absolute href to a leaf sibling into a relative path", () => {
    const pathToFile = new Map([
      ["runtime/scheduler", "runtime/scheduler.md"],
      ["runtime/executor", "runtime/executor.md"],
    ]);
    const result = rewriteLinks("See [the executor](/runtime/executor.md) for details.", {
      fromPath: "runtime/scheduler.md",
      pathToFile,
    });
    expect(result.markdown).toBe("See [the executor](./executor.md) for details.");
    expect(result.brokenLinks).toEqual([]);
  });

  test("rewrites an absolute href with no .md extension", () => {
    const pathToFile = new Map([
      ["runtime/scheduler", "runtime/scheduler.md"],
      ["runtime/executor", "runtime/executor.md"],
    ]);
    const result = rewriteLinks("[executor](/runtime/executor)", {
      fromPath: "runtime/scheduler.md",
      pathToFile,
    });
    expect(result.markdown).toBe("[executor](./executor.md)");
  });

  test("rewrites an absolute href to an index concept, including an explicit /index.md suffix", () => {
    const pathToFile = new Map([
      ["runtime", "runtime/index.md"],
      ["runtime/scheduler", "runtime/scheduler.md"],
    ]);
    const result = rewriteLinks("[runtime](/runtime/index.md)", {
      fromPath: "runtime/scheduler.md",
      pathToFile,
    });
    expect(result.markdown).toBe("[runtime](./index.md)");
  });
});

describe("rewriteLinks — relative hrefs", () => {
  test("rewrites a same-directory relative href", () => {
    const pathToFile = new Map([
      ["a", "a.md"],
      ["b", "b.md"],
    ]);
    const result = rewriteLinks("[b](./b.md)", { fromPath: "a.md", pathToFile });
    expect(result.markdown).toBe("[b](./b.md)");
  });

  test("rewrites a relative href from an index file into its own child", () => {
    const pathToFile = new Map([
      ["runtime/scheduler", "runtime/scheduler/index.md"],
      ["runtime/scheduler/queue", "runtime/scheduler/queue.md"],
    ]);
    const result = rewriteLinks("[queue](./queue.md)", {
      fromPath: "runtime/scheduler/index.md",
      pathToFile,
    });
    expect(result.markdown).toBe("[queue](./queue.md)");
  });

  test("rewrites a relative href that climbs out to a sibling directory", () => {
    const pathToFile = new Map([
      ["runtime/scheduler", "runtime/scheduler/index.md"],
      ["runtime/other-leaf", "runtime/other-leaf.md"],
    ]);
    const result = rewriteLinks("[other](../other-leaf.md)", {
      fromPath: "runtime/scheduler/index.md",
      pathToFile,
    });
    expect(result.markdown).toBe("[other](../other-leaf.md)");
  });

  test("rewrites a relative href crossing from one branch's leaf into another branch's leaf", () => {
    const pathToFile = new Map([
      ["runtime/scheduler/queue", "runtime/scheduler/queue.md"],
      ["storage/index", "storage/index.md"],
    ]);
    // storage/index is a synthetic path for this fixture; assert only reachability math.
    const result = rewriteLinks("[queue](/runtime/scheduler/queue.md)", {
      fromPath: "storage/index.md",
      pathToFile,
    });
    expect(result.markdown).toBe("[queue](../runtime/scheduler/queue.md)");
  });
});

describe("rewriteLinks — links that must never be rewritten", () => {
  test("leaves an anchor link untouched", () => {
    const result = rewriteLinks("[jump](#section-two)", { fromPath: "a.md", pathToFile: new Map() });
    expect(result.markdown).toBe("[jump](#section-two)");
    expect(result.brokenLinks).toEqual([]);
  });

  test("leaves an external link untouched", () => {
    const result = rewriteLinks("[docs](https://example.com/doc)", { fromPath: "a.md", pathToFile: new Map() });
    expect(result.markdown).toBe("[docs](https://example.com/doc)");
    expect(result.brokenLinks).toEqual([]);
  });

  test("leaves a mailto link untouched", () => {
    const result = rewriteLinks("[email](mailto:jane@example.com)", { fromPath: "a.md", pathToFile: new Map() });
    expect(result.markdown).toBe("[email](mailto:jane@example.com)");
  });
});

describe("rewriteLinks — broken links", () => {
  test("leaves a link to a missing concept intact and reports it", () => {
    const pathToFile = new Map([["runtime/scheduler", "runtime/scheduler.md"]]);
    const result = rewriteLinks("[ghost](/runtime/ghost.md)", { fromPath: "runtime/scheduler.md", pathToFile });
    expect(result.markdown).toBe("[ghost](/runtime/ghost.md)");
    expect(result.brokenLinks).toEqual([{ fromPath: "runtime/scheduler.md", href: "/runtime/ghost.md" }]);
  });

  test("reports every broken link, not just the first", () => {
    const result = rewriteLinks("[a](/missing/a.md) and [b](./missing-b.md)", {
      fromPath: "runtime/scheduler.md",
      pathToFile: new Map(),
    });
    expect(result.brokenLinks).toHaveLength(2);
    expect(result.markdown).toBe("[a](/missing/a.md) and [b](./missing-b.md)");
  });

  test("a broken link does not prevent a later resolvable link in the same document from rewriting", () => {
    const pathToFile = new Map([["runtime/executor", "runtime/executor.md"]]);
    const result = rewriteLinks("[ghost](/runtime/ghost.md) then [executor](/runtime/executor.md)", {
      fromPath: "runtime/scheduler.md",
      pathToFile,
    });
    expect(result.markdown).toBe("[ghost](/runtime/ghost.md) then [executor](./executor.md)");
    expect(result.brokenLinks).toEqual([{ fromPath: "runtime/scheduler.md", href: "/runtime/ghost.md" }]);
  });
});

describe("rewriteLinks — no links", () => {
  test("returns the markdown unchanged and no broken links when there are no links at all", () => {
    const result = rewriteLinks("Just some prose with no links.", { fromPath: "a.md", pathToFile: new Map() });
    expect(result.markdown).toBe("Just some prose with no links.");
    expect(result.brokenLinks).toEqual([]);
  });

  test("handles the empty string", () => {
    const result = rewriteLinks("", { fromPath: "a.md", pathToFile: new Map() });
    expect(result.markdown).toBe("");
    expect(result.brokenLinks).toEqual([]);
  });
});
