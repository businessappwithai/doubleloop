// tests/relay-optimistic.test.ts — module m17 (Relay client runtime). Covers withOptimistic,
// insertOptimisticEdge and removeOptimisticEdge against a real Environment/Store (never a mock of
// Relay itself): an optimistic edge is visible in the store synchronously, before the injected
// fetchImpl's deferred response ever settles, is finalized on success and rolled back to the
// prior store state on failure — Relay's own OperationExecutor does the rollback; these tests
// assert its observable effect on the store. A hand-built `ConcreteRequest` stands in for a
// relay-compiler artifact (this module ships before m21 generates real ones); its shape mirrors
// what the compiler actually emits for a trivial mutation, so `commitMutation` accepts it
// unmodified. `fetchImpl` is always injected — no test performs a network call.
import { describe, test, expect, vi } from "vitest";
import { Record as RelayRecord, type ConcreteRequest, type RequestParameters } from "relay-runtime";
import { createRelayEnvironment } from "../src/relay/environment";
import { insertOptimisticEdge, removeOptimisticEdge, withOptimistic } from "../src/relay/optimistic";
import { ValidationError } from "../src/core/errors";
import type { FetchImpl } from "../src/relay/fetch";

const CONNECTION_KEY = "SidebarTree_children";
const HANDLE_KEY = `__${CONNECTION_KEY}_connection`;

const TEST_MUTATION_REQUEST: RequestParameters = {
  cacheID: "test-mutation",
  id: null,
  text: "mutation TestMutation($input: TestMutationInput!) { testMutation(input: $input) { ok } }",
  name: "TestMutation",
  operationKind: "mutation",
  metadata: {},
};

const TEST_MUTATION: ConcreteRequest = {
  fragment: {
    argumentDefinitions: [{ defaultValue: null, kind: "LocalArgument", name: "input" }],
    kind: "Fragment",
    metadata: null,
    name: "TestMutation",
    selections: [
      {
        alias: null,
        args: [{ kind: "Variable", name: "input", variableName: "input" }],
        concreteType: "TestMutationPayload",
        kind: "LinkedField",
        name: "testMutation",
        plural: false,
        selections: [{ alias: null, args: null, kind: "ScalarField", name: "ok", storageKey: null }],
        storageKey: null,
      },
    ],
    type: "Mutation",
    abstractKey: null,
  },
  kind: "Request",
  operation: {
    argumentDefinitions: [{ defaultValue: null, kind: "LocalArgument", name: "input" }],
    kind: "Operation",
    name: "TestMutation",
    selections: [
      {
        alias: null,
        args: [{ kind: "Variable", name: "input", variableName: "input" }],
        concreteType: "TestMutationPayload",
        kind: "LinkedField",
        name: "testMutation",
        plural: false,
        selections: [{ alias: null, args: null, kind: "ScalarField", name: "ok", storageKey: null }],
        storageKey: null,
      },
    ],
  },
  params: TEST_MUTATION_REQUEST,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

function buildEnvironment(fetchImpl: FetchImpl, onError?: (error: unknown) => void) {
  return createRelayEnvironment({ endpoint: "/api/graphql", fetchImpl, ...(onError ? { onError } : {}) });
}

/** Creates a Bundle record with an empty, already-fetched-looking connection at CONNECTION_KEY. */
function seedEmptyConnection(
  environment: ReturnType<typeof buildEnvironment>["environment"],
  parentID: string,
): string {
  const connectionID = `${parentID}:connection`;
  environment.commitUpdate((store) => {
    const parent = store.get(parentID) ?? store.create(parentID, "Bundle");
    const connection = store.create(connectionID, "ConceptConnection");
    connection.setLinkedRecords([], "edges");
    parent.setLinkedRecord(connection, HANDLE_KEY);
  });
  return connectionID;
}

function edgeNodeIDs(
  environment: ReturnType<typeof buildEnvironment>["environment"],
  connectionID: string,
): readonly string[] {
  const connection = environment.getStore().getSource().get(connectionID);
  if (!connection) return [];
  const edgeIDs = RelayRecord.getLinkedRecordIDs(connection, "edges") ?? [];
  return edgeIDs.map((edgeID) => {
    const edge = environment.getStore().getSource().get(edgeID);
    return RelayRecord.getLinkedRecordID(edge!, "node")!;
  });
}

describe("withOptimistic — insertEdge", () => {
  test("inserts the edge synchronously, before the network responds", async () => {
    const deferred = createDeferred<Response>();
    const fetchImpl: FetchImpl = vi.fn().mockReturnValue(deferred.promise);
    const { environment } = buildEnvironment(fetchImpl);
    const connectionID = seedEmptyConnection(environment, "bundle-1");

    const onCompleted = vi.fn();
    const settled = new Promise<void>((resolve) => {
      withOptimistic(environment, {
        mutation: TEST_MUTATION,
        variables: { input: { bundleId: "bundle-1", title: "New Concept" } },
        insertEdge: {
          parentID: "bundle-1",
          connectionKey: CONNECTION_KEY,
          edgeTypeName: "ConceptEdge",
          nodeTypeName: "Concept",
          nodeDataID: "concept-temp-1",
          nodeFields: { title: "New Concept" },
        },
        onCompleted: (response, errors) => {
          onCompleted(response, errors);
          resolve();
        },
        onError: () => resolve(),
      });
    });

    // Visible immediately — the fetch promise has not resolved yet.
    expect(edgeNodeIDs(environment, connectionID)).toEqual(["concept-temp-1"]);
    const node = environment.getStore().getSource().get("concept-temp-1");
    expect(RelayRecord.getValue(node!, "title")).toBe("New Concept");

    deferred.resolve(jsonResponse(200, { data: { testMutation: { ok: true } } }));
    await settled;

    expect(onCompleted).toHaveBeenCalledTimes(1);
    // The optimistic edge survives once the real payload is committed.
    expect(edgeNodeIDs(environment, connectionID)).toEqual(["concept-temp-1"]);
  });

  test("inserts at the start of the connection when position is 'start'", async () => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { testMutation: { ok: true } } }));
    const { environment } = buildEnvironment(fetchImpl);
    const connectionID = seedEmptyConnection(environment, "bundle-2");

    environment.commitUpdate((store) => {
      insertOptimisticEdge(store, {
        parentID: "bundle-2",
        connectionKey: CONNECTION_KEY,
        edgeTypeName: "ConceptEdge",
        nodeTypeName: "Concept",
        nodeDataID: "concept-a",
      });
    });
    environment.commitUpdate((store) => {
      insertOptimisticEdge(store, {
        parentID: "bundle-2",
        connectionKey: CONNECTION_KEY,
        edgeTypeName: "ConceptEdge",
        nodeTypeName: "Concept",
        nodeDataID: "concept-b",
        position: "start",
      });
    });

    expect(edgeNodeIDs(environment, connectionID)).toEqual(["concept-b", "concept-a"]);
  });

  test("rolls back the optimistic edge to the prior store state when the mutation is rejected", async () => {
    const deferred = createDeferred<Response>();
    const fetchImpl: FetchImpl = vi.fn().mockReturnValue(deferred.promise);
    const onError = vi.fn();
    const { environment } = buildEnvironment(fetchImpl);
    const connectionID = seedEmptyConnection(environment, "bundle-3");

    const settled = new Promise<void>((resolve) => {
      withOptimistic(environment, {
        mutation: TEST_MUTATION,
        variables: { input: { bundleId: "bundle-3", title: "New Concept" } },
        insertEdge: {
          parentID: "bundle-3",
          connectionKey: CONNECTION_KEY,
          edgeTypeName: "ConceptEdge",
          nodeTypeName: "Concept",
          nodeDataID: "concept-temp-2",
          nodeFields: { title: "New Concept" },
        },
        onError: (error) => {
          onError(error);
          resolve();
        },
        onCompleted: () => resolve(),
      });
    });

    expect(edgeNodeIDs(environment, connectionID)).toEqual(["concept-temp-2"]);

    deferred.resolve(jsonResponse(500, {}));
    await settled;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    // Reverted to the empty connection committed by seedEmptyConnection.
    expect(edgeNodeIDs(environment, connectionID)).toEqual([]);
  });

  test("rolls back after a GraphQL errors payload, not only after an HTTP failure", async () => {
    const deferred = createDeferred<Response>();
    const fetchImpl: FetchImpl = vi.fn().mockReturnValue(deferred.promise);
    const { environment } = buildEnvironment(fetchImpl);
    const connectionID = seedEmptyConnection(environment, "bundle-4");
    const onError = vi.fn();

    const settled = new Promise<void>((resolve) => {
      withOptimistic(environment, {
        mutation: TEST_MUTATION,
        variables: { input: { bundleId: "bundle-4", title: "New Concept" } },
        insertEdge: {
          parentID: "bundle-4",
          connectionKey: CONNECTION_KEY,
          edgeTypeName: "ConceptEdge",
          nodeTypeName: "Concept",
          nodeDataID: "concept-temp-3",
        },
        onError: (error) => {
          onError(error);
          resolve();
        },
        onCompleted: () => resolve(),
      });
    });

    deferred.resolve(
      jsonResponse(200, {
        errors: [{ message: "stale version", extensions: { code: "conflict" } }],
      }),
    );
    await settled;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(edgeNodeIDs(environment, connectionID)).toEqual([]);
  });
});

describe("withOptimistic — removeEdge", () => {
  test("optimistically removes an edge before the network responds", async () => {
    const deferred = createDeferred<Response>();
    const fetchImpl: FetchImpl = vi.fn().mockReturnValue(deferred.promise);
    const { environment } = buildEnvironment(fetchImpl);
    const connectionID = seedEmptyConnection(environment, "bundle-5");
    environment.commitUpdate((store) => {
      insertOptimisticEdge(store, {
        parentID: "bundle-5",
        connectionKey: CONNECTION_KEY,
        edgeTypeName: "ConceptEdge",
        nodeTypeName: "Concept",
        nodeDataID: "concept-existing",
      });
    });
    expect(edgeNodeIDs(environment, connectionID)).toEqual(["concept-existing"]);

    const settled = new Promise<void>((resolve) => {
      withOptimistic(environment, {
        mutation: TEST_MUTATION,
        variables: { input: { bundleId: "bundle-5", title: "n/a" } },
        removeEdge: { parentID: "bundle-5", connectionKey: CONNECTION_KEY, nodeID: "concept-existing" },
        onCompleted: () => resolve(),
        onError: () => resolve(),
      });
    });

    expect(edgeNodeIDs(environment, connectionID)).toEqual([]);

    deferred.resolve(jsonResponse(200, { data: { testMutation: { ok: true } } }));
    await settled;
  });

  test("restores the removed edge on rollback", async () => {
    const deferred = createDeferred<Response>();
    const fetchImpl: FetchImpl = vi.fn().mockReturnValue(deferred.promise);
    const { environment } = buildEnvironment(fetchImpl);
    const connectionID = seedEmptyConnection(environment, "bundle-6");
    environment.commitUpdate((store) => {
      insertOptimisticEdge(store, {
        parentID: "bundle-6",
        connectionKey: CONNECTION_KEY,
        edgeTypeName: "ConceptEdge",
        nodeTypeName: "Concept",
        nodeDataID: "concept-restorable",
      });
    });

    const settled = new Promise<void>((resolve) => {
      withOptimistic(environment, {
        mutation: TEST_MUTATION,
        variables: { input: { bundleId: "bundle-6", title: "n/a" } },
        removeEdge: { parentID: "bundle-6", connectionKey: CONNECTION_KEY, nodeID: "concept-restorable" },
        onCompleted: () => resolve(),
        onError: () => resolve(),
      });
    });

    deferred.resolve(jsonResponse(500, {}));
    await settled;

    expect(edgeNodeIDs(environment, connectionID)).toEqual(["concept-restorable"]);
  });
});

describe("withOptimistic — no edge edit", () => {
  test("behaves like a plain commitMutation, still invoking the caller's own optimisticUpdater", async () => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { testMutation: { ok: true } } }));
    const { environment } = buildEnvironment(fetchImpl);
    const optimisticUpdater = vi.fn();

    await new Promise<void>((resolve) => {
      withOptimistic(environment, {
        mutation: TEST_MUTATION,
        variables: { input: { bundleId: "bundle-7", title: "x" } },
        optimisticUpdater,
        onCompleted: () => resolve(),
        onError: () => resolve(),
      });
    });

    expect(optimisticUpdater).toHaveBeenCalledTimes(1);
  });

  test("runs the edge edit before the caller's own optimisticUpdater when both are given", async () => {
    const fetchImpl: FetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { testMutation: { ok: true } } }));
    const { environment } = buildEnvironment(fetchImpl);
    const connectionID = seedEmptyConnection(environment, "bundle-8");
    const order: string[] = [];

    await new Promise<void>((resolve) => {
      withOptimistic(environment, {
        mutation: TEST_MUTATION,
        variables: { input: { bundleId: "bundle-8", title: "x" } },
        insertEdge: {
          parentID: "bundle-8",
          connectionKey: CONNECTION_KEY,
          edgeTypeName: "ConceptEdge",
          nodeTypeName: "Concept",
          nodeDataID: "concept-order",
        },
        optimisticUpdater: () => {
          order.push(edgeNodeIDs(environment, connectionID).length === 1 ? "edge-already-inserted" : "edge-missing");
        },
        onCompleted: () => resolve(),
        onError: () => resolve(),
      });
    });

    expect(order).toEqual(["edge-already-inserted"]);
  });
});

describe("insertOptimisticEdge / removeOptimisticEdge — direct calls", () => {
  test("throws ValidationError('relay.optimisticParentMissing') when the parent record doesn't exist", () => {
    const fetchImpl: FetchImpl = vi.fn();
    const { environment } = buildEnvironment(fetchImpl);

    expect(() => {
      environment.commitUpdate((store) => {
        insertOptimisticEdge(store, {
          parentID: "missing-parent",
          connectionKey: CONNECTION_KEY,
          edgeTypeName: "ConceptEdge",
          nodeTypeName: "Concept",
          nodeDataID: "concept-x",
        });
      });
    }).toThrow(ValidationError);
  });

  test("throws ValidationError('relay.optimisticConnectionMissing') when the connection field is absent", () => {
    const fetchImpl: FetchImpl = vi.fn();
    const { environment } = buildEnvironment(fetchImpl);
    environment.commitUpdate((store) => {
      store.create("bundle-9", "Bundle");
    });

    let caught: unknown;
    try {
      environment.commitUpdate((store) => {
        insertOptimisticEdge(store, {
          parentID: "bundle-9",
          connectionKey: CONNECTION_KEY,
          edgeTypeName: "ConceptEdge",
          nodeTypeName: "Concept",
          nodeDataID: "concept-x",
        });
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toBe("relay.optimisticConnectionMissing");
  });

  test("removeOptimisticEdge throws ValidationError when the parent is missing", () => {
    const fetchImpl: FetchImpl = vi.fn();
    const { environment } = buildEnvironment(fetchImpl);

    expect(() => {
      environment.commitUpdate((store) => {
        removeOptimisticEdge(store, { parentID: "missing-parent", connectionKey: CONNECTION_KEY, nodeID: "concept-x" });
      });
    }).toThrow(ValidationError);
  });

  test("removeOptimisticEdge is a no-op when the node id isn't present in the connection", () => {
    const fetchImpl: FetchImpl = vi.fn();
    const { environment } = buildEnvironment(fetchImpl);
    const connectionID = seedEmptyConnection(environment, "bundle-10");

    expect(() => {
      environment.commitUpdate((store) => {
        removeOptimisticEdge(store, { parentID: "bundle-10", connectionKey: CONNECTION_KEY, nodeID: "nonexistent" });
      });
    }).not.toThrow();
    expect(edgeNodeIDs(environment, connectionID)).toEqual([]);
  });
});
