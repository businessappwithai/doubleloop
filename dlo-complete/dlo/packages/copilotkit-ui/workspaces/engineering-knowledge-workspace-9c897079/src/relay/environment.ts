// src/relay/environment.ts — builds one Relay `Environment` (Implementation.md m17). Deliberately
// exports only a factory, never a constructed instance: a module-level singleton would leak one
// request's normalized store into another's response on the server (each SSR request needs its
// own `RecordSource`), and would defeat hot-reload in the browser. Both the server route and the
// browser entrypoint call this with their own `fetchImpl`. `gcReleaseBufferSize` bounds how many
// released (no-longer-retained) operations `RelayModernStore` keeps before it actually sweeps —
// without a bound, a long-lived browser tab's store grows for the life of the session.
import { Environment, Network, RecordSource, Store } from "relay-runtime";
import { createFetchFn, type FetchImpl } from "./fetch";

/** Released operations the store retains before a GC sweep actually reclaims them. */
const DEFAULT_GC_RELEASE_BUFFER_SIZE = 10;

export interface CreateRelayEnvironmentDeps {
  readonly endpoint: string;
  readonly fetchImpl: FetchImpl;
  /** Forwarded to `createFetchFn` — invoked with every transport/GraphQL error, never swallows it. */
  readonly onError?: (error: unknown) => void;
  /** `true` for the server-side environment built per request; omitted (browser) defaults to `false`. */
  readonly isServer?: boolean;
  readonly gcReleaseBufferSize?: number;
  /** Defaults to deferring GC to a microtask so it never runs synchronously inside a commit. */
  readonly gcScheduler?: (run: () => void) => void;
}

export interface RelayEnvironmentHandle {
  readonly environment: Environment;
  readonly store: Store;
  readonly source: RecordSource;
}

/**
 * Constructs an independent `RecordSource` + `Store` + `Environment`. Call this once per HTTP
 * request on the server and once per page load in the browser — never memoize the result at
 * module scope; see the module comment above for why.
 */
export function createRelayEnvironment(deps: CreateRelayEnvironmentDeps): RelayEnvironmentHandle {
  const source = new RecordSource();
  const store = new Store(source, {
    gcReleaseBufferSize: deps.gcReleaseBufferSize ?? DEFAULT_GC_RELEASE_BUFFER_SIZE,
    gcScheduler: deps.gcScheduler ?? ((run) => queueMicrotask(run)),
  });
  const network = Network.create(
    createFetchFn({
      endpoint: deps.endpoint,
      fetchImpl: deps.fetchImpl,
      ...(deps.onError ? { onError: deps.onError } : {}),
    }),
  );
  const environment = new Environment({
    network,
    store,
    ...(deps.isServer !== undefined ? { isServer: deps.isServer } : {}),
  });

  return { environment, store, source };
}
