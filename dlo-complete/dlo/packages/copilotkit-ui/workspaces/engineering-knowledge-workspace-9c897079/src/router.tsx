// src/router.tsx — the single router factory. Neither ssr.tsx nor client.tsx imports this
// file directly: the framework resolves it itself through the `#tanstack-router-entry`
// virtual module alias (app.config.ts's `tanstackStart()` plugin points that alias at this
// exact file), which is why the factory must be exported under the name it looks up —
// `getRouter` — not an arbitrary one. This keeps the route tree defined exactly once for
// both the server render and the browser hydration.
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
