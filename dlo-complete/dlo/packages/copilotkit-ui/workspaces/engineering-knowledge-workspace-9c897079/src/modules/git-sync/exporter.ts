// src/modules/git-sync/exporter.ts — pure OKF export planning (Implementation.md m14). Turns a
// bundle's concepts, their frontmatter and their rendered Markdown bodies into the exact
// `Array<{path, contents}>` the Git-sync worker writes to disk: directory layout mirroring the
// hierarchy (`concepts.path`), `index.md` for any concept with children (or already flagged
// `isIndex`), `<slug>.md` otherwise (m8's `conceptFileName`), frontmatter serialised through m8's
// `serializeFrontmatter`, and cross-links rewritten by `link-rewriter.ts`. No `Db`, `FsPort`, or
// `GitPort` here — `git-sync-module.ts` is the only caller and the only place that touches those.
//
// `planExport` sorts by exported path before doing anything else, so both `pathToFile` (built
// once, used by every file's link rewrite) and the returned `files` array are independent of the
// order `inputs` arrived in. That determinism is not cosmetic: `git-sync-module.ts` detects a
// no-op sync by writing the plan and asking `GitPort.status` whether the working tree is dirty,
// and that detection is only meaningful if the same bundle state always produces byte-identical
// output.
import { conceptFileName, joinDocument } from "../../core/okf/markdown-document";
import { serializeFrontmatter } from "../../core/okf/frontmatter";
import type { OkfFrontmatter } from "../../core/okf/schema";
import { rewriteLinks, type BrokenLink } from "./link-rewriter";

/** The subset of a Concept row `exporter.ts` needs — matches m8's `conceptFileName` input shape exactly. */
export interface ExportConcept {
  readonly id: string;
  readonly slug: string;
  /** Canonical materialised path (Database.md `concepts.path`), e.g. `"runtime/scheduler"`. */
  readonly path: string;
  readonly isIndex: boolean;
  readonly childCount: number;
}

export interface ExportConceptInput {
  readonly concept: ExportConcept;
  readonly frontmatter: OkfFrontmatter;
  readonly bodyMarkdown: string;
}

export interface ExportFile {
  readonly path: string;
  readonly contents: string;
}

export interface ExportPlan {
  /** Sorted by `path`. */
  readonly files: readonly ExportFile[];
  readonly brokenLinks: readonly BrokenLink[];
}

/** Pure: the exported OKF file path for `concept` — `"<path>/index.md"` or `"<path>.md"`. */
export function exportedFilePath(concept: ExportConcept): string {
  return conceptFileName(concept) === "index.md" ? `${concept.path}/index.md` : `${concept.path}.md`;
}

/**
 * Builds the full OKF file set for a bundle. An empty `inputs` produces `{ files: [], brokenLinks: [] }`.
 * Every body's cross-links are rewritten against every *other* input's exported path (including
 * itself, for the rare self-link) before that file's frontmatter+body are joined into its final
 * contents.
 */
export function planExport(inputs: readonly ExportConceptInput[]): ExportPlan {
  const decorated = inputs
    .map((input) => ({ input, filePath: exportedFilePath(input.concept) }))
    .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));

  const pathToFile = new Map<string, string>();
  for (const { input, filePath } of decorated) {
    pathToFile.set(input.concept.path, filePath);
  }

  const files: ExportFile[] = [];
  const brokenLinks: BrokenLink[] = [];

  for (const { input, filePath } of decorated) {
    const { markdown, brokenLinks: fileBrokenLinks } = rewriteLinks(input.bodyMarkdown, {
      fromPath: filePath,
      pathToFile,
    });
    brokenLinks.push(...fileBrokenLinks);

    const frontmatterYaml = serializeFrontmatter(input.frontmatter).replace(/\n+$/, "");
    files.push({ path: filePath, contents: joinDocument({ frontmatter: frontmatterYaml, body: markdown }) });
  }

  return { files, brokenLinks };
}
