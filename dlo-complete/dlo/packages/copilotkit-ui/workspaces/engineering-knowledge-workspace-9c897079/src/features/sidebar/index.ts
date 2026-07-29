// src/features/sidebar/index.ts — public surface of the lazily-paginated sidebar tree (m21).
export {
  useTreePagination,
  DEFAULT_TREE_PAGE_SIZE,
  EMPTY_NODE_STATE,
  type TreeChildSummary,
  type TreeNodeState,
  type UseTreePaginationOptions,
  type UseTreePaginationResult,
} from "./use-tree-pagination";
export { SidebarTree, type SidebarTreeProps } from "./SidebarTree";
