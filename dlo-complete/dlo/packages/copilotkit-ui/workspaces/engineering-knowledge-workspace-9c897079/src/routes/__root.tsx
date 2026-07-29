// src/routes/__root.tsx — the document shell every route renders inside. Loads the Astryx
// theme cascade and the workspace's own global reset before any route content paints, so
// there is no flash of unstyled content on the SSR'd first response. Mounts the theme provider
// (src/styles/theme.tsx) and the three-pane AppFrame (src/components/shell) so every route
// renders inside the sidebar/main/inspector layout with dark mode wired up.
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import astryxThemeCss from "@astryxdesign/theme-neutral/theme.css?url";
import globalCss from "../styles/global.css?url";
import { ThemeProvider } from "../styles/theme";
import { AppFrame, SidebarChrome, ThemeToggle, ToolbarShell } from "../components/shell";

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
      // StyleX compiles every Astryx component's styles into one sheet that the
      // astryxStylex() plugin serves at this URL. It is a served path, not an
      // importable module — importing it fails SSR resolution — so it has to be
      // linked. Without it the theme tokens load but no layout or spacing rules
      // do, and the whole app renders unstyled.
      { rel: "stylesheet", href: "/virtual:stylex.css" },
      { rel: "stylesheet", href: globalCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <ThemeProvider>
        <AppFrame sidebar={<SidebarChrome title="Engineering Knowledge Workspace" />}>
          <ToolbarShell actions={<ThemeToggle />} />
          <Outlet />
        </AppFrame>
      </ThemeProvider>
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
