// tests/route-root.test.tsx — module m16's `__root.tsx`, the document shell every route renders
// inside. `RootDocument` renders a literal `<html><head>…<body>` — that's the real, correct SSR
// shape (Architecture.md), but it also means this route can never be mounted with
// `@testing-library/react`'s `render()`: RTL always appends into a `<div>` under the *existing*
// jsdom document, and React's DOM-nesting validation (rightly) refuses an `<html>` inside a
// `<div>`. `renderToStaticMarkup` sidesteps that: it produces the document string the same way
// SSR does, with no jsdom container involved. The one dynamic behaviour `__root.tsx` wires in —
// `ThemeProvider` stamping `data-theme` on `document.documentElement` — is already covered against
// a real DOM in `tests/theme.test.ts` ("stamps document.documentElement with the resolved theme"),
// so it is not re-asserted here.
import { describe, test, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRouter, createRoute, createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import type { ReactElement } from "react";

// Vite's `?url` suffix resolves to a real built-asset URL in dev/build, but under Vitest's
// transform pipeline it resolves to an empty string — which React then refuses to set as a
// `<link href>` (a bare `href=""` would make the browser re-request the whole page). Both of
// __root.tsx's stylesheet imports use that suffix, so they're stubbed to fixed URLs here.
vi.mock("@astryxdesign/theme-neutral/theme.css?url", () => ({ default: "/astryx-theme.css" }));
vi.mock("../src/styles/global.css?url", () => ({ default: "/global.css" }));

const { Route: RootRoute } = await import("../src/routes/__root");

async function renderRootToString(): Promise<string> {
  const indexRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "/",
    component: (): ReactElement => <div data-testid="child-route-content">child content</div>,
  });
  const routeTree = RootRoute.addChildren([indexRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("root route (__root.tsx)", () => {
  test("declares the workspace title, description, viewport, and theme/global stylesheets in head", () => {
    const head = RootRoute.options.head?.({} as never);
    expect(head?.meta).toEqual(
      expect.arrayContaining([
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        {
          name: "description",
          content:
            "Engineering Knowledge Workspace — a collaborative, block-based workspace for Open Knowledge Format (OKF) documentation.",
        },
        { title: "Engineering Knowledge Workspace" },
      ]),
    );
    expect(head?.links).toHaveLength(2);
    expect(head?.links?.every((link) => link.rel === "stylesheet")).toBe(true);
  });

  test("renders a full HTML document with the theme and global stylesheets linked", async () => {
    const html = await renderRootToString();
    expect(html).toMatch(/^<html lang="en">/);
    expect(html).toContain('<link rel="stylesheet" href="/astryx-theme.css"');
    expect(html).toContain('<link rel="stylesheet" href="/global.css"');
    expect(html).toContain("<body>");
  });

  test("composes AppFrame with the sidebar title, a theme toggle in the toolbar, and the routed child in the main pane", async () => {
    const html = await renderRootToString();
    expect(html).toContain("Engineering Knowledge Workspace");
    expect(html).toMatch(/<nav[^>]*aria-label="Sidebar"/);
    expect(html).toMatch(/<main[^>]*>/);
    expect(html).toContain('data-testid="child-route-content"');
    expect(html).toContain("child content");
  });
});
