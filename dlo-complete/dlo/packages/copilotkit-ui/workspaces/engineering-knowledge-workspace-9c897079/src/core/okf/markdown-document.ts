// src/core/okf/markdown-document.ts — split/join the `---`-delimited frontmatter block from an
// OKF Markdown document's body, and name the exported file for a Concept (Implementation.md m8).
// Text-only: this module knows nothing about YAML or zod — `frontmatter.ts` owns parsing the raw
// block this extracts. Delimiter matching tolerates CRLF line endings and a leading UTF-8 BOM
// (both are realistic for a Git-synced file authored on Windows or exported by another tool), but
// an opened-and-never-closed `---` fence is a genuine authoring error, not something to guess
// through, so it throws rather than silently treating the whole file as frontmatter-less.
import { ValidationError } from "../errors";
import type { Concept } from "../types";

const BOM = String.fromCharCode(0xfeff);

/** Matches the very first line of a document being exactly a `---` fence. */
const OPENING_FENCE = /^---(?:\r\n|\n)/;

/**
 * Matches the closing `---` fence: a line boundary (start of string or a newline), the fence
 * itself, then another line boundary (a newline or end of string). Used against the text that
 * follows the opening fence, so `^` here means "frontmatter is empty".
 */
const CLOSING_FENCE = /(?:^|\r\n|\n)---(?:\r\n|\n|$)/;

export interface SplitDocument {
  /** Raw YAML text between the fences, exactly as written; `null` if the document has none. */
  readonly frontmatter: string | null;
  readonly body: string;
}

/**
 * Separates the `---`-delimited frontmatter block from the document body. A document that does
 * not open with a `---` fence has no frontmatter at all: `frontmatter` is `null` and `body` is
 * the entire (BOM-stripped) input, unchanged. Throws `ValidationError`
 * (`details.reason === "document.unterminatedFrontmatter"`) if a `---` fence is opened but never
 * closed.
 */
export function splitDocument(text: string): SplitDocument {
  const stripped = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const opening = OPENING_FENCE.exec(stripped);
  if (!opening) {
    return { frontmatter: null, body: stripped };
  }

  // A successful `exec()` always sets index 0 to the full match; `noUncheckedIndexedAccess`
  // cannot see that guarantee, so the fallback is dead code, never an actual truncation.
  const afterOpening = stripped.slice(opening[0]?.length ?? 0);
  const closing = CLOSING_FENCE.exec(afterOpening);
  if (!closing) {
    throw new ValidationError("document frontmatter fence is never closed", {
      details: { reason: "document.unterminatedFrontmatter" },
    });
  }

  return {
    frontmatter: afterOpening.slice(0, closing.index),
    body: afterOpening.slice(closing.index + (closing[0]?.length ?? 0)),
  };
}

/**
 * Reassembles a document from its parts. `frontmatter: null` produces a body-only document with
 * no fences at all — the inverse of {@link splitDocument}'s "no frontmatter" case. Always emits
 * `\n` line endings, regardless of what the original document used.
 */
export function joinDocument(doc: SplitDocument): string {
  if (doc.frontmatter === null) {
    return doc.body;
  }
  return `---\n${doc.frontmatter}\n---\n${doc.body}`;
}

/**
 * The exported OKF filename for a Concept: `index.md` when it is the progressive-disclosure
 * root of a subtree (Database.md `concepts`: `is_index OR has_children`), `<slug>.md` otherwise.
 */
export function conceptFileName(concept: Pick<Concept, "slug" | "isIndex" | "childCount">): string {
  return concept.isIndex || concept.childCount > 0 ? "index.md" : `${concept.slug}.md`;
}
