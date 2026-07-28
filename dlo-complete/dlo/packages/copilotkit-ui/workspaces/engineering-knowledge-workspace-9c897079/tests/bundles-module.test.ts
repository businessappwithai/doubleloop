// tests/bundles-module.test.ts — module m9 (bundles module). Exercises `createBundleModule`
// against a hand-stubbed `BundleRepository` (no SQL, no FakeDb) plus the deterministic
// `FakeClock`/`SeqIds` from tests/helpers/fake-ports.ts. Covers create/get/list/rename/archive
// happy paths on real returned records, slug normalisation, unique-slug → ConflictError,
// unknown id → NotFoundError, stale version passthrough, and the DB↔domain trust translation
// including its failure mode.
import { describe, test, expect, vi } from "vitest";
import { createFakeClock, createSeqIds } from "./helpers/fake-ports";
import {
  createBundleModule,
  dbTrustToDomain,
  domainTrustToDb,
  normalizeSlug,
  type CreateBundleModuleDeps,
} from "../src/modules/bundles/bundle-module";
import type { BundleRepository, BundleRow } from "../src/modules/bundles/bundle-repository";
import { createRequestContext } from "../src/core/context";
import { ConflictError, NotFoundError, ValidationError } from "../src/core/errors";
import { asActorId, asBundleId } from "../src/core/ids";
import type { Logger } from "../src/server/ports";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "30000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRow(overrides: Partial<BundleRow> = {}): BundleRow {
  return {
    id: BUNDLE_ID,
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

function createRepoStub(): BundleRepository {
  return {
    insert: vi.fn(),
    findById: vi.fn(),
    findBySlug: vi.fn(),
    listConnection: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  };
}

function createModule(overrides: Partial<CreateBundleModuleDeps> = {}) {
  const repo = overrides.repo ?? createRepoStub();
  const clock = overrides.clock ?? createFakeClock(NOW);
  const ids = overrides.ids ?? createSeqIds();
  const logger = overrides.logger ?? createSilentLogger();
  return { module: createBundleModule({ repo, clock, ids, logger }), repo, clock, ids, logger };
}

const ctx = createRequestContext({
  requestId: "req-1",
  actor: { id: asActorId(ACTOR_ID), email: "a@example.com", displayName: "A" },
});

describe("createBundleModule.get", () => {
  test("returns the mapped Bundle for a live row", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow());

    const bundle = await module.get(ctx, asBundleId(BUNDLE_ID));

    expect(bundle).toEqual({
      id: BUNDLE_ID,
      workspaceId: WORKSPACE_ID,
      slug: "onboarding",
      title: "Onboarding",
      description: "",
      okfVersion: "1.0",
      defaultTrust: "unverified",
      createdBy: ACTOR_ID,
      conceptCount: 0,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      deletedAt: null,
    });
    expect(repo.findById).toHaveBeenCalledWith(BUNDLE_ID);
  });

  test("raises NotFoundError('bundle.notFound') for an unknown id", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(null);

    try {
      await module.get(ctx, asBundleId(BUNDLE_ID));
      throw new Error("expected get to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("bundle.notFound");
      expect((err as NotFoundError).code).toBe("not_found");
    }
  });

  test("maps a non-null deletedAt to an ISO string", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findById).mockResolvedValue(makeRow({ deleted_at: NOW }));

    const bundle = await module.get(ctx, asBundleId(BUNDLE_ID));
    expect(bundle.deletedAt).toBe(NOW.toISOString());
  });
});

describe("createBundleModule.list", () => {
  test("maps an empty connection through unchanged", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.listConnection).mockResolvedValue({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });

    const connection = await module.list(ctx, WORKSPACE_ID, {});
    expect(connection.edges).toEqual([]);
    expect(connection.totalCount).toBe(0);
  });

  test("maps every edge's node from BundleRow to Bundle and preserves cursor/pageInfo", async () => {
    const { module, repo } = createModule();
    const row = makeRow();
    vi.mocked(repo.listConnection).mockResolvedValue({
      edges: [{ node: { ...row, sortKey: row.title }, cursor: "cursor-1" }],
      pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: "cursor-1", endCursor: "cursor-1" },
      totalCount: 5,
    });

    const connection = await module.list(ctx, WORKSPACE_ID, { first: 1 });
    expect(connection.edges).toEqual([{ node: expect.objectContaining({ id: BUNDLE_ID }), cursor: "cursor-1" }]);
    expect(connection.pageInfo.hasNextPage).toBe(true);
    expect(connection.totalCount).toBe(5);
    expect(repo.listConnection).toHaveBeenCalledWith(WORKSPACE_ID, { first: 1 });
  });

  test("pagination past the end still maps through an empty edge list", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.listConnection).mockResolvedValue({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: null, endCursor: null },
      totalCount: 1,
    });

    const connection = await module.list(ctx, WORKSPACE_ID, { first: 5, after: "cursor-1" });
    expect(connection.edges).toEqual([]);
    expect(connection.pageInfo.hasPreviousPage).toBe(true);
  });
});

describe("createBundleModule.create", () => {
  test("normalises the slug, defaults optional fields, and returns the mapped Bundle", async () => {
    const { module, repo, ids } = createModule();
    vi.mocked(repo.insert).mockResolvedValue(makeRow());

    const bundle = await module.create(ctx, {
      workspaceId: WORKSPACE_ID,
      slug: "  Onboarding Guide!! ",
      title: "  Onboarding  ",
    });

    expect(bundle.id).toBe(BUNDLE_ID);
    expect(repo.insert).toHaveBeenCalledWith({
      id: (ids as ReturnType<typeof createSeqIds>).issued[0],
      workspaceId: WORKSPACE_ID,
      slug: "onboarding-guide",
      title: "Onboarding",
      description: "",
      okfVersion: "1.0",
      defaultTrust: "unverified",
      createdBy: ACTOR_ID,
      createdAt: NOW,
    });
  });

  test("passes through explicit description, okfVersion and defaultTrust", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.insert).mockResolvedValue(makeRow({ default_trust: "machine_confirmed" }));

    await module.create(ctx, {
      workspaceId: WORKSPACE_ID,
      slug: "onboarding",
      title: "Onboarding",
      description: "A guide",
      okfVersion: "2.0",
      defaultTrust: "machine-confirmed",
    });

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "A guide",
        okfVersion: "2.0",
        defaultTrust: "machine_confirmed",
      }),
    );
  });

  test("raises ValidationError('bundle.invalidSlug') for a slug that normalises to empty", async () => {
    const { module } = createModule();
    await expect(
      module.create(ctx, { workspaceId: WORKSPACE_ID, slug: "!!!", title: "Onboarding" }),
    ).rejects.toThrow(ValidationError);
  });

  test("raises ValidationError('bundle.invalidTitle') for a blank title", async () => {
    const { module } = createModule();
    try {
      await module.create(ctx, { workspaceId: WORKSPACE_ID, slug: "onboarding", title: "   " });
      throw new Error("expected create to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("bundle.invalidTitle");
    }
  });

  test("maps a 23505 unique violation to ConflictError('bundle.slugTaken')", async () => {
    const { module, repo } = createModule();
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "bundles_workspace_slug_live_key"'), {
      code: "23505",
    });
    vi.mocked(repo.insert).mockRejectedValue(pgError);

    try {
      await module.create(ctx, { workspaceId: WORKSPACE_ID, slug: "onboarding", title: "Onboarding" });
      throw new Error("expected create to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toBe("bundle.slugTaken");
      expect((err as ConflictError).details).toEqual({ workspaceId: WORKSPACE_ID, slug: "onboarding" });
      expect((err as ConflictError).cause).toBe(pgError);
    }
  });

  test("rethrows a non-unique-violation error unchanged", async () => {
    const { module, repo } = createModule();
    const otherError = new Error("connection reset");
    vi.mocked(repo.insert).mockRejectedValue(otherError);

    await expect(
      module.create(ctx, { workspaceId: WORKSPACE_ID, slug: "onboarding", title: "Onboarding" }),
    ).rejects.toBe(otherError);
  });
});

describe("createBundleModule.rename", () => {
  test("returns the mapped Bundle with the new title", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.update).mockResolvedValue(makeRow({ title: "Renamed", version: 2 }));

    const bundle = await module.rename(ctx, asBundleId(BUNDLE_ID), 1, "  Renamed  ");
    expect(bundle.title).toBe("Renamed");
    expect(bundle.version).toBe(2);
    expect(repo.update).toHaveBeenCalledWith(BUNDLE_ID, 1, "Renamed", NOW);
  });

  test("raises ValidationError('bundle.invalidTitle') for an over-length title", async () => {
    const { module } = createModule();
    await expect(module.rename(ctx, asBundleId(BUNDLE_ID), 1, "x".repeat(301))).rejects.toThrow(
      ValidationError,
    );
  });

  test("propagates ConflictError('bundle.staleVersion') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const conflict = new ConflictError("bundle.staleVersion", { details: { id: BUNDLE_ID, expectedVersion: 1 } });
    vi.mocked(repo.update).mockRejectedValue(conflict);

    await expect(module.rename(ctx, asBundleId(BUNDLE_ID), 1, "Renamed")).rejects.toBe(conflict);
  });
});

describe("createBundleModule.archive", () => {
  test("returns the mapped Bundle with deletedAt set", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.softDelete).mockResolvedValue(makeRow({ deleted_at: NOW, version: 2 }));

    const bundle = await module.archive(ctx, asBundleId(BUNDLE_ID), 1);
    expect(bundle.deletedAt).toBe(NOW.toISOString());
    expect(repo.softDelete).toHaveBeenCalledWith(BUNDLE_ID, 1, NOW);
  });

  test("propagates ConflictError('bundle.staleVersion') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const conflict = new ConflictError("bundle.staleVersion", { details: { id: BUNDLE_ID, expectedVersion: 1 } });
    vi.mocked(repo.softDelete).mockRejectedValue(conflict);

    await expect(module.archive(ctx, asBundleId(BUNDLE_ID), 1)).rejects.toBe(conflict);
  });
});

describe("normalizeSlug", () => {
  test.each([
    ["Onboarding Guide", "onboarding-guide"],
    ["  spaced out  ", "spaced-out"],
    ["Already-Valid-Slug", "already-valid-slug"],
    ["multiple___separators", "multiple-separators"],
    ["--leading-and-trailing--", "leading-and-trailing"],
    ["UPPER", "upper"],
  ])("normalises %j to %j", (input, expected) => {
    expect(normalizeSlug(input)).toBe(expected);
  });

  test("raises ValidationError('bundle.invalidSlug') when the result is empty", () => {
    try {
      normalizeSlug("!!!");
      throw new Error("expected normalizeSlug to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("bundle.invalidSlug");
    }
  });

  test("raises ValidationError('bundle.invalidSlug') above the 96-character limit", () => {
    expect(() => normalizeSlug("a".repeat(97))).toThrow(ValidationError);
  });

  test("accepts a slug at exactly the 96-character limit", () => {
    const slug = "a".repeat(96);
    expect(normalizeSlug(slug)).toBe(slug);
  });
});

describe("dbTrustToDomain / domainTrustToDb", () => {
  test.each([
    ["unverified", "unverified"],
    ["machine_confirmed", "machine-confirmed"],
    ["human_reviewed", "human-reviewed"],
  ] as const)("maps db value %j to domain value %j", (dbValue, domainValue) => {
    expect(dbTrustToDomain(dbValue)).toBe(domainValue);
    expect(domainTrustToDb(domainValue)).toBe(dbValue);
  });

  test("raises ValidationError('bundle.corruptTrust') for a value outside the enum", () => {
    try {
      dbTrustToDomain("not-a-real-value");
      throw new Error("expected dbTrustToDomain to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("bundle.corruptTrust");
      expect((err as ValidationError).details).toEqual({ value: "not-a-real-value" });
    }
  });
});
