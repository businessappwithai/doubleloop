// tests/relay-fetch.test.ts — module m17 (Relay client runtime). Covers createFetchFn's three
// distinguished failure shapes (non-2xx NetworkError, malformed-body ValidationError, GraphQL
// `errors` array GraphQLPayloadError with `extensions.code` preserved), the request body it
// posts (query text, variables, operationName), and that `onError` observes every failure before
// it is rethrown. `fetchImpl` is a `vi.fn()` in every test — never the ambient `fetch` — matching
// the module's contract that a stray real network call is never made.
import { describe, test, expect, vi } from "vitest";
import {
  createFetchFn,
  GraphQLPayloadError,
  NetworkError,
  type FetchImpl,
} from "../src/relay/fetch";
import { ValidationError } from "../src/core/errors";
import type { RequestParameters, Variables } from "relay-runtime";

const REQUEST: RequestParameters = {
  cacheID: "test-cache-id",
  id: null,
  text: "mutation TestMutation($input: TestInput!) { testMutation(input: $input) { ok } }",
  name: "TestMutation",
  operationKind: "mutation",
  metadata: {},
};

const VARIABLES: Variables = { input: { bundleId: "bundle-1", title: "New Concept" } };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function rawResponse(status: number, rawBody: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: () => Promise.resolve(rawBody),
  } as Response;
}

describe("createFetchFn", () => {
  test("posts operation text, variables and operationName to the endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { testMutation: { ok: true } } }));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    await fetchGraphQL(REQUEST, VARIABLES, { force: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/graphql");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", accept: "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      query: REQUEST.text,
      variables: VARIABLES,
      operationName: REQUEST.name,
    });
  });

  test("returns the parsed body verbatim on a successful response", async () => {
    const body = { data: { testMutation: { ok: true } } };
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    const result = await fetchGraphQL(REQUEST, VARIABLES, { force: true });

    expect(result).toEqual(body);
  });

  test("rejects with NetworkError on HTTP 500, preserving status and operation name", async () => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { message: "boom" }));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    await expect(fetchGraphQL(REQUEST, VARIABLES, {})).rejects.toThrow(NetworkError);
    try {
      await fetchGraphQL(REQUEST, VARIABLES, {});
      throw new Error("expected fetchGraphQL to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const networkError = err as NetworkError;
      expect(networkError.code).toBe("relay.httpError");
      expect(networkError.httpStatus).toBe(500);
      expect(networkError.details).toEqual({
        operationName: "TestMutation",
        status: 500,
        statusText: "Error",
      });
    }
  });

  test("rejects with NetworkError on HTTP 404", async () => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { message: "not found" }));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    try {
      await fetchGraphQL(REQUEST, VARIABLES, {});
      throw new Error("expected fetchGraphQL to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).httpStatus).toBe(404);
      expect((err as NetworkError).code).toBe("relay.httpError");
    }
  });

  test("rejects with ValidationError('relay.malformedResponse') on a non-JSON body", async () => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(rawResponse(200, "not json at all {{{"));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    try {
      await fetchGraphQL(REQUEST, VARIABLES, {});
      throw new Error("expected fetchGraphQL to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("relay.malformedResponse");
      expect((err as ValidationError).details.operationName).toBe("TestMutation");
      expect((err as ValidationError).cause).toBeInstanceOf(SyntaxError);
    }
  });

  test.each([
    ["a bare scalar", "42"],
    ["a JSON array", "[1,2,3]"],
    ["an object with neither data nor errors", JSON.stringify({ extensions: { code: "internal" } })],
    ["an errors array with a non-object entry", JSON.stringify({ errors: ["boom"] })],
    ["an errors array whose entries lack a message", JSON.stringify({ errors: [{ extensions: {} }] })],
  ])("rejects with ValidationError('relay.malformedResponse') for %s", async (_label, rawBody) => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(rawResponse(200, rawBody));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    await expect(fetchGraphQL(REQUEST, VARIABLES, {})).rejects.toMatchObject({
      constructor: ValidationError,
      message: "relay.malformedResponse",
    });
  });

  test("rejects with GraphQLPayloadError preserving extensions.code for a single error", async () => {
    const body = {
      errors: [
        {
          message: "Concept was modified by someone else",
          extensions: { code: "conflict", conceptId: "concept-1" },
        },
      ],
    };
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    try {
      await fetchGraphQL(REQUEST, VARIABLES, {});
      throw new Error("expected fetchGraphQL to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphQLPayloadError);
      const graphQLError = err as GraphQLPayloadError;
      expect(graphQLError.code).toBe("conflict");
      expect(graphQLError.httpStatus).toBe(409);
      expect(graphQLError.message).toBe("Concept was modified by someone else");
      expect(graphQLError.extensions).toEqual({ code: "conflict", conceptId: "concept-1" });
      expect(graphQLError.errors).toEqual(body.errors);
    }
  });

  test("preserves every entry of a multi-error GraphQL payload, keyed off the first error's extensions", async () => {
    const body = {
      errors: [
        { message: "first failure", extensions: { code: "validation" } },
        { message: "second failure" },
      ],
    };
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    try {
      await fetchGraphQL(REQUEST, VARIABLES, {});
      throw new Error("expected fetchGraphQL to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphQLPayloadError);
      const graphQLError = err as GraphQLPayloadError;
      expect(graphQLError.code).toBe("validation");
      expect(graphQLError.httpStatus).toBe(400);
      expect(graphQLError.errors).toHaveLength(2);
      expect(graphQLError.errors[1]?.message).toBe("second failure");
    }
  });

  test("defaults an error with no recognized extensions.code to 'internal' / 500", async () => {
    const body = { errors: [{ message: "unlabeled failure" }] };
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl });

    try {
      await fetchGraphQL(REQUEST, VARIABLES, {});
      throw new Error("expected fetchGraphQL to reject");
    } catch (err) {
      const graphQLError = err as GraphQLPayloadError;
      expect(graphQLError.code).toBe("internal");
      expect(graphQLError.httpStatus).toBe(500);
    }
  });

  test("invokes onError with the thrown error before rethrowing, for every failure shape", async () => {
    const onError = vi.fn();
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl, onError });

    await expect(fetchGraphQL(REQUEST, VARIABLES, {})).rejects.toBeInstanceOf(NetworkError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(NetworkError);
  });

  test("does not invoke onError when the response succeeds", async () => {
    const onError = vi.fn();
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { testMutation: { ok: true } } }));
    const fetchGraphQL = createFetchFn({ endpoint: "/api/graphql", fetchImpl, onError });

    await fetchGraphQL(REQUEST, VARIABLES, {});

    expect(onError).not.toHaveBeenCalled();
  });
});
