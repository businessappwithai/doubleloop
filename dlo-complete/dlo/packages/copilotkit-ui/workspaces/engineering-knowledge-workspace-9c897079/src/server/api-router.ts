// src/server/api-router.ts — the minimal path/method dispatcher that mounts this app's plain
// `Request -> Response` API handlers onto the server entry (`src/ssr.tsx`).
//
// Why this exists at all: `src/routes/api/graphql.ts` exports bare `GET`/`POST` functions because
// the pinned release (`@tanstack/react-start@1.168.32`) ships no `createServerFileRoute` — see
// that file's own header for the evidence. Nothing was therefore registering them, so every
// GraphQL POST fell through to the router, rendered the SPA shell, and came back 404: the UI
// loaded but could not reach its own backend. `src/ssr.tsx`'s `fetch` is the single point both
// the dev server and `vite preview` funnel every request through, so dispatching there mounts the
// handlers for real under both without depending on a framework feature this version lacks.
//
// Kept in its own module, parameterised over its route table, for one concrete reason: `ssr.tsx`
// calls `createStartHandler` at module scope, which resolves the framework's
// `#tanstack-router-entry` virtual module and so cannot be imported under vitest at all. Every
// branch below would be untestable if it lived there.

/** A mounted handler: the same plain shape `src/routes/api/*.ts` already exports. */
export type ApiHandler = (request: Request) => Promise<Response>;

/** Path → uppercase HTTP method → handler. */
export type ApiRouteTable = Readonly<Record<string, Readonly<Record<string, ApiHandler>>>>;

/** Reads `key` from `record` only when it is an own property — never one inherited from a prototype. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Builds a dispatcher over `routes`.
 *
 * The returned function answers `null` — never a Response — for a path that is not mounted, which
 * is the signal for `ssr.tsx` to fall through to the router so ordinary pages still render. A
 * *mounted* path reached with an unmounted method answers 405 itself rather than falling through:
 * otherwise a wrong verb on `/api/graphql` would quietly render the SPA shell, which is exactly
 * the failure this module was written to end. The 405 body carries the same
 * `{ errors: [{ message, extensions.code }] }` shape every other error in this app uses, so
 * `src/relay/fetch.ts` can read it without a special case.
 *
 * Query strings and hashes are ignored (`new URL(...).pathname`), and methods are matched
 * case-insensitively, because neither distinction is meaningful for routing here.
 */
export function createApiDispatcher(routes: ApiRouteTable): (request: Request) => Promise<Response | null> {
  return async function dispatchApiRoute(request: Request): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    // Own-property lookups only: a bare `routes[pathname]` would resolve `/constructor` and
    // `/toString` to inherited members of `Object.prototype` and answer 405 for them instead of
    // letting those (perfectly ordinary) paths render.
    const handlers = own(routes, pathname);
    if (!handlers) {
      return null;
    }
    const method = request.method.toUpperCase();
    const handler = own(handlers, method);
    if (!handler) {
      return Response.json(
        {
          errors: [
            {
              message: `${method} is not supported by ${pathname}`,
              extensions: { code: "method_not_allowed" },
            },
          ],
        },
        { status: 405 },
      );
    }
    return handler(request);
  };
}
