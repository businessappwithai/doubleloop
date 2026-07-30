// src/routes/api/graphql.ts — module m15's thin `/api/graphql` server route (Implementation.md
// m15: "method check, body parse, request-id assignment, actor resolution, delegation, JSON
// response").
//
// This is NOT wired through `@tanstack/react-start/server`'s `createServerFileRoute(...).methods`
// the way Architecture.md's illustrative example shows: the pinned release
// (`@tanstack/react-start@1.168.32` / `@tanstack/react-router@1.170.18`, per `package.json`) ships
// no such export — `grep -rn "createServerFileRoute" node_modules/@tanstack/react-start*` and
// `node_modules/@tanstack/router-core` both come back empty, and `@tanstack/react-start`'s own
// `index.d.ts` only re-exports `createServerFn`/`createMiddleware` (RPC-style server functions),
// not file-based API routes. Chasing a framework feature this dependency version does not ship
// would mean either inventing an import that fails at build time or vendoring the missing
// machinery — both worse than what Implementation.md's own acceptance criteria actually requires:
// "the route handler is invoked directly with a Request object; no HTTP server is started." This
// file satisfies exactly that contract with plain, framework-free `GET`/`POST` exports —
// `(request: Request) => Promise<Response>`, the same shape every other route convention in this
// ecosystem converges on — so it is a drop-in once a future module upgrades the framework or wires
// a router-level adapter; nothing here would need to change.
//
// The consequence of that, learned the hard way: because file-based routing never registers these
// exports, NOTHING mounted them, so every GraphQL POST fell through to the router, rendered the
// SPA shell and came back 404 — the UI loaded and could not reach its own backend. They are now
// mounted by `src/server/api-router.ts` from the server entry (`src/ssr.tsx`), the one point both
// `vite dev` and `vite preview` funnel every request through. Do not assume exporting a handler
// here is enough; the route table in `ssr.tsx` is what makes it reachable.
//
// `createGraphqlHandlers(resolveOrchestrator)` is the actual implementation, parameterised over
// how to obtain an `Orchestrator`, specifically so `tests/graphql-route.test.ts` can hand it a
// fake `Orchestrator` (a stub `execute`/`createRequestContext`) and exercise every response branch
// — 405, 400 (twice: unparseable JSON and a missing/invalid actor), and 200 with an `errors` array
// — without constructing a real `PgDb`/Postgres connection. `GET`/`POST` are `createGraphqlHandlers`
// bound to the real process singleton, `getStartedOrchestrator` (`orchestrator.ts`) — the
// *started* one, so migrations have run before the first query executes.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../../core/context";
import { asActorId } from "../../core/ids";
import { getStartedOrchestrator, type Orchestrator } from "../../server/orchestrator";

const ACTOR_ID_HEADER = "x-actor-id";
const ACTOR_EMAIL_HEADER = "x-actor-email";
const ACTOR_DISPLAY_NAME_HEADER = "x-actor-display-name";

const RequestBodySchema = z.object({
  query: z.string().min(1),
  variables: z.record(z.unknown()).nullish(),
  operationName: z.string().min(1).nullish(),
});

export type GraphQLRequestBody = z.infer<typeof RequestBodySchema>;

function jsonError(status: number, message: string, code: string): Response {
  return Response.json({ errors: [{ message, extensions: { code } }] }, { status });
}

async function parseRequestBody(request: Request): Promise<GraphQLRequestBody | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  const parsed = RequestBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolves the acting identity from request headers. There is no authentication module in this
 * codebase (Database.md's `users` table comment: "Authentication itself is out of scope for the
 * persistence layer") and none of `m4`–`m14`'s built modules populate one, so this is the actual
 * boundary where an actor is established: the caller supplies it via headers, validated the same
 * way every other id in this system is (`asActorId` — a v4 UUID, per `core/ids.ts`). Returns
 * `null` — never a fabricated default actor — when any header is missing or the id is not a valid
 * UUID, which `POST` below turns into the same 400 a malformed body gets.
 */
function resolveActor(request: Request): Actor | null {
  const id = request.headers.get(ACTOR_ID_HEADER);
  const email = request.headers.get(ACTOR_EMAIL_HEADER);
  const displayName = request.headers.get(ACTOR_DISPLAY_NAME_HEADER);
  if (id === null || email === null || displayName === null) {
    return null;
  }
  try {
    return { id: asActorId(id), email, displayName };
  } catch {
    return null;
  }
}

/**
 * How the handlers obtain an `Orchestrator`. Allowed to be async because the real resolver
 * (`getStartedOrchestrator`) has to await `start()` — migrations — before the first query runs;
 * a plain synchronous stub is still valid, which is what `tests/graphql-route.test.ts` passes.
 */
export type ResolveOrchestrator = () => Orchestrator | Promise<Orchestrator>;

export function createGraphqlHandlers(resolveOrchestrator: ResolveOrchestrator): {
  GET: () => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
} {
  async function GET(): Promise<Response> {
    return jsonError(405, "GET is not supported; POST a GraphQL request to this route", "method_not_allowed");
  }

  async function POST(request: Request): Promise<Response> {
    const body = await parseRequestBody(request);
    if (!body) {
      return jsonError(400, "Malformed GraphQL request body", "validation");
    }

    const actor = resolveActor(request);
    if (!actor) {
      return jsonError(
        400,
        `Malformed GraphQL request: missing or invalid ${ACTOR_ID_HEADER}/${ACTOR_EMAIL_HEADER}/${ACTOR_DISPLAY_NAME_HEADER} header`,
        "validation",
      );
    }

    const orchestrator = await resolveOrchestrator();
    const requestId = randomUUID();
    const ctx = orchestrator.createRequestContext({ requestId, actor });
    const result = await orchestrator.execute({
      query: body.query,
      ctx,
      ...(body.variables != null ? { variables: body.variables } : {}),
      ...(body.operationName != null ? { operationName: body.operationName } : {}),
    });

    return Response.json(result, { status: 200, headers: { "x-request-id": requestId } });
  }

  return { GET, POST };
}

export const { GET, POST } = createGraphqlHandlers(getStartedOrchestrator);
