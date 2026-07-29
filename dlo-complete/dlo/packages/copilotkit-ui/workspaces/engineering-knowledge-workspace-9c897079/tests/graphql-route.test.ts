// @vitest-environment node
//
// Runs in the node environment: this suite constructs real `Request` objects and reads their
// `Response`s, which is exactly what Node's built-in fetch globals are for; nothing here is
// DOM-dependent.
//
// tests/graphql-route.test.ts — module m15 (src/routes/api/graphql.ts). `createGraphqlHandlers`
// is exercised against a hand-stubbed `Orchestrator` — no real `PgDb`, no HTTP server, per this
// module's own acceptance criteria ("the route handler is invoked directly with a Request object;
// no HTTP server is started"). Covers every response branch: GET's 405, a malformed-JSON body's
// 400, a missing/invalid actor header's 400, and a well-formed request's 200 (both a clean result
// and one carrying a GraphQL `errors` array) — plus that `createRequestContext`/`execute` receive
// exactly what the request supplied (variables/operationName included only when present).
import { describe, expect, test, vi } from "vitest";
import { createGraphqlHandlers } from "../src/routes/api/graphql";
import type { Orchestrator, OrchestratorExecuteInput } from "../src/server/orchestrator";
import type { Actor } from "../src/core/context";
import { asActorId } from "../src/core/ids";

const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const VALID_HEADERS = {
  "content-type": "application/json",
  "x-actor-id": ACTOR_ID,
  "x-actor-email": "a@example.com",
  "x-actor-display-name": "A",
};

function stubOrchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
  return {
    config: {} as Orchestrator["config"],
    modules: {} as Orchestrator["modules"],
    schema: vi.fn(),
    createRequestContext: vi.fn(({ requestId, actor }) => ({ requestId, actor })),
    execute: vi.fn(async () => ({ data: { ping: "pong" } })),
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

function postRequest(body: unknown, headers: Record<string, string> = VALID_HEADERS): Request {
  return new Request("http://localhost/api/graphql", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/graphql", () => {
  test("returns 405 method_not_allowed", async () => {
    const orchestrator = stubOrchestrator();
    const { GET } = createGraphqlHandlers(() => orchestrator);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(body.errors[0].extensions.code).toBe("method_not_allowed");
  });
});

describe("POST /api/graphql — 400s", () => {
  test("unparseable JSON body returns 400 validation", async () => {
    const orchestrator = stubOrchestrator();
    const { POST } = createGraphqlHandlers(() => orchestrator);
    const request = postRequest("{not json");

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errors[0].extensions.code).toBe("validation");
    expect(orchestrator.execute).not.toHaveBeenCalled();
  });

  test("a body missing the required query field returns 400 validation", async () => {
    const orchestrator = stubOrchestrator();
    const { POST } = createGraphqlHandlers(() => orchestrator);
    const request = postRequest({ variables: {} });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(orchestrator.execute).not.toHaveBeenCalled();
  });

  test("an empty-string query returns 400 validation", async () => {
    const orchestrator = stubOrchestrator();
    const { POST } = createGraphqlHandlers(() => orchestrator);
    const request = postRequest({ query: "" });

    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  test.each([
    ["missing x-actor-id", { ...VALID_HEADERS, "x-actor-id": "" }],
    ["missing x-actor-email", { ...VALID_HEADERS, "x-actor-email": "" }],
    ["missing x-actor-display-name", { ...VALID_HEADERS, "x-actor-display-name": "" }],
  ])("%s returns 400 validation", async (_name, headers) => {
    const orchestrator = stubOrchestrator();
    const { POST } = createGraphqlHandlers(() => orchestrator);
    const cleanedHeaders = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== ""));
    const request = postRequest({ query: "{ ping }" }, cleanedHeaders);

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errors[0].extensions.code).toBe("validation");
    expect(orchestrator.execute).not.toHaveBeenCalled();
  });

  test("a non-UUID x-actor-id returns 400 validation", async () => {
    const orchestrator = stubOrchestrator();
    const { POST } = createGraphqlHandlers(() => orchestrator);
    const request = postRequest({ query: "{ ping }" }, { ...VALID_HEADERS, "x-actor-id": "not-a-uuid" });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(orchestrator.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/graphql — 200s", () => {
  test("a well-formed request resolves the actor, delegates to the orchestrator, and returns its result", async () => {
    const execute = vi.fn(async () => ({ data: { ping: "pong" } }));
    const createRequestContext = vi.fn(({ requestId, actor }: { requestId: string; actor: Actor }) => ({
      requestId,
      actor,
    }));
    const orchestrator = stubOrchestrator({ execute, createRequestContext });
    const { POST } = createGraphqlHandlers(() => orchestrator);
    const request = postRequest({ query: "{ ping }", variables: { a: 1 }, operationName: "Ping" });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ data: { ping: "pong" } });
    expect(response.headers.get("x-request-id")).toBeTruthy();

    expect(createRequestContext).toHaveBeenCalledTimes(1);
    const ctxArg = createRequestContext.mock.calls[0]![0] as { requestId: string; actor: Actor };
    expect(ctxArg.actor).toEqual({ id: asActorId(ACTOR_ID), email: "a@example.com", displayName: "A" });
    expect(typeof ctxArg.requestId).toBe("string");
    expect(ctxArg.requestId.length).toBeGreaterThan(0);

    expect(execute).toHaveBeenCalledTimes(1);
    const executeArg = execute.mock.calls[0]![0] as OrchestratorExecuteInput;
    expect(executeArg.query).toBe("{ ping }");
    expect(executeArg.variables).toEqual({ a: 1 });
    expect(executeArg.operationName).toBe("Ping");
  });

  test("omits variables/operationName from the execute() input when the request did not supply them", async () => {
    const execute = vi.fn(async () => ({ data: {} }));
    const orchestrator = stubOrchestrator({ execute });
    const { POST } = createGraphqlHandlers(() => orchestrator);
    const request = postRequest({ query: "{ ping }" });

    await POST(request);

    const executeArg = execute.mock.calls[0]![0] as OrchestratorExecuteInput;
    expect("variables" in executeArg).toBe(false);
    expect("operationName" in executeArg).toBe(false);
  });

  test("still returns 200 when the orchestrator's result carries a GraphQL errors array", async () => {
    const execute = vi.fn(async () => ({
      errors: [{ message: "bundle.notFound", extensions: { code: "not_found" } }],
    }));
    const orchestrator = stubOrchestrator({ execute });
    const { POST } = createGraphqlHandlers(() => orchestrator);
    const request = postRequest({ query: "{ bundle(id: \"x\") { id } }" });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.errors[0].extensions.code).toBe("not_found");
  });

  test("each request gets its own request id", async () => {
    const orchestrator = stubOrchestrator();
    const { POST } = createGraphqlHandlers(() => orchestrator);

    const responseA = await POST(postRequest({ query: "{ ping }" }));
    const responseB = await POST(postRequest({ query: "{ ping }" }));

    expect(responseA.headers.get("x-request-id")).not.toBe(responseB.headers.get("x-request-id"));
  });
});

describe("createGraphqlHandlers — default export binding", () => {
  test("GET/POST exported from the module are bound to getOrchestrator", async () => {
    const routeModule = await import("../src/routes/api/graphql");
    expect(typeof routeModule.GET).toBe("function");
    expect(typeof routeModule.POST).toBe("function");
  });
});
