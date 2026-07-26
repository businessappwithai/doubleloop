// src/client.tsx — browser hydration entry point. Vite's client build targets this file.
// `StartClient` takes no props: it hydrates by calling `getRouter()` from `./router` itself
// (via the framework's `#tanstack-router-entry` virtual module alias), the same router
// factory ssr.tsx uses to serve the request, so the tree is defined exactly once.
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
