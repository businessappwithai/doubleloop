// tests/concepts-module.test.ts — module m10 (concepts and hierarchy module). Exercises
// `createConceptModule` against a hand-stubbed `ConceptRepository` (no SQL, no FakeDb) plus the
// deterministic `FakeClock`/`SeqIds` from tests/helpers/fake-ports.ts. Covers get/getByPath/list/
// create/updateMetadata/archive happy paths on real returned records, slug normalisation and
// title validation, root vs. non-root path/depth derivation, sort-key allocation via the real
// `keyBetween`, unknown parent, unique-slug → ConflictError, empty update, and stale-version
// passthrough (Implementation.md m10 acceptance).
import { describe, test, expect, vi } from "vitest";
import { createFakeClock, createSeqIds } from "./helpers/fake-ports";
import {
  createConceptModule,
  normalizeSlug,
  type CreateConceptModuleDeps,
} from "../src/modules/concepts/concept-module";
import type { ConceptRepository, ConceptRow } from "../src/modules/concepts/concept-repository";
import { createRequestContext } from "../src/core/context";
import { ConflictError, NotFoundError, ValidationError } from "../src/core/errors";
import { asActorId, asBundleId, asConceptId } from "../src/core/ids";
import type { Logger } from "../src/server/ports";

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

function createRepoStub(): ConceptRepository {
  return {
    insert: vi.fn(),
    findById: vi.fn(),
    findByIdUnscoped: vi.fn(),
    findByPath: vi.fn(),
    listConnection: vi.fn(),
    lastSiblingSortKey: vi.fn(),
    updateTitle: vi.fn(),
    setIsIndex: vi.fn(),
    softDelete: vi.fn(),
  };
}

function createModule(overrides: Partial<CreateConceptModuleDeps> = {}) {
  const repo = overrides.repo ?? createRepoStub();
  const clock = overrides.clock ?? createFakeClock(NOW);
  const ids = overrides.ids ?? createSeqIds();
  const logger = overrides.logger ?? createSilentLogger();
  return { module: createConceptModule({ repo, clock, ids, logger }), repo, clock, ids, logger };
}

const ctx = createRequestContext({
  requestId: "req-1",
  actor: { id: asActorId(ACTOR_ID), email: "a@example.com", displayName: "A" },
});

describe("createConceptModule.get", () => {
  test("returns the mapped Concept for a live row", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow());

    const concept = await module.get(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID));

    expect(concept).toEqual({
      id: CONCEPT_ID,
      bundleId: BUNDLE_ID,
      parentId: null,
      slug: "getting-started",
      path: "getting-started",
      title: "Getting Started",
      sortKey: "V",
      depth: 0,
      isIndex: false,
      childCount: 0,
      createdBy: ACTOR_ID,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      deletedAt: null,
    });
    expect(repo.findById).toHaveBeenCalledWith(BUNDLE_ID, CONCEPT_ID);
  });

  test("raises NotFoundError('concept.notFound') for an unknown id", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(null);

    try {
      await module.get(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID));
      throw new Error("expected get to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("concept.notFound");
      expect((err as NotFoundError).code).toBe("not_found");
    }
  });

  test("maps a non-null parentId and deletedAt", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow({ parent_id: PARENT_ID, deleted_at: NOW }));

    const concept = await module.get(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID));
    expect(concept.parentId).toBe(PARENT_ID);
    expect(concept.deletedAt).toBe(NOW.toISOString());
  });
});

describe("createConceptModule.getByPath", () => {
  test("returns the mapped Concept for a live row", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByPath).mockResolvedValue(makeRow());

    const concept = await module.getByPath(ctx, asBundleId(BUNDLE_ID), "getting-started");
    expect(concept.id).toBe(CONCEPT_ID);
    expect(repo.findByPath).toHaveBeenCalledWith(BUNDLE_ID, "getting-started");
  });

  test("raises NotFoundError('concept.notFound') for an unknown path", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByPath).mockResolvedValue(null);

    try {
      await module.getByPath(ctx, asBundleId(BUNDLE_ID), "missing/path");
      throw new Error("expected getByPath to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("concept.notFound");
    }
  });
});

describe("createConceptModule.list", () => {
  test("maps an empty connection through unchanged", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.listConnection).mockResolvedValue({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });

    const connection = await module.list(ctx, asBundleId(BUNDLE_ID), {});
    expect(connection.edges).toEqual([]);
    expect(connection.totalCount).toBe(0);
  });

  test("maps every edge's node from ConceptRow to Concept and preserves cursor/pageInfo", async () => {
    const { module, repo } = createModule();
    const row = makeRow();
    vi.mocked(repo.listConnection).mockResolvedValue({
      edges: [{ node: { ...row, sortKey: row.sort_key }, cursor: "cursor-1" }],
      pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: "cursor-1", endCursor: "cursor-1" },
      totalCount: 5,
    });

    const connection = await module.list(ctx, asBundleId(BUNDLE_ID), { first: 1 });
    expect(connection.edges).toEqual([{ node: expect.objectContaining({ id: CONCEPT_ID }), cursor: "cursor-1" }]);
    expect(connection.pageInfo.hasNextPage).toBe(true);
    expect(connection.totalCount).toBe(5);
    expect(repo.listConnection).toHaveBeenCalledWith(BUNDLE_ID, { first: 1 });
  });
});

describe("createConceptModule.create", () => {
  test("root concept: normalises the slug, defaults isIndex, derives path/depth 0, and returns the mapped Concept", async () => {
    const { module, repo, ids } = createModule();
    vi.mocked(repo.lastSiblingSortKey).mockResolvedValue(null);
    vi.mocked(repo.insert).mockResolvedValue(makeRow());

    const concept = await module.create(ctx, {
      bundleId: asBundleId(BUNDLE_ID),
      parentId: null,
      slug: "  Getting Started!! ",
      title: "  Getting Started  ",
    });

    expect(concept.id).toBe(CONCEPT_ID);
    expect(repo.lastSiblingSortKey).toHaveBeenCalledWith(BUNDLE_ID, null);
    expect(repo.insert).toHaveBeenCalledWith({
      id: (ids as ReturnType<typeof createSeqIds>).issued[0],
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
  });

  test("child concept: derives path from the parent's path and depth from parent.depth + 1", async () => {
    const { module, repo } = createModule();
    const parentRow = makeRow({ id: PARENT_ID, path: "guides", depth: 0, slug: "guides" });
    vi.mocked(repo.findById).mockResolvedValue(parentRow);
    vi.mocked(repo.lastSiblingSortKey).mockResolvedValue(null);
    vi.mocked(repo.insert).mockResolvedValue(
      makeRow({ parent_id: PARENT_ID, path: "guides/getting-started", depth: 1 }),
    );

    await module.create(ctx, {
      bundleId: asBundleId(BUNDLE_ID),
      parentId: asConceptId(PARENT_ID),
      slug: "getting-started",
      title: "Getting Started",
    });

    expect(repo.findById).toHaveBeenCalledWith(BUNDLE_ID, PARENT_ID);
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: PARENT_ID, path: "guides/getting-started", depth: 1 }),
    );
  });

  test("appends after the last sibling's sort_key when siblings already exist", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.lastSiblingSortKey).mockResolvedValue("A");
    vi.mocked(repo.insert).mockResolvedValue(makeRow());

    await module.create(ctx, { bundleId: asBundleId(BUNDLE_ID), parentId: null, slug: "next", title: "Next" });

    const insertedSortKey = (vi.mocked(repo.insert).mock.calls[0]![0] as { sortKey: string }).sortKey;
    expect(insertedSortKey > "A").toBe(true);
  });

  test("passes through an explicit isIndex", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.lastSiblingSortKey).mockResolvedValue(null);
    vi.mocked(repo.insert).mockResolvedValue(makeRow({ is_index: true }));

    await module.create(ctx, {
      bundleId: asBundleId(BUNDLE_ID),
      parentId: null,
      slug: "index",
      title: "Index",
      isIndex: true,
    });

    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ isIndex: true }));
  });

  test("raises ValidationError('concept.invalidSlug') for a slug that normalises to empty", async () => {
    const { module } = createModule();
    await expect(
      module.create(ctx, { bundleId: asBundleId(BUNDLE_ID), parentId: null, slug: "!!!", title: "Title" }),
    ).rejects.toThrow(ValidationError);
  });

  test("raises ValidationError('concept.invalidTitle') for a blank title", async () => {
    const { module } = createModule();
    try {
      await module.create(ctx, { bundleId: asBundleId(BUNDLE_ID), parentId: null, slug: "slug", title: "   " });
      throw new Error("expected create to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("concept.invalidTitle");
    }
  });

  test("raises NotFoundError('concept.parentNotFound') for a parentId that does not resolve to a live concept", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(null);

    try {
      await module.create(ctx, {
        bundleId: asBundleId(BUNDLE_ID),
        parentId: asConceptId(PARENT_ID),
        slug: "child",
        title: "Child",
      });
      throw new Error("expected create to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("concept.parentNotFound");
    }
  });

  test("maps a 23505 unique violation to ConflictError('concept.slugTaken')", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.lastSiblingSortKey).mockResolvedValue(null);
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "concepts_sibling_slug_live_key"'),
      { code: "23505" },
    );
    vi.mocked(repo.insert).mockRejectedValue(pgError);

    try {
      await module.create(ctx, { bundleId: asBundleId(BUNDLE_ID), parentId: null, slug: "dup", title: "Dup" });
      throw new Error("expected create to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toBe("concept.slugTaken");
      expect((err as ConflictError).details).toEqual({ bundleId: BUNDLE_ID, parentId: null, slug: "dup" });
      expect((err as ConflictError).cause).toBe(pgError);
    }
  });

  test("rethrows a non-unique-violation error unchanged", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.lastSiblingSortKey).mockResolvedValue(null);
    const otherError = new Error("connection reset");
    vi.mocked(repo.insert).mockRejectedValue(otherError);

    await expect(
      module.create(ctx, { bundleId: asBundleId(BUNDLE_ID), parentId: null, slug: "x", title: "X" }),
    ).rejects.toBe(otherError);
  });
});

describe("createConceptModule.updateMetadata", () => {
  test("applies only a title patch", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.updateTitle).mockResolvedValue(makeRow({ title: "Renamed", version: 2 }));

    const concept = await module.updateMetadata(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      title: "Renamed",
    });

    expect(concept.title).toBe("Renamed");
    expect(concept.version).toBe(2);
    expect(repo.updateTitle).toHaveBeenCalledWith(BUNDLE_ID, CONCEPT_ID, 1, "Renamed", NOW);
    expect(repo.setIsIndex).not.toHaveBeenCalled();
  });

  test("applies only an isIndex patch", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.setIsIndex).mockResolvedValue(makeRow({ is_index: true, version: 2 }));

    const concept = await module.updateMetadata(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      isIndex: true,
    });

    expect(concept.isIndex).toBe(true);
    expect(repo.setIsIndex).toHaveBeenCalledWith(BUNDLE_ID, CONCEPT_ID, 1, true, NOW);
    expect(repo.updateTitle).not.toHaveBeenCalled();
  });

  test("chains the optimistic-concurrency version across both writes when both fields are supplied", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.updateTitle).mockResolvedValue(makeRow({ title: "Renamed", version: 2 }));
    vi.mocked(repo.setIsIndex).mockResolvedValue(makeRow({ title: "Renamed", is_index: true, version: 3 }));

    const concept = await module.updateMetadata(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      title: "Renamed",
      isIndex: true,
    });

    expect(repo.updateTitle).toHaveBeenCalledWith(BUNDLE_ID, CONCEPT_ID, 1, "Renamed", NOW);
    expect(repo.setIsIndex).toHaveBeenCalledWith(BUNDLE_ID, CONCEPT_ID, 2, true, NOW);
    expect(concept.version).toBe(3);
  });

  test("raises ValidationError('concept.emptyUpdate') when neither field is supplied", async () => {
    const { module } = createModule();
    try {
      await module.updateMetadata(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {});
      throw new Error("expected updateMetadata to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("concept.emptyUpdate");
    }
  });

  test("propagates ConflictError('concept.staleVersion') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const conflict = new ConflictError("concept.staleVersion", { details: { id: CONCEPT_ID, expectedVersion: 1 } });
    vi.mocked(repo.updateTitle).mockRejectedValue(conflict);

    await expect(
      module.updateMetadata(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, { title: "Renamed" }),
    ).rejects.toBe(conflict);
  });
});

describe("createConceptModule.archive", () => {
  test("returns the mapped Concept with deletedAt set", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.softDelete).mockResolvedValue(makeRow({ deleted_at: NOW, version: 2 }));

    const concept = await module.archive(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1);
    expect(concept.deletedAt).toBe(NOW.toISOString());
    expect(repo.softDelete).toHaveBeenCalledWith(BUNDLE_ID, CONCEPT_ID, 1, NOW);
  });

  test("propagates ConflictError('concept.staleVersion') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const conflict = new ConflictError("concept.staleVersion", { details: { id: CONCEPT_ID, expectedVersion: 1 } });
    vi.mocked(repo.softDelete).mockRejectedValue(conflict);

    await expect(module.archive(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1)).rejects.toBe(conflict);
  });
});

describe("normalizeSlug", () => {
  test.each([
    ["Getting Started", "getting-started"],
    ["  spaced out  ", "spaced-out"],
    ["Already-Valid-Slug", "already-valid-slug"],
    ["multiple___separators", "multiple-separators"],
    ["--leading-and-trailing--", "leading-and-trailing"],
    ["UPPER", "upper"],
  ])("normalises %j to %j", (input, expected) => {
    expect(normalizeSlug(input)).toBe(expected);
  });

  test("raises ValidationError('concept.invalidSlug') when the result is empty", () => {
    try {
      normalizeSlug("!!!");
      throw new Error("expected normalizeSlug to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("concept.invalidSlug");
    }
  });

  test("raises ValidationError('concept.invalidSlug') above the 96-character limit", () => {
    expect(() => normalizeSlug("a".repeat(97))).toThrow(ValidationError);
  });

  test("accepts a slug at exactly the 96-character limit", () => {
    const slug = "a".repeat(96);
    expect(normalizeSlug(slug)).toBe(slug);
  });
});

// ---------------------------------------------------------------------------
// getById — the unscoped lookup the Relay Node interface needs
//
// `node(id:)` is handed a global id and nothing else, so it has no bundle to scope by.
// `concepts.id` is a `uuid PRIMARY KEY`, so an id-only lookup is unambiguous. Without this,
// `node(id:)` on a Concept threw outright and the concept route plus every sidebar expansion
// below the root failed with "Couldn't load this concept".
// ---------------------------------------------------------------------------

describe("ConceptModule.getById", () => {
  test("returns the mapped concept for an existing id", async () => {
    const { module, repo } = createModule();
    const row = makeRow();
    vi.mocked(repo.findByIdUnscoped).mockResolvedValue(row);

    const result = await module.getById(ctx, asConceptId(row.id));

    expect(result.id).toBe(row.id);
    expect(result.title).toBe(row.title);
  });

  test("queries by id alone — no bundle scope is passed", async () => {
    const { module, repo } = createModule();
    const row = makeRow();
    vi.mocked(repo.findByIdUnscoped).mockResolvedValue(row);

    await module.getById(ctx, asConceptId(row.id));

    expect(repo.findByIdUnscoped).toHaveBeenCalledWith(row.id);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  test("throws NotFoundError('concept.notFound') when no row matches", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByIdUnscoped).mockResolvedValue(null);

    await expect(
      module.getById(ctx, asConceptId("50000000-0000-4000-8000-0000000000ff")),
    ).rejects.toThrow(NotFoundError);
  });

  test("the NotFoundError carries the id it looked for", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByIdUnscoped).mockResolvedValue(null);
    const missing = "50000000-0000-4000-8000-0000000000ff";

    try {
      await module.getById(ctx, asConceptId(missing));
      throw new Error("expected getById to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("concept.notFound");
      expect((err as NotFoundError).details["id"]).toBe(missing);
    }
  });
});
