// src/routes/search.tsx — the search route (Implementation.md m21). `search(bundleId, ...)`
// (`search-schema.graphql`) is bundle-scoped, and this app has no cross-bundle search field, so
// the route takes the bundle as a `?bundle=` search param (set by `bundles.$bundleId.tsx`'s
// "Search this bundle" link) rather than a path segment — landing on `/search` with no bundle
// selected yet is a real, navigable state, not an error, so it gets its own empty state rather
// than a redirect.
import { useMemo, type ReactElement } from "react";
import { createFileRoute } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { EmptyState, Link, Spinner, Stack } from "@astryxdesign/core";
import { SearchPanel, type SearchHitSummary } from "../features/search";
import { useBrowserRelayEnvironment } from "./index";

export interface SearchRouteSearchParams {
  readonly bundle?: string;
}

function validateSearch(search: Record<string, unknown>): SearchRouteSearchParams {
  return typeof search["bundle"] === "string" ? { bundle: search["bundle"] } : {};
}

export const Route = createFileRoute("/search")({
  ssr: false,
  validateSearch,
  component: SearchRoute,
});

const styles = stylex.create({
  page: {
    width: "100%",
    maxWidth: "720px",
    marginInline: "auto",
  },
});

function conceptHref(conceptId: string): string {
  return `/concepts/${encodeURIComponent(conceptId)}`;
}

function SearchRoute(): ReactElement {
  const { bundle } = Route.useSearch();
  const environment = useBrowserRelayEnvironment();

  const onSelectHit = useMemo(
    () => (hit: SearchHitSummary) => {
      window.location.assign(conceptHref(hit.id));
    },
    [],
  );

  if (!bundle) {
    return (
      <Stack direction="vertical" gap={3} padding={4} xstyle={styles.page}>
        <EmptyState
          title="No bundle selected"
          description="Open a bundle first, then use its “Search this bundle” link."
          actions={
            <Link href="/" label="Browse bundles">
              Browse bundles
            </Link>
          }
        />
      </Stack>
    );
  }

  if (!environment) {
    return (
      <Stack direction="horizontal" gap={2} vAlign="center" padding={4}>
        <Spinner size="sm" />
      </Stack>
    );
  }

  return (
    <Stack direction="vertical" gap={3} padding={4} xstyle={styles.page}>
      <SearchPanel environment={environment} bundleId={bundle} onSelectHit={onSelectHit} />
    </Stack>
  );
}
