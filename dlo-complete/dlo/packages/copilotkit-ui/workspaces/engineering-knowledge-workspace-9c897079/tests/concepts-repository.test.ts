// tests/concepts-repository.test.ts — module m10 (concepts and hierarchy module). Exercises
// `createConceptRepository` against the in-memory `FakeDb` (tests/helpers/fake-ports.ts): no real
// Postgres. Covers the happy path for every method on real returned rows, an unknown id/path,
// `deleted_at IS NULL` filtering, `lastSiblingSortKey` for both a root and a non-root parent and
// the empty-siblings case, a stale-version conflict on `updateTitle`/`setIsIndex`/`softDelete`, and
// asserts every issued SQL string uses only `$n` placeholders (Implementation.md m10 acceptance).
import { describe, test, expect } from "vitest";
import { createFakeDb } from "./helpers/fake-ports";
import { createConceptRepository, type ConceptRow } from "../src/modules/concepts/concept-repository";
import { ConflictError } from "../src/core/errors";

const BUNDLE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const CONCEPT_ID = "30000000-0000-4000-8000-000000000001";
const PARENT_ID = "30000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRow(overrides: Partial<ConceptRow> = {}): ConceptRow {
  return {
    id: CONCEPT_ID,
    bundle_id: BUNDLE_ID,
    parent_id: null,
    slug: "getting-started",
    path: "getting-started",
    title: "Getting Started",
    sort_key: "V",
    depth: 0,
    is_index: false,
    child_count: 0,
    created_by: ACTOR_ID,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

/** Mirrors pg-db.ts's own `assertPositionalSql`: every `$` must be immediately followed by a digit. */
function assertOnlyPositionalPlaceholders(sql: string): void {
  for (let index = sql.indexOf("$"); index !== -1; index = sql.indexOf("$", index + 1)) {
    expect(/^\d/.test(sql.slice(index + 1))).toBe(true);
  }
}

describe("createConceptRepository", () => {
  describe("insert", () => {
    test("returns the inserted row from RETURNING", async () => {
      const db = createFakeDb();
      const row = makeRow();
      db.when("INSERT INTO concepts", { rows: [row], rowCount: 1 });
      const repo = createConceptRepository(db);

      const result = await repo.insert({
        id: row.id,
        bundleId: BUNDLE_ID,
        parentId: null,
        slug: "getting-started",
        path: "getting-started",
        title: "Getting Started",
        sortKey: "V",
        depth: 0,
        isIndex: false,
        createdBy: ACTOR_ID,
        createdAt: NOW,
      });

      expect(result).toEqual(row);
      expect(db.calls).toHaveLength(1);
      expect(db.calls[0]!.params).toEqual([
        row.id,
        BUNDLE_ID,
        null,
        "getting-started",
        "getting-started",
        "Getting Started",
        "V",
        0,
        false,
        ACTOR_ID,
        NOW,
      ]);
    });

    test("uses only $n placeholders, never interpolated values", async () => {
      const db = createFakeDb();
      db.when("INSERT INTO concepts", { rows: [makeRow()], rowCount: 1 });
      const repo = createConceptRepository(db);

      await repo.insert({
        id: CONCEPT_ID,
        bundleId: BUNDLE_ID,
        parentId: PARENT_ID,
        slug: "getting-started",
        path: "parent/getting-started",
        title: "Getting Started",
        sortKey: "V",
        depth: 1,
        isIndex: false,
        createdBy: ACTOR_ID,
        createdAt: NOW,
      });

      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
      expect(db.calls[0]!.sql).not.toContain(BUNDLE_ID);
    });
  });

  describe("findById", () => {
    test("returns the matching live row", async () => {
      const db = createFakeDb();
      const row = makeRow();
      db.when(/FROM concepts WHERE id = \$1 AND bundle_id = \$2/, { rows: [row] });
      const repo = createConceptRepository(db);

      await expect(repo.findById(BUNDLE_ID, CONCEPT_ID)).resolves.toEqual(row);
      expect(db.calls[0]!.params).toEqual([CONCEPT_ID, BUNDLE_ID]);
      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
    });

    test("returns null for an unknown id", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts WHERE id = \$1 AND bundle_id = \$2/, { rows: [] });
      const repo = createConceptRepository(db);

      await expect(repo.findById(BUNDLE_ID, "does-not-exist")).resolves.toBeNull();
    });

    test("filters out soft-deleted concepts via deleted_at IS NULL in the SQL text", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts WHERE id = \$1 AND bundle_id = \$2/, { rows: [] });
      const repo = createConceptRepository(db);

      await repo.findById(BUNDLE_ID, CONCEPT_ID);
      expect(db.calls[0]!.sql).toContain("deleted_at IS NULL");
    });
  });

  describe("findByPath", () => {
    test("returns the matching live row for bundle + path", async () => {
      const db = createFakeDb();
      const row = makeRow();
      db.when(/FROM concepts WHERE bundle_id = \$1 AND path = \$2/, { rows: [row] });
      const repo = createConceptRepository(db);

      await expect(repo.findByPath(BUNDLE_ID, "getting-started")).resolves.toEqual(row);
      expect(db.calls[0]!.params).toEqual([BUNDLE_ID, "getting-started"]);
    });

    test("returns null for an unknown path", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts WHERE bundle_id = \$1 AND path = \$2/, { rows: [] });
      const repo = createConceptRepository(db);

      await expect(repo.findByPath(BUNDLE_ID, "missing/path")).resolves.toBeNull();
    });
  });

  describe("listConnection", () => {
    test("returns an empty connection for a bundle with no concepts", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts\s+WHERE bundle_id = \$1/, { rows: [] });
      const repo = createConceptRepository(db);

      const connection = await repo.listConnection(BUNDLE_ID, {});
      expect(connection.edges).toEqual([]);
      expect(connection.totalCount).toBe(0);
      expect(connection.pageInfo).toEqual({
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      });
    });

    test("returns every live row ordered as the query already sorted them", async () => {
      const db = createFakeDb();
      const rowA = makeRow({ id: "30000000-0000-4000-8000-000000000001", sort_key: "A" });
      const rowB = makeRow({ id: "30000000-0000-4000-8000-000000000002", sort_key: "B" });
      db.when(/FROM concepts\s+WHERE bundle_id = \$1/, { rows: [rowA, rowB] });
      const repo = createConceptRepository(db);

      const connection = await repo.listConnection(BUNDLE_ID, {});
      expect(connection.edges.map((edge) => edge.node.id)).toEqual([rowA.id, rowB.id]);
      expect(connection.totalCount).toBe(2);
      expect(db.calls[0]!.params).toEqual([BUNDLE_ID]);
      expect(db.calls[0]!.sql).toContain('ORDER BY sort_key COLLATE "C", id');
    });

    test("pagination past the end returns no edges and no next page", async () => {
      const db = createFakeDb();
      const rowA = makeRow({ id: "30000000-0000-4000-8000-000000000001" });
      db.when(/FROM concepts\s+WHERE bundle_id = \$1/, { rows: [rowA] });
      const repo = createConceptRepository(db);

      const connection = await repo.listConnection(BUNDLE_ID, { first: 5 });
      expect(connection.pageInfo.hasNextPage).toBe(false);
      expect(connection.edges).toHaveLength(1);

      const secondPage = await repo.listConnection(BUNDLE_ID, {
        first: 5,
        after: connection.pageInfo.endCursor!,
      });
      expect(secondPage.edges).toEqual([]);
      expect(secondPage.pageInfo.hasNextPage).toBe(false);
      expect(secondPage.pageInfo.hasPreviousPage).toBe(true);
    });
  });

  describe("lastSiblingSortKey", () => {
    test("returns the greatest live sibling sort_key under a non-root parent", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2/, {
        rows: [{ sort_key: "z" }],
      });
      const repo = createConceptRepository(db);

      await expect(repo.lastSiblingSortKey(BUNDLE_ID, PARENT_ID)).resolves.toBe("z");
      expect(db.calls[0]!.params).toEqual([BUNDLE_ID, PARENT_ID]);
      expect(db.calls[0]!.sql).toContain("DESC");
      expect(db.calls[0]!.sql).toContain("LIMIT 1");
    });

    test("passes null through for the bundle root", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2/, {
        rows: [{ sort_key: "V" }],
      });
      const repo = createConceptRepository(db);

      await repo.lastSiblingSortKey(BUNDLE_ID, null);
      expect(db.calls[0]!.params).toEqual([BUNDLE_ID, null]);
    });

    test("returns null when there are no siblings", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2/, { rows: [] });
      const repo = createConceptRepository(db);

      await expect(repo.lastSiblingSortKey(BUNDLE_ID, null)).resolves.toBeNull();
    });
  });

  describe("updateTitle", () => {
    test("returns the updated row on a matching id + version", async () => {
      const db = createFakeDb();
      const updated = makeRow({ title: "Renamed", version: 2 });
      db.when(/UPDATE concepts\s+SET title/, { rows: [updated], rowCount: 1 });
      const repo = createConceptRepository(db);

      const result = await repo.updateTitle(BUNDLE_ID, CONCEPT_ID, 1, "Renamed", NOW);
      expect(result).toEqual(updated);
      expect(db.calls[0]!.params).toEqual([CONCEPT_ID, BUNDLE_ID, 1, "Renamed", NOW]);
      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
    });

    test("raises ConflictError('concept.staleVersion') when rowCount is 0", async () => {
      const db = createFakeDb();
      db.when(/UPDATE concepts\s+SET title/, { rows: [], rowCount: 0 });
      const repo = createConceptRepository(db);

      try {
        await repo.updateTitle(BUNDLE_ID, CONCEPT_ID, 1, "Renamed", NOW);
        throw new Error("expected updateTitle to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toBe("concept.staleVersion");
        expect((err as ConflictError).details).toEqual({ id: CONCEPT_ID, expectedVersion: 1 });
      }
    });

    test("raises ConflictError('concept.staleVersion') for an unknown id, identically to a stale version", async () => {
      const db = createFakeDb();
      db.when(/UPDATE concepts\s+SET title/, { rows: [], rowCount: 0 });
      const repo = createConceptRepository(db);

      await expect(repo.updateTitle(BUNDLE_ID, "does-not-exist", 1, "Renamed", NOW)).rejects.toThrow(
        ConflictError,
      );
    });
  });

  describe("setIsIndex", () => {
    test("returns the updated row on a matching id + version", async () => {
      const db = createFakeDb();
      const updated = makeRow({ is_index: true, version: 2 });
      db.when(/UPDATE concepts\s+SET is_index/, { rows: [updated], rowCount: 1 });
      const repo = createConceptRepository(db);

      const result = await repo.setIsIndex(BUNDLE_ID, CONCEPT_ID, 1, true, NOW);
      expect(result).toEqual(updated);
      expect(db.calls[0]!.params).toEqual([CONCEPT_ID, BUNDLE_ID, 1, true, NOW]);
    });

    test("raises ConflictError('concept.staleVersion') when rowCount is 0", async () => {
      const db = createFakeDb();
      db.when(/UPDATE concepts\s+SET is_index/, { rows: [], rowCount: 0 });
      const repo = createConceptRepository(db);

      await expect(repo.setIsIndex(BUNDLE_ID, CONCEPT_ID, 1, true, NOW)).rejects.toThrow(ConflictError);
    });
  });

  describe("softDelete", () => {
    test("returns the archived row on a matching id + version", async () => {
      const db = createFakeDb();
      const archived = makeRow({ deleted_at: NOW, version: 2 });
      db.when(/UPDATE concepts\s+SET deleted_at/, { rows: [archived], rowCount: 1 });
      const repo = createConceptRepository(db);

      const result = await repo.softDelete(BUNDLE_ID, CONCEPT_ID, 1, NOW);
      expect(result).toEqual(archived);
      expect(db.calls[0]!.params).toEqual([CONCEPT_ID, BUNDLE_ID, 1, NOW]);
      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
    });

    test("raises ConflictError('concept.staleVersion') when rowCount is 0", async () => {
      const db = createFakeDb();
      db.when(/UPDATE concepts\s+SET deleted_at/, { rows: [], rowCount: 0 });
      const repo = createConceptRepository(db);

      try {
        await repo.softDelete(BUNDLE_ID, CONCEPT_ID, 1, NOW);
        throw new Error("expected softDelete to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toBe("concept.staleVersion");
      }
    });
  });
});
