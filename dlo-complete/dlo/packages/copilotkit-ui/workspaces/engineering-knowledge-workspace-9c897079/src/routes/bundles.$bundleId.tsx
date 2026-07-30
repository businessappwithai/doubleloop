// src/routes/bundles.$bundleId.tsx — a bundle's concept tree (Implementation.md m21). There is
// no GraphQL field for "root concepts of a bundle" — `Concept.children`/`ancestors` are resolver
// extensions on `Concept` (`hierarchy-schema.graphql`), always requiring a source `Concept`, never
// a bundle-scoped root query. This route resolves the bundle's root once via the existing
// `conceptByPath(bundleId, "index")` field (the OKF convention Architecture.md's HierarchyModule
// section names — "progressive disclosure via index.md") and hands that single id to
// `SidebarTree`, which treats it like any other node from then on. A bundle with no `index`
// concept renders `SidebarTree`'s own zero-concepts empty state (`rootId: null`) — the same state
// as a bundle whose index concept exists but has no children.
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createFileRoute } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { fetchQuery, graphql } from "relay-runtime";
import { Banner, EmptyState, Link, Spinner, Stack, Text } from "@astryxdesign/core";
import { SidebarChrome } from "../components/shell";
import { SidebarTree } from "../features/sidebar";
import { useBrowserRelayEnvironment } from "./index";
import type { BundleRouteQuery, BundleRouteQuery$data } from "../__generated__/BundleRouteQuery.graphql";

export const Route = createFileRoute("/bundles/$bundleId")({
  ssr: false,
  component: BundleRoute,
});

const BUNDLE_ROUTE_QUERY = graphql`
  query BundleRouteQuery($bundleId: ID!) {
    bundle(id: $bundleId) {
      id
      title
      description
    }

  }
`;

type BundleRouteStatus = "loading" | "loaded" | "error";
type BundleRouteData = BundleRouteQuery$data;

const styles = stylex.create({
  page: {
    width: "100%",
    minHeight: "60vh",
  },
  tree: {
    flexBasis: "320px",
    flexShrink: 0,
    flexGrow: 0,
    minWidth: 0,
    borderInlineEndWidth: "1px",
    borderInlineEndStyle: "solid",
    borderInlineEndColor: "light-dark(#E4E7EB, #2C2D30)",
  },
  main: {
    flexGrow: 1,
    minWidth: 0,
  },
});

function conceptHref(conceptId: string): string {
  return `/concepts/${encodeURIComponent(conceptId)}`;
}

function searchHref(bundleId: string): string {
  return `/search?bundle=${encodeURIComponent(bundleId)}`;
}

function BundleRoute(): ReactElement {
  const { bundleId } = Route.useParams();
  const environment = useBrowserRelayEnvironment();
  const [status, setStatus] = useState<BundleRouteStatus>("loading");
  const [data, setData] = useState<BundleRouteData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!environment) {
      return;
    }
    let cancelled = false;
    setStatus("loading");
    fetchQuery<BundleRouteQuery>(environment, BUNDLE_ROUTE_QUERY, { bundleId })
      .toPromise()
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result) {
          setStatus("error");
          setError("Failed to load bundle");
          return;
        }
        setData(result);
        setStatus("loaded");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load bundle");
      });
    return () => {
      cancelled = true;
    };
  }, [environment, bundleId]);

  // The bundle IS the tree's root node — `hierarchy-schema.graphql` extends `Bundle` with the same
  // `children` connection `Concept` has. This used to be `rootConcept?.id`, resolved from
  // `conceptByPath(path: "index")`, which left every bundle without an `index` concept — including
  // every seeded one — showing an empty sidebar next to a full concept list.
  const rootId = useMemo(() => data?.bundle?.id ?? null, [data]);

  if (!environment || status === "loading") {
    return (
      <Stack direction="horizontal" gap={2} vAlign="center" padding={4}>
        <Spinner size="sm" />
        <Text type="body" size="sm" color="secondary">
          Loading bundle…
        </Text>
      </Stack>
    );
  }

  if (status === "error") {
    return <Banner status="error" title="Couldn't load this bundle" description={error ?? "Failed to load bundle"} />;
  }

  if (!data?.bundle) {
    return <EmptyState title="Bundle not found" description="This bundle does not exist or was deleted." />;
  }

  return (
    <Stack direction="horizontal" gap={0} xstyle={styles.page}>
      <Stack xstyle={styles.tree}>
        <SidebarChrome title={data.bundle.title}>
          <SidebarTree
            environment={environment}
            rootId={rootId}
            onSelect={(conceptId) => {
              window.location.assign(conceptHref(conceptId));
            }}
          />
        </SidebarChrome>
      </Stack>
      <Stack direction="vertical" gap={3} padding={4} xstyle={styles.main}>
        <Text type="display-3" as="h1">
          {data.bundle.title}
        </Text>
        <Text type="body" color="secondary">
          {data.bundle.description || "No description."}
        </Text>
        <Stack direction="horizontal" gap={3}>
          <Link href={searchHref(bundleId)} label={`Search ${data.bundle.title}`}>
            Search this bundle
          </Link>
          <Link href="/" label="Back to all bundles">
            All bundles
          </Link>
        </Stack>
        {rootId ? (
          <Text type="body" size="sm" color="secondary">
            Select a concept in the tree to open it.
          </Text>
        ) : null}
      </Stack>
    </Stack>
  );
}
