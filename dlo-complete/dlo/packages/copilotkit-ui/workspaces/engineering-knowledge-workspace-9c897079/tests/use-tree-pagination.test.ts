// tests/use-tree-pagination.test.ts — module m21's `useTreePagination` hook. Exercises expand,
// collapse, `loadMore` pagination and dedup, and error handling for both the first fetch and a
// subsequent page, entirely against `relay-test-utils`' mock environment — no network call ever
// reaches `fetchQuery`.
import { describe, test, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createMockEnvironment } from "relay-test-utils";
import { useTreePagination, EMPTY_NODE_STATE } from "../src/features/sidebar/use-tree-pagination";
import { flushMicrotasks } from "./helpers/test-utils";

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
        children: {
          edges,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

describe("useTreePagination", () => {
  test("getNode returns EMPTY_NODE_STATE for an id that has never been touched", () => {
    const environment = createMockEnvironment();
    const { result } = renderHook(() => useTreePagination(environment));
    expect(result.current.getNode("unknown")).toEqual(EMPTY_NODE_STATE);
  });

  test("toggle expands a collapsed node and fetches its first page", async () => {
    const environment = createMockEnvironment();
    const { result } = renderHook(() => useTreePagination(environment, { pageSize: 10 }));

    act(() => {
      result.current.toggle("root");
    });
    expect(result.current.getNode("root").expanded).toBe(true);
    expect(result.current.getNode("root").loading).toBe(true);

    await act(async () => {
      environment.mock.resolveMostRecentOperation(
        childrenPayload("root", [childEdge("a", "Alpha"), childEdge("b", "Beta")], true, "cursor-b"),
      );
      await flushMicrotasks();
    });

    const node = result.current.getNode("root");
    expect(node.loading).toBe(false);
    expect(node.loaded).toBe(true);
    expect(node.expanded).toBe(true);
    expect(node.children.map((c) => c.id)).toEqual(["a", "b"]);
    expect(node.hasNextPage).toBe(true);
    expect(node.endCursor).toBe("cursor-b");
    expect(node.error).toBeNull();
  });

  test("toggle collapses an expanded node without refetching", async () => {
    const environment = createMockEnvironment();
    // `mock.getAllOperations()` only reports *pending* (unresolved) operations, so it drops back
    // to zero the instant a fetch resolves. Spying on `execute` directly gives the running total
    // of network requests actually issued, which is what "no second fetch" needs to assert.
    const executeSpy = vi.spyOn(environment, "execute");
    const { result } = renderHook(() => useTreePagination(environment));

    act(() => {
      result.current.toggle("root");
    });
    await act(async () => {
      environment.mock.resolveMostRecentOperation(childrenPayload("root", [childEdge("a", "Alpha")], false, null));
      await flushMicrotasks();
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.toggle("root");
    });
    expect(result.current.getNode("root").expanded).toBe(false);
    // Children stay cached — collapsing never discards what was already loaded.
    expect(result.current.getNode("root").children.map((c) => c.id)).toEqual(["a"]);
    expect(executeSpy).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.toggle("root");
    });
    expect(result.current.getNode("root").expanded).toBe(true);
    // Re-expanding an already-loaded node reuses the cache — still no second fetch.
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  test("a node with exactly one child loads and reports it", async () => {
    const environment = createMockEnvironment();
    const { result } = renderHook(() => useTreePagination(environment));

    act(() => {
      result.current.toggle("root");
    });
    await act(async () => {
      environment.mock.resolveMostRecentOperation(childrenPayload("root", [childEdge("only", "Only Child")], false, null));
      await flushMicrotasks();
    });

    const node = result.current.getNode("root");
    expect(node.children).toHaveLength(1);
    expect(node.children[0]?.id).toBe("only");
    expect(node.hasNextPage).toBe(false);
  });

  test("loadMore appends a page and stops once hasNextPage is false", async () => {
    const environment = createMockEnvironment();
    const { result } = renderHook(() => useTreePagination(environment, { pageSize: 2 }));

    act(() => {
      result.current.toggle("root");
    });
    await act(async () => {
      environment.mock.resolveMostRecentOperation(
        childrenPayload("root", [childEdge("a", "Alpha"), childEdge("b", "Beta")], true, "cursor-b"),
      );
      await flushMicrotasks();
    });

    act(() => {
      result.current.loadMore("root");
    });
    expect(result.current.getNode("root").loadingMore).toBe(true);

    await act(async () => {
      environment.mock.resolveMostRecentOperation(childrenPayload("root", [childEdge("c", "Gamma")], false, null));
      await flushMicrotasks();
    });

    const node = result.current.getNode("root");
    expect(node.loadingMore).toBe(false);
    expect(node.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(node.hasNextPage).toBe(false);

    // hasNextPage is now false — a further loadMore must not issue another request.
    const operationsBefore = environment.mock.getAllOperations().length;
    act(() => {
      result.current.loadMore("root");
    });
    expect(environment.mock.getAllOperations()).toHaveLength(operationsBefore);
  });

  test("a duplicate concurrent loadMore issues exactly one request", async () => {
    const environment = createMockEnvironment();
    const { result } = renderHook(() => useTreePagination(environment));

    act(() => {
      result.current.toggle("root");
    });
    await act(async () => {
      environment.mock.resolveMostRecentOperation(childrenPayload("root", [childEdge("a", "Alpha")], true, "cursor-a"));
      await flushMicrotasks();
    });
    const operationsAfterFirstLoad = environment.mock.getAllOperations().length;

    act(() => {
      result.current.loadMore("root");
      result.current.loadMore("root");
    });
    expect(environment.mock.getAllOperations()).toHaveLength(operationsAfterFirstLoad + 1);

    await act(async () => {
      environment.mock.resolveMostRecentOperation(childrenPayload("root", [childEdge("b", "Beta")], false, null));
      await flushMicrotasks();
    });
    // Exactly one page appended, not two.
    expect(result.current.getNode("root").children.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("a loadMore failure preserves already-loaded children and reports the error", async () => {
    const environment = createMockEnvironment();
    const { result } = renderHook(() => useTreePagination(environment));

    act(() => {
      result.current.toggle("root");
    });
    await act(async () => {
      environment.mock.resolveMostRecentOperation(childrenPayload("root", [childEdge("a", "Alpha")], true, "cursor-a"));
      await flushMicrotasks();
    });

    act(() => {
      result.current.loadMore("root");
    });
    await act(async () => {
      environment.mock.rejectMostRecentOperation(new Error("network exploded"));
      await flushMicrotasks();
    });

    const node = result.current.getNode("root");
    expect(node.loadingMore).toBe(false);
    expect(node.error).toBe("network exploded");
    // The page that failed to load never overwrites what was already there.
    expect(node.children.map((c) => c.id)).toEqual(["a"]);
    expect(node.hasNextPage).toBe(true);
    expect(node.endCursor).toBe("cursor-a");
  });

  test("a first-fetch failure reports an error without marking the node loaded", async () => {
    const environment = createMockEnvironment();
    const { result } = renderHook(() => useTreePagination(environment));

    act(() => {
      result.current.toggle("root");
    });
    await act(async () => {
      environment.mock.rejectMostRecentOperation(new Error("boom"));
      await flushMicrotasks();
    });

    const node = result.current.getNode("root");
    expect(node.loading).toBe(false);
    expect(node.loaded).toBe(false);
    expect(node.error).toBe("boom");
    expect(node.expanded).toBe(true);
    expect(node.children).toEqual([]);
  });

  test("a bundle with zero concepts resolves to an empty, loaded, non-erroring root", async () => {
    const environment = createMockEnvironment();
    const { result } = renderHook(() => useTreePagination(environment));

    act(() => {
      result.current.toggle("root");
    });
    await act(async () => {
      environment.mock.resolveMostRecentOperation(childrenPayload("root", [], false, null));
      await flushMicrotasks();
    });

    const node = result.current.getNode("root");
    expect(node.loaded).toBe(true);
    expect(node.children).toEqual([]);
    expect(node.error).toBeNull();
  });
});
