// src/relay/optimistic.ts — `commitMutation` wrapped with declarative `ConnectionHandler` edge
// edits (Implementation.md m17). Every create/delete mutation in this app (`createConcept`,
// `moveConcept`, …) needs the same two moves against a Relay Connection: insert a client-only
// edge before the server confirms, or remove one. Hand-writing `ConnectionHandler.getConnection`
// + `createEdge` + `insertEdgeAfter` in every `optimisticUpdater` invites the two call sites to
// drift; `withOptimistic` composes them once. Relay itself — not this file — is what applies the
// optimistic update synchronously when the mutation is committed and rolls it back if the
// mutation's network request rejects; this file only builds the `SelectorStoreUpdater` Relay runs.
import {
  ConnectionHandler,
  commitMutation,
  type Disposable,
  type Environment,
  type MutationConfig,
  type MutationParameters,
  type RecordSourceProxy,
  type SelectorStoreUpdater,
  type Variables,
} from "relay-runtime";
import { ValidationError } from "../core/errors";

/** The GraphQL scalar types a client-only optimistic node record can hold. */
export type OptimisticScalar = string | number | boolean | null;

export interface OptimisticEdgeInsertConfig {
  /** Data id of the record that owns the connection field (e.g. a Concept or Bundle). */
  readonly parentID: string;
  /** The `@connection(key: "...")` key the compiled query registered this connection under. */
  readonly connectionKey: string;
  readonly filters?: Variables | null;
  /** GraphQL type name of the edge (e.g. `"ConceptEdge"`). */
  readonly edgeTypeName: string;
  /** GraphQL type name of the node (e.g. `"Concept"`). */
  readonly nodeTypeName: string;
  /** Data id for the new node — a client-generated id until the server confirms. */
  readonly nodeDataID: string;
  readonly nodeFields?: Readonly<Record<string, OptimisticScalar>>;
  readonly cursor?: string | null;
  /** Where to splice the edge into the connection. Defaults to `"end"`. */
  readonly position?: "start" | "end";
}

export interface OptimisticEdgeRemoveConfig {
  readonly parentID: string;
  readonly connectionKey: string;
  readonly filters?: Variables | null;
  readonly nodeID: string;
}

function getRequiredConnection(
  store: RecordSourceProxy,
  parentID: string,
  connectionKey: string,
  filters: Variables | null | undefined,
) {
  const parent = store.get(parentID);
  if (!parent) {
    throw new ValidationError("relay.optimisticParentMissing", { details: { parentID, connectionKey } });
  }
  const connection = ConnectionHandler.getConnection(parent, connectionKey, filters ?? null);
  if (!connection) {
    throw new ValidationError("relay.optimisticConnectionMissing", {
      details: { parentID, connectionKey },
    });
  }
  return connection;
}

/** Inserts a client-only edge into a Relay connection — the optimistic half of a create mutation. */
export function insertOptimisticEdge(store: RecordSourceProxy, config: OptimisticEdgeInsertConfig): void {
  const connection = getRequiredConnection(store, config.parentID, config.connectionKey, config.filters);

  const node = store.get(config.nodeDataID) ?? store.create(config.nodeDataID, config.nodeTypeName);
  for (const [field, value] of Object.entries(config.nodeFields ?? {})) {
    node.setValue(value, field);
  }

  const edge = ConnectionHandler.createEdge(store, connection, node, config.edgeTypeName);
  if (config.cursor !== undefined && config.cursor !== null) {
    edge.setValue(config.cursor, "cursor");
  }

  if (config.position === "start") {
    ConnectionHandler.insertEdgeBefore(connection, edge, config.cursor ?? null);
  } else {
    ConnectionHandler.insertEdgeAfter(connection, edge, config.cursor ?? null);
  }
}

/** Removes a node's edge from a Relay connection — the optimistic half of a delete mutation. */
export function removeOptimisticEdge(store: RecordSourceProxy, config: OptimisticEdgeRemoveConfig): void {
  const connection = getRequiredConnection(store, config.parentID, config.connectionKey, config.filters);
  ConnectionHandler.deleteNode(connection, config.nodeID);
}

export interface WithOptimisticConfig<TOperation extends MutationParameters = MutationParameters>
  extends MutationConfig<TOperation> {
  readonly insertEdge?: OptimisticEdgeInsertConfig;
  readonly removeEdge?: OptimisticEdgeRemoveConfig;
}

/**
 * Wraps `commitMutation` so a call site declares a connection edit instead of hand-writing a
 * `ConnectionHandler` sequence. When neither `insertEdge` nor `removeEdge` is given this composes
 * nothing and behaves exactly like `commitMutation`. When both the config's own `optimisticUpdater`
 * and an edge edit are given, the edge edit runs first, then the caller's updater.
 *
 * The edge edit is applied twice: once as `optimisticUpdater` (visible synchronously, before the
 * network responds) and once as `updater` (applied against the real payload once it lands). Relay
 * discards the optimistic proxy entirely once the real response commits and replaces it with only
 * what the real payload normalizes — for a mutation whose selection doesn't itself return the
 * connection field (the common case here), skipping the second application would make the edge
 * flicker away the instant the server confirms. Running the same edit as `updater` keeps it.
 */
export function withOptimistic<TOperation extends MutationParameters = MutationParameters>(
  environment: Environment,
  config: WithOptimisticConfig<TOperation>,
): Disposable {
  const { insertEdge, removeEdge, optimisticUpdater, updater, ...rest } = config;

  if (!insertEdge && !removeEdge) {
    return commitMutation(environment, { ...rest, optimisticUpdater, updater });
  }

  const applyEdgeEdit = (store: Parameters<SelectorStoreUpdater<TOperation["response"]>>[0]): void => {
    if (insertEdge) {
      insertOptimisticEdge(store, insertEdge);
    }
    if (removeEdge) {
      removeOptimisticEdge(store, removeEdge);
    }
  };

  const composedOptimisticUpdater: SelectorStoreUpdater<TOperation["response"]> = (store, data) => {
    applyEdgeEdit(store);
    optimisticUpdater?.(store, data);
  };

  const composedUpdater: SelectorStoreUpdater<TOperation["response"]> = (store, data) => {
    applyEdgeEdit(store);
    updater?.(store, data);
  };

  return commitMutation(environment, {
    ...rest,
    optimisticUpdater: composedOptimisticUpdater,
    updater: composedUpdater,
  });
}
