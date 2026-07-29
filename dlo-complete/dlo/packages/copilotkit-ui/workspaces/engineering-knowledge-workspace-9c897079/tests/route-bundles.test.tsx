// tests/route-bundles.test.tsx — module m21's `/bundles/$bundleId` route. Mounted through a
// minimal, isolated TanStack Router tree (a fresh root route, not the real `__root.tsx` shell —
// this route's own composition of `SidebarChrome` + `SidebarTree` is what's under test, not m16's
// application frame) so `Route.useParams()` resolves for real. `useBrowserRelayEnvironment` is
// stubbed to return a `relay-test-utils` mock environment synchronously; no network call ever
// reaches `fetchQuery`.
import { describe, test, expect, vi } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
import { createMockEnvironment } from "relay-test-utils";
import { flushMicrotasks } from "./helpers/test-utils";

// `Spinner`'s mount effect calls `canvas.getContext('2d')`, and TanStack Router's scroll
// restoration calls `window.scrollTo` — neither is implemented by jsdom (see
// `tests/editor-toolbar.test.tsx`); both are stubbed to their harmless no-op path.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
window.scrollTo = (() => {}) as typeof window.scrollTo;

vi.mock("../src/routes/index", () => ({
  useBrowserRelayEnvironment: vi.fn(),
}));

import { useBrowserRelayEnvironment } from "../src/routes/index";
import { Route as BundleRoute } from "../src/routes/bundles.$bundleId";

const mockUseBrowserRelayEnvironment = useBrowserRelayEnvironment as unknown as ReturnType<typeof vi.fn>;

function childEdge(id: string, title: string, childCount = 0) {
  return {
    cursor: `cursor-${id}`,
    node: { id, title, slug: title.toLowerCase(), isIndex: false, childCount },
  };
}

async function renderBundleRoute(
  environment: ReturnType<typeof createMockEnvironment>,
  bundleId: string,
): Promise<void> {
  mockUseBrowserRelayEnvironment.mockReturnValue(environment);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  BundleRoute.update({
    id: "/bundles/$bundleId",
    path: "/bundles/$bundleId",
    getParentRoute: () => rootRoute,
  });
  const routeTree = rootRoute.addChildren([BundleRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/bundles/${bundleId}`] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

async function resolveBundleQuery(
  environment: ReturnType<typeof createMockEnvironment>,
  payload: unknown,
): Promise<void> {
  await act(async () => {
    environment.mock.resolveMostRecentOperation(payload);
    await flushMicrotasks();
  });
}

describe("BundleRoute", () => {
  test("shows a loading indicator while the bundle query is in flight", async () => {
    const environment = createMockEnvironment();
    await renderBundleRoute(environment, "bundle-abc");
    expect(screen.getByText("Loading bundle…")).toBeInTheDocument();
  });

  test("renders an error banner when the bundle query rejects", async () => {
    const environment = createMockEnvironment();
    await renderBundleRoute(environment, "bundle-abc");
    await act(async () => {
      environment.mock.rejectMostRecentOperation(new Error("db unreachable"));
      await flushMicrotasks();
    });
    expect(screen.getByText("Couldn't load this bundle")).toBeInTheDocument();
    expect(screen.getByText("db unreachable")).toBeInTheDocument();
  });

  test("renders 'Bundle not found' when the bundle does not exist", async () => {
    const environment = createMockEnvironment();
    await renderBundleRoute(environment, "bundle-missing");
    await resolveBundleQuery(environment, { data: { bundle: null, rootConcept: null } });
    expect(screen.getByText("Bundle not found")).toBeInTheDocument();
  });

  test("renders the bundle's title, description, and SidebarChrome with a zero-concept SidebarTree", async () => {
    const environment = createMockEnvironment();
    await renderBundleRoute(environment, "bundle-abc");
    await resolveBundleQuery(environment, {
      data: {
        bundle: { id: "bundle-abc", title: "Runbooks", description: "Deployment runbooks" },
        rootConcept: null,
      },
    });

    expect(screen.getAllByText("Runbooks").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Deployment runbooks")).toBeInTheDocument();
    expect(screen.getByText("No concepts yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search Runbooks" })).toHaveAttribute(
      "href",
      "/search?bundle=bundle-abc",
    );
    expect(screen.getByRole("link", { name: "Back to all bundles" })).toHaveAttribute("href", "/");
  });

  test("falls back to 'No description.' when the bundle has none", async () => {
    const environment = createMockEnvironment();
    await renderBundleRoute(environment, "bundle-abc");
    await resolveBundleQuery(environment, {
      data: { bundle: { id: "bundle-abc", title: "Runbooks", description: "" }, rootConcept: null },
    });
    expect(screen.getByText("No description.")).toBeInTheDocument();
  });

  test("hands the root concept id to SidebarTree, which fetches and renders its children", async () => {
    const environment = createMockEnvironment();
    await renderBundleRoute(environment, "bundle-abc");
    await resolveBundleQuery(environment, {
      data: {
        bundle: { id: "bundle-abc", title: "Runbooks", description: "Deployment runbooks" },
        rootConcept: { id: "concept-root", title: "index", childCount: 1 },
      },
    });

    expect(screen.getByText("Select a concept in the tree to open it.")).toBeInTheDocument();

    await act(async () => {
      environment.mock.resolveMostRecentOperation({
        data: {
          node: {
            __typename: "Concept",
            id: "concept-root",
            children: {
              edges: [childEdge("concept-child", "Deploying to Prod", 0)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
      await flushMicrotasks();
    });

    const tree = screen.getByRole("tree", { name: "Concept tree" });
    expect(within(tree).getByText("Deploying to Prod")).toBeInTheDocument();
  });
});
