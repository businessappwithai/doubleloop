// src/modules/search/query-builder.ts — the only file in module m12 that knows what a search
// SQL statement looks like (Implementation.md m12; Database.md "Query Patterns" §6/§7). Pure: no
// `Db`, no I/O. Three predicate shapes combine with a plain `AND`: `content_blocks @> $n::jsonb`
// against the mandated `jsonb_path_ops` index (`concept_documents_blocks_gin`) for structured
// block queries, `(title_tsv @@ … OR body_tsv @@ … OR title ILIKE …)` for prose — the trigram
// `ILIKE` leg catches partial-word/identifier matches `websearch_to_tsquery` cannot (Database.md
// `pg_trgm` justification) — and `bundle_id = $1` on every query so the `btree_gin` composite
// indexes (`concept_documents_body_tsv_gin`, `concepts_title_tsv_idx`) stay usable. Cursor
// pagination is deliberately NOT expressed here as `LIMIT`/`OFFSET`: relevance rank is not
// monotonic against any single column, so there is no correct keyset predicate for it. Instead
// this returns every scoped match, ordered, and `search-module.ts` pages it in memory through
// `core/connection.ts`'s `buildConnection` — the same fetch-the-full-scoped-set convention
// `core/connection.ts` documents for the sidebar's `children` connection.
import { ValidationError } from "../../core/errors";
import type { BundleId } from "../../core/ids";

/** Above this many whitespace-separated words, a text query is rejected rather than built. */
export const MAX_SEARCH_TERMS = 12;

/** A JSONB fragment matched with `@>` against `concept_documents.content_blocks`. */
export type ContainmentFragment = Readonly<Record<string, unknown>>;

export interface SearchQueryInput {
  readonly bundleId: BundleId;
  /** Free-text query. Whitespace-only is treated as absent. */
  readonly text?: string;
  readonly containment?: ContainmentFragment;
}

export interface BuiltSearchQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Splits `text` into the whitespace-separated words `websearch_to_tsquery` and the highlighter
 * both reason about. Pure; used by both {@link buildSearchQuery} (term-limit validation) and
 * `search-module.ts` (snippet highlighting) so the two never disagree on what a "term" is.
 */
export function splitSearchTerms(text: string): readonly string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/**
 * Builds the SQL text and parameter array for one search request. Throws
 * `ValidationError('search.emptyQuery')` when both `text` (after trimming) and `containment` are
 * absent, and `ValidationError('search.tooManyTerms')` when `text` splits into more than
 * {@link MAX_SEARCH_TERMS} words.
 */
export function buildSearchQuery(input: SearchQueryInput): BuiltSearchQuery {
  const trimmedText = (input.text ?? "").trim();
  const hasText = trimmedText.length > 0;
  const hasContainment = input.containment !== undefined;

  if (!hasText && !hasContainment) {
    throw new ValidationError("search.emptyQuery", { details: { text: input.text ?? null } });
  }

  const terms = hasText ? splitSearchTerms(trimmedText) : [];
  if (terms.length > MAX_SEARCH_TERMS) {
    throw new ValidationError("search.tooManyTerms", {
      details: { termCount: terms.length, limit: MAX_SEARCH_TERMS },
    });
  }

  const params: unknown[] = [input.bundleId];
  const whereLines: string[] = [" WHERE c.bundle_id = $1", "   AND c.deleted_at IS NULL"];
  let rankExpr = "0";

  if (hasText) {
    params.push(trimmedText);
    const textIdx = params.length;
    rankExpr = `ts_rank_cd(c.title_tsv || d.body_tsv, websearch_to_tsquery('okf_english', $${textIdx}))`;
    whereLines.push(
      `   AND (c.title_tsv @@ websearch_to_tsquery('okf_english', $${textIdx})` +
        ` OR d.body_tsv @@ websearch_to_tsquery('okf_english', $${textIdx})` +
        ` OR c.title ILIKE '%' || $${textIdx} || '%')`,
    );
  }

  if (hasContainment) {
    params.push(JSON.stringify(input.containment));
    const containmentIdx = params.length;
    whereLines.push(`   AND d.content_blocks @> $${containmentIdx}::jsonb`);
  }

  const sql = [
    "SELECT c.id AS id, c.path AS path, c.title AS title, d.body_markdown AS body_markdown,",
    `       ${rankExpr} AS rank`,
    "  FROM concepts c",
    "  JOIN concept_documents d ON d.concept_id = c.id",
    ...whereLines,
    " ORDER BY rank DESC, c.path",
  ].join("\n");

  return { sql, params };
}
