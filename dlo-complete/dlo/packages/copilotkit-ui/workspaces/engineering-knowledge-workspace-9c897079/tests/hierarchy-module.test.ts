// tests/hierarchy-module.test.ts — module m10 (concepts and hierarchy module). Exercises
// `createHierarchyModule` against a hand-stubbed `HierarchyRepository` (no SQL, no FakeDb) plus
// the deterministic `FakeClock` from tests/helpers/fake-ports.ts. Covers `children`/`ancestors`
// passthrough and mapping, `move`'s three `afterId` shapes (append/prepend/insert-after) via the
// real `keyBetween`, root vs. non-root path/depth derivation, a move to a missing parent raising
// `NotFoundError`, both shapes of cycle (self-parenting and move-under-own-descendant) raising
// `ValidationError('hierarchy.cycle')`, an unknown `afterId` raising `NotFoundError`, and
// stale-version passthrough (Implementation.md m10 acceptance).
import { describe, test, expect, vi } from "vitest";
import { createFakeClock } from "./helpers/fake-ports";
import { createHierarchyModule, type CreateHierarchyModuleDeps } from "../src/modules/hierarchy/hierarchy-module";
import type { HierarchyConceptRow, HierarchyRepository } from "../src/modules/hierarchy/hierarchy-repository";
import { createRequestContext } from "../src/core/context";
import { ConflictError, NotFoundError, ValidationError } from "../src/core/errors";
import { asActorId, asBundleId, asConceptId } from "../src/core/ids";
import type { Logger } from "../src/server/ports";

const BUNDLE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const CONCEPT_ID = "30000000-0000-4000-8000-000000000001";
const PARENT_ID = "30000000-0000-4000-8000-000000000002";
const OTHER_ID = "30000000-0000-4000-8000-000000000003";
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

function createSilentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

function createRepoStub(): HierarchyRepository {
  return {
    findById: vi.fn(),
    childrenConnection: vi.fn(),
    ancestorPath: vi.fn(),
    siblings: vi.fn(),
    moveSubtree: vi.fn(),
  };
}

function createModule(overrides: Partial<CreateHierarchyModuleDeps> = {}) {
  const repo = overrides.repo ?? createRepoStub();
  const clock = overrides.clock ?? createFakeClock(NOW);
  const logger = overrides.logger ?? createSilentLogger();
  return { module: createHierarchyModule({ repo, clock, logger }), repo, clock, logger };
}

const ctx = createRequestContext({
  requestId: "req-1",
  actor: { id: asActorId(ACTOR_ID), email: "a@example.com", displayName: "A" },
});

describe("createHierarchyModule.children", () => {
  test("maps an empty connection through unchanged", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.childrenConnection).mockResolvedValue({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });

    const connection = await module.children(ctx, asBundleId(BUNDLE_ID), null, {});
    expect(connection.edges).toEqual([]);
    expect(repo.childrenConnection).toHaveBeenCalledWith(BUNDLE_ID, null, {});
  });

  test("maps every edge's node from HierarchyConceptRow to Concept and preserves cursor/pageInfo", async () => {
    const { module, repo } = createModule();
    const row = makeRow({ parent_id: PARENT_ID });
    vi.mocked(repo.childrenConnection).mockResolvedValue({
      edges: [{ node: { ...row, sortKey: row.sort_key }, cursor: "cursor-1" }],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: "cursor-1", endCursor: "cursor-1" },
      totalCount: 1,
    });

    const connection = await module.children(ctx, asBundleId(BUNDLE_ID), asConceptId(PARENT_ID), { first: 10 });
    expect(connection.edges).toEqual([{ node: expect.objectContaining({ id: CONCEPT_ID }), cursor: "cursor-1" }]);
    expect(repo.childrenConnection).toHaveBeenCalledWith(BUNDLE_ID, PARENT_ID, { first: 10 });
  });
});

describe("createHierarchyModule.ancestors", () => {
  test("excludes the concept itself from the returned chain", async () => {
    const { module, repo } = createModule();
    const grandparent = makeRow({ id: "30000000-0000-4000-8000-000000000010", depth: 0, slug: "root" });
    const parent = makeRow({ id: PARENT_ID, depth: 1, slug: "parent" });
    const self = makeRow({ id: CONCEPT_ID, depth: 2 });
    vi.mocked(repo.ancestorPath).mockResolvedValue([grandparent, parent, self]);

    const ancestors = await module.ancestors(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID));
    expect(ancestors.map((a) => a.id)).toEqual([grandparent.id, parent.id]);
    expect(repo.ancestorPath).toHaveBeenCalledWith(BUNDLE_ID, CONCEPT_ID);
  });

  test("returns an empty array when the ancestor path is a root with no ancestors above it", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.ancestorPath).mockResolvedValue([makeRow({ id: CONCEPT_ID, depth: 0 })]);

    const ancestors = await module.ancestors(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID));
    expect(ancestors).toEqual([]);
  });
});

describe("createHierarchyModule.move", () => {
  test("raises NotFoundError('concept.notFound') for an unknown moved concept", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(null);

    try {
      await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, { newParentId: null });
      throw new Error("expected move to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("concept.notFound");
    }
  });

  test("raises NotFoundError('hierarchy.parentNotFound') for a missing destination parent", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockImplementation(async (_bundleId, id) =>
      id === CONCEPT_ID ? makeRow() : null,
    );

    try {
      await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
        newParentId: asConceptId(PARENT_ID),
      });
      throw new Error("expected move to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("hierarchy.parentNotFound");
    }
  });

  test("raises ValidationError('hierarchy.cycle') when moving a node to be its own parent", async () => {
    const { module, repo } = createModule();
    const target = makeRow();
    vi.mocked(repo.findById).mockImplementation(async (_bundleId, id) => (id === CONCEPT_ID ? target : null));
    // ancestorPath(newParentId) is inclusive of newParentId itself; newParentId === id here.
    vi.mocked(repo.ancestorPath).mockResolvedValue([target]);

    try {
      await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
        newParentId: asConceptId(CONCEPT_ID),
      });
      throw new Error("expected move to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("hierarchy.cycle");
      expect((err as ValidationError).details).toEqual({
        bundleId: BUNDLE_ID,
        id: CONCEPT_ID,
        newParentId: CONCEPT_ID,
      });
    }
  });

  test("raises ValidationError('hierarchy.cycle') when moving a node under its own descendant", async () => {
    const { module, repo } = createModule();
    const target = makeRow({ id: CONCEPT_ID, depth: 0 });
    const descendant = makeRow({ id: OTHER_ID, parent_id: CONCEPT_ID, depth: 1 });
    vi.mocked(repo.findById).mockImplementation(async (_bundleId, id) =>
      id === CONCEPT_ID ? target : id === OTHER_ID ? descendant : null,
    );
    // Walking OTHER_ID's ancestors back to the root passes through CONCEPT_ID.
    vi.mocked(repo.ancestorPath).mockResolvedValue([target, descendant]);

    await expect(
      module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, { newParentId: asConceptId(OTHER_ID) }),
    ).rejects.toThrow(ValidationError);
  });

  test("raises NotFoundError('hierarchy.afterConceptNotFound') when afterId does not name a live sibling", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow());
    vi.mocked(repo.siblings).mockResolvedValue([]);

    try {
      await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
        newParentId: null,
        afterId: asConceptId(OTHER_ID),
      });
      throw new Error("expected move to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("hierarchy.afterConceptNotFound");
    }
  });

  test("append (afterId omitted): allocates a sort_key after the last sibling", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow());
    vi.mocked(repo.siblings).mockResolvedValue([
      { id: "30000000-0000-4000-8000-000000000020", sortKey: "A" },
      { id: "30000000-0000-4000-8000-000000000021", sortKey: "M" },
    ]);
    vi.mocked(repo.moveSubtree).mockResolvedValue(makeRow({ version: 2 }));

    await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, { newParentId: null });

    const input = vi.mocked(repo.moveSubtree).mock.calls[0]![3];
    expect(input.sortKey > "M").toBe(true);
  });

  test("prepend (afterId === null): allocates a sort_key before the first sibling", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow());
    vi.mocked(repo.siblings).mockResolvedValue([
      { id: "30000000-0000-4000-8000-000000000020", sortKey: "M" },
      { id: "30000000-0000-4000-8000-000000000021", sortKey: "Z" },
    ]);
    vi.mocked(repo.moveSubtree).mockResolvedValue(makeRow({ version: 2 }));

    await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, { newParentId: null, afterId: null });

    const input = vi.mocked(repo.moveSubtree).mock.calls[0]![3];
    expect(input.sortKey < "M").toBe(true);
  });

  test("insert-after a concrete sibling: allocates a sort_key strictly between it and the next sibling", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow());
    const siblingA = { id: "30000000-0000-4000-8000-000000000020", sortKey: "A" };
    const siblingB = { id: "30000000-0000-4000-8000-000000000021", sortKey: "M" };
    vi.mocked(repo.siblings).mockResolvedValue([siblingA, siblingB]);
    vi.mocked(repo.moveSubtree).mockResolvedValue(makeRow({ version: 2 }));

    await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      newParentId: null,
      afterId: asConceptId(siblingA.id),
    });

    const input = vi.mocked(repo.moveSubtree).mock.calls[0]![3];
    expect(input.sortKey > "A").toBe(true);
    expect(input.sortKey < "M").toBe(true);
  });

  test("insert-after the last sibling behaves like an append (no upper bound)", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow());
    const onlySibling = { id: "30000000-0000-4000-8000-000000000020", sortKey: "M" };
    vi.mocked(repo.siblings).mockResolvedValue([onlySibling]);
    vi.mocked(repo.moveSubtree).mockResolvedValue(makeRow({ version: 2 }));

    await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      newParentId: null,
      afterId: asConceptId(onlySibling.id),
    });

    const input = vi.mocked(repo.moveSubtree).mock.calls[0]![3];
    expect(input.sortKey > "M").toBe(true);
  });

  test("root move: derives depth 0 and path === the concept's own slug", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow({ slug: "getting-started" }));
    vi.mocked(repo.siblings).mockResolvedValue([]);
    vi.mocked(repo.moveSubtree).mockResolvedValue(makeRow({ version: 2 }));

    await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, { newParentId: null });

    const input = vi.mocked(repo.moveSubtree).mock.calls[0]![3];
    expect(input).toMatchObject({ parentId: null, depth: 0, path: "getting-started" });
  });

  test("non-root move: derives depth = parent.depth + 1 and path = parent.path + '/' + slug", async () => {
    const { module, repo } = createModule();
    const target = makeRow({ slug: "getting-started" });
    const parent = makeRow({ id: PARENT_ID, path: "guides", depth: 0, slug: "guides" });
    vi.mocked(repo.findById).mockImplementation(async (_bundleId, id) =>
      id === CONCEPT_ID ? target : id === PARENT_ID ? parent : null,
    );
    vi.mocked(repo.ancestorPath).mockResolvedValue([parent]);
    vi.mocked(repo.siblings).mockResolvedValue([]);
    vi.mocked(repo.moveSubtree).mockResolvedValue(makeRow({ version: 2 }));

    await module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      newParentId: asConceptId(PARENT_ID),
    });

    const input = vi.mocked(repo.moveSubtree).mock.calls[0]![3];
    expect(input).toMatchObject({ parentId: PARENT_ID, depth: 1, path: "guides/getting-started" });
    expect(vi.mocked(repo.moveSubtree)).toHaveBeenCalledWith(BUNDLE_ID, CONCEPT_ID, 1, input, NOW);
  });

  test("propagates ConflictError('concept.staleVersion') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow());
    vi.mocked(repo.siblings).mockResolvedValue([]);
    const conflict = new ConflictError("concept.staleVersion", { details: { id: CONCEPT_ID, expectedVersion: 1 } });
    vi.mocked(repo.moveSubtree).mockRejectedValue(conflict);

    await expect(
      module.move(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, { newParentId: null }),
    ).rejects.toBe(conflict);
  });
});
