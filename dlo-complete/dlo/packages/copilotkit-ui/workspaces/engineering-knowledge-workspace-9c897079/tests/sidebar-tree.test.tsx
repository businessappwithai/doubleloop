// tests/sidebar-tree.test.tsx — module m21's `SidebarTree`. Covers the loading/error/empty
// states `use-tree-pagination.ts` drives, row rendering with expand markers, expand-on-click
// fetching a child's first page, the "Load more" row appearing and firing `loadMore`, and
// keyboard navigation (`ArrowDown`/`ArrowUp`) across the flattened row list. Entirely against
// `relay-test-utils`' mock environment — no network call ever reaches `fetchQuery`.
import { describe, test, expect, vi } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { createMockEnvironment } from "relay-test-utils";
import { SidebarTree } from "../src/features/sidebar/SidebarTree";
import { flushMicrotasks } from "./helpers/test-utils";

// `Spinner`'s mount effect calls `canvas.getContext('2d')`, which jsdom does not implement — it
// logs the gap via its virtual console rather than throwing, and `vitest.setup.ts` turns any
// stray `console.error` into a hard test failure. Stubbed to return `null`, exactly the
// "no context available" path `Spinner`'s effect already handles by returning early (see
// `tests/editor-toolbar.test.tsx`).
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

function childEdge(id: string, title: string, childCount = 0) {
  return {
    cursor: `cursor-${id}`,
    node: { id, title, slug: title.toLowerCase(), isIndex: false, childCount },
  };
}

function childrenPayload(
  nodeId: string,
  edges: ReturnType<typeof childEdge>[],
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      node: {
        __typename: "Concept",
        id: nodeId,
        children: { edges, pageInfo: { hasNextPage, endCursor } },
      },
    },
  };
}

async function resolve(environment: ReturnType<typeof createMockEnvironment>, payload: unknown): Promise<void> {
  await act(async () => {
    environment.mock.resolveMostRecentOperation(payload);
    await flushMicrotasks();
  });
}

describe("SidebarTree", () => {
  test("renders nothing to fetch and shows the empty state when rootId is null", () => {
    const environment = createMockEnvironment();
    render(<SidebarTree environment={environment} rootId={null} />);
    expect(screen.getByText("No concepts yet")).toBeInTheDocument();
  });

  test("shows a loading indicator while the root's first page is in flight", () => {
    const environment = createMockEnvironment();
    render(<SidebarTree environment={environment} rootId="root" />);
    expect(screen.getByText("Loading concepts…")).toBeInTheDocument();
  });

  test("shows an error banner when the first fetch fails", async () => {
    const environment = createMockEnvironment();
    render(<SidebarTree environment={environment} rootId="root" />);
    await act(async () => {
      environment.mock.rejectMostRecentOperation(new Error("network exploded"));
      await flushMicrotasks();
    });
    expect(screen.getByText("Couldn't load this bundle's concepts")).toBeInTheDocument();
    expect(screen.getByText("network exploded")).toBeInTheDocument();
  });

  test("shows the empty state once loaded with zero children", async () => {
    const environment = createMockEnvironment();
    render(<SidebarTree environment={environment} rootId="root" />);
    await resolve(environment, childrenPayload("root", [], false, null));
    expect(screen.getByText("No concepts yet")).toBeInTheDocument();
  });

  test("renders a row per child, with an expand marker only for children that have children", async () => {
    const environment = createMockEnvironment();
    render(<SidebarTree environment={environment} rootId="root" />);
    await resolve(
      environment,
      childrenPayload("root", [childEdge("a", "Alpha", 2), childEdge("b", "Beta", 0)], false, null),
    );

    const tree = screen.getByRole("tree", { name: "Concept tree" });
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Alpha")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("button", { name: "Expand Alpha" })).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Beta")).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("button")).not.toBeInTheDocument();
  });

  test("expanding a node with children fetches and renders its first page nested beneath it", async () => {
    const environment = createMockEnvironment();
    render(<SidebarTree environment={environment} rootId="root" />);
    await resolve(environment, childrenPayload("root", [childEdge("a", "Alpha", 1)], false, null));

    await act(async () => {
      screen.getByRole("button", { name: "Expand Alpha" }).click();
    });
    await resolve(environment, childrenPayload("a", [childEdge("a1", "Alpha Child", 0)], false, null));

    const tree = screen.getByRole("tree", { name: "Concept tree" });
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText("Alpha Child")).toBeInTheDocument();
    expect(rows[1]!.getAttribute("aria-level")).toBe("2");
    expect(screen.getByRole("button", { name: "Collapse Alpha" })).toBeInTheDocument();
  });

  test("a per-level load-more row appears when hasNextPage, and activating it fetches the next page", async () => {
    const environment = createMockEnvironment();
    render(<SidebarTree environment={environment} rootId="root" pageSize={1} />);
    await resolve(environment, childrenPayload("root", [childEdge("a", "Alpha")], true, "cursor-a"));

    let tree = screen.getByRole("tree", { name: "Concept tree" });
    let rows = within(tree).getAllByRole("treeitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText("Load more")).toBeInTheDocument();

    await act(async () => {
      rows[1]!.click();
    });
    expect(within(screen.getByRole("tree")).getByText("Loading more…")).toBeInTheDocument();

    await resolve(environment, childrenPayload("root", [childEdge("b", "Beta")], false, null));

    tree = screen.getByRole("tree", { name: "Concept tree" });
    rows = within(tree).getAllByRole("treeitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Alpha")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Beta")).toBeInTheDocument();
  });

  test("calls onSelect when a leaf row is activated", async () => {
    const environment = createMockEnvironment();
    const onSelect = vi.fn();
    render(<SidebarTree environment={environment} rootId="root" onSelect={onSelect} />);
    await resolve(environment, childrenPayload("root", [childEdge("a", "Alpha", 0)], false, null));

    await act(async () => {
      screen.getByText("Alpha").click();
    });
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  test("ArrowDown and ArrowUp move focus across rows", async () => {
    const environment = createMockEnvironment();
    render(<SidebarTree environment={environment} rootId="root" />);
    await resolve(
      environment,
      childrenPayload("root", [childEdge("a", "Alpha", 0), childEdge("b", "Beta", 0)], false, null),
    );

    const tree = screen.getByRole("tree", { name: "Concept tree" });
    let rows = within(tree).getAllByRole("treeitem");
    expect(rows[0]!.tabIndex).toBe(0);
    expect(rows[1]!.tabIndex).toBe(-1);

    act(() => {
      fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    });
    rows = within(screen.getByRole("tree")).getAllByRole("treeitem");
    expect(rows[0]!.tabIndex).toBe(-1);
    expect(rows[1]!.tabIndex).toBe(0);

    act(() => {
      fireEvent.keyDown(rows[1]!, { key: "ArrowUp" });
    });
    rows = within(screen.getByRole("tree")).getAllByRole("treeitem");
    expect(rows[0]!.tabIndex).toBe(0);
    expect(rows[1]!.tabIndex).toBe(-1);
  });
});
