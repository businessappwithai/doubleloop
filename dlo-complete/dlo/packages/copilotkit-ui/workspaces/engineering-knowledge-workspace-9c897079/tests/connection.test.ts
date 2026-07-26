// tests/connection.test.ts — module m7 (Relay conventions). Covers encodeCursor/decodeCursor
// round-tripping and malformed rejection, validateConnectionArgs for every rejected shape, and
// buildConnection's forward/backward pagination algorithm: empty input, exactly-`first`/`last`,
// one-past-the-limit (hasNextPage/hasPreviousPage flips), `after`/`before` bounding, and a stale
// cursor whose row is no longer present.
import { Buffer } from "node:buffer";
import { describe, test, expect } from "vitest";
import {
  MAX_CONNECTION_PAGE_SIZE,
  buildConnection,
  decodeCursor,
  encodeCursor,
  validateConnectionArgs,
  type ConnectionRow,
} from "../src/core/connection";
import { ValidationError } from "../src/core/errors";

function makeRows(count: number): ConnectionRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    sortKey: String(index).padStart(4, "0"),
  }));
}

function cursorOf(row: ConnectionRow): string {
  return encodeCursor(row.sortKey, row.id);
}

describe("encodeCursor/decodeCursor", () => {
  test("round-trips sortKey and id", () => {
    const cursor = encodeCursor("0007", "concept-1");
    expect(decodeCursor(cursor)).toEqual({ sortKey: "0007", id: "concept-1" });
  });

  test("splits on the last '|' so a sortKey containing '|' still round-trips", () => {
    const cursor = encodeCursor("a|b", "concept-1");
    expect(decodeCursor(cursor)).toEqual({ sortKey: "a|b", id: "concept-1" });
  });

  test("rejects a non-base64 cursor", () => {
    expect(() => decodeCursor("not-valid-base64!!!")).toThrow(ValidationError);
    try {
      decodeCursor("not-valid-base64!!!");
      throw new Error("expected decodeCursor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("cursor.malformed");
      expect((err as ValidationError).details).toEqual({
        cursor: "not-valid-base64!!!",
        reason: "not valid base64",
      });
    }
  });

  test("rejects base64 that decodes without a '|' separator", () => {
    const cursor = Buffer.from("no-separator-here", "utf8").toString("base64");
    expect(() => decodeCursor(cursor)).toThrow(ValidationError);
    try {
      decodeCursor(cursor);
      throw new Error("expected decodeCursor to throw");
    } catch (err) {
      expect((err as ValidationError).message).toBe("cursor.malformed");
      expect((err as ValidationError).details).toEqual({ cursor, reason: "missing '|' separator" });
    }
  });

  test("rejects an empty cursor", () => {
    expect(() => decodeCursor("")).toThrow(ValidationError);
  });
});

describe("validateConnectionArgs", () => {
  test("accepts no arguments", () => {
    expect(() => validateConnectionArgs({})).not.toThrow();
  });

  test("accepts first at 0 and at the 200 limit", () => {
    expect(() => validateConnectionArgs({ first: 0 })).not.toThrow();
    expect(() => validateConnectionArgs({ first: MAX_CONNECTION_PAGE_SIZE })).not.toThrow();
  });

  test("accepts last at 0 and at the 200 limit", () => {
    expect(() => validateConnectionArgs({ last: 0 })).not.toThrow();
    expect(() => validateConnectionArgs({ last: MAX_CONNECTION_PAGE_SIZE })).not.toThrow();
  });

  test("rejects a negative first", () => {
    expect(() => validateConnectionArgs({ first: -1 })).toThrow(ValidationError);
    try {
      validateConnectionArgs({ first: -1 });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ValidationError).message).toBe("connection.negativeFirst");
    }
  });

  test("rejects a negative last", () => {
    try {
      validateConnectionArgs({ last: -1 });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ValidationError).message).toBe("connection.negativeLast");
    }
  });

  test("rejects first above the 200 limit", () => {
    try {
      validateConnectionArgs({ first: MAX_CONNECTION_PAGE_SIZE + 1 });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ValidationError).message).toBe("connection.firstAboveLimit");
      expect((err as ValidationError).details).toEqual({
        first: MAX_CONNECTION_PAGE_SIZE + 1,
        limit: MAX_CONNECTION_PAGE_SIZE,
      });
    }
  });

  test("rejects last above the 200 limit", () => {
    try {
      validateConnectionArgs({ last: MAX_CONNECTION_PAGE_SIZE + 1 });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ValidationError).message).toBe("connection.lastAboveLimit");
    }
  });

  test("rejects first together with last", () => {
    try {
      validateConnectionArgs({ first: 5, last: 5 });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ValidationError).message).toBe("connection.firstAndLastTogether");
    }
  });

  test("every ValidationError carries the fixed validation code and 400 status", () => {
    try {
      validateConnectionArgs({ first: -1 });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ValidationError).code).toBe("validation");
      expect((err as ValidationError).httpStatus).toBe(400);
    }
  });
});

describe("buildConnection", () => {
  test("an empty row set has hasNextPage/hasPreviousPage false and null cursors", () => {
    const connection = buildConnection([], {});
    expect(connection.edges).toEqual([]);
    expect(connection.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    });
    expect(connection.totalCount).toBe(0);
  });

  test("exactly `first` rows: no next page", () => {
    const rows = makeRows(5);
    const connection = buildConnection(rows, { first: 5 });
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows);
    expect(connection.pageInfo.hasNextPage).toBe(false);
    expect(connection.pageInfo.hasPreviousPage).toBe(false);
    expect(connection.totalCount).toBe(5);
    expect(connection.pageInfo.startCursor).toBe(cursorOf(rows[0]!));
    expect(connection.pageInfo.endCursor).toBe(cursorOf(rows[4]!));
  });

  test("`first` + 1 rows: hasNextPage is true and only `first` edges are returned", () => {
    const rows = makeRows(6);
    const connection = buildConnection(rows, { first: 5 });
    expect(connection.edges).toHaveLength(5);
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows.slice(0, 5));
    expect(connection.pageInfo.hasNextPage).toBe(true);
    expect(connection.pageInfo.hasPreviousPage).toBe(false);
    expect(connection.totalCount).toBe(6);
  });

  test("forward pagination with `after` bounds the window and reports hasPreviousPage", () => {
    const rows = makeRows(6);
    const connection = buildConnection(rows, { after: cursorOf(rows[1]!), first: 3 });
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows.slice(2, 5));
    expect(connection.pageInfo.hasNextPage).toBe(true);
    expect(connection.pageInfo.hasPreviousPage).toBe(true);
    expect(connection.totalCount).toBe(6);
  });

  test("exactly `last` rows: no previous page", () => {
    const rows = makeRows(5);
    const connection = buildConnection(rows, { last: 5 });
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows);
    expect(connection.pageInfo.hasPreviousPage).toBe(false);
    expect(connection.pageInfo.hasNextPage).toBe(false);
  });

  test("`last` + 1 rows: hasPreviousPage is true and only the trailing `last` edges are returned", () => {
    const rows = makeRows(6);
    const connection = buildConnection(rows, { last: 5 });
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows.slice(1, 6));
    expect(connection.pageInfo.hasPreviousPage).toBe(true);
    expect(connection.pageInfo.hasNextPage).toBe(false);
  });

  test("backward pagination with `before`: rows beyond the boundary set hasNextPage", () => {
    const rows = makeRows(6);
    const connection = buildConnection(rows, { before: cursorOf(rows[5]!), last: 5 });
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows.slice(0, 5));
    expect(connection.pageInfo.hasPreviousPage).toBe(false);
    expect(connection.pageInfo.hasNextPage).toBe(true);
  });

  test("backward pagination with `before` and `last` truncating the window", () => {
    const rows = makeRows(6);
    const connection = buildConnection(rows, { before: cursorOf(rows[5]!), last: 3 });
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows.slice(2, 5));
    expect(connection.pageInfo.hasPreviousPage).toBe(true);
    expect(connection.pageInfo.hasNextPage).toBe(true);
  });

  test("a stale `after` cursor whose row is gone is treated as unbounded on that side", () => {
    const rows = makeRows(4);
    const connection = buildConnection(rows, { after: encodeCursor("9999", "deleted-row") });
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows);
  });

  test("a stale `before` cursor whose row is gone is treated as unbounded on that side", () => {
    const rows = makeRows(4);
    const connection = buildConnection(rows, { before: encodeCursor("9999", "deleted-row") });
    expect(connection.edges.map((edge) => edge.node)).toEqual(rows);
  });

  test("an `after` cursor at or past the `before` cursor yields an empty window", () => {
    const rows = makeRows(6);
    const connection = buildConnection(rows, { after: cursorOf(rows[4]!), before: cursorOf(rows[1]!) });
    expect(connection.edges).toEqual([]);
    expect(connection.totalCount).toBe(6);
  });

  test("rejects first and last together", () => {
    expect(() => buildConnection(makeRows(3), { first: 1, last: 1 })).toThrow(ValidationError);
  });

  test("rejects a negative first", () => {
    expect(() => buildConnection(makeRows(3), { first: -1 })).toThrow(ValidationError);
  });

  test("rejects first above the 200 limit", () => {
    expect(() => buildConnection(makeRows(3), { first: MAX_CONNECTION_PAGE_SIZE + 1 })).toThrow(
      ValidationError,
    );
  });
});
