// tests/search-panel.test.tsx — module m21's `SearchPanel`. Covers the debounced search input
// (one query per burst via an injected `SearchTimer`, never one per keystroke), empty/no-results
// states, highlighted-snippet rendering, `onSelectHit`, and that a stale response arriving after
// a newer request was already issued is discarded. Entirely against `relay-test-utils`' mock
// environment — no network call ever reaches `fetchQuery`.
import { describe, test, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { createMockEnvironment } from "relay-test-utils";
import { SearchPanel, renderHighlightedSnippet, type SearchTimer, type SearchTimerHandle } from "../src/features/search/SearchPanel";
import { flushMicrotasks } from "./helpers/test-utils";

// `Spinner`'s mount effect calls `canvas.getContext('2d')`, which jsdom does not implement (see
// `tests/editor-toolbar.test.tsx`); stubbed to return `null`, the "no context available" path
// `Spinner` already handles.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

/** A manually-driven `SearchTimer`: `fire()` runs the most recently scheduled callback, exactly
 * once, mirroring what a real debounce timer does after `debounceMs` elapses. */
function createManualTimer(): SearchTimer & { pendingCount: () => number; fireLatest: () => void } {
  const pending = new Map<SearchTimerHandle, () => void>();
  let nextHandle = 1;
  return {
    setTimeout: (handler) => {
      const handle = nextHandle++ as unknown as SearchTimerHandle;
      pending.set(handle, handler);
      return handle;
    },
    clearTimeout: (handle) => {
      pending.delete(handle);
    },
    pendingCount: () => pending.size,
    fireLatest: () => {
      const entries = [...pending.entries()];
      const last = entries.at(-1);
      if (!last) {
        throw new Error("fireLatest: no pending timer");
      }
      pending.delete(last[0]);
      last[1]();
    },
  };
}

function searchHit(id: string, title: string, path: string, snippet: string, rank = 1) {
  return { id, title, path, rank, snippet };
}

function searchPayload(hits: ReturnType<typeof searchHit>[]) {
  return {
    data: {
      search: {
        edges: hits.map((node) => ({ node })),
        totalCount: hits.length,
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

describe("renderHighlightedSnippet", () => {
  test("splits plain and **bold**-marked spans", () => {
    const pieces = renderHighlightedSnippet("before **match** after");
    expect(pieces).toHaveLength(3);
  });

  test("returns a single plain span for text with no markers", () => {
    const pieces = renderHighlightedSnippet("no markers here");
    expect(pieces).toHaveLength(1);
  });

  test("handles a snippet made entirely of one marked span", () => {
    const pieces = renderHighlightedSnippet("**all bold**");
    expect(pieces).toHaveLength(1);
  });
});

describe("SearchPanel", () => {
  test("renders the empty state before any input", () => {
    const environment = createMockEnvironment();
    render(<SearchPanel environment={environment} bundleId="bundle-1" timer={createManualTimer()} />);
    expect(screen.getByText("Search this bundle")).toBeInTheDocument();
  });

  test("clearing the query returns to the empty state and cancels a pending debounce without a query", () => {
    const environment = createMockEnvironment();
    const timer = createManualTimer();
    render(<SearchPanel environment={environment} bundleId="bundle-1" timer={timer} />);

    const input = screen.getByRole("textbox", { name: "Search" });
    fireEvent.change(input, { target: { value: "alpha" } });
    expect(timer.pendingCount()).toBe(1);

    fireEvent.change(input, { target: { value: "   " } });
    expect(timer.pendingCount()).toBe(0);
    expect(screen.getByText("Search this bundle")).toBeInTheDocument();
  });

  test("a burst of keystrokes issues exactly one query, debounced to the last value", async () => {
    const environment = createMockEnvironment();
    const executeSpy = vi.spyOn(environment, "execute");
    const timer = createManualTimer();
    render(<SearchPanel environment={environment} bundleId="bundle-1" timer={timer} />);

    const input = screen.getByRole("textbox", { name: "Search" });
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "al" } });
    fireEvent.change(input, { target: { value: "alp" } });
    expect(timer.pendingCount()).toBe(1);
    expect(executeSpy).not.toHaveBeenCalled();

    act(() => {
      timer.fireLatest();
    });
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(executeSpy).toHaveBeenCalledTimes(1);

    await resolve(environment, searchPayload([searchHit("c1", "Alpha Concept", "/alpha", "an **alp**ine trail")]));
    expect(screen.getByText("Alpha Concept")).toBeInTheDocument();
  });

  test("renders hits with a highlighted snippet, path, and title", async () => {
    const environment = createMockEnvironment();
    const timer = createManualTimer();
    render(<SearchPanel environment={environment} bundleId="bundle-1" timer={timer} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "alpha" } });
    act(() => timer.fireLatest());
    await resolve(
      environment,
      searchPayload([searchHit("c1", "Alpha Concept", "/docs/alpha", "the **alpha** rollout guide")]),
    );

    expect(screen.getByText("Alpha Concept")).toBeInTheDocument();
    expect(screen.getByText("/docs/alpha")).toBeInTheDocument();
    expect(screen.getByText("alpha", { selector: "strong" })).toBeInTheDocument();
  });

  test("renders a no-results state naming the query when the search returns zero hits", async () => {
    const environment = createMockEnvironment();
    const timer = createManualTimer();
    render(<SearchPanel environment={environment} bundleId="bundle-1" timer={timer} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "nonexistent" } });
    act(() => timer.fireLatest());
    await resolve(environment, searchPayload([]));

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByText('Nothing matched "nonexistent".')).toBeInTheDocument();
  });

  test("renders an error banner when the search fails", async () => {
    const environment = createMockEnvironment();
    const timer = createManualTimer();
    render(<SearchPanel environment={environment} bundleId="bundle-1" timer={timer} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "alpha" } });
    act(() => timer.fireLatest());
    await act(async () => {
      environment.mock.rejectMostRecentOperation(new Error("search backend unavailable"));
      await flushMicrotasks();
    });

    expect(screen.getByText("Search failed")).toBeInTheDocument();
    expect(screen.getByText("search backend unavailable")).toBeInTheDocument();
  });

  test("calls onSelectHit with the clicked hit", async () => {
    const environment = createMockEnvironment();
    const timer = createManualTimer();
    const onSelectHit = vi.fn();
    render(<SearchPanel environment={environment} bundleId="bundle-1" timer={timer} onSelectHit={onSelectHit} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "alpha" } });
    act(() => timer.fireLatest());
    const hit = searchHit("c1", "Alpha Concept", "/docs/alpha", "the **alpha** guide");
    await resolve(environment, searchPayload([hit]));

    await act(async () => {
      screen.getByText("Alpha Concept").click();
    });
    expect(onSelectHit).toHaveBeenCalledWith(hit);
  });

  test("a stale response arriving after a newer request was issued is discarded", async () => {
    const environment = createMockEnvironment();
    const timer = createManualTimer();
    render(<SearchPanel environment={environment} bundleId="bundle-1" timer={timer} />);
    const input = screen.getByRole("textbox", { name: "Search" });

    fireEvent.change(input, { target: { value: "alpha" } });
    act(() => timer.fireLatest());
    expect(environment.mock.getAllOperations()).toHaveLength(1);
    const firstOperation = environment.mock.getMostRecentOperation();

    fireEvent.change(input, { target: { value: "beta" } });
    act(() => timer.fireLatest());
    expect(environment.mock.getAllOperations()).toHaveLength(2);

    await resolve(environment, searchPayload([searchHit("c2", "Beta Concept", "/docs/beta", "the **beta** guide")]));
    expect(screen.getByText("Beta Concept")).toBeInTheDocument();

    // The first (now-stale) request resolving afterward must not clobber the second's result.
    await act(async () => {
      environment.mock.resolve(firstOperation, searchPayload([searchHit("c1", "Alpha Concept", "/docs/alpha", "x")]));
      await flushMicrotasks();
    });
    expect(screen.getByText("Beta Concept")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Concept")).not.toBeInTheDocument();
  });
});
