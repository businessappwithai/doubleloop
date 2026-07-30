// src/ssr.tsx — server entry point. Named `ssr.tsx` (not the framework's default lookup name
// `server.tsx`), so app.config.ts configures `server.entry: "ssr"` to point the build at it.
// The dev server and the built preview server (`vite preview`) both invoke this module's
// default export as `{ fetch(request) }` — see @tanstack/start-plugin-core's dev/preview
// server plugins. It streams the router's render through defaultStreamHandler; the router
// itself comes from ./router's `getRouter`, resolved through the framework's own
// `#tanstack-router-entry` virtual module alias, not imported here directly.
//
// This entry is ALSO where `/api/graphql` is mounted, because nothing else was: the handlers in
// `src/routes/api/graphql.ts` are plain `GET`/`POST` exports (that release ships no
// `createServerFileRoute` — see its header), so file-based routing never registered them and
// every GraphQL POST fell through to the router, rendered the SPA shell and returned 404. The
// dispatch logic itself lives in `src/server/api-router.ts` so it stays testable — importing THIS
// module under vitest is impossible, since `createStartHandler` resolves the framework's
// `#tanstack-router-entry` virtual module at module scope.
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createApiDispatcher } from "./server/api-router";
import { GET as graphqlGET, POST as graphqlPOST } from "./routes/api/graphql";

const dispatchApiRoute = createApiDispatcher({
  "/api/graphql": { GET: () => graphqlGET(), POST: (request) => graphqlPOST(request) },
});

const startHandler = createStartHandler(defaultStreamHandler);

const fetch = async (request: Request, ...rest: unknown[]): Promise<Response> => {
  const apiResponse = await dispatchApiRoute(request);
  if (apiResponse) {
    return apiResponse;
  }
  return (startHandler as unknown as (req: Request, ...args: unknown[]) => Promise<Response>)(
    request,
    ...rest,
  );
};

export default { fetch };
