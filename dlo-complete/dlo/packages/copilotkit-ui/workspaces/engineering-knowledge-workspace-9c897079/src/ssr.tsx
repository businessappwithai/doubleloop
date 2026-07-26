// src/ssr.tsx — server entry point. Named `ssr.tsx` (not the framework's default lookup name
// `server.tsx`), so app.config.ts configures `server.entry: "ssr"` to point the build at it.
// The dev server and the built preview server (`vite preview`) both invoke this module's
// default export as `{ fetch(request) }` — see @tanstack/start-plugin-core's dev/preview
// server plugins. It streams the router's render through defaultStreamHandler; the router
// itself comes from ./router's `getRouter`, resolved through the framework's own
// `#tanstack-router-entry` virtual module alias, not imported here directly.
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

const fetch = createStartHandler(defaultStreamHandler);

export default { fetch };
