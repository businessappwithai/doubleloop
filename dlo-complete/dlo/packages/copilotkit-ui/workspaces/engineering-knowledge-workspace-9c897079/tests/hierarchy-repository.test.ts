// tests/hierarchy-repository.test.ts — module m10 (concepts and hierarchy module). Exercises
// `createHierarchyRepository` against the in-memory `FakeDb` (tests/helpers/fake-ports.ts): no
// real Postgres. Covers `childrenConnection` pagination (0, 1, exactly-first and first-plus-one
// children — Implementation.md m10 acceptance), `ancestorPath` at depth 1 and depth 5, `siblings`
// excluding the moved node, and `moveSubtree`'s exact statement order — the advisory lock issued
// before any write — plus its stale-version conflict.
import { describe, test, expect } from "vitest";
import { createFakeDb } from "./helpers/fake-ports";
import {
  createHierarchyRepository,
  type HierarchyConceptRow,
} from "../src/modules/hierarchy/hierarchy-repository";
import { ConflictError } from "../src/core/errors";

const BUNDLE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const CONCEPT_ID = "30000000-0000-4000-8000-000000000001";
const PARENT_ID = "30000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRow(overrides: Partial<HierarchyConceptRow> = {}): HierarchyConceptRow {
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

function assertOnlyPositionalPlaceholders(sql: string): void {
  for (let index = sql.indexOf("$"); index !== -1; index = sql.indexOf("$", index + 1)) {
    expect(/^\d/.test(sql.slice(index + 1))).toBe(true);
  }
}

describe("createHierarchyRepository", () => {
  describe("findById", () => {
    test("returns the matching live row", async () => {
      const db = createFakeDb();
      const row = makeRow();
      db.when(/FROM concepts WHERE id = \$1 AND bundle_id = \$2/, { rows: [row] });
      const repo = createHierarchyRepository(db);

      await expect(repo.findById(BUNDLE_ID, CONCEPT_ID)).resolves.toEqual(row);
    });

    test("returns null for an unknown id", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts WHERE id = \$1 AND bundle_id = \$2/, { rows: [] });
      const repo = createHierarchyRepository(db);

      await expect(repo.findById(BUNDLE_ID, "does-not-exist")).resolves.toBeNull();
    });
  });

  describe("childrenConnection", () => {
    test("0 children returns an empty connection", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2/, { rows: [] });
      const repo = createHierarchyRepository(db);

      const connection = await repo.childrenConnection(BUNDLE_ID, null, {});
      expect(connection.edges).toEqual([]);
      expect(connection.totalCount).toBe(0);
      expect(connection.pageInfo).toEqual({
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      });
    });

    test("1 child returns a single edge with no next page", async () => {
      const db = createFakeDb();
      const child = makeRow({ parent_id: PARENT_ID });
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2/, { rows: [child] });
      const repo = createHierarchyRepository(db);

      const connection = await repo.childrenConnection(BUNDLE_ID, PARENT_ID, {});
      expect(connection.edges).toHaveLength(1);
      expect(connection.edges[0]!.node.id).toBe(CONCEPT_ID);
      expect(connection.pageInfo.hasNextPage).toBe(false);
      expect(db.calls[0]!.params).toEqual([BUNDLE_ID, PARENT_ID]);
      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
    });

    test("exactly-first children (first === row count) returns no next page", async () => {
      const db = createFakeDb();
      const rowA = makeRow({ id: "30000000-0000-4000-8000-000000000001", sort_key: "A" });
      const rowB = makeRow({ id: "30000000-0000-4000-8000-000000000002", sort_key: "B" });
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2/, {
        rows: [rowA, rowB],
      });
      const repo = createHierarchyRepository(db);

      const connection = await repo.childrenConnection(BUNDLE_ID, null, { first: 2 });
      expect(connection.edges).toHaveLength(2);
      expect(connection.pageInfo.hasNextPage).toBe(false);
    });

    test("first-plus-one children (first < row count) returns a next page", async () => {
      const db = createFakeDb();
      const rowA = makeRow({ id: "30000000-0000-4000-8000-000000000001", sort_key: "A" });
      const rowB = makeRow({ id: "30000000-0000-4000-8000-000000000002", sort_key: "B" });
      const rowC = makeRow({ id: "30000000-0000-4000-8000-000000000003", sort_key: "C" });
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2/, {
        rows: [rowA, rowB, rowC],
      });
      const repo = createHierarchyRepository(db);

      const connection = await repo.childrenConnection(BUNDLE_ID, null, { first: 2 });
      expect(connection.edges).toHaveLength(2);
      expect(connection.pageInfo.hasNextPage).toBe(true);
      expect(connection.totalCount).toBe(3);
    });
  });

  describe("ancestorPath", () => {
    test("depth 1: a root concept's inclusive path is itself alone", async () => {
      const db = createFakeDb();
      const root = makeRow({ depth: 0 });
      db.when(/WITH RECURSIVE ancestry/, { rows: [root] });
      const repo = createHierarchyRepository(db);

      const path = await repo.ancestorPath(BUNDLE_ID, CONCEPT_ID);
      expect(path).toEqual([root]);
      expect(db.calls[0]!.params).toEqual([CONCEPT_ID, BUNDLE_ID]);
      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
    });

    test("depth 5: returns the full ancestor chain root-first, inclusive of the concept itself", async () => {
      const db = createFakeDb();
      const chain = [0, 1, 2, 3, 4].map((depth) =>
        makeRow({ id: `30000000-0000-4000-8000-00000000000${depth + 1}`, depth }),
      );
      db.when(/WITH RECURSIVE ancestry/, { rows: chain });
      const repo = createHierarchyRepository(db);

      const path = await repo.ancestorPath(BUNDLE_ID, chain[4]!.id);
      expect(path.map((row) => row.depth)).toEqual([0, 1, 2, 3, 4]);
      expect(path[path.length - 1]!.id).toBe(chain[4]!.id);
    });

    test("returns an empty array when the id does not resolve to a live concept", async () => {
      const db = createFakeDb();
      db.when(/WITH RECURSIVE ancestry/, { rows: [] });
      const repo = createHierarchyRepository(db);

      await expect(repo.ancestorPath(BUNDLE_ID, "does-not-exist")).resolves.toEqual([]);
    });
  });

  describe("siblings", () => {
    test("excludes the moved node and returns live siblings sort-key ordered", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2 AND id <> \$3/, {
        rows: [
          { id: "30000000-0000-4000-8000-000000000010", sort_key: "A" },
          { id: "30000000-0000-4000-8000-000000000011", sort_key: "C" },
        ],
      });
      const repo = createHierarchyRepository(db);

      const result = await repo.siblings(BUNDLE_ID, null, CONCEPT_ID);
      expect(result).toEqual([
        { id: "30000000-0000-4000-8000-000000000010", sortKey: "A" },
        { id: "30000000-0000-4000-8000-000000000011", sortKey: "C" },
      ]);
      expect(db.calls[0]!.params).toEqual([BUNDLE_ID, null, CONCEPT_ID]);
    });

    test("returns an empty array when there are no other live siblings", async () => {
      const db = createFakeDb();
      db.when(/FROM concepts\s+WHERE bundle_id = \$1 AND parent_id IS NOT DISTINCT FROM \$2 AND id <> \$3/, {
        rows: [],
      });
      const repo = createHierarchyRepository(db);

      await expect(repo.siblings(BUNDLE_ID, null, CONCEPT_ID)).resolves.toEqual([]);
    });
  });

  describe("moveSubtree", () => {
    test("issues the advisory lock before any write statement, then the reparent, then the descendant rewrite", async () => {
      const db = createFakeDb();
      db.when(/pg_advisory_xact_lock/, { rows: [] });
      const updated = makeRow({ parent_id: PARENT_ID, path: "parent/getting-started", depth: 1, version: 2 });
      db.when(/UPDATE concepts\s+SET parent_id/, { rows: [updated], rowCount: 1 });
      db.when(/WITH RECURSIVE subtree/, { rows: [] });
      const repo = createHierarchyRepository(db);

      const result = await repo.moveSubtree(
        BUNDLE_ID,
        CONCEPT_ID,
        1,
        { parentId: PARENT_ID, sortKey: "V", depth: 1, path: "parent/getting-started" },
        NOW,
      );

      expect(result).toEqual(updated);
      expect(db.calls).toHaveLength(3);
      expect(db.calls[0]!.sql).toContain("pg_advisory_xact_lock");
      expect(db.calls[0]!.params).toEqual([BUNDLE_ID]);
      expect(db.calls[1]!.sql).toContain("UPDATE concepts");
      expect(db.calls[1]!.sql).toContain("SET parent_id");
      expect(db.calls[2]!.sql).toContain("WITH RECURSIVE subtree");
      assertOnlyPositionalPlaceholders(db.calls[1]!.sql);
      assertOnlyPositionalPlaceholders(db.calls[2]!.sql);
    });

    test("runs inside a transaction that commits on success", async () => {
      const db = createFakeDb();
      db.when(/pg_advisory_xact_lock/, { rows: [] });
      db.when(/UPDATE concepts\s+SET parent_id/, { rows: [makeRow({ version: 2 })], rowCount: 1 });
      db.when(/WITH RECURSIVE subtree/, { rows: [] });
      const repo = createHierarchyRepository(db);

      await repo.moveSubtree(BUNDLE_ID, CONCEPT_ID, 1, { parentId: null, sortKey: "V", depth: 0, path: "root" }, NOW);

      expect(db.transactions).toHaveLength(1);
      expect(db.transactions[0]!.outcome).toBe("commit");
    });

    test("raises ConflictError('concept.staleVersion') when the reparent affects zero rows, and rolls back", async () => {
      const db = createFakeDb();
      db.when(/pg_advisory_xact_lock/, { rows: [] });
      db.when(/UPDATE concepts\s+SET parent_id/, { rows: [], rowCount: 0 });
      const repo = createHierarchyRepository(db);

      try {
        await repo.moveSubtree(
          BUNDLE_ID,
          CONCEPT_ID,
          1,
          { parentId: null, sortKey: "V", depth: 0, path: "getting-started" },
          NOW,
        );
        throw new Error("expected moveSubtree to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toBe("concept.staleVersion");
        expect((err as ConflictError).details).toEqual({ bundleId: BUNDLE_ID, id: CONCEPT_ID, expectedVersion: 1 });
      }
      expect(db.transactions).toHaveLength(1);
      expect(db.transactions[0]!.outcome).toBe("rollback");
      // The descendant-rewrite statement must never run once the reparent itself failed.
      expect(db.calls.some((call) => call.sql.includes("WITH RECURSIVE subtree"))).toBe(false);
    });
  });
});
