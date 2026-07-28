// src/modules/git-sync/link-rewriter.ts — pure Markdown cross-link rewriting for the Git-sync
// export (Implementation.md m14). Concepts are addressed internally by their canonical
// `concepts.path` (Database.md "concepts"): an authored link's href is either "absolute"
// (leading `/`, bundle-root-relative, e.g. `/runtime/scheduler.md` or `/runtime/scheduler`),
// "relative" (POSIX-relative to the directory *containing* the linking concept's own exported
// file, e.g. `./sibling.md` or `../other/leaf.md`), "external" (a URL/mailto/etc. with a scheme),
// or an "anchor" (a bare `#fragment`) — the same four-way split `concept_links.kind` uses
// (Database.md `concept_links`). Only absolute/relative hrefs name another concept; external and
// anchor hrefs pass through unchanged.
//
// A resolvable internal href is rewritten to a path relative to the *linking file's own
// directory* — not merely the concept's materialised path — because `exporter.ts` may place a
// concept's content at `<path>/index.md` (any concept with children) rather than `<path>.md`, and
// only the file's actual directory gives correct `../` counting in either case. An internal href
// that does not resolve to any key of `ctx.pathToFile` (a broken cross-link, or one to a concept
// outside this bundle) is left byte-for-byte intact — never dropped, never replaced with a
// guessed path — and reported in `brokenLinks` for the caller to surface.
import { posix } from "node:path";

/** Matches Markdown inline link syntax `[label](href)` — deliberately not image syntax `![...]`. */
const LINK_PATTERN = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** A URI with an explicit scheme (`https:`, `mailto:`, ...) — anything not a bare filesystem-style path. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export type LinkKind = "absolute" | "relative" | "external" | "anchor";

export interface BrokenLink {
  /** The exported file path (repo-relative) the broken link was found in. */
  readonly fromPath: string;
  /** The href exactly as authored. */
  readonly href: string;
}

export interface RewriteContext {
  /** The exported file path (repo-relative, e.g. `runtime/scheduler/index.md`) this markdown will be written to. */
  readonly fromPath: string;
  /** Every live concept's canonical `path` (Database.md `concepts.path`) mapped to its exported file path. */
  readonly pathToFile: ReadonlyMap<string, string>;
}

export interface RewriteResult {
  readonly markdown: string;
  readonly brokenLinks: readonly BrokenLink[];
}

/** Pure: classifies `href` the way `concept_links.kind` does (Database.md `concept_links`). */
export function classifyHref(href: string): LinkKind {
  if (href.startsWith("#")) {
    return "anchor";
  }
  if (SCHEME_PATTERN.test(href)) {
    return "external";
  }
  return href.startsWith("/") ? "absolute" : "relative";
}

/** Strips a trailing `.md`, then a trailing `/index` (or a bare `index`), leaving a bundle-relative concept path. */
function stripToConceptPath(path: string): string {
  const withoutExtension = path.endsWith(".md") ? path.slice(0, -".md".length) : path;
  if (withoutExtension === "index") {
    return "";
  }
  return withoutExtension.endsWith("/index") ? withoutExtension.slice(0, -"/index".length) : withoutExtension;
}

/** Resolves `href` (already classified as absolute or relative) to the concept path it names. */
function resolveConceptPath(href: string, kind: "absolute" | "relative", fromPath: string): string {
  if (kind === "absolute") {
    return stripToConceptPath(href.slice(1));
  }
  const fromDir = posix.dirname(fromPath);
  const joined = posix.normalize(posix.join(fromDir, href));
  return stripToConceptPath(joined === "." ? "" : joined);
}

/** Prefixes a same-directory relative path with `./`, matching the `./sibling.md` convention (Database.md `concept_links`). */
function toRelativeHref(from: string, to: string): string {
  const relative = posix.relative(posix.dirname(from), to);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Rewrites every absolute/relative internal link in `markdown` to a path relative to
 * `ctx.fromPath`'s own directory. External and anchor links pass through unchanged. An
 * absolute/relative href that does not resolve to a key of `ctx.pathToFile` is left unchanged
 * and reported in the result's `brokenLinks`.
 */
export function rewriteLinks(markdown: string, ctx: RewriteContext): RewriteResult {
  const brokenLinks: BrokenLink[] = [];

  const rewritten = markdown.replace(LINK_PATTERN, (full: string, label: string, href: string) => {
    const kind = classifyHref(href);
    if (kind === "external" || kind === "anchor") {
      return full;
    }
    const conceptPath = resolveConceptPath(href, kind, ctx.fromPath);
    const targetFile = ctx.pathToFile.get(conceptPath);
    if (targetFile === undefined) {
      brokenLinks.push({ fromPath: ctx.fromPath, href });
      return full;
    }
    return `[${label}](${toRelativeHref(ctx.fromPath, targetFile)})`;
  });

  return { markdown: rewritten, brokenLinks };
}
