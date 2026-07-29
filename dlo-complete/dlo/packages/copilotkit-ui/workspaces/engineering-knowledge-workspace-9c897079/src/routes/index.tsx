// src/routes/index.tsx — the bundle picker (Implementation.md m21), replacing the marketing
// landing page module m1 shipped. This is also where the app's client-only Relay/actor wiring
// lives — `bundles.$bundleId.tsx`, `concepts.$conceptId.tsx` and `search.tsx` all import
// `useBrowserRelayEnvironment`/`getOrCreateClientActor` from here, since m21 has no dedicated
// file in its `touches` list for shared client bootstrapping and this is the app's entry route.
//
// No auth module exists (`src/routes/api/graphql.ts`'s `resolveActor`: "There is no
// authentication module in this codebase... the caller supplies it via headers"). Rather than
// bake a fabricated "system" actor into server code, `getOrCreateClientActor` generates one
// pseudo-identity per browser (persisted in `localStorage`) the first time the app runs there —
// labelled here, not silently assumed, per Architecture.md's "no silent fallbacks" rule. Replace
// this with real sign-in once an auth module exists.
//
// `useBrowserRelayEnvironment` only ever constructs the environment inside a `useEffect` — never
// during render — so this and every other route stay render-safe under SSR (`window`/`crypto` are
// browser-only) regardless of exactly how this TanStack Start release's `ssr: false` route option
// treats an initial server pass; every one of these routes also sets `ssr: false` itself, since
// their data only ever comes from the client-side Relay environment.
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createFileRoute } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { fetchQuery, graphql, type IEnvironment } from "relay-runtime";
import { Banner, EmptyState, List, ListItem, Spinner, Stack, Text } from "@astryxdesign/core";
import { createRelayEnvironment } from "../relay/environment";
import type { IndexBundlesQuery, IndexBundlesQuery$data } from "../__generated__/IndexBundlesQuery.graphql";

const ACTOR_ID_STORAGE_KEY = "ekw.actorId";
const ACTOR_NAME_STORAGE_KEY = "ekw.actorName";
const GRAPHQL_ENDPOINT = "/api/graphql";

/**
 * No workspace/tenant module exists (`bundle-schema.graphql`'s `workspaceId` is a bare `String!`,
 * never backed by a `workspaces` module or a switcher UI) — this workspace is effectively
 * single-tenant, so every bundle list request uses one fixed, real (not fabricated) identifier.
 */
export const DEFAULT_WORKSPACE_ID = "default-workspace";

export interface ClientActorIdentity {
  readonly actorId: string;
  readonly email: string;
  readonly displayName: string;
}

/** Reads (or creates and persists) this browser's pseudo-actor identity. See the module header. */
export function getOrCreateClientActor(): ClientActorIdentity {
  const existingId = window.localStorage.getItem(ACTOR_ID_STORAGE_KEY);
  const existingName = window.localStorage.getItem(ACTOR_NAME_STORAGE_KEY);
  if (existingId && existingName) {
    return { actorId: existingId, email: `${existingId}@workspace.local`, displayName: existingName };
  }
  const actorId = crypto.randomUUID();
  const displayName = `Guest ${actorId.slice(0, 4).toUpperCase()}`;
  window.localStorage.setItem(ACTOR_ID_STORAGE_KEY, actorId);
  window.localStorage.setItem(ACTOR_NAME_STORAGE_KEY, displayName);
  return { actorId, email: `${actorId}@workspace.local`, displayName };
}

/**
 * Builds a fresh browser-side Relay environment (`src/relay/environment.ts` — never memoized at
 * module scope, per that module's own contract). Injects the three actor headers
 * `/api/graphql`'s `resolveActor` requires, on top of whatever `init` Relay's fetch function set.
 */
export function createBrowserRelayEnvironment(): IEnvironment {
  const actor = getOrCreateClientActor();
  const { environment } = createRelayEnvironment({
    endpoint: GRAPHQL_ENDPOINT,
    fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-actor-id", actor.actorId);
      headers.set("x-actor-email", actor.email);
      headers.set("x-actor-display-name", actor.displayName);
      return fetch(input, { ...init, headers });
    },
  });
  return environment;
}

/** Constructs the browser Relay environment on mount; `null` until then (never during SSR). */
export function useBrowserRelayEnvironment(): IEnvironment | null {
  const [environment, setEnvironment] = useState<IEnvironment | null>(null);
  useEffect(() => {
    setEnvironment(createBrowserRelayEnvironment());
  }, []);
  return environment;
}

export const Route = createFileRoute("/")({
  ssr: false,
  component: HomePage,
});

const BUNDLES_QUERY = graphql`
  query IndexBundlesQuery($workspaceId: String!, $first: Int) {
    bundles(workspaceId: $workspaceId, first: $first) {
      edges {
        node {
          id
          slug
          title
          description
          conceptCount
          defaultTrust
        }
      }
      totalCount
    }
  }
`;

type BundleSummary = IndexBundlesQuery$data["bundles"]["edges"][number]["node"];

type BundleListStatus = "loading" | "loaded" | "error";

const styles = stylex.create({
  page: {
    width: "100%",
    maxWidth: "960px",
    marginInline: "auto",
  },
});

function bundleHref(bundleId: string): string {
  return `/bundles/${encodeURIComponent(bundleId)}`;
}

function HomePage(): ReactElement {
  const environment = useBrowserRelayEnvironment();
  const [status, setStatus] = useState<BundleListStatus>("loading");
  const [bundles, setBundles] = useState<readonly BundleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!environment) {
      return;
    }
    let cancelled = false;
    setStatus("loading");
    fetchQuery<IndexBundlesQuery>(environment, BUNDLES_QUERY, { workspaceId: DEFAULT_WORKSPACE_ID, first: 50 })
      .toPromise()
      .then((data) => {
        if (cancelled) {
          return;
        }
        if (!data) {
          setStatus("error");
          setError("Failed to load bundles");
          return;
        }
        setBundles(data.bundles.edges.map((edge) => edge.node));
        setStatus("loaded");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load bundles");
      });
    return () => {
      cancelled = true;
    };
  }, [environment]);

  const body = useMemo((): ReactElement => {
    if (!environment || status === "loading") {
      return (
        <Stack direction="horizontal" gap={2} vAlign="center" padding={4}>
          <Spinner size="sm" />
          <Text type="body" size="sm" color="secondary">
            Loading bundles…
          </Text>
        </Stack>
      );
    }
    if (status === "error") {
      return <Banner status="error" title="Couldn't load bundles" description={error ?? "Failed to load bundles"} />;
    }
    if (bundles.length === 0) {
      return (
        <EmptyState
          title="No knowledge bundles yet"
          description="Bundles are created via the GraphQL API; once one exists it will show up here."
        />
      );
    }
    return (
      <List aria-label="Knowledge bundles">
        {bundles.map((bundle) => (
          <ListItem
            key={bundle.id}
            label={bundle.title}
            description={`${bundle.description || "No description."} · ${bundle.conceptCount} concept${bundle.conceptCount === 1 ? "" : "s"}`}
            href={bundleHref(bundle.id)}
          />
        ))}
      </List>
    );
  }, [environment, status, error, bundles]);

  return (
    <Stack direction="vertical" gap={4} padding={4} xstyle={styles.page}>
      <Stack direction="vertical" gap={1}>
        <Text type="display-3" as="h1">
          Engineering Knowledge Workspace
        </Text>
        <Text type="body" color="secondary">
          Pick a knowledge bundle below to browse its concepts and search within it.
        </Text>
      </Stack>
      {body}
    </Stack>
  );
}
