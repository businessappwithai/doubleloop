// src/features/sidebar/use-tree-pagination.ts — a hook over the `Concept.children` Relay
// Connection (Implementation.md m21). Every node in the sidebar tree (the bundle's root concept
// and every concept reachable by expanding one) is addressed by its own Relay global id and owns
// an independent page of `children`, fetched imperatively via `fetchQuery` rather than
// `usePaginationFragment` — this hook needs to report `loading`/`loadingMore`/`error` per node
// explicitly (so `SidebarTree` can render a spinner or an inline error under exactly the node
// that failed), which a Suspense-based fragment hook does not expose.
//
// There is no GraphQL field for "root concepts of a bundle" (`Concept.children`/`ancestors` are
// resolver extensions on `Concept`, requiring a source `Concept` — see `hierarchy-schema.graphql`)
// — only per-node pagination exists. `SidebarTree`'s caller resolves the bundle's root concept id
// once (via `conceptByPath(bundleId, "index")`, itself an existing Query field) and this hook
// treats it like any other node id from then on, so the gap only has to be worked around once, at
// the top.
//
// Dedup uses a `Set` ref mutated synchronously the instant a fetch is kicked off — not a `loading`
// flag read from React state — because two synchronous calls to `loadMore`/`toggle` for the same
// id (e.g. a double click before the first render commits) must only ever start one network
// request, and React state updates are not guaranteed to have committed between the two calls.
import { useCallback, useMemo, useRef, useState } from "react";
import { fetchQuery, graphql, type IEnvironment } from "relay-runtime";
import type {
  SidebarTreeChildrenQuery,
  SidebarTreeChildrenQuery$data,
} from "../../__generated__/SidebarTreeChildrenQuery.graphql";

/** One child row, exactly what `SidebarTree` needs to render and to recurse into. */
export interface TreeChildSummary {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly isIndex: boolean;
  readonly childCount: number;
}

/** Per-node state this hook tracks. Every node not yet touched reads as {@link EMPTY_NODE_STATE}. */
export interface TreeNodeState {
  readonly expanded: boolean;
  /** True while this node's first page is in flight. */
  readonly loading: boolean;
  /** True while a subsequent page (`loadMore`) is in flight. */
  readonly loadingMore: boolean;
  /** The most recent fetch's error message, or `null`. Cleared at the start of the next fetch. */
  readonly error: string | null;
  /** True once this node's first page has successfully loaded at least once. */
  readonly loaded: boolean;
  readonly children: readonly TreeChildSummary[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export const EMPTY_NODE_STATE: TreeNodeState = Object.freeze({
  expanded: false,
  loading: false,
  loadingMore: false,
  error: null,
  loaded: false,
  children: [],
  hasNextPage: false,
  endCursor: null,
});

export const DEFAULT_TREE_PAGE_SIZE = 25;

export interface UseTreePaginationOptions {
  /** Page size for both the first fetch and every `loadMore`. @default {@link DEFAULT_TREE_PAGE_SIZE} */
  readonly pageSize?: number;
}

export interface UseTreePaginationResult {
  /** Returns `id`'s current state, or {@link EMPTY_NODE_STATE} if `id` has never been touched. */
  getNode(id: string): TreeNodeState;
  /**
   * Collapses an expanded node. Expands a collapsed one, fetching its first page the first time
   * (a re-expand of an already-loaded node reuses its cached children — no refetch).
   */
  toggle(id: string): void;
  /** Fetches the next page of `id`'s children. A no-op while a page is already in flight, or once `hasNextPage` is false. */
  loadMore(id: string): void;
}

const CHILDREN_QUERY = graphql`
  query SidebarTreeChildrenQuery($id: ID!, $first: Int!, $after: String) {
    node(id: $id) {
      ... on Concept {
        children(first: $first, after: $after) {
          edges {
            cursor
            node {
              id
              title
              slug
              isIndex
              childCount
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

type ChildrenQueryData = SidebarTreeChildrenQuery$data;

function toSummaries(data: ChildrenQueryData): {
  children: TreeChildSummary[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const children = data.node?.children;
  if (!children) {
    throw new Error("useTreePagination: node did not resolve to a Concept with children");
  }
  return {
    children: children.edges.map((edge) => ({ ...edge.node })),
    hasNextPage: children.pageInfo.hasNextPage,
    endCursor: children.pageInfo.endCursor ?? null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load children";
}

/** A hook over the `children` Connection: expand/collapse, paginated `loadMore`, per-node errors. */
export function useTreePagination(
  environment: IEnvironment,
  options: UseTreePaginationOptions = {},
): UseTreePaginationResult {
  const pageSize = options.pageSize ?? DEFAULT_TREE_PAGE_SIZE;
  const [nodes, setNodes] = useState<Readonly<Record<string, TreeNodeState>>>({});
  const inFlight = useRef<Set<string>>(new Set());

  const getNode = useCallback((id: string): TreeNodeState => nodes[id] ?? EMPTY_NODE_STATE, [nodes]);

  const patchNode = useCallback((id: string, patch: Partial<TreeNodeState>): void => {
    setNodes((prev) => {
      const current = prev[id] ?? EMPTY_NODE_STATE;
      return { ...prev, [id]: { ...current, ...patch } };
    });
  }, []);

  const fetchFirstPage = useCallback(
    (id: string): void => {
      if (inFlight.current.has(id)) {
        return;
      }
      inFlight.current.add(id);
      patchNode(id, { loading: true, error: null });

      fetchQuery<SidebarTreeChildrenQuery>(environment, CHILDREN_QUERY, { id, first: pageSize, after: null })
        .toPromise()
        .then((data) => {
          inFlight.current.delete(id);
          if (!data) {
            patchNode(id, { loading: false, error: "Failed to load children" });
            return;
          }
          const { children, hasNextPage, endCursor } = toSummaries(data);
          patchNode(id, { loading: false, loaded: true, error: null, children, hasNextPage, endCursor });
        })
        .catch((error: unknown) => {
          inFlight.current.delete(id);
          patchNode(id, { loading: false, error: errorMessage(error) });
        });
    },
    [environment, pageSize, patchNode],
  );

  const toggle = useCallback(
    (id: string): void => {
      const current = nodes[id] ?? EMPTY_NODE_STATE;
      if (current.expanded) {
        patchNode(id, { expanded: false });
        return;
      }
      patchNode(id, { expanded: true });
      if (!current.loaded) {
        fetchFirstPage(id);
      }
    },
    [nodes, patchNode, fetchFirstPage],
  );

  const loadMore = useCallback(
    (id: string): void => {
      const current = nodes[id] ?? EMPTY_NODE_STATE;
      if (!current.hasNextPage || inFlight.current.has(id)) {
        return;
      }
      inFlight.current.add(id);
      patchNode(id, { loadingMore: true, error: null });

      fetchQuery<SidebarTreeChildrenQuery>(environment, CHILDREN_QUERY, {
        id,
        first: pageSize,
        after: current.endCursor,
      })
        .toPromise()
        .then((data) => {
          inFlight.current.delete(id);
          if (!data) {
            patchNode(id, { loadingMore: false, error: "Failed to load more children" });
            return;
          }
          const page = toSummaries(data);
          setNodes((prev) => {
            const node = prev[id] ?? EMPTY_NODE_STATE;
            return {
              ...prev,
              [id]: {
                ...node,
                loadingMore: false,
                error: null,
                children: [...node.children, ...page.children],
                hasNextPage: page.hasNextPage,
                endCursor: page.endCursor,
              },
            };
          });
        })
        .catch((error: unknown) => {
          inFlight.current.delete(id);
          // Preserve `children`/`pageInfo` exactly as they were — a failed loadMore never
          // discards what was already loaded.
          patchNode(id, { loadingMore: false, error: errorMessage(error) });
        });
    },
    [nodes, environment, pageSize, patchNode],
  );

  return useMemo(() => ({ getNode, toggle, loadMore }), [getNode, toggle, loadMore]);
}
