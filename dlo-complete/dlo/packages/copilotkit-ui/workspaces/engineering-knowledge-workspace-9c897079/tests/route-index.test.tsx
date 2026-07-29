// tests/route-index.test.tsx — module m21's `/` route (the bundle picker) plus the shared
// client-bootstrapping helpers this file owns: `getOrCreateClientActor` (the per-browser pseudo
// identity), `createBrowserRelayEnvironment` (wires those actor headers into every GraphQL
// request) and the `useBrowserRelayEnvironment` hook every other client route imports from here.
// `createRelayEnvironment` is mocked so the actor-header wiring can be asserted directly against
// the `fetchImpl` closure without ever making a network call, and the route itself is exercised
// against a `relay-test-utils` mock environment — no network call ever reaches `fetchQuery`.
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
import { createMockEnvironment } from "relay-test-utils";
import type { ReactElement } from "react";
import { flushMicrotasks } from "./helpers/test-utils";

// `Spinner`'s mount effect calls `canvas.getContext('2d')`, which jsdom does not implement (see
// `tests/editor-toolbar.test.tsx`); stubbed to return `null`, the "no context available" path.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
// TanStack Router's scroll restoration calls `window.scrollTo`, unimplemented by jsdom (see
// `tests/route-bundles.test.tsx`); stubbed to its harmless no-op path.
window.scrollTo = (() => {}) as typeof window.scrollTo;

vi.mock("../src/relay/environment", () => ({
  createRelayEnvironment: vi.fn(),
}));

import { createRelayEnvironment } from "../src/relay/environment";
import {
  DEFAULT_WORKSPACE_ID,
  getOrCreateClientActor,
  createBrowserRelayEnvironment,
  useBrowserRelayEnvironment,
  Route as IndexRoute,
} from "../src/routes/index";

const mockCreateRelayEnvironment = createRelayEnvironment as unknown as ReturnType<typeof vi.fn>;

const ACTOR_ID_KEY = "ekw.actorId";
const ACTOR_NAME_KEY = "ekw.actorName";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("getOrCreateClientActor", () => {
  test("creates and persists a new pseudo-actor when no identity is stored", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const actor = getOrCreateClientActor();

    expect(actor).toEqual({
      actorId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      email: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@workspace.local",
      displayName: "Guest AAAA",
    });
    expect(window.localStorage.getItem(ACTOR_ID_KEY)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(window.localStorage.getItem(ACTOR_NAME_KEY)).toBe("Guest AAAA");
  });

  test("returns the existing identity without generating a new id when both keys are present", () => {
    window.localStorage.setItem(ACTOR_ID_KEY, "existing-id");
    window.localStorage.setItem(ACTOR_NAME_KEY, "Existing Name");
    const randomUUID = vi.spyOn(crypto, "randomUUID");

    const actor = getOrCreateClientActor();

    expect(actor).toEqual({
      actorId: "existing-id",
      email: "existing-id@workspace.local",
      displayName: "Existing Name",
    });
    expect(randomUUID).not.toHaveBeenCalled();
  });

  test("regenerates when only the id half of the stored identity is present", () => {
    window.localStorage.setItem(ACTOR_ID_KEY, "half-stored-id");
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-2222-3333-4444-555555555555");

    const actor = getOrCreateClientActor();

    expect(actor.actorId).toBe("11111111-2222-3333-4444-555555555555");
    expect(window.localStorage.getItem(ACTOR_NAME_KEY)).toBe("Guest 1111");
  });

  test("regenerates when only the name half of the stored identity is present", () => {
    window.localStorage.setItem(ACTOR_NAME_KEY, "Orphaned Name");
    vi.spyOn(crypto, "randomUUID").mockReturnValue("66666666-7777-8888-9999-000000000000");

    const actor = getOrCreateClientActor();

    expect(actor.actorId).toBe("66666666-7777-8888-9999-000000000000");
    expect(window.localStorage.getItem(ACTOR_ID_KEY)).toBe("66666666-7777-8888-9999-000000000000");
  });
});

describe("createBrowserRelayEnvironment", () => {
  test("builds the environment against the GraphQL endpoint and injects the three actor headers", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("77777777-8888-9999-aaaa-bbbbbbbbbbbb");
    const fakeEnvironment = createMockEnvironment();
    mockCreateRelayEnvironment.mockReturnValue({
      environment: fakeEnvironment,
      store: fakeEnvironment.getStore(),
      source: fakeEnvironment.getStore().getSource(),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const environment = createBrowserRelayEnvironment();

    expect(environment).toBe(fakeEnvironment);
    expect(mockCreateRelayEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "/api/graphql" }),
    );
    const { fetchImpl } = mockCreateRelayEnvironment.mock.calls[0]?.[0] as {
      fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    };

    await fetchImpl("/api/graphql", { method: "POST", headers: { "content-type": "application/json" } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, calledInit] = fetchSpy.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const headers = new Headers(calledInit.headers);
    expect(headers.get("x-actor-id")).toBe("77777777-8888-9999-aaaa-bbbbbbbbbbbb");
    expect(headers.get("x-actor-email")).toBe("77777777-8888-9999-aaaa-bbbbbbbbbbbb@workspace.local");
    expect(headers.get("x-actor-display-name")).toBe("Guest 7777");
    expect(headers.get("content-type")).toBe("application/json");
  });
});

describe("useBrowserRelayEnvironment", () => {
  test("is null until mount, then resolves to the constructed browser environment", async () => {
    const fakeEnvironment = createMockEnvironment();
    mockCreateRelayEnvironment.mockReturnValue({
      environment: fakeEnvironment,
      store: fakeEnvironment.getStore(),
      source: fakeEnvironment.getStore().getSource(),
    });

    const { result } = renderHook(() => useBrowserRelayEnvironment());

    await act(async () => {
      await flushMicrotasks();
    });

    expect(result.current).toBe(fakeEnvironment);
  });
});

describe("HomePage (index route)", () => {
  async function renderIndexRoute(environment: ReturnType<typeof createMockEnvironment>): Promise<void> {
    mockCreateRelayEnvironment.mockReturnValue({
      environment,
      store: environment.getStore(),
      source: environment.getStore().getSource(),
    });
    const rootRoute = createRootRoute({ component: (): ReactElement => <Outlet /> });
    IndexRoute.update({ id: "/", path: "/", getParentRoute: () => rootRoute });
    const routeTree = rootRoute.addChildren([IndexRoute]);
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
    await act(async () => {
      render(<RouterProvider router={router} />);
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }

  async function resolveBundles(environment: ReturnType<typeof createMockEnvironment>, payload: unknown): Promise<void> {
    await act(async () => {
      environment.mock.resolveMostRecentOperation(payload);
      await flushMicrotasks();
    });
  }

  test("shows a loading indicator while the bundle list query is in flight", async () => {
    const environment = createMockEnvironment();
    await renderIndexRoute(environment);
    expect(screen.getByText("Loading bundles…")).toBeInTheDocument();
    expect(environment.mock.getMostRecentOperation().request.variables).toEqual({
      workspaceId: DEFAULT_WORKSPACE_ID,
      first: 50,
    });
  });

  test("renders an error banner when the bundle list query rejects", async () => {
    const environment = createMockEnvironment();
    await renderIndexRoute(environment);
    await act(async () => {
      environment.mock.rejectMostRecentOperation(new Error("bundles backend unavailable"));
      await flushMicrotasks();
    });
    expect(screen.getByText("Couldn't load bundles")).toBeInTheDocument();
    expect(screen.getByText("bundles backend unavailable")).toBeInTheDocument();
  });

  test("renders the empty state when the workspace has zero bundles", async () => {
    const environment = createMockEnvironment();
    await renderIndexRoute(environment);
    await resolveBundles(environment, { data: { bundles: { edges: [], totalCount: 0 } } });
    expect(screen.getByText("No knowledge bundles yet")).toBeInTheDocument();
  });

  test("renders each bundle with a singular/plural concept count and a link to it", async () => {
    const environment = createMockEnvironment();
    await renderIndexRoute(environment);
    await resolveBundles(environment, {
      data: {
        bundles: {
          totalCount: 2,
          edges: [
            {
              node: {
                id: "bundle-1",
                slug: "runbooks",
                title: "Runbooks",
                description: "Deployment runbooks",
                conceptCount: 1,
                defaultTrust: "UNVERIFIED",
              },
            },
            {
              node: {
                id: "bundle-2",
                slug: "onboarding",
                title: "Onboarding",
                description: "",
                conceptCount: 3,
                defaultTrust: "HUMAN_REVIEWED",
              },
            },
          ],
        },
      },
    });

    expect(screen.getByRole("link", { name: /Runbooks/ })).toHaveAttribute("href", "/bundles/bundle-1");
    expect(screen.getByText("Deployment runbooks · 1 concept")).toBeInTheDocument();
    expect(screen.getByText("No description. · 3 concepts")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Onboarding/ })).toHaveAttribute("href", "/bundles/bundle-2");
  });
});
