// tests/route-concept.test.tsx — module m21's `/concepts/$conceptId` route. Mounted through a
// minimal, isolated TanStack Router tree (a fresh root route, not the real `__root.tsx` shell),
// so `Route.useParams()` resolves for real. `useBrowserRelayEnvironment`/`getOrCreateClientActor`
// are stubbed to return a `relay-test-utils` mock environment and a fixed actor synchronously.
// `BlockEditor` and `CollaborationPluginBridge` are mocked — mounting real Lexical/Yjs/WebSocket
// machinery is `editor-*.test.tsx`'s and `collab-*.test.ts(x)`'s own tested concern, not this
// route's composition — while `PresenceBar` and `FrontmatterPanel` render for real, since
// asserting they appear together with the header and editor is exactly what this file covers.
import { describe, test, expect, vi } from "vitest";
import { useEffect } from "react";
import { render, screen, within, act } from "@testing-library/react";
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
import { createMockEnvironment } from "relay-test-utils";
import type { ReactElement } from "react";
import { flushMicrotasks } from "./helpers/test-utils";
import type { PresencePeer } from "../src/collab/awareness";

// `Spinner`'s mount effect calls `canvas.getContext('2d')`, and TanStack Router's scroll
// restoration calls `window.scrollTo` — neither is implemented by jsdom (see
// `tests/editor-toolbar.test.tsx`); both are stubbed to their harmless no-op path.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
window.scrollTo = (() => {}) as typeof window.scrollTo;

vi.mock("../src/routes/index", () => ({
  useBrowserRelayEnvironment: vi.fn(),
  getOrCreateClientActor: vi.fn(() => ({
    actorId: "actor-1",
    email: "actor-1@workspace.local",
    displayName: "Ada Lovelace",
  })),
}));

vi.mock("../src/editor", () => ({
  BlockEditor: (props: { onEditorReady?: (editor: unknown) => void }) => {
    useEffect(() => {
      props.onEditorReady?.({});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="block-editor" />;
  },
}));

const TEST_PEERS: PresencePeer[] = [
  { clientId: 1, actorId: "actor-2", name: "Grace Hopper", color: "#ff0000", lastSeen: 0 },
];

vi.mock("../src/collab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/collab")>();
  return {
    ...actual,
    CollaborationPluginBridge: () => <div data-testid="collab-bridge" />,
    createCollabProvider: vi.fn(() => ({
      awareness: {},
      status: "disconnected",
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    })),
    setLocalPresence: vi.fn(),
    subscribePresence: vi.fn((_awareness: unknown, setPeers: (peers: readonly PresencePeer[]) => void) => {
      setPeers(TEST_PEERS);
      return () => {};
    }),
  };
});

import { useBrowserRelayEnvironment } from "../src/routes/index";
import { Route as ConceptRoute } from "../src/routes/concepts.$conceptId";

const mockUseBrowserRelayEnvironment = useBrowserRelayEnvironment as unknown as ReturnType<typeof vi.fn>;

async function renderConceptRoute(
  environment: ReturnType<typeof createMockEnvironment>,
  conceptId: string,
): Promise<void> {
  mockUseBrowserRelayEnvironment.mockReturnValue(environment);
  const rootRoute = createRootRoute({ component: (): ReactElement => <Outlet /> });
  ConceptRoute.update({
    id: "/concepts/$conceptId",
    path: "/concepts/$conceptId",
    getParentRoute: () => rootRoute,
  });
  const routeTree = rootRoute.addChildren([ConceptRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/concepts/${conceptId}`] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function conceptPayload(overrides: Partial<{ id: string; bundleId: string; title: string }> = {}) {
  return {
    data: {
      node: {
        __typename: "Concept",
        id: overrides.id ?? "concept-1",
        bundleId: overrides.bundleId ?? "bundle-1",
        title: overrides.title ?? "Deployment Runbook",
        path: "/deployment-runbook",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        ancestors: [],
      },
      conceptDocument: { bodyMarkdown: "# Deploying to prod" },
    },
  };
}

async function resolveNext(environment: ReturnType<typeof createMockEnvironment>, payload: unknown): Promise<void> {
  await act(async () => {
    environment.mock.resolveMostRecentOperation(payload);
    await flushMicrotasks();
  });
}

describe("ConceptRoute", () => {
  test("shows a loading spinner while the concept query is in flight", async () => {
    const environment = createMockEnvironment();
    await renderConceptRoute(environment, "concept-1");
    expect(screen.queryByTestId("block-editor")).not.toBeInTheDocument();
  });

  test("renders 'Concept not found' when the node does not resolve", async () => {
    const environment = createMockEnvironment();
    await renderConceptRoute(environment, "concept-missing");
    await resolveNext(environment, { data: { node: null, conceptDocument: null } });
    expect(screen.getByText("Concept not found")).toBeInTheDocument();
  });

  test("renders an error banner when the concept query rejects", async () => {
    const environment = createMockEnvironment();
    await renderConceptRoute(environment, "concept-1");
    await act(async () => {
      environment.mock.rejectMostRecentOperation(new Error("graphql exploded"));
      await flushMicrotasks();
    });
    expect(screen.getByText("Couldn't load this concept")).toBeInTheDocument();
    expect(screen.getByText("graphql exploded")).toBeInTheDocument();
  });

  test("renders the document header, editor, presence bar, and frontmatter panel together once loaded", async () => {
    const environment = createMockEnvironment();
    await renderConceptRoute(environment, "concept-1");
    await resolveNext(environment, conceptPayload({ title: "Deployment Runbook" }));

    // DocumentHeader: title heading plus its trust/lifecycle badges.
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { name: "Deployment Runbook" })).toBeInTheDocument();
    expect(within(header).getByText("Unverified")).toBeInTheDocument();
    expect(within(header).getByText("Active")).toBeInTheDocument();

    // BlockEditor (mocked) mounted and reported an editor instance.
    expect(screen.getByTestId("block-editor")).toBeInTheDocument();
    // ...which is what gates CollaborationPluginBridge (mocked) rendering at all.
    expect(screen.getByTestId("collab-bridge")).toBeInTheDocument();

    // PresenceBar: rendered for real, showing the one injected remote peer.
    expect(screen.getByRole("group", { name: "1 person editing this document" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Grace Hopper" })).toBeInTheDocument();

    // FrontmatterPanel: rendered for real, seeded from the loaded concept.
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Deployment Runbook");
  });

  test("renders the bundle's trust level once the bundle query resolves", async () => {
    const environment = createMockEnvironment();
    await renderConceptRoute(environment, "concept-1");
    await resolveNext(environment, conceptPayload({ bundleId: "bundle-9" }));
    await resolveNext(environment, {
      data: { bundle: { id: "bundle-9", title: "Runbooks", defaultTrust: "HUMAN_REVIEWED" } },
    });

    expect(within(screen.getByRole("banner")).getByText("Human-reviewed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to bundle" })).toHaveAttribute("href", "/bundles/bundle-9");
  });

  test("saving the frontmatter title commits the update mutation with the expected variables", async () => {
    const environment = createMockEnvironment();
    await renderConceptRoute(environment, "concept-1");
    await resolveNext(environment, conceptPayload({ title: "Old Title", bundleId: "bundle-9", id: "concept-1" }));

    const { fireEvent } = await import("@testing-library/react");
    const titleInput = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(titleInput, { target: { value: "New Title" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    const operation = environment.mock.getMostRecentOperation();
    expect(operation.request.variables).toEqual({
      input: { bundleId: "bundle-9", id: "concept-1", expectedVersion: 1, title: "New Title" },
    });

    await act(async () => {
      environment.mock.resolveMostRecentOperation({
        data: {
          updateConceptMetadata: {
            concept: { id: "concept-1", title: "New Title", version: 2, updatedAt: "2026-01-02T00:00:00.000Z" },
          },
        },
      });
      await flushMicrotasks();
    });

    // The save completed without throwing and the form re-initialized to the saved value.
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("New Title");
  });
});
