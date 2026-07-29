// tests/route-search.test.tsx — module m21's `/search` route. Bundle-scoped: the route reads
// its bundle from the `?bundle=` search param (set by `bundles.$bundleId.tsx`'s "Search this
// bundle" link) rather than a path segment, since `search-schema.graphql`'s `search` field has no
// cross-bundle variant. Landing on `/search` with no `?bundle=` is a real, navigable empty state,
// not an error. Mounted through a minimal, isolated TanStack Router tree so `Route.useSearch()`
// resolves for real; `useBrowserRelayEnvironment` is stubbed to control exactly when the Relay
// environment becomes available. All Relay data comes from `relay-test-utils`' mock environment —
// no network call ever reaches `fetchQuery`.
import { describe, test, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
import { createMockEnvironment } from "relay-test-utils";
import type { ReactElement } from "react";
import { flushMicrotasks } from "./helpers/test-utils";

// `Spinner`'s mount effect calls `canvas.getContext('2d')`, and TanStack Router's scroll
// restoration calls `window.scrollTo` — neither is implemented by jsdom (see
// `tests/route-bundles.test.tsx`); both are stubbed to their harmless no-op path.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
window.scrollTo = (() => {}) as typeof window.scrollTo;

vi.mock("../src/routes/index", () => ({
  useBrowserRelayEnvironment: vi.fn(),
}));

import { useBrowserRelayEnvironment } from "../src/routes/index";
import { Route as SearchRoute } from "../src/routes/search";

const mockUseBrowserRelayEnvironment = useBrowserRelayEnvironment as unknown as ReturnType<typeof vi.fn>;

async function renderSearchRoute(initialEntry: string): Promise<void> {
  const rootRoute = createRootRoute({ component: (): ReactElement => <Outlet /> });
  SearchRoute.update({ id: "/search", path: "/search", getParentRoute: () => rootRoute });
  const routeTree = rootRoute.addChildren([SearchRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initialEntry] }) });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("SearchRoute", () => {
  test("renders an empty state with a link back to bundles when no bundle is selected", async () => {
    mockUseBrowserRelayEnvironment.mockReturnValue(null);
    await renderSearchRoute("/search");

    expect(screen.getByText("No bundle selected")).toBeInTheDocument();
    expect(
      screen.getByText("Open a bundle first, then use its “Search this bundle” link."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse bundles" })).toHaveAttribute("href", "/");
  });

  test("ignores a non-string bundle search param and falls back to the empty state", async () => {
    mockUseBrowserRelayEnvironment.mockReturnValue(null);
    await renderSearchRoute("/search?bundle[]=oops");

    expect(screen.getByText("No bundle selected")).toBeInTheDocument();
  });

  test("shows a spinner while the Relay environment is still initializing", async () => {
    mockUseBrowserRelayEnvironment.mockReturnValue(null);
    await renderSearchRoute("/search?bundle=bundle-1");

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("No bundle selected")).not.toBeInTheDocument();
  });

  test("renders SearchPanel scoped to the bundle id from the search param once the environment is ready", async () => {
    const environment = createMockEnvironment();
    mockUseBrowserRelayEnvironment.mockReturnValue(environment);
    await renderSearchRoute("/search?bundle=bundle-1");

    expect(screen.getByText("Search this bundle")).toBeInTheDocument();
    expect(environment.mock.getAllOperations()).toHaveLength(0);
  });

  test("navigates to the concept page when a search hit is selected", async () => {
    const environment = createMockEnvironment();
    mockUseBrowserRelayEnvironment.mockReturnValue(environment);
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign: assignSpy },
      writable: true,
    });

    vi.useFakeTimers();
    await renderSearchRoute("/search?bundle=bundle-1");

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "alpha" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(environment.mock.getAllOperations()).toHaveLength(1);

    await act(async () => {
      environment.mock.resolveMostRecentOperation({
        data: {
          search: {
            edges: [
              {
                node: {
                  id: "concept with spaces",
                  title: "Alpha Concept",
                  path: "/docs/alpha",
                  rank: 1,
                  snippet: "the **alpha** guide",
                },
              },
            ],
            totalCount: 1,
          },
        },
      });
      await flushMicrotasks();
    });
    vi.useRealTimers();

    await act(async () => {
      screen.getByText("Alpha Concept").click();
    });

    expect(assignSpy).toHaveBeenCalledWith("/concepts/concept%20with%20spaces");
  });
});
