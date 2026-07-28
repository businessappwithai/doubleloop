// tests/relay-environment.test.ts — module m17 (Relay client runtime). Covers
// createRelayEnvironment: the network it builds is wired to the injected fetchImpl/endpoint
// (proved by driving environment.getNetwork().execute() directly, without needing compiled Relay
// artifacts), onError forwarding into the fetch layer, the isServer flag, gc option passthrough,
// and — the module's central invariant — that two factory calls never share a store.
import { describe, test, expect, vi } from "vitest";
import {
  createOperationDescriptor,
  type ConcreteRequest,
  type RequestParameters,
  type Variables,
} from "relay-runtime";
import { createRelayEnvironment, type CreateRelayEnvironmentDeps } from "../src/relay/environment";
import type { FetchImpl } from "../src/relay/fetch";

const TEST_REQUEST: RequestParameters = {
  cacheID: "test-query",
  id: null,
  text: "query TestQuery { testField }",
  name: "TestQuery",
  operationKind: "query",
  metadata: {},
};

const TEST_QUERY: ConcreteRequest = {
  fragment: {
    argumentDefinitions: [],
    kind: "Fragment",
    metadata: null,
    name: "TestQuery",
    selections: [{ alias: null, args: null, kind: "ScalarField", name: "testField", storageKey: null }],
    type: "Query",
    abstractKey: null,
  },
  kind: "Request",
  operation: {
    argumentDefinitions: [],
    kind: "Operation",
    name: "TestQuery",
    selections: [{ alias: null, args: null, kind: "ScalarField", name: "testField", storageKey: null }],
  },
  params: TEST_REQUEST,
};

const NO_VARIABLES: Variables = {};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function buildDeps(overrides: Partial<CreateRelayEnvironmentDeps> = {}): CreateRelayEnvironmentDeps {
  const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { testField: "ok" } }));
  return { endpoint: "/api/graphql", fetchImpl, ...overrides };
}

describe("createRelayEnvironment", () => {
  test("wires the network's execute() through the injected fetchImpl and endpoint", async () => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { testField: "ok" } }));
    const { environment } = createRelayEnvironment({ endpoint: "/api/graphql", fetchImpl });

    const response = await new Promise((resolve, reject) => {
      environment
        .getNetwork()
        .execute(TEST_REQUEST, NO_VARIABLES, {})
        .subscribe({ next: resolve, error: reject });
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("/api/graphql");
    expect(response).toEqual({ data: { testField: "ok" } });
  });

  test("propagates a transport failure to the network observable's error channel", async () => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const { environment } = createRelayEnvironment({ endpoint: "/api/graphql", fetchImpl });

    const error = await new Promise((resolve) => {
      environment
        .getNetwork()
        .execute(TEST_REQUEST, NO_VARIABLES, {})
        .subscribe({ next: () => {}, error: resolve });
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 500");
  });

  test("forwards onError into the underlying fetch layer", async () => {
    const onError = vi.fn();
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const { environment } = createRelayEnvironment({ endpoint: "/api/graphql", fetchImpl, onError });

    await new Promise<void>((resolve) => {
      environment
        .getNetwork()
        .execute(TEST_REQUEST, NO_VARIABLES, {})
        .subscribe({ next: () => {}, error: () => resolve() });
    });

    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("defaults isServer to false", () => {
    const { environment } = createRelayEnvironment(buildDeps());
    expect(environment.isServer()).toBe(false);
  });

  test("sets isServer to true when requested", () => {
    const { environment } = createRelayEnvironment(buildDeps({ isServer: true }));
    expect(environment.isServer()).toBe(true);
  });

  test("two factory calls produce independent environments, stores and sources", () => {
    const first = createRelayEnvironment(buildDeps());
    const second = createRelayEnvironment(buildDeps());

    expect(first.environment).not.toBe(second.environment);
    expect(first.store).not.toBe(second.store);
    expect(first.source).not.toBe(second.source);
  });

  test("writes committed to one store are invisible to an independently created store", () => {
    const first = createRelayEnvironment(buildDeps());
    const second = createRelayEnvironment(buildDeps());

    first.environment.commitUpdate((store) => {
      store.create("concept-1", "Concept").setValue("First store only", "title");
    });

    expect(first.environment.getStore().getSource().get("concept-1")).toBeDefined();
    expect(second.environment.getStore().getSource().get("concept-1")).toBeUndefined();
  });

  test("accepts a custom gcReleaseBufferSize and gcScheduler, and retain/dispose still works", () => {
    const gcScheduler = vi.fn((run: () => void) => run());
    const { environment } = createRelayEnvironment(buildDeps({ gcReleaseBufferSize: 0, gcScheduler }));

    const operation = createOperationDescriptor(TEST_QUERY, {});
    const disposable = environment.retain(operation);

    expect(() => disposable.dispose()).not.toThrow();
  });

  test("accepts the default gcReleaseBufferSize and gcScheduler when neither is supplied", () => {
    const { environment } = createRelayEnvironment(buildDeps());

    const operation = createOperationDescriptor(TEST_QUERY, {});
    const disposable = environment.retain(operation);

    expect(() => disposable.dispose()).not.toThrow();
  });
});
