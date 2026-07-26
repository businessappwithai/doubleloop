// src/routes/__root.tsx — the document shell every route renders inside. Loads the Astryx
// theme cascade and the workspace's own global reset before any route content paints, so
// there is no flash of unstyled content on the SSR'd first response.
// m16 (Astryx UI shell) mounts the ThemeProvider and AppFrame here; until then this stays a
// plain document shell.
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import astryxThemeCss from "@astryxdesign/theme-neutral/theme.css?url";
import globalCss from "../styles/global.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content:
          "Engineering Knowledge Workspace — a collaborative, block-based workspace for Open Knowledge Format (OKF) documentation.",
      },
      { title: "Engineering Knowledge Workspace" },
    ],
    links: [
      { rel: "stylesheet", href: astryxThemeCss },
      { rel: "stylesheet", href: globalCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
