// src/features/search/SearchPanel.tsx — the bundle search panel (Implementation.md m21). Debounces
// keystrokes through an injectable `SearchTimer` (mirrors `collab/provider.ts`'s `CollabTimer`
// pattern) so a burst of typing issues exactly one query, `debounceMs` after the last keystroke —
// never one per keystroke. `search-schema.graphql`'s `search(bundleId, text, ...)` throws
// `search.emptyQuery` when both `text` and `containment` are omitted, so an empty/whitespace-only
// query is never sent at all: the panel renders its own "type to search" empty state instead of
// asking the server to reject an empty query. A monotonically increasing request generation
// (`latestRequest`) discards a response that arrives after a newer request was already issued —
// otherwise a slow first keystroke's response could overwrite a fast second keystroke's result.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fetchQuery, graphql, type IEnvironment } from "relay-runtime";
import { Banner, EmptyState, List, ListItem, Spinner, Stack, Text, TextInput } from "@astryxdesign/core";
import type { SearchPanelQuery, SearchPanelQuery$data } from "../../__generated__/SearchPanelQuery.graphql";

export type SearchTimerHandle = ReturnType<typeof setTimeout>;

/** Injectable timer for debouncing, so tests can assert "one query per burst" deterministically. */
export interface SearchTimer {
  setTimeout(handler: () => void, delayMs: number): SearchTimerHandle;
  clearTimeout(handle: SearchTimerHandle): void;
}

const defaultTimer: SearchTimer = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export const DEFAULT_SEARCH_DEBOUNCE_MS = 300;
export const DEFAULT_SEARCH_PAGE_SIZE = 20;

export interface SearchHitSummary {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly rank: number;
  readonly snippet: string;
}

type SearchStatus = "empty" | "loading" | "loaded" | "error";

const SEARCH_QUERY = graphql`
  query SearchPanelQuery($bundleId: ID!, $text: String, $first: Int) {
    search(bundleId: $bundleId, text: $text, first: $first) {
      edges {
        node {
          id
          title
          path
          rank
          snippet
        }
      }
      totalCount
    }
  }
`;

function toHits(data: SearchPanelQuery$data): SearchHitSummary[] {
  return data.search.edges.map((edge) => ({ ...edge.node }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Search failed";
}

const styles = stylex.create({
  panel: {
    width: "100%",
  },
  hitList: {
    width: "100%",
  },
});

/** Splits a `**bold**`-marked snippet (see `search-module.ts`) into plain and highlighted spans. */
export function renderHighlightedSnippet(snippet: string): ReactNode[] {
  const pieces: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(snippet)) !== null) {
    if (match.index > cursor) {
      pieces.push(<span key={key++}>{snippet.slice(cursor, match.index)}</span>);
    }
    pieces.push(<strong key={key++}>{match[1]}</strong>);
    cursor = match.index + match[0].length;
  }
  if (cursor < snippet.length) {
    pieces.push(<span key={key++}>{snippet.slice(cursor)}</span>);
  }
  return pieces;
}

export interface SearchPanelProps {
  readonly environment: IEnvironment;
  readonly bundleId: string;
  readonly debounceMs?: number;
  readonly timer?: SearchTimer;
  readonly pageSize?: number;
  readonly onSelectHit?: (hit: SearchHitSummary) => void;
}

/** The search input (debounced), result list with highlighted snippets, and empty/no-results states. */
export function SearchPanel({
  environment,
  bundleId,
  debounceMs = DEFAULT_SEARCH_DEBOUNCE_MS,
  timer = defaultTimer,
  pageSize = DEFAULT_SEARCH_PAGE_SIZE,
  onSelectHit,
}: SearchPanelProps): ReactElement {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("empty");
  const [hits, setHits] = useState<readonly SearchHitSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pendingTimer = useRef<SearchTimerHandle | null>(null);
  const latestRequest = useRef(0);

  const cancelPendingTimer = useCallback((): void => {
    if (pendingTimer.current !== null) {
      timer.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
  }, [timer]);

  useEffect(() => cancelPendingTimer, [cancelPendingTimer]);

  const runSearch = useCallback(
    (text: string): void => {
      const requestId = ++latestRequest.current;
      setStatus("loading");
      setError(null);

      fetchQuery<SearchPanelQuery>(environment, SEARCH_QUERY, { bundleId, text, first: pageSize })
        .toPromise()
        .then((data) => {
          if (requestId !== latestRequest.current) {
            return;
          }
          if (!data) {
            setStatus("error");
            setError("Search failed");
            return;
          }
          setHits(toHits(data));
          setStatus("loaded");
        })
        .catch((err: unknown) => {
          if (requestId !== latestRequest.current) {
            return;
          }
          setStatus("error");
          setError(errorMessage(err));
        });
    },
    [environment, bundleId, pageSize],
  );

  const handleChange = useCallback(
    (value: string): void => {
      setQuery(value);
      cancelPendingTimer();

      const trimmed = value.trim();
      if (trimmed.length === 0) {
        latestRequest.current += 1;
        setStatus("empty");
        setHits([]);
        setError(null);
        return;
      }

      pendingTimer.current = timer.setTimeout(() => {
        pendingTimer.current = null;
        runSearch(trimmed);
      }, debounceMs);
    },
    [cancelPendingTimer, timer, debounceMs, runSearch],
  );

  const body = useMemo((): ReactElement => {
    if (status === "empty") {
      return <EmptyState title="Search this bundle" description="Type to search concept titles and content." />;
    }
    if (status === "error") {
      return <Banner status="error" title="Search failed" description={error ?? "Search failed"} />;
    }
    if (status === "loading") {
      return (
        <Stack direction="horizontal" gap={2} vAlign="center" padding={3}>
          <Spinner size="sm" />
          <Text type="body" size="sm" color="secondary">
            Searching…
          </Text>
        </Stack>
      );
    }
    if (hits.length === 0) {
      return <EmptyState title="No results" description={`Nothing matched "${query.trim()}".`} />;
    }
    return (
      <List aria-label="Search results" xstyle={styles.hitList}>
        {hits.map((hit) => (
          <ListItem
            key={hit.id}
            label={hit.title}
            description={
              <Stack direction="vertical" gap={1}>
                <Text type="body" size="sm" color="secondary">
                  {hit.path}
                </Text>
                <Text type="body" size="sm">
                  {renderHighlightedSnippet(hit.snippet)}
                </Text>
              </Stack>
            }
            {...(onSelectHit ? { onClick: () => onSelectHit(hit) } : {})}
          />
        ))}
      </List>
    );
  }, [status, error, hits, query, onSelectHit]);

  return (
    <Stack direction="vertical" gap={3} xstyle={styles.panel}>
      <TextInput
        label="Search"
        isLabelHidden
        value={query}
        onChange={handleChange}
        placeholder="Search concepts…"
      />
      {body}
    </Stack>
  );
}
