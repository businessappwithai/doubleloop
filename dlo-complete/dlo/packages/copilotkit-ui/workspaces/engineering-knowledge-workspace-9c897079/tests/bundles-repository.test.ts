// tests/bundles-repository.test.ts — module m9 (bundles module). Exercises
// `createBundleRepository` against the in-memory `FakeDb` (tests/helpers/fake-ports.ts): no real
// Postgres. Covers the happy path for every method on real returned rows, an empty list,
// pagination past the end, a stale-version conflict on `update` and `softDelete`, and asserts
// every issued SQL string uses only `$n` placeholders (Implementation.md m9 acceptance).
import { describe, test, expect } from "vitest";
import { createFakeDb } from "./helpers/fake-ports";
import { createBundleRepository, type BundleRow } from "../src/modules/bundles/bundle-repository";
import { ConflictError } from "../src/core/errors";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRow(overrides: Partial<BundleRow> = {}): BundleRow {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    workspace_id: WORKSPACE_ID,
    slug: "onboarding",
    title: "Onboarding",
    description: "",
    okf_version: "1.0",
    default_trust: "unverified",
    created_by: ACTOR_ID,
    concept_count: 0,
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

describe("createBundleRepository", () => {
  describe("insert", () => {
    test("returns the inserted row from RETURNING", async () => {
      const db = createFakeDb();
      const row = makeRow();
      db.when("INSERT INTO bundles", { rows: [row], rowCount: 1 });
      const repo = createBundleRepository(db);

      const result = await repo.insert({
        id: row.id,
        workspaceId: WORKSPACE_ID,
        slug: "onboarding",
        title: "Onboarding",
        description: "",
        okfVersion: "1.0",
        defaultTrust: "unverified",
        createdBy: ACTOR_ID,
        createdAt: NOW,
      });

      expect(result).toEqual(row);
      expect(db.calls).toHaveLength(1);
      expect(db.calls[0]!.params).toEqual([
        row.id,
        WORKSPACE_ID,
        "onboarding",
        "Onboarding",
        "",
        "1.0",
        "unverified",
        ACTOR_ID,
        NOW,
      ]);
    });

    test("uses only $n placeholders, never interpolated values", async () => {
      const db = createFakeDb();
      db.when("INSERT INTO bundles", { rows: [makeRow()], rowCount: 1 });
      const repo = createBundleRepository(db);

      await repo.insert({
        id: makeRow().id,
        workspaceId: WORKSPACE_ID,
        slug: "onboarding",
        title: "Onboarding",
        description: "",
        okfVersion: "1.0",
        defaultTrust: "unverified",
        createdBy: ACTOR_ID,
        createdAt: NOW,
      });

      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
      expect(db.calls[0]!.sql).not.toContain(WORKSPACE_ID);
    });
  });

  describe("findById", () => {
    test("returns the matching live row", async () => {
      const db = createFakeDb();
      const row = makeRow();
      db.when(/FROM bundles WHERE id = \$1/, { rows: [row] });
      const repo = createBundleRepository(db);

      await expect(repo.findById(row.id)).resolves.toEqual(row);
      expect(db.calls[0]!.params).toEqual([row.id]);
      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
    });

    test("returns null for an unknown id", async () => {
      const db = createFakeDb();
      db.when(/FROM bundles WHERE id = \$1/, { rows: [] });
      const repo = createBundleRepository(db);

      await expect(repo.findById("does-not-exist")).resolves.toBeNull();
    });

    test("filters out soft-deleted bundles via deleted_at IS NULL in the SQL text", async () => {
      const db = createFakeDb();
      db.when(/FROM bundles WHERE id = \$1/, { rows: [] });
      const repo = createBundleRepository(db);

      await repo.findById("some-id");
      expect(db.calls[0]!.sql).toContain("deleted_at IS NULL");
    });
  });

  describe("findBySlug", () => {
    test("returns the matching live row for workspace + slug", async () => {
      const db = createFakeDb();
      const row = makeRow();
      db.when(/FROM bundles WHERE workspace_id = \$1 AND slug = \$2/, { rows: [row] });
      const repo = createBundleRepository(db);

      await expect(repo.findBySlug(WORKSPACE_ID, "onboarding")).resolves.toEqual(row);
      expect(db.calls[0]!.params).toEqual([WORKSPACE_ID, "onboarding"]);
    });

    test("returns null when no bundle matches", async () => {
      const db = createFakeDb();
      db.when(/FROM bundles WHERE workspace_id = \$1 AND slug = \$2/, { rows: [] });
      const repo = createBundleRepository(db);

      await expect(repo.findBySlug(WORKSPACE_ID, "missing")).resolves.toBeNull();
    });
  });

  describe("listConnection", () => {
    test("returns an empty connection for a workspace with no bundles", async () => {
      const db = createFakeDb();
      db.when(/FROM bundles\s+WHERE workspace_id = \$1/, { rows: [] });
      const repo = createBundleRepository(db);

      const connection = await repo.listConnection(WORKSPACE_ID, {});
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
      const rowA = makeRow({ id: "30000000-0000-4000-8000-000000000001", title: "Alpha", slug: "alpha" });
      const rowB = makeRow({ id: "30000000-0000-4000-8000-000000000002", title: "Beta", slug: "beta" });
      db.when(/FROM bundles\s+WHERE workspace_id = \$1/, { rows: [rowA, rowB] });
      const repo = createBundleRepository(db);

      const connection = await repo.listConnection(WORKSPACE_ID, {});
      expect(connection.edges.map((edge) => edge.node.id)).toEqual([rowA.id, rowB.id]);
      expect(connection.totalCount).toBe(2);
      expect(db.calls[0]!.params).toEqual([WORKSPACE_ID]);
    });

    test("pagination past the end returns no edges and no next page", async () => {
      const db = createFakeDb();
      const rowA = makeRow({ id: "30000000-0000-4000-8000-000000000001", title: "Alpha" });
      db.when(/FROM bundles\s+WHERE workspace_id = \$1/, { rows: [rowA] });
      const repo = createBundleRepository(db);

      const connection = await repo.listConnection(WORKSPACE_ID, { first: 5 });
      expect(connection.pageInfo.hasNextPage).toBe(false);
      expect(connection.edges).toHaveLength(1);

      const secondPage = await repo.listConnection(WORKSPACE_ID, {
        first: 5,
        after: connection.pageInfo.endCursor!,
      });
      expect(secondPage.edges).toEqual([]);
      expect(secondPage.pageInfo.hasNextPage).toBe(false);
      expect(secondPage.pageInfo.hasPreviousPage).toBe(true);
    });
  });

  describe("update", () => {
    test("returns the updated row on a matching id + version", async () => {
      const db = createFakeDb();
      const updated = makeRow({ title: "Renamed", version: 2 });
      db.when(/UPDATE bundles\s+SET title/, { rows: [updated], rowCount: 1 });
      const repo = createBundleRepository(db);

      const result = await repo.update(updated.id, 1, "Renamed", NOW);
      expect(result).toEqual(updated);
      expect(db.calls[0]!.params).toEqual([updated.id, 1, "Renamed", NOW]);
      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
    });

    test("raises ConflictError('bundle.staleVersion') when rowCount is 0", async () => {
      const db = createFakeDb();
      db.when(/UPDATE bundles\s+SET title/, { rows: [], rowCount: 0 });
      const repo = createBundleRepository(db);

      await expect(repo.update("some-id", 1, "Renamed", NOW)).rejects.toThrow(ConflictError);
      try {
        await repo.update("some-id", 1, "Renamed", NOW);
        throw new Error("expected update to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toBe("bundle.staleVersion");
        expect((err as ConflictError).details).toEqual({ id: "some-id", expectedVersion: 1 });
      }
    });
  });

  describe("softDelete", () => {
    test("returns the archived row on a matching id + version", async () => {
      const db = createFakeDb();
      const archived = makeRow({ deleted_at: NOW, version: 2 });
      db.when(/UPDATE bundles\s+SET deleted_at/, { rows: [archived], rowCount: 1 });
      const repo = createBundleRepository(db);

      const result = await repo.softDelete(archived.id, 1, NOW);
      expect(result).toEqual(archived);
      expect(db.calls[0]!.params).toEqual([archived.id, 1, NOW]);
      assertOnlyPositionalPlaceholders(db.calls[0]!.sql);
    });

    test("raises ConflictError('bundle.staleVersion') when rowCount is 0", async () => {
      const db = createFakeDb();
      db.when(/UPDATE bundles\s+SET deleted_at/, { rows: [], rowCount: 0 });
      const repo = createBundleRepository(db);

      try {
        await repo.softDelete("some-id", 1, NOW);
        throw new Error("expected softDelete to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).message).toBe("bundle.staleVersion");
      }
    });
  });
});
