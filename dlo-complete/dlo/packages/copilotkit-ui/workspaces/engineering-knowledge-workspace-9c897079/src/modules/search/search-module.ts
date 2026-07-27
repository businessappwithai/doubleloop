// src/modules/search/search-module.ts — the business logic for module m12 (Architecture.md
// "SearchModule": "the only module that writes search SQL" — the module itself never touches SQL
// directly, it delegates to `search-repository.ts`; the sentence means "the only module whose
// concern is search SQL shape", which lives one file over in `query-builder.ts`). Maps repository
// rows to `SearchHit`, computes the highlighted excerpt, and builds the `SearchHitConnection`
// through `core/connection.ts`'s Relay algorithm over the full ordered result set.
import { buildConnection, type Connection, type ConnectionArgs, type ConnectionRow } from "../../core/connection";
import { splitSearchTerms, type SearchQueryInput } from "./query-builder";
import type { SearchRepository, SearchRow } from "./search-repository";

export interface SearchHit extends ConnectionRow {
  readonly id: string;
  /** Same as `path` — `concepts.path` is `COLLATE "C"`, matching this query's `ORDER BY`. */
  readonly sortKey: string;
  readonly title: string;
  readonly path: string;
  /** Full-text relevance rank; `0` for a pure containment match with no text query. */
  readonly rank: number;
  /** A truncated excerpt around the first matched term, with matches wrapped in `**bold**`. */
  readonly snippet: string;
}

export interface SearchModule {
  search(query: SearchQueryInput, args: ConnectionArgs): Promise<Connection<SearchHit>>;
}

export function createSearchModule(repo: SearchRepository): SearchModule {
  return {
    async search(query, args) {
      const rows = await repo.search(query);
      const terms = query.text !== undefined ? splitSearchTerms(query.text) : [];
      const hits = rows.map((row) => toSearchHit(row, terms));
      return buildConnection(hits, args);
    },
  };
}

function toSearchHit(row: SearchRow, terms: readonly string[]): SearchHit {
  return {
    id: row.id,
    sortKey: row.path,
    title: row.title,
    path: row.path,
    rank: row.rank,
    snippet: highlightSnippet(row.bodyMarkdown, terms),
  };
}

/** Characters of surrounding context kept on each side of the first matched term. */
export const SNIPPET_CONTEXT_CHARS = 40;
const SNIPPET_ELLIPSIS = "…";

interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/** The leftmost occurrence (case-insensitive) of any of `terms` in `body`, or `null` if none match. */
function findFirstMatch(body: string, terms: readonly string[]): MatchRange | null {
  const lowerBody = body.toLowerCase();
  let best: MatchRange | null = null;
  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    if (lowerTerm.length === 0) {
      continue;
    }
    const index = lowerBody.indexOf(lowerTerm);
    if (index === -1) {
      continue;
    }
    if (best === null || index < best.start) {
      best = { start: index, end: index + term.length };
    }
  }
  return best;
}

/**
 * Extracts a `±SNIPPET_CONTEXT_CHARS`-character window of `body` around the first term match and
 * wraps the match in `**…**`. An ellipsis is prefixed/suffixed only when the window is actually
 * truncated on that side — a match at position 0 gets no leading ellipsis, and a match ending at
 * `body.length` gets no trailing one. With no term match (or no terms at all — a containment-only
 * query), returns a plain leading truncation of `body` with no highlight.
 */
export function highlightSnippet(body: string, terms: readonly string[]): string {
  const match = findFirstMatch(body, terms);
  if (match === null) {
    const end = Math.min(body.length, SNIPPET_CONTEXT_CHARS * 2);
    return end < body.length ? `${body.slice(0, end)}${SNIPPET_ELLIPSIS}` : body.slice(0, end);
  }

  const windowStart = Math.max(0, match.start - SNIPPET_CONTEXT_CHARS);
  const windowEnd = Math.min(body.length, match.end + SNIPPET_CONTEXT_CHARS);
  const prefix = windowStart > 0 ? SNIPPET_ELLIPSIS : "";
  const suffix = windowEnd < body.length ? SNIPPET_ELLIPSIS : "";
  const before = body.slice(windowStart, match.start);
  const matched = body.slice(match.start, match.end);
  const after = body.slice(match.end, windowEnd);
  return `${prefix}${before}**${matched}**${after}${suffix}`;
}
