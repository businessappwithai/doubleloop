// src/core/connection.ts — Relay Connections (Architecture.md "GraphQL conventions (Relay,
// mandated)"; Implementation.md m7). `rows` passed to `buildConnection` is the full, already
// bundle/parent-scoped result set for the connection (e.g. every child of a concept, in sort-key
// order) — not a single DB-fetched page. That is what lets this stay a pure function: `totalCount`
// is `rows.length`, and `first`/`after`/`last`/`before` are applied by locating the cursor's row
// within `rows` and slicing, exactly like the reference `graphql-relay` `connectionFromArray`
// helper, except the cursor is a stable `(sortKey, id)` pair rather than an array offset — the
// fractional-index `sort_key` columns in Database.md are `COLLATE "C"`-ordered specifically so
// this stays deterministic across a hierarchy reorder.
//
// `Buffer` is imported explicitly from "node:buffer" rather than used as an ambient global:
// tsconfig.json's `types: ["vite/client"]` does not include "node", so the global `Buffer`
// declaration from `@types/node` is not in scope.
import { Buffer } from "node:buffer";
import { ValidationError } from "./errors";

/** The 200-row ceiling on `first`/`last` — also the `LIMIT` a repository should query for. */
export const MAX_CONNECTION_PAGE_SIZE = 200;

export interface ConnectionArgs {
  readonly first?: number;
  readonly after?: string;
  readonly last?: number;
  readonly before?: string;
}

/** The minimum shape `buildConnection` needs from a row to place it and cursor it. */
export interface ConnectionRow {
  readonly id: string;
  readonly sortKey: string;
}

export interface DecodedCursor {
  readonly sortKey: string;
  readonly id: string;
}

export interface Edge<T> {
  readonly node: T;
  readonly cursor: string;
}

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor: string | null;
  readonly endCursor: string | null;
}

export interface Connection<T> {
  readonly edges: ReadonlyArray<Edge<T>>;
  readonly pageInfo: PageInfo;
  readonly totalCount: number;
}

/** Encodes `sortKey` and `id` as an opaque cursor: `base64("sortKey|id")`. */
export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(`${sortKey}|${id}`, "utf8").toString("base64");
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes a cursor produced by {@link encodeCursor}. Throws `ValidationError` with message
 * `'cursor.malformed'` on non-base64 input or a missing `|` separator. `id` never contains `|`
 * (it is a UUID), so the split uses the *last* `|` to tolerate a `sortKey` that does.
 */
export function decodeCursor(cursor: string): DecodedCursor {
  if (typeof cursor !== "string" || cursor.length === 0 || !BASE64_PATTERN.test(cursor)) {
    throw new ValidationError("cursor.malformed", { details: { cursor, reason: "not valid base64" } });
  }

  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const separatorIndex = decoded.lastIndexOf("|");
  if (separatorIndex === -1) {
    throw new ValidationError("cursor.malformed", {
      details: { cursor, reason: "missing '|' separator" },
    });
  }

  return {
    sortKey: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1),
  };
}

/**
 * Rejects a `ConnectionArgs` that the Relay pagination algorithm cannot honour: negative `first`
 * or `last`, either above {@link MAX_CONNECTION_PAGE_SIZE}, or `first` and `last` supplied
 * together (their combination is undefined by the Relay Cursor Connections spec).
 */
export function validateConnectionArgs(args: ConnectionArgs): void {
  if (args.first !== undefined) {
    if (args.first < 0) {
      throw new ValidationError("connection.negativeFirst", { details: { first: args.first } });
    }
    if (args.first > MAX_CONNECTION_PAGE_SIZE) {
      throw new ValidationError("connection.firstAboveLimit", {
        details: { first: args.first, limit: MAX_CONNECTION_PAGE_SIZE },
      });
    }
  }
  if (args.last !== undefined) {
    if (args.last < 0) {
      throw new ValidationError("connection.negativeLast", { details: { last: args.last } });
    }
    if (args.last > MAX_CONNECTION_PAGE_SIZE) {
      throw new ValidationError("connection.lastAboveLimit", {
        details: { last: args.last, limit: MAX_CONNECTION_PAGE_SIZE },
      });
    }
  }
  if (args.first !== undefined && args.last !== undefined) {
    throw new ValidationError("connection.firstAndLastTogether", {
      details: { first: args.first, last: args.last },
    });
  }
}

function findCursorIndex(rows: readonly ConnectionRow[], cursor: string): number {
  const { id } = decodeCursor(cursor);
  return rows.findIndex((row) => row.id === id);
}

/**
 * Implements the Relay pagination algorithm over the full row set for a connection: bounds the
 * window by `after`/`before`, then truncates it by `first`/`last`, producing `edges`, `pageInfo`
 * and `totalCount` (the size of `rows` — every row this connection could ever return, ignoring
 * the requested page). A stale `after`/`before` cursor whose row is no longer present (e.g. it
 * was deleted between requests) is treated as not bounding that side, rather than throwing —
 * only a structurally malformed cursor throws (via {@link decodeCursor}).
 */
export function buildConnection<T extends ConnectionRow>(
  rows: readonly T[],
  args: ConnectionArgs,
): Connection<T> {
  validateConnectionArgs(args);

  let windowStart = 0;
  let windowEnd = rows.length;

  if (args.after !== undefined) {
    const index = findCursorIndex(rows, args.after);
    if (index !== -1) {
      windowStart = index + 1;
    }
  }
  if (args.before !== undefined) {
    const index = findCursorIndex(rows, args.before);
    if (index !== -1) {
      windowEnd = index;
    }
  }
  if (windowStart > windowEnd) {
    windowStart = windowEnd;
  }

  let sliceStart = windowStart;
  let sliceEnd = windowEnd;
  let hasNextPage = windowEnd < rows.length;
  let hasPreviousPage = windowStart > 0;

  const windowLength = windowEnd - windowStart;
  if (args.first !== undefined && windowLength > args.first) {
    sliceEnd = windowStart + args.first;
    hasNextPage = true;
  } else if (args.last !== undefined && windowLength > args.last) {
    sliceStart = windowEnd - args.last;
    hasPreviousPage = true;
  }

  const pageRows = rows.slice(sliceStart, sliceEnd);
  const edges: Array<Edge<T>> = pageRows.map((row) => ({
    node: row,
    cursor: encodeCursor(row.sortKey, row.id),
  }));

  return {
    edges,
    pageInfo: {
      hasNextPage,
      hasPreviousPage,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
    totalCount: rows.length,
  };
}
