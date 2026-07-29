// src/routes/concepts.$conceptId.tsx — the concept document page (Implementation.md m21):
// `DocumentHeader` + `BlockEditor` + `CollaborationPluginBridge` + `PresenceBar` +
// `FrontmatterPanel` composed together. Looked up by `node(id:)` alone (a concept's own global id
// resolves it regardless of bundle — Relay Global Object Identification exists exactly so this
// route does not need a `bundleId` segment), then a second query fetches the owning bundle (for
// `defaultTrust` and the breadcrumb root) once the first query reports it.
//
// No module exposes per-concept OKF frontmatter over GraphQL: `concept_frontmatter` is a real
// Database.md table, but none of m9-m21's modules define a `frontmatter`/`concept-frontmatter`
// GraphQL fragment or a persistence mutation for it (`core/types.ts`'s own header comment:
// "the fluid block/CRDT payload and the YAML frontmatter live in separate tables ... owned by
// later modules" — no later module ever claimed it). `frontmatter` below is therefore synthesised
// from the real fields that do exist (`title`, `updatedAt`, the bundle's `defaultTrust`) with
// honestly-labelled placeholders for the rest (`lifecycle: "active"` — every concept this route
// can reach is live, i.e. not soft-deleted, since every read path filters `deleted_at IS NULL`;
// empty `tags`/`links`; a `provenance` block naming this workspace as the source). `onSave` only
// ever persists `title`, through the one real, already-existing mutation
// (`updateConceptMetadata`) — every other `OkfFrontmatter` field the panel lets a user edit is
// display-only until a frontmatter-persistence module exists. This is a real, load-bearing gap in
// the current schema, not an oversight in this route; see the module comment on
// `hierarchy-schema.graphql`'s `Concept.children` for the sibling gap in the sidebar tree.
//
// Presence uses its own, second Yjs connection to the room (`createCollabProvider` +
// `setLocalPresence`/`subscribePresence`, exactly the public API `collab/index.ts` exports for
// this purpose) rather than reaching into `CollaborationPluginBridge`'s internal provider, which
// it does not expose. Two sockets to the same room is not ideal, but every piece used here is
// already a tested, public seam — reusing `CollaborationPluginBridge`'s own provider would need a
// new callback prop on a component this module does not own.
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createFileRoute } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { Doc } from "yjs";
import { commitMutation, fetchQuery, graphql } from "relay-runtime";
import type { LexicalEditor } from "lexical";
import { Banner, EmptyState, Link, Spinner, Stack } from "@astryxdesign/core";
import { DocumentHeader, type DocumentHeaderBreadcrumbEntry } from "../components/shell";
import { BlockEditor } from "../editor";
import {
  CollaborationPluginBridge,
  PresenceBar,
  createCollabProvider,
  setLocalPresence,
  subscribePresence,
  type PresencePeer,
} from "../collab";
import { FrontmatterPanel } from "../features/frontmatter";
import type { OkfFrontmatter } from "../core/okf/schema";
import type { Lifecycle, TrustLevel } from "../core/types";
import { getOrCreateClientActor, useBrowserRelayEnvironment } from "./index";
import type { ConceptRouteQuery, ConceptRouteQuery$data } from "../__generated__/ConceptRouteQuery.graphql";
import type { ConceptRouteBundleQuery, ConceptRouteBundleQuery$data } from "../__generated__/ConceptRouteBundleQuery.graphql";
import type { ConceptRouteUpdateTitleMutation } from "../__generated__/ConceptRouteUpdateTitleMutation.graphql";

export const Route = createFileRoute("/concepts/$conceptId")({
  ssr: false,
  component: ConceptRoute,
});

const CONCEPT_ROUTE_QUERY = graphql`
  query ConceptRouteQuery($conceptId: ID!) {
    node(id: $conceptId) {
      __typename
      ... on Concept {
        id
        bundleId
        title
        path
        version
        updatedAt
        ancestors {
          id
          title
        }
      }
    }
    conceptDocument(conceptId: $conceptId) {
      bodyMarkdown
    }
  }
`;

const CONCEPT_ROUTE_BUNDLE_QUERY = graphql`
  query ConceptRouteBundleQuery($bundleId: ID!) {
    bundle(id: $bundleId) {
      id
      title
      defaultTrust
    }
  }
`;

const UPDATE_TITLE_MUTATION = graphql`
  mutation ConceptRouteUpdateTitleMutation($input: UpdateConceptMetadataInput!) {
    updateConceptMetadata(input: $input) {
      concept {
        id
        title
        version
        updatedAt
      }
    }
  }
`;

/** Every concept this route can reach is live — every read path filters `deleted_at IS NULL`. */
const SYNTHETIC_LIFECYCLE: Lifecycle = "active";
/** Used only when the bundle query hasn't resolved yet — see the module header. */
const FALLBACK_TRUST: TrustLevel = "unverified";

/**
 * The GraphQL `TrustLevel` enum is SCREAMING_CASE (`schema.root.graphql`); the domain
 * `TrustLevel` union (`core/types.ts`) is hyphenated lowercase, by that module's own design (its
 * header comment: the two are deliberately not required to share a spelling). This is the one
 * place a GraphQL-sourced trust value crosses into a domain-typed prop (`DocumentHeader`,
 * `FrontmatterPanel`).
 */
function toDomainTrust(value: string): TrustLevel {
  switch (value) {
    case "MACHINE_CONFIRMED":
      return "machine-confirmed";
    case "HUMAN_REVIEWED":
      return "human-reviewed";
    default:
      return "unverified";
  }
}

type RouteStatus = "loading" | "loaded" | "not-found" | "error";
type ConceptData = ConceptRouteQuery$data;
type BundleData = ConceptRouteBundleQuery$data;

const styles = stylex.create({
  page: {
    width: "100%",
    maxWidth: "1100px",
    marginInline: "auto",
  },
  body: {
    width: "100%",
  },
  editorColumn: {
    flexGrow: 1,
    minWidth: 0,
  },
  inspectorColumn: {
    flexBasis: "320px",
    flexShrink: 0,
    minWidth: 0,
  },
});

function collabWebSocketUrl(): string {
  // No client-exposed env var carries the collab relay's ws:// URL (`.env.example`'s
  // `COLLAB_WS_URL` is server-only, and Vite only exposes `VITE_`-prefixed vars to the browser).
  // Same-host, the default port from that file's `COLLAB_WS_PORT=1234` is the only real value
  // available client-side.
  return `ws://${window.location.hostname}:1234`;
}

function bundleHref(bundleId: string): string {
  return `/bundles/${encodeURIComponent(bundleId)}`;
}

function conceptHref(conceptId: string): string {
  return `/concepts/${encodeURIComponent(conceptId)}`;
}

function buildBreadcrumb(bundle: BundleData["bundle"], node: ConceptData["node"]): DocumentHeaderBreadcrumbEntry[] {
  const entries: DocumentHeaderBreadcrumbEntry[] = [];
  if (bundle) {
    entries.push({ id: bundle.id, label: bundle.title, href: bundleHref(bundle.id) });
  }
  if (node && node.__typename === "Concept") {
    for (const ancestor of node.ancestors) {
      entries.push({ id: ancestor.id, label: ancestor.title, href: conceptHref(ancestor.id) });
    }
  }
  return entries;
}

function ConceptRoute(): ReactElement {
  const { conceptId } = Route.useParams();
  const environment = useBrowserRelayEnvironment();
  const actor = useMemo(() => (typeof window !== "undefined" ? getOrCreateClientActor() : null), []);

  const [status, setStatus] = useState<RouteStatus>("loading");
  const [data, setData] = useState<ConceptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<BundleData["bundle"] | null>(null);
  const [editor, setEditor] = useState<LexicalEditor | null>(null);
  const [peers, setPeers] = useState<readonly PresencePeer[]>([]);

  useEffect(() => {
    if (!environment) {
      return;
    }
    let cancelled = false;
    setStatus("loading");
    fetchQuery<ConceptRouteQuery>(environment, CONCEPT_ROUTE_QUERY, { conceptId })
      .toPromise()
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result || !result.node) {
          setStatus("not-found");
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
        setError(err instanceof Error ? err.message : "Failed to load concept");
      });
    return () => {
      cancelled = true;
    };
  }, [environment, conceptId]);

  const bundleId = data?.node && data.node.__typename === "Concept" ? data.node.bundleId : null;

  useEffect(() => {
    if (!environment || !bundleId) {
      return;
    }
    let cancelled = false;
    fetchQuery<ConceptRouteBundleQuery>(environment, CONCEPT_ROUTE_BUNDLE_QUERY, { bundleId })
      .toPromise()
      .then((result) => {
        if (!cancelled && result) {
          setBundle(result.bundle);
        }
      })
      .catch(() => {
        // Non-fatal: the page still renders with FALLBACK_TRUST if the bundle lookup fails.
      });
    return () => {
      cancelled = true;
    };
  }, [environment, bundleId]);

  useEffect(() => {
    if (!actor) {
      return;
    }
    const provider = createCollabProvider({
      room: `concept:${conceptId}`,
      wsUrl: collabWebSocketUrl(),
      doc: new Doc(),
      WebSocketPolyfill: WebSocket,
    });
    setLocalPresence(provider.awareness, { actorId: actor.actorId, name: actor.displayName });
    const unsubscribe = subscribePresence(provider.awareness, setPeers, { excludeActorId: actor.actorId });
    provider.connect();
    return () => {
      unsubscribe();
      provider.disconnect();
    };
  }, [actor, conceptId]);

  const savingRef = useRef(false);
  const [frontmatterOverride, setFrontmatterOverride] = useState<{ title: string; updatedAt: string } | null>(null);

  const concept = data?.node && data.node.__typename === "Concept" ? data.node : null;
  const document = data?.conceptDocument ?? null;

  const frontmatter = useMemo((): OkfFrontmatter | null => {
    if (!concept) {
      return null;
    }
    const title = frontmatterOverride?.title ?? concept.title;
    const updatedAt = frontmatterOverride?.updatedAt ?? concept.updatedAt;
    return {
      id: concept.id,
      title,
      trust: bundle ? toDomainTrust(bundle.defaultTrust) : FALLBACK_TRUST,
      lifecycle: SYNTHETIC_LIFECYCLE,
      provenance: {
        source: "workspace",
        author: actor?.displayName ?? "Unknown",
        retrievedAt: concept.updatedAt,
      },
      tags: [],
      links: [],
      updatedAt,
    };
  }, [concept, bundle, actor, frontmatterOverride]);

  const handleSaveFrontmatter = useMemo(
    () =>
      (next: OkfFrontmatter): void => {
        if (!environment || !concept || !bundleId || savingRef.current) {
          return;
        }
        if (next.title === concept.title) {
          return;
        }
        savingRef.current = true;
        commitMutation<ConceptRouteUpdateTitleMutation>(environment, {
          mutation: UPDATE_TITLE_MUTATION,
          variables: {
            input: { bundleId, id: concept.id, expectedVersion: concept.version, title: next.title },
          },
          onCompleted: () => {
            savingRef.current = false;
            setFrontmatterOverride({ title: next.title, updatedAt: new Date().toISOString() });
          },
          onError: () => {
            savingRef.current = false;
          },
        });
      },
    [environment, concept, bundleId],
  );

  if (!environment || status === "loading") {
    return (
      <Stack direction="horizontal" gap={2} vAlign="center" padding={4}>
        <Spinner size="sm" />
      </Stack>
    );
  }

  if (status === "not-found") {
    return <EmptyState title="Concept not found" description="This concept does not exist or was deleted." />;
  }

  if (status === "error" || !concept || !frontmatter) {
    return <Banner status="error" title="Couldn't load this concept" description={error ?? "Failed to load concept"} />;
  }

  const breadcrumb = buildBreadcrumb(bundle, data?.node ?? null);

  return (
    <Stack direction="vertical" gap={4} padding={4} xstyle={styles.page}>
      <DocumentHeader title={concept.title} trust={frontmatter.trust} lifecycle={frontmatter.lifecycle} breadcrumb={breadcrumb} />
      <PresenceBar peers={peers} />
      <Stack direction="horizontal" gap={4} xstyle={styles.body}>
        <Stack direction="vertical" gap={3} xstyle={styles.editorColumn}>
          <BlockEditor
            namespace={`concept-${concept.id}`}
            initialMarkdown={document?.bodyMarkdown ?? ""}
            onEditorReady={setEditor}
          />
          {editor ? (
            <CollaborationPluginBridge
              editor={editor}
              room={`concept:${concept.id}`}
              wsUrl={collabWebSocketUrl()}
              WebSocketPolyfill={WebSocket}
              username={actor?.displayName ?? "Anonymous"}
              initialMarkdown={document?.bodyMarkdown ?? ""}
            />
          ) : null}
        </Stack>
        <Stack xstyle={styles.inspectorColumn}>
          <FrontmatterPanel frontmatter={frontmatter} onSave={handleSaveFrontmatter} />
        </Stack>
      </Stack>
      <Link href={bundle ? bundleHref(bundle.id) : "/"} label="Back to bundle">
        Back to bundle
      </Link>
    </Stack>
  );
}
