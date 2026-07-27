// src/relay/fetch.ts — the Relay `FetchFunction` for /api/graphql (Implementation.md m17).
// `fetchImpl` is always injected (never the ambient `fetch`) so both the server and browser
// Relay environments (src/relay/environment.ts) can supply their own transport and so tests never
// touch the network — vitest.setup.ts stubs the global `fetch` to throw specifically to catch a
// stray real call. Three failure shapes are distinguished on purpose, because the UI needs to
// react to each differently: a non-2xx response is a `NetworkError` (the server never ran the
// resolver), an unparsable or structurally invalid body is a `ValidationError('relay.malformedResponse')`
// (the server is broken or misconfigured), and a well-formed `errors` array is a `GraphQLPayloadError`
// that preserves the server's `extensions` verbatim — that is what lets a mutation's
// `ConflictError('concept.staleVersion')` (thrown server-side, converted to `extensions.code:
// "conflict"` by `errors-to-graphql.ts`) reach `onCompleted`/`onError` in the UI with `code`
// intact, instead of being flattened into an opaque "something went wrong".
import type { CacheConfig, FetchFunction, GraphQLResponse, RequestParameters, Variables } from "relay-runtime";
import { AppError, type AppErrorOptions, ValidationError } from "../core/errors";

/** The subset of the `fetch` signature this module depends on — injected, never the global. */
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A tuple type guaranteed to have at least one element, so its head never needs an `undefined` check. */
type NonEmptyArray<T> = readonly [T, ...T[]];

function isNonEmpty<T>(items: readonly T[]): items is NonEmptyArray<T> {
  return items.length > 0;
}

/** A single entry of a GraphQL response's `errors` array, as sent by `errors-to-graphql.ts`. */
export interface RawGraphQLError {
  readonly message: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRawGraphQLError(value: unknown): value is RawGraphQLError {
  if (!isRecord(value) || typeof value.message !== "string") {
    return false;
  }
  return value.extensions === undefined || isRecord(value.extensions);
}

interface ParsedGraphQLBody {
  readonly data?: unknown;
  readonly errors?: readonly RawGraphQLError[];
}

/**
 * Validates that `value` has the minimal shape of a GraphQL response — an object with a `data`
 * key, an `errors` key, or both — and that `errors`, if present, is an array of well-formed
 * entries. Returns `null` for anything else, which the caller turns into
 * `ValidationError('relay.malformedResponse')`.
 */
function parseGraphQLBody(value: unknown): ParsedGraphQLBody | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasData = "data" in value;
  const hasErrors = "errors" in value;
  if (!hasData && !hasErrors) {
    return null;
  }
  if (hasErrors) {
    const rawErrors = value.errors;
    if (!Array.isArray(rawErrors) || !rawErrors.every(isRawGraphQLError)) {
      return null;
    }
    return { data: value.data, errors: rawErrors };
  }
  return { data: value.data };
}

/** A non-2xx HTTP response to a GraphQL POST — the resolver never ran. */
export class NetworkError extends AppError {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus: number, options: AppErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** The nearest HTTP status for a known `AppError` code, used only to shape a `GraphQLPayloadError`. */
const GRAPHQL_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  validation: 400,
  conflict: 409,
  forbidden: 403,
  internal: 500,
};

/**
 * A 2xx response whose GraphQL `errors` array is non-empty. Shaped like the `AppError` the
 * server threw: `code` and `extensions` are read verbatim from the first error's
 * `extensions.code`/`extensions`, so a server-side `ConflictError('concept.staleVersion')`
 * reaches this rejection with `code === "conflict"` and `extensions.code === "conflict"` intact.
 * `errors` retains every entry the server returned, not just the first.
 */
export class GraphQLPayloadError extends AppError {
  readonly code: string;
  readonly httpStatus: number;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly errors: NonEmptyArray<RawGraphQLError>;

  constructor(errors: NonEmptyArray<RawGraphQLError>, operationName: string) {
    const [first] = errors;
    const extensions = Object.freeze({ ...(first.extensions ?? {}) });
    const code = typeof extensions.code === "string" ? extensions.code : "internal";
    super(first.message, { details: { operationName, errorCount: errors.length } });
    this.code = code;
    this.httpStatus = GRAPHQL_ERROR_HTTP_STATUS[code] ?? 500;
    this.extensions = extensions;
    this.errors = errors;
  }
}

export interface CreateFetchFnOptions {
  readonly endpoint: string;
  readonly fetchImpl: FetchImpl;
  /** Invoked with every error before it is rethrown — for logging, never to change the rejection. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Builds the `FetchFunction` a Relay `Network` executes every operation through. `cacheConfig`
 * and `uploadables` are accepted (Relay always passes four arguments) but unused: this app has no
 * client-side response cache and no file uploads.
 */
export function createFetchFn(options: CreateFetchFnOptions): FetchFunction {
  const { endpoint, fetchImpl, onError } = options;

  const fetchGraphQL: FetchFunction = async (
    request: RequestParameters,
    variables: Variables,
    _cacheConfig: CacheConfig,
  ): Promise<GraphQLResponse> => {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: request.text, variables, operationName: request.name }),
      });

      if (!response.ok) {
        throw new NetworkError(
          "relay.httpError",
          `GraphQL request "${request.name}" failed with HTTP ${response.status}`,
          response.status,
          {
            details: {
              operationName: request.name,
              status: response.status,
              statusText: response.statusText,
            },
          },
        );
      }

      const rawBody = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch (cause) {
        throw new ValidationError("relay.malformedResponse", {
          details: { operationName: request.name, reason: "response body is not valid JSON" },
          cause,
        });
      }

      const parsedBody = parseGraphQLBody(json);
      if (parsedBody === null) {
        throw new ValidationError("relay.malformedResponse", {
          details: {
            operationName: request.name,
            reason: "response body has neither 'data' nor a well-formed 'errors' array",
          },
        });
      }

      if (parsedBody.errors !== undefined && isNonEmpty(parsedBody.errors)) {
        throw new GraphQLPayloadError(parsedBody.errors, request.name);
      }

      return json as GraphQLResponse;
    } catch (error) {
      onError?.(error);
      throw error;
    }
  };

  return fetchGraphQL;
}
