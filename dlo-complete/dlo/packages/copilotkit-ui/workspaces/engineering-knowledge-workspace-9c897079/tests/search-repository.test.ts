// tests/search-repository.test.ts — module m12 (search). Covers search-repository.ts against
// FakeDb (Database.md "No unit test touches PostgreSQL"): the exact SQL/params it forwards from
// query-builder.ts, snake_case-to-camelCase row mapping, and the empty-result path. Query-shape
// assertions themselves (text-only/containment-only/combined, bundle scope, validation) live in
// tests/search-query-builder.test.ts — this file only proves the repository wires the builder's
// output straight through the Db port.
import { describe, expect, test } from "vitest";
import { createSearchRepository } from "../src/modules/search/search-repository";
import { buildSearchQuery } from "../src/modules/search/query-builder";
import { asBundleId } from "../src/core/ids";
import { ValidationError } from "../src/core/errors";
import { createFakeDb } from "./helpers/fake-ports";

const BUNDLE_ID = asBundleId("f47ac10b-58cc-4372-a567-0e02b2c3d479");

describe("createSearchRepository", () => {
  test("executes the exact statement query-builder built and maps rows to SearchRow", async () => {
    const db = createFakeDb();
    const input = { bundleId: BUNDLE_ID, text: "ingress" };
    const built = buildSearchQuery(input);
    db.when(built.sql, {
      rows: [
        {
          id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          path: "networking/ingress",
          title: "Ingress controllers",
          body_markdown: "Configuring an ingress controller for the cluster.",
          rank: 0.607_927,
        },
      ],
    });
    const repo = createSearchRepository(db);

    const rows = await repo.search(input);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toBe(built.sql);
    expect(db.calls[0]?.params).toEqual(built.params);
    expect(rows).toEqual([
      {
        id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        path: "networking/ingress",
        title: "Ingress controllers",
        bodyMarkdown: "Configuring an ingress controller for the cluster.",
        rank: 0.607_927,
      },
    ]);
  });

  test("maps multiple rows in the order returned", async () => {
    const db = createFakeDb();
    const input = { bundleId: BUNDLE_ID, containment: { root: {} } };
    const built = buildSearchQuery(input);
    db.when(built.sql, {
      rows: [
        { id: "id-1", path: "a", title: "A", body_markdown: "body a", rank: 0 },
        { id: "id-2", path: "b", title: "B", body_markdown: "body b", rank: 0 },
      ],
    });
    const repo = createSearchRepository(db);

    const rows = await repo.search(input);

    expect(rows.map((r) => r.id)).toEqual(["id-1", "id-2"]);
  });

  test("returns [] when the query matches no rows", async () => {
    const db = createFakeDb();
    const input = { bundleId: BUNDLE_ID, text: "nonexistent" };
    const built = buildSearchQuery(input);
    db.when(built.sql, { rows: [] });
    const repo = createSearchRepository(db);

    const rows = await repo.search(input);

    expect(rows).toEqual([]);
  });

  test("propagates the ValidationError query-builder throws for an invalid query without querying the Db", async () => {
    const db = createFakeDb();
    const repo = createSearchRepository(db);

    await expect(repo.search({ bundleId: BUNDLE_ID })).rejects.toThrow(ValidationError);
    expect(db.calls).toHaveLength(0);
  });
});
