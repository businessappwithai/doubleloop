// tests/bundles-resolvers.test.ts — module m9 (bundles module). Exercises every resolver in
// bundle-schema.ts against a hand-stubbed `BundleModule` (no repository, no FakeDb): every
// `Bundle` field resolver including the global-id encoding and the TrustLevel enum translation in
// both directions, both Query resolvers, all three Mutation resolvers including optional-field
// omission, and the malformed/wrong-type global id failure modes.
import { describe, test, expect, vi } from "vitest";
import {
  bundleFieldResolvers,
  bundleMutationResolvers,
  bundleQueryResolvers,
  trustLevelFromGraphQL,
  trustLevelToGraphQL,
  type BundleGraphQLContext,
} from "../src/modules/bundles/bundle-schema";
import type { BundleModule } from "../src/modules/bundles/bundle-module";
import { createRequestContext } from "../src/core/context";
import { ValidationError } from "../src/core/errors";
import { toGlobalId } from "../src/core/global-id";
import { asActorId, asBundleId, asConceptId } from "../src/core/ids";
import type { Bundle } from "../src/core/types";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "30000000-0000-4000-8000-000000000001";
const NOW_ISO = "2026-01-01T00:00:00.000Z";

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: asBundleId(BUNDLE_ID),
    workspaceId: WORKSPACE_ID,
    slug: "onboarding",
    title: "Onboarding",
    description: "A guide",
    okfVersion: "1.0",
    defaultTrust: "unverified",
    createdBy: asActorId(ACTOR_ID),
    conceptCount: 3,
    version: 1,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
    ...overrides,
  };
}

function createModuleStub(): BundleModule {
  return {
    get: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
  };
}

function createContext(bundles: BundleModule): BundleGraphQLContext {
  const requestContext = createRequestContext({
    requestId: "req-1",
    actor: { id: asActorId(ACTOR_ID), email: "a@example.com", displayName: "A" },
  });
  return { ...requestContext, bundles };
}

describe("bundleFieldResolvers", () => {
  test("id encodes the branded BundleId as a Relay global id", () => {
    const bundle = makeBundle();
    expect(bundleFieldResolvers.id(bundle)).toBe(toGlobalId("Bundle", BUNDLE_ID));
  });

  test("workspaceId, slug, title, description, okfVersion pass through unchanged", () => {
    const bundle = makeBundle();
    expect(bundleFieldResolvers.workspaceId(bundle)).toBe(WORKSPACE_ID);
    expect(bundleFieldResolvers.slug(bundle)).toBe("onboarding");
    expect(bundleFieldResolvers.title(bundle)).toBe("Onboarding");
    expect(bundleFieldResolvers.description(bundle)).toBe("A guide");
    expect(bundleFieldResolvers.okfVersion(bundle)).toBe("1.0");
  });

  test.each([
    ["unverified", "UNVERIFIED"],
    ["machine-confirmed", "MACHINE_CONFIRMED"],
    ["human-reviewed", "HUMAN_REVIEWED"],
  ] as const)("defaultTrust converts domain value %j to enum name %j", (domainValue, enumName) => {
    const bundle = makeBundle({ defaultTrust: domainValue });
    expect(bundleFieldResolvers.defaultTrust(bundle)).toBe(enumName);
  });

  test("conceptCount and version pass through as numbers", () => {
    const bundle = makeBundle({ conceptCount: 42, version: 7 });
    expect(bundleFieldResolvers.conceptCount(bundle)).toBe(42);
    expect(bundleFieldResolvers.version(bundle)).toBe(7);
  });

  test("createdAt and updatedAt pass through the ISO strings unchanged", () => {
    const bundle = makeBundle({ createdAt: "2026-02-03T04:05:06.000Z", updatedAt: "2026-02-04T00:00:00.000Z" });
    expect(bundleFieldResolvers.createdAt(bundle)).toBe("2026-02-03T04:05:06.000Z");
    expect(bundleFieldResolvers.updatedAt(bundle)).toBe("2026-02-04T00:00:00.000Z");
  });
});

describe("trustLevelToGraphQL / trustLevelFromGraphQL", () => {
  test("round-trips every TrustLevel", () => {
    for (const value of ["unverified", "machine-confirmed", "human-reviewed"] as const) {
      expect(trustLevelFromGraphQL(trustLevelToGraphQL(value))).toBe(value);
    }
  });

  test("raises ValidationError('bundle.invalidTrustLevel') for an unknown enum name", () => {
    try {
      trustLevelFromGraphQL("NOT_A_REAL_VALUE");
      throw new Error("expected trustLevelFromGraphQL to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("bundle.invalidTrustLevel");
    }
  });
});

describe("bundleQueryResolvers.bundle", () => {
  test("decodes the global id and delegates to BundleModule.get", async () => {
    const module = createModuleStub();
    const bundle = makeBundle();
    vi.mocked(module.get).mockResolvedValue(bundle);
    const ctx = createContext(module);

    const result = await bundleQueryResolvers.bundle(undefined, { id: toGlobalId("Bundle", BUNDLE_ID) }, ctx);

    expect(result).toBe(bundle);
    expect(module.get).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID));
  });

  test("raises ValidationError('globalId.wrongType') for a Concept id", async () => {
    const module = createModuleStub();
    const ctx = createContext(module);
    const conceptGlobalId = toGlobalId("Concept", asConceptId("40000000-0000-4000-8000-000000000001"));

    try {
      await bundleQueryResolvers.bundle(undefined, { id: conceptGlobalId }, ctx);
      throw new Error("expected resolveBundle to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("globalId.wrongType");
    }
  });

  test("propagates NotFoundError from BundleModule.get unchanged", async () => {
    const module = createModuleStub();
    const notFound = new ValidationError("bundle.notFound");
    vi.mocked(module.get).mockRejectedValue(notFound);
    const ctx = createContext(module);

    await expect(
      bundleQueryResolvers.bundle(undefined, { id: toGlobalId("Bundle", BUNDLE_ID) }, ctx),
    ).rejects.toBe(notFound);
  });
});

describe("bundleQueryResolvers.bundles", () => {
  test("passes workspaceId through with no pagination args", async () => {
    const module = createModuleStub();
    const emptyConnection = {
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    };
    vi.mocked(module.list).mockResolvedValue(emptyConnection);
    const ctx = createContext(module);

    const result = await bundleQueryResolvers.bundles(undefined, { workspaceId: WORKSPACE_ID }, ctx);

    expect(result).toBe(emptyConnection);
    expect(module.list).toHaveBeenCalledWith(ctx, WORKSPACE_ID, {});
  });

  test("only forwards the pagination args that were actually supplied", async () => {
    const module = createModuleStub();
    vi.mocked(module.list).mockResolvedValue({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });
    const ctx = createContext(module);

    await bundleQueryResolvers.bundles(undefined, { workspaceId: WORKSPACE_ID, first: 10, after: "cur-1" }, ctx);

    expect(module.list).toHaveBeenCalledWith(ctx, WORKSPACE_ID, { first: 10, after: "cur-1" });
  });
});

describe("bundleMutationResolvers.createBundle", () => {
  test("builds the domain input, omitting fields that were not supplied", async () => {
    const module = createModuleStub();
    const bundle = makeBundle();
    vi.mocked(module.create).mockResolvedValue(bundle);
    const ctx = createContext(module);

    const result = await bundleMutationResolvers.createBundle(
      undefined,
      { input: { workspaceId: WORKSPACE_ID, slug: "onboarding", title: "Onboarding" } },
      ctx,
    );

    expect(result).toEqual({ bundle });
    expect(module.create).toHaveBeenCalledWith(ctx, {
      workspaceId: WORKSPACE_ID,
      slug: "onboarding",
      title: "Onboarding",
    });
  });

  test("converts a supplied defaultTrust enum name to the domain value", async () => {
    const module = createModuleStub();
    vi.mocked(module.create).mockResolvedValue(makeBundle());
    const ctx = createContext(module);

    await bundleMutationResolvers.createBundle(
      undefined,
      {
        input: {
          workspaceId: WORKSPACE_ID,
          slug: "onboarding",
          title: "Onboarding",
          description: "A guide",
          okfVersion: "2.0",
          defaultTrust: "MACHINE_CONFIRMED",
        },
      },
      ctx,
    );

    expect(module.create).toHaveBeenCalledWith(ctx, {
      workspaceId: WORKSPACE_ID,
      slug: "onboarding",
      title: "Onboarding",
      description: "A guide",
      okfVersion: "2.0",
      defaultTrust: "machine-confirmed",
    });
  });
});

describe("bundleMutationResolvers.renameBundle", () => {
  test("decodes the id and delegates to BundleModule.rename", async () => {
    const module = createModuleStub();
    const bundle = makeBundle({ title: "Renamed" });
    vi.mocked(module.rename).mockResolvedValue(bundle);
    const ctx = createContext(module);

    const result = await bundleMutationResolvers.renameBundle(
      undefined,
      { input: { id: toGlobalId("Bundle", BUNDLE_ID), expectedVersion: 1, title: "Renamed" } },
      ctx,
    );

    expect(result).toEqual({ bundle });
    expect(module.rename).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), 1, "Renamed");
  });
});

describe("bundleMutationResolvers.archiveBundle", () => {
  test("decodes the id and delegates to BundleModule.archive", async () => {
    const module = createModuleStub();
    const bundle = makeBundle({ deletedAt: NOW_ISO });
    vi.mocked(module.archive).mockResolvedValue(bundle);
    const ctx = createContext(module);

    const result = await bundleMutationResolvers.archiveBundle(
      undefined,
      { input: { id: toGlobalId("Bundle", BUNDLE_ID), expectedVersion: 1 } },
      ctx,
    );

    expect(result).toEqual({ bundle });
    expect(module.archive).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), 1);
  });
});
