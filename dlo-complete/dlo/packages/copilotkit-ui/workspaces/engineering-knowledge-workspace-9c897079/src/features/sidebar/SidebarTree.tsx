// src/features/sidebar/SidebarTree.tsx — the lazily-paginated concept tree (Implementation.md
// m21), driven entirely by `use-tree-pagination.ts`'s per-node state map. Rendered as a flat list
// of `role="treeitem"` rows (indentation encodes depth) rather than nested JSX, because keyboard
// navigation (`ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`) needs one linear order to move
// through regardless of how deep a given row is nested — recomputing that order from a nested
// tree on every key press would be strictly more code for the same result. A trailing
// `"load-more"` row is spliced into a level's own row list right after its last loaded child, so
// "Load more" behaves like any other focusable row instead of a one-off case the keyboard handler
// has to special-know about.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import * as stylex from "@stylexjs/stylex";
import type { IEnvironment } from "relay-runtime";
import { Banner, EmptyState, Icon, Spinner, Stack, Text } from "@astryxdesign/core";
import { useTreePagination, type TreeChildSummary, type TreeNodeState } from "./use-tree-pagination";

const INDENT_PX = 16;
const BASE_INDENT_PX = 8;

const styles = stylex.create({
  tree: {
    width: "100%",
    outline: "none",
  },
  row: {
    width: "100%",
    cursor: "pointer",
    borderRadius: "6px",
  },
  rowFocused: {
    boxShadow: "inset 0 0 0 2px light-dark(#1A73E8, #7CACF8)",
  },
  expandMarker: {
    flexShrink: 0,
    width: "16px",
    height: "16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    color: "inherit",
  },
  expandMarkerSpacer: {
    flexShrink: 0,
    width: "16px",
    height: "16px",
  },
  loadMoreRow: {
    width: "100%",
    cursor: "pointer",
  },
  errorText: {
    color: "light-dark(#B3261E, #F2B8B5)",
  },
});

type VisibleRow =
  | {
      readonly kind: "concept";
      readonly id: string;
      readonly depth: number;
      readonly parentId: string;
      readonly child: TreeChildSummary;
      readonly hasChildren: boolean;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "load-more";
      readonly id: string;
      readonly depth: number;
      readonly parentId: string;
    };

function flattenLevel(nodeId: string, depth: number, getNode: (id: string) => TreeNodeState): VisibleRow[] {
  const node = getNode(nodeId);
  const rows: VisibleRow[] = [];
  for (const child of node.children) {
    const childNode = getNode(child.id);
    rows.push({
      kind: "concept",
      id: child.id,
      depth,
      parentId: nodeId,
      child,
      hasChildren: child.childCount > 0,
      expanded: childNode.expanded,
    });
    if (childNode.expanded) {
      rows.push(...flattenLevel(child.id, depth + 1, getNode));
    }
  }
  if (node.hasNextPage) {
    rows.push({ kind: "load-more", id: `${nodeId}::load-more`, depth, parentId: nodeId });
  }
  return rows;
}

export interface SidebarTreeProps {
  readonly environment: IEnvironment;
  /** The bundle's root concept id (Relay global id), or `null` for a bundle with zero concepts. */
  readonly rootId: string | null;
  readonly onSelect?: (conceptId: string) => void;
  readonly pageSize?: number;
}

/** The lazily-paginated sidebar tree: keyboard navigation, expand markers, per-level load-more. */
export function SidebarTree({ environment, rootId, onSelect, pageSize }: SidebarTreeProps): ReactElement {
  const { getNode, toggle, loadMore } = useTreePagination(environment, pageSize !== undefined ? { pageSize } : {});
  const initializedRoot = useRef<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    if (rootId !== null && initializedRoot.current !== rootId) {
      initializedRoot.current = rootId;
      toggle(rootId);
    }
  }, [rootId, toggle]);

  const root = rootId !== null ? getNode(rootId) : EMPTY_ROOT;
  const rows = useMemo(
    () => (rootId !== null ? flattenLevel(rootId, 0, getNode) : []),
    [rootId, getNode],
  );

  useEffect(() => {
    if (rows.length === 0) {
      setFocusedId(null);
      return;
    }
    if (focusedId === null || !rows.some((row) => row.id === focusedId)) {
      setFocusedId(rows[0]!.id);
    }
  }, [rows, focusedId]);

  useEffect(() => {
    if (focusedId === null) {
      return;
    }
    rowRefs.current.get(focusedId)?.focus();
  }, [focusedId]);

  const activate = useCallback(
    (row: VisibleRow): void => {
      if (row.kind === "load-more") {
        loadMore(row.parentId);
        return;
      }
      onSelect?.(row.id);
    },
    [loadMore, onSelect],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (rows.length === 0 || focusedId === null) {
        return;
      }
      const index = rows.findIndex((row) => row.id === focusedId);
      if (index === -1) {
        return;
      }
      const current = rows[index]!;

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          const next = rows[Math.min(index + 1, rows.length - 1)];
          if (next) {
            setFocusedId(next.id);
          }
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          const previous = rows[Math.max(index - 1, 0)];
          if (previous) {
            setFocusedId(previous.id);
          }
          break;
        }
        case "ArrowRight": {
          event.preventDefault();
          if (current.kind === "concept" && current.hasChildren) {
            if (!current.expanded) {
              toggle(current.id);
            } else {
              const next = rows[index + 1];
              if (next) {
                setFocusedId(next.id);
              }
            }
          }
          break;
        }
        case "ArrowLeft": {
          event.preventDefault();
          if (current.kind === "concept" && current.expanded) {
            toggle(current.id);
          } else {
            const parentRow = rows.find((row) => row.id === current.parentId);
            if (parentRow) {
              setFocusedId(parentRow.id);
            } else if (current.parentId !== rootId) {
              setFocusedId(current.parentId);
            }
          }
          break;
        }
        case "Enter": {
          event.preventDefault();
          activate(current);
          break;
        }
        case " ": {
          event.preventDefault();
          if (current.kind === "load-more") {
            loadMore(current.parentId);
          } else if (current.hasChildren) {
            toggle(current.id);
          } else {
            onSelect?.(current.id);
          }
          break;
        }
        default:
          break;
      }
    },
    [rows, focusedId, toggle, loadMore, activate, onSelect, rootId],
  );

  if (rootId === null) {
    return <EmptyState title="No concepts yet" description="This bundle has no concepts to browse." />;
  }

  if (root.error && !root.loaded) {
    return (
      <Banner
        status="error"
        title="Couldn't load this bundle's concepts"
        description={root.error}
      />
    );
  }

  if (root.loading && !root.loaded) {
    return (
      <Stack direction="horizontal" gap={2} vAlign="center" padding={3}>
        <Spinner size="sm" />
        <Text type="body" size="sm" color="secondary">
          Loading concepts…
        </Text>
      </Stack>
    );
  }

  if (root.loaded && rows.length === 0) {
    return <EmptyState title="No concepts yet" description="This bundle has no concepts to browse." />;
  }

  return (
    <Stack
      direction="vertical"
      gap={0}
      role="tree"
      aria-label="Concept tree"
      xstyle={styles.tree}
      onKeyDown={handleKeyDown}
    >
      {rows.map((row) =>
        row.kind === "load-more" ? (
          <LoadMoreRow
            key={row.id}
            row={row}
            isFocused={row.id === focusedId}
            isLoading={getNode(row.parentId).loadingMore}
            onFocus={() => setFocusedId(row.id)}
            onActivate={() => activate(row)}
            registerRef={(el) => setRowRef(rowRefs.current, row.id, el)}
          />
        ) : (
          <ConceptRow
            key={row.id}
            row={row}
            isFocused={row.id === focusedId}
            error={getNode(row.id).error}
            onFocus={() => setFocusedId(row.id)}
            onToggle={() => toggle(row.id)}
            onActivate={() => activate(row)}
            registerRef={(el) => setRowRef(rowRefs.current, row.id, el)}
          />
        ),
      )}
    </Stack>
  );
}

const EMPTY_ROOT: TreeNodeState = {
  expanded: false,
  loading: false,
  loadingMore: false,
  error: null,
  loaded: false,
  children: [],
  hasNextPage: false,
  endCursor: null,
};

function setRowRef(map: Map<string, HTMLDivElement>, id: string, el: HTMLDivElement | null): void {
  if (el) {
    map.set(id, el);
  } else {
    map.delete(id);
  }
}

interface ConceptRowProps {
  readonly row: Extract<VisibleRow, { kind: "concept" }>;
  readonly isFocused: boolean;
  readonly error: string | null;
  readonly onFocus: () => void;
  readonly onToggle: () => void;
  readonly onActivate: () => void;
  readonly registerRef: (el: HTMLDivElement | null) => void;
}

function ConceptRow({ row, isFocused, error, onFocus, onToggle, onActivate, registerRef }: ConceptRowProps): ReactElement {
  return (
    <div
      ref={registerRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      tabIndex={isFocused ? 0 : -1}
      onFocus={onFocus}
      onClick={onActivate}
      {...stylex.props(styles.row, isFocused && styles.rowFocused)}
      style={{ paddingInlineStart: `${row.depth * INDENT_PX + BASE_INDENT_PX}px` }}
    >
      <Stack direction="horizontal" gap={1} vAlign="center" padding={1}>
        {row.hasChildren ? (
          <button
            type="button"
            aria-label={row.expanded ? `Collapse ${row.child.title}` : `Expand ${row.child.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            {...stylex.props(styles.expandMarker)}
          >
            <Icon icon={row.expanded ? "chevronDown" : "chevronRight"} size="sm" />
          </button>
        ) : (
          <span {...stylex.props(styles.expandMarkerSpacer)} />
        )}
        <Text type="body" size="sm">
          {row.child.title}
        </Text>
      </Stack>
      {error ? (
        <Text type="body" size="sm" xstyle={styles.errorText}>
          {error}
        </Text>
      ) : null}
    </div>
  );
}

interface LoadMoreRowProps {
  readonly row: Extract<VisibleRow, { kind: "load-more" }>;
  readonly isFocused: boolean;
  readonly isLoading: boolean;
  readonly onFocus: () => void;
  readonly onActivate: () => void;
  readonly registerRef: (el: HTMLDivElement | null) => void;
}

function LoadMoreRow({ row, isFocused, isLoading, onFocus, onActivate, registerRef }: LoadMoreRowProps): ReactElement {
  return (
    <div
      ref={registerRef}
      role="treeitem"
      aria-level={row.depth + 1}
      tabIndex={isFocused ? 0 : -1}
      onFocus={onFocus}
      onClick={onActivate}
      {...stylex.props(styles.row, styles.loadMoreRow, isFocused && styles.rowFocused)}
      style={{ paddingInlineStart: `${row.depth * INDENT_PX + BASE_INDENT_PX}px` }}
    >
      <Stack direction="horizontal" gap={1} vAlign="center" padding={1}>
        {isLoading ? <Spinner size="sm" /> : null}
        <Text type="body" size="sm" color="secondary">
          {isLoading ? "Loading more…" : "Load more"}
        </Text>
      </Stack>
    </div>
  );
}
