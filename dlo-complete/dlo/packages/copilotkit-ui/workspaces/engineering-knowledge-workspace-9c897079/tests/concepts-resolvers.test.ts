// tests/concepts-resolvers.test.ts — module m10 (concepts and hierarchy module). Exercises every
// resolver in concept-schema.ts against a hand-stubbed `ConceptModule` (no repository, no FakeDb)
// and every resolver in hierarchy-schema.ts against a hand-stubbed `HierarchyModule`: every
// `Concept` field resolver including global-id encoding, both Query resolvers, all three concept
// Mutation resolvers including optional-field omission, the `children`/`ancestors` field resolvers
// on `Concept`, `moveConcept`'s three `newParentId`/`afterId` shapes, and the malformed/wrong-type
// global id failure modes shared by both schema files.
import { describe, test, expect, vi } from "vitest";
import {
  conceptFieldResolvers,
  conceptMutationResolvers,
  conceptQueryResolvers,
  decodeBundleId,
  decodeConceptId,
  type ConceptGraphQLContext,
} from "../src/modules/concepts/concept-schema";
import type { ConceptModule } from "../src/modules/concepts/concept-module";
import {
  bundleHierarchyFieldResolvers,
  conceptHierarchyFieldResolvers,
  hierarchyMutationResolvers,
  type HierarchyGraphQLContext,
} from "../src/modules/hierarchy/hierarchy-schema";
import type { HierarchyModule } from "../src/modules/hierarchy/hierarchy-module";
import { createRequestContext } from "../src/core/context";
import { NotFoundError, ValidationError } from "../src/core/errors";
import { toGlobalId } from "../src/core/global-id";
import { asActorId, asBundleId, asConceptId } from "../src/core/ids";
import type { Concept } from "../src/core/types";

const BUNDLE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const CONCEPT_ID = "30000000-0000-4000-8000-000000000001";
const PARENT_ID = "30000000-0000-4000-8000-000000000002";
const OTHER_ID = "30000000-0000-4000-8000-000000000003";
const NOW_ISO = "2026-01-01T00:00:00.000Z";

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: asConceptId(CONCEPT_ID),
    bundleId: asBundleId(BUNDLE_ID),
    parentId: null,
    slug: "getting-started",
    path: "getting-started",
    title: "Getting Started",
    sortKey: "V",
    depth: 0,
    isIndex: false,
    childCount: 0,
    createdBy: asActorId(ACTOR_ID),
    version: 1,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
    ...overrides,
  };
}

function createConceptModuleStub(): ConceptModule {
  return {
    get: vi.fn(),
    getByPath: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    updateMetadata: vi.fn(),
    archive: vi.fn(),
  };
}

function createHierarchyModuleStub(): HierarchyModule {
  return {
    children: vi.fn(),
    ancestors: vi.fn(),
    move: vi.fn(),
  };
}

function createConceptContext(concepts: ConceptModule): ConceptGraphQLContext {
  const requestContext = createRequestContext({
    requestId: "req-1",
    actor: { id: asActorId(ACTOR_ID), email: "a@example.com", displayName: "A" },
  });
  return { ...requestContext, concepts };
}

function createHierarchyContext(hierarchy: HierarchyModule): HierarchyGraphQLContext {
  const requestContext = createRequestContext({
    requestId: "req-1",
    actor: { id: asActorId(ACTOR_ID), email: "a@example.com", displayName: "A" },
  });
  return { ...requestContext, hierarchy };
}

// ---------------------------------------------------------------------------
// decodeBundleId / decodeConceptId
// ---------------------------------------------------------------------------

describe("decodeBundleId / decodeConceptId", () => {
  test("decodeBundleId round-trips a Bundle global id", () => {
    expect(decodeBundleId(toGlobalId("Bundle", BUNDLE_ID))).toBe(BUNDLE_ID);
  });

  test("decodeBundleId raises ValidationError('globalId.wrongType') for a Concept id", () => {
    try {
      decodeBundleId(toGlobalId("Concept", CONCEPT_ID));
      throw new Error("expected decodeBundleId to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("globalId.wrongType");
    }
  });

  test("decodeConceptId round-trips a Concept global id", () => {
    expect(decodeConceptId(toGlobalId("Concept", CONCEPT_ID))).toBe(CONCEPT_ID);
  });

  test("decodeConceptId raises ValidationError('globalId.wrongType') for a Bundle id", () => {
    try {
      decodeConceptId(toGlobalId("Bundle", BUNDLE_ID));
      throw new Error("expected decodeConceptId to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("globalId.wrongType");
    }
  });

  test("raises ValidationError('globalId.malformed') for a non-base64 id", () => {
    expect(() => decodeConceptId("not valid base64!!")).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// conceptFieldResolvers
// ---------------------------------------------------------------------------

describe("conceptFieldResolvers", () => {
  test("id encodes the branded ConceptId as a Relay global id", () => {
    const concept = makeConcept();
    expect(conceptFieldResolvers.id(concept)).toBe(toGlobalId("Concept", CONCEPT_ID));
  });

  test("bundleId encodes the branded BundleId as a Relay global id", () => {
    const concept = makeConcept();
    expect(conceptFieldResolvers.bundleId(concept)).toBe(toGlobalId("Bundle", BUNDLE_ID));
  });

  test("parentId is null for a root concept", () => {
    const concept = makeConcept({ parentId: null });
    expect(conceptFieldResolvers.parentId(concept)).toBeNull();
  });

  test("parentId encodes a non-null parent as a Relay global id", () => {
    const concept = makeConcept({ parentId: asConceptId(PARENT_ID) });
    expect(conceptFieldResolvers.parentId(concept)).toBe(toGlobalId("Concept", PARENT_ID));
  });

  test("slug, path, title, sortKey pass through unchanged", () => {
    const concept = makeConcept();
    expect(conceptFieldResolvers.slug(concept)).toBe("getting-started");
    expect(conceptFieldResolvers.path(concept)).toBe("getting-started");
    expect(conceptFieldResolvers.title(concept)).toBe("Getting Started");
    expect(conceptFieldResolvers.sortKey(concept)).toBe("V");
  });

  test("depth, isIndex, childCount, version pass through as their raw types", () => {
    const concept = makeConcept({ depth: 3, isIndex: true, childCount: 7, version: 2 });
    expect(conceptFieldResolvers.depth(concept)).toBe(3);
    expect(conceptFieldResolvers.isIndex(concept)).toBe(true);
    expect(conceptFieldResolvers.childCount(concept)).toBe(7);
    expect(conceptFieldResolvers.version(concept)).toBe(2);
  });

  test("createdAt and updatedAt pass through the ISO strings unchanged", () => {
    const concept = makeConcept({ createdAt: "2026-02-03T04:05:06.000Z", updatedAt: "2026-02-04T00:00:00.000Z" });
    expect(conceptFieldResolvers.createdAt(concept)).toBe("2026-02-03T04:05:06.000Z");
    expect(conceptFieldResolvers.updatedAt(concept)).toBe("2026-02-04T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// conceptQueryResolvers
// ---------------------------------------------------------------------------

describe("conceptQueryResolvers.concept", () => {
  test("decodes both global ids and delegates to ConceptModule.get", async () => {
    const module = createConceptModuleStub();
    const concept = makeConcept();
    vi.mocked(module.get).mockResolvedValue(concept);
    const ctx = createConceptContext(module);

    const result = await conceptQueryResolvers.concept(
      undefined,
      { bundleId: toGlobalId("Bundle", BUNDLE_ID), id: toGlobalId("Concept", CONCEPT_ID) },
      ctx,
    );

    expect(result).toBe(concept);
    expect(module.get).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID));
  });

  test("raises ValidationError('globalId.wrongType') when bundleId is actually a Concept id", async () => {
    const module = createConceptModuleStub();
    const ctx = createConceptContext(module);

    await expect(
      conceptQueryResolvers.concept(
        undefined,
        { bundleId: toGlobalId("Concept", CONCEPT_ID), id: toGlobalId("Concept", CONCEPT_ID) },
        ctx,
      ),
    ).rejects.toThrow(ValidationError);
  });

  test("propagates NotFoundError from ConceptModule.get unchanged", async () => {
    const module = createConceptModuleStub();
    const notFound = new ValidationError("concept.notFound");
    vi.mocked(module.get).mockRejectedValue(notFound);
    const ctx = createConceptContext(module);

    await expect(
      conceptQueryResolvers.concept(
        undefined,
        { bundleId: toGlobalId("Bundle", BUNDLE_ID), id: toGlobalId("Concept", CONCEPT_ID) },
        ctx,
      ),
    ).rejects.toBe(notFound);
  });
});

describe("conceptQueryResolvers.conceptByPath", () => {
  test("decodes bundleId and delegates to ConceptModule.getByPath", async () => {
    const module = createConceptModuleStub();
    const concept = makeConcept();
    vi.mocked(module.getByPath).mockResolvedValue(concept);
    const ctx = createConceptContext(module);

    const result = await conceptQueryResolvers.conceptByPath(
      undefined,
      { bundleId: toGlobalId("Bundle", BUNDLE_ID), path: "getting-started" },
      ctx,
    );

    expect(result).toBe(concept);
    expect(module.getByPath).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), "getting-started");
  });
});

// ---------------------------------------------------------------------------
// Nullable-field semantics
//
// `concept` and `conceptByPath` are declared nullable in concept-schema.graphql
// (`Concept`, not `Concept!`), but ConceptModule.get/getByPath signal absence by throwing
// NotFoundError('concept.notFound') — their documented contract. Without translating that to
// null, the nullable field could never be null and one missing concept failed the whole
// operation. The bundle route asks for `conceptByPath(path: "index")` to find a landing concept,
// bundles are not required to have one, and every bundle without an `index` concept rendered
// "Couldn't load this bundle — concept.notFound" instead of its concept tree.
// ---------------------------------------------------------------------------

describe("conceptQueryResolvers — absent concepts resolve to null", () => {
  test("conceptByPath returns null when the path has no concept", async () => {
    const module = createConceptModuleStub();
    vi.mocked(module.getByPath).mockRejectedValue(new NotFoundError("concept.notFound"));
    const ctx = createConceptContext(module);

    await expect(
      conceptQueryResolvers.conceptByPath(
        undefined,
        { bundleId: toGlobalId("Bundle", BUNDLE_ID), path: "index" },
        ctx,
      ),
    ).resolves.toBeNull();
  });

  test("concept returns null when the id has no concept", async () => {
    const module = createConceptModuleStub();
    vi.mocked(module.get).mockRejectedValue(new NotFoundError("concept.notFound"));
    const ctx = createConceptContext(module);

    await expect(
      conceptQueryResolvers.concept(
        undefined,
        { bundleId: toGlobalId("Bundle", BUNDLE_ID), id: toGlobalId("Concept", CONCEPT_ID) },
        ctx,
      ),
    ).resolves.toBeNull();
  });

  test("a NotFoundError for something OTHER than the concept still propagates", async () => {
    // A missing bundle is not "this field is empty" — it must fail the operation.
    const module = createConceptModuleStub();
    const bundleMissing = new NotFoundError("bundle.notFound");
    vi.mocked(module.getByPath).mockRejectedValue(bundleMissing);
    const ctx = createConceptContext(module);

    await expect(
      conceptQueryResolvers.conceptByPath(
        undefined,
        { bundleId: toGlobalId("Bundle", BUNDLE_ID), path: "index" },
        ctx,
      ),
    ).rejects.toBe(bundleMissing);
  });

  test("a non-NotFound error propagates unchanged", async () => {
    const module = createConceptModuleStub();
    const dbFailure = new Error("connection terminated unexpectedly");
    vi.mocked(module.getByPath).mockRejectedValue(dbFailure);
    const ctx = createConceptContext(module);

    await expect(
      conceptQueryResolvers.conceptByPath(
        undefined,
        { bundleId: toGlobalId("Bundle", BUNDLE_ID), path: "index" },
        ctx,
      ),
    ).rejects.toBe(dbFailure);
  });

  test("a ValidationError from decoding is raised before the module is consulted", async () => {
    const module = createConceptModuleStub();
    const ctx = createConceptContext(module);

    await expect(
      conceptQueryResolvers.conceptByPath(
        undefined,
        { bundleId: toGlobalId("Concept", CONCEPT_ID), path: "index" },
        ctx,
      ),
    ).rejects.toThrow(ValidationError);
    expect(module.getByPath).not.toHaveBeenCalled();
  });

  test("a found concept is still returned, not nulled", async () => {
    const module = createConceptModuleStub();
    const concept = makeConcept();
    vi.mocked(module.getByPath).mockResolvedValue(concept);
    const ctx = createConceptContext(module);

    await expect(
      conceptQueryResolvers.conceptByPath(
        undefined,
        { bundleId: toGlobalId("Bundle", BUNDLE_ID), path: "index" },
        ctx,
      ),
    ).resolves.toBe(concept);
  });
});

describe("conceptQueryResolvers.concepts", () => {
  test("passes bundleId through with no pagination args", async () => {
    const module = createConceptModuleStub();
    const emptyConnection = {
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    };
    vi.mocked(module.list).mockResolvedValue(emptyConnection);
    const ctx = createConceptContext(module);

    const result = await conceptQueryResolvers.concepts(undefined, { bundleId: toGlobalId("Bundle", BUNDLE_ID) }, ctx);

    expect(result).toBe(emptyConnection);
    expect(module.list).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), {});
  });

  test("only forwards the pagination args that were actually supplied", async () => {
    const module = createConceptModuleStub();
    vi.mocked(module.list).mockResolvedValue({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });
    const ctx = createConceptContext(module);

    await conceptQueryResolvers.concepts(
      undefined,
      { bundleId: toGlobalId("Bundle", BUNDLE_ID), first: 10, after: "cur-1" },
      ctx,
    );

    expect(module.list).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), { first: 10, after: "cur-1" });
  });
});

// ---------------------------------------------------------------------------
// conceptMutationResolvers
// ---------------------------------------------------------------------------

describe("conceptMutationResolvers.createConcept", () => {
  test("builds the domain input with a null parentId, omitting isIndex when not supplied", async () => {
    const module = createConceptModuleStub();
    const concept = makeConcept();
    vi.mocked(module.create).mockResolvedValue(concept);
    const ctx = createConceptContext(module);

    const result = await conceptMutationResolvers.createConcept(
      undefined,
      { input: { bundleId: toGlobalId("Bundle", BUNDLE_ID), slug: "getting-started", title: "Getting Started" } },
      ctx,
    );

    expect(result).toEqual({ concept });
    expect(module.create).toHaveBeenCalledWith(ctx, {
      bundleId: asBundleId(BUNDLE_ID),
      parentId: null,
      slug: "getting-started",
      title: "Getting Started",
    });
  });

  test("decodes a supplied parentId and passes through isIndex", async () => {
    const module = createConceptModuleStub();
    vi.mocked(module.create).mockResolvedValue(makeConcept());
    const ctx = createConceptContext(module);

    await conceptMutationResolvers.createConcept(
      undefined,
      {
        input: {
          bundleId: toGlobalId("Bundle", BUNDLE_ID),
          parentId: toGlobalId("Concept", PARENT_ID),
          slug: "getting-started",
          title: "Getting Started",
          isIndex: true,
        },
      },
      ctx,
    );

    expect(module.create).toHaveBeenCalledWith(ctx, {
      bundleId: asBundleId(BUNDLE_ID),
      parentId: asConceptId(PARENT_ID),
      slug: "getting-started",
      title: "Getting Started",
      isIndex: true,
    });
  });
});

describe("conceptMutationResolvers.updateConceptMetadata", () => {
  test("only forwards the patch fields that were actually supplied", async () => {
    const module = createConceptModuleStub();
    const concept = makeConcept({ title: "Renamed" });
    vi.mocked(module.updateMetadata).mockResolvedValue(concept);
    const ctx = createConceptContext(module);

    const result = await conceptMutationResolvers.updateConceptMetadata(
      undefined,
      {
        input: {
          bundleId: toGlobalId("Bundle", BUNDLE_ID),
          id: toGlobalId("Concept", CONCEPT_ID),
          expectedVersion: 1,
          title: "Renamed",
        },
      },
      ctx,
    );

    expect(result).toEqual({ concept });
    expect(module.updateMetadata).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      title: "Renamed",
    });
  });

  test("forwards both title and isIndex when both are supplied", async () => {
    const module = createConceptModuleStub();
    vi.mocked(module.updateMetadata).mockResolvedValue(makeConcept());
    const ctx = createConceptContext(module);

    await conceptMutationResolvers.updateConceptMetadata(
      undefined,
      {
        input: {
          bundleId: toGlobalId("Bundle", BUNDLE_ID),
          id: toGlobalId("Concept", CONCEPT_ID),
          expectedVersion: 1,
          title: "Renamed",
          isIndex: true,
        },
      },
      ctx,
    );

    expect(module.updateMetadata).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      title: "Renamed",
      isIndex: true,
    });
  });
});

describe("conceptMutationResolvers.archiveConcept", () => {
  test("decodes both ids and delegates to ConceptModule.archive", async () => {
    const module = createConceptModuleStub();
    const concept = makeConcept({ deletedAt: NOW_ISO });
    vi.mocked(module.archive).mockResolvedValue(concept);
    const ctx = createConceptContext(module);

    const result = await conceptMutationResolvers.archiveConcept(
      undefined,
      { input: { bundleId: toGlobalId("Bundle", BUNDLE_ID), id: toGlobalId("Concept", CONCEPT_ID), expectedVersion: 1 } },
      ctx,
    );

    expect(result).toEqual({ concept });
    expect(module.archive).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1);
  });
});

// ---------------------------------------------------------------------------
// conceptHierarchyFieldResolvers (children / ancestors on Concept)
// ---------------------------------------------------------------------------

describe("conceptHierarchyFieldResolvers.children", () => {
  test("scopes the lookup by the source concept's own bundleId and id, with no pagination args", async () => {
    const module = createHierarchyModuleStub();
    const emptyConnection = {
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    };
    vi.mocked(module.children).mockResolvedValue(emptyConnection);
    const ctx = createHierarchyContext(module);
    const source = makeConcept();

    const result = await conceptHierarchyFieldResolvers.children(source, {}, ctx);

    expect(result).toBe(emptyConnection);
    expect(module.children).toHaveBeenCalledWith(ctx, source.bundleId, source.id, {});
  });

  test("only forwards the pagination args that were actually supplied", async () => {
    const module = createHierarchyModuleStub();
    vi.mocked(module.children).mockResolvedValue({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });
    const ctx = createHierarchyContext(module);
    const source = makeConcept();

    await conceptHierarchyFieldResolvers.children(source, { first: 20, before: "cur-9" }, ctx);

    expect(module.children).toHaveBeenCalledWith(ctx, source.bundleId, source.id, { first: 20, before: "cur-9" });
  });
});

// ---------------------------------------------------------------------------
// bundleHierarchyFieldResolvers.children (Bundle.children)
//
// `HierarchyModule.children` has always taken `null` for "bundle root"; nothing exposed it through
// GraphQL. `Concept.children` needs a source Concept, so the sidebar tree had no root to expand and
// its caller invented one by looking up `conceptByPath(bundleId, "index")`. A bundle is not
// required to have a concept at that path — none of the seeded ones do — and every such bundle
// rendered an empty sidebar next to a full concept list.
// ---------------------------------------------------------------------------

describe("bundleHierarchyFieldResolvers.children", () => {
  const emptyConnection = {
    edges: [],
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: 0,
  };

  test("asks for the bundle's root level by passing a null parentId", async () => {
    const module = createHierarchyModuleStub();
    vi.mocked(module.children).mockResolvedValue(emptyConnection);
    const ctx = createHierarchyContext(module);

    const result = await bundleHierarchyFieldResolvers.children({ id: asBundleId(BUNDLE_ID) }, {}, ctx);

    expect(result).toBe(emptyConnection);
    expect(module.children).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), null, {});
  });

  test("forwards the pagination args that were supplied", async () => {
    const module = createHierarchyModuleStub();
    vi.mocked(module.children).mockResolvedValue(emptyConnection);
    const ctx = createHierarchyContext(module);

    await bundleHierarchyFieldResolvers.children(
      { id: asBundleId(BUNDLE_ID) },
      { first: 25, after: "cur-1" },
      ctx,
    );

    expect(module.children).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), null, {
      first: 25,
      after: "cur-1",
    });
  });

  test("treats an explicit null cursor as absent — Relay sends after: null for the first page", async () => {
    // Passing that null straight through reached the cursor decoder and failed the request with
    // `cursor.malformed`, so the first page of any Relay-driven connection could never load.
    const module = createHierarchyModuleStub();
    vi.mocked(module.children).mockResolvedValue(emptyConnection);
    const ctx = createHierarchyContext(module);

    await bundleHierarchyFieldResolvers.children(
      { id: asBundleId(BUNDLE_ID) },
      { first: 25, after: null, last: null, before: null } as never,
      ctx,
    );

    expect(module.children).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), null, { first: 25 });
  });

  test("Concept.children treats an explicit null cursor as absent too", async () => {
    const module = createHierarchyModuleStub();
    vi.mocked(module.children).mockResolvedValue(emptyConnection);
    const ctx = createHierarchyContext(module);
    const source = makeConcept();

    await conceptHierarchyFieldResolvers.children(source, { first: 25, after: null } as never, ctx);

    expect(module.children).toHaveBeenCalledWith(ctx, source.bundleId, source.id, { first: 25 });
  });
});

describe("conceptHierarchyFieldResolvers.ancestors", () => {
  test("scopes the lookup by the source concept's own bundleId and id", async () => {
    const module = createHierarchyModuleStub();
    const ancestors = [makeConcept({ id: asConceptId(PARENT_ID), depth: 0 })];
    vi.mocked(module.ancestors).mockResolvedValue(ancestors);
    const ctx = createHierarchyContext(module);
    const source = makeConcept();

    const result = await conceptHierarchyFieldResolvers.ancestors(source, {}, ctx);

    expect(result).toBe(ancestors);
    expect(module.ancestors).toHaveBeenCalledWith(ctx, source.bundleId, source.id);
  });
});

// ---------------------------------------------------------------------------
// hierarchyMutationResolvers.moveConcept
// ---------------------------------------------------------------------------

describe("hierarchyMutationResolvers.moveConcept", () => {
  test("newParentId omitted and afterId omitted: moves to bundle root, appended as last child", async () => {
    const module = createHierarchyModuleStub();
    const concept = makeConcept({ parentId: null });
    vi.mocked(module.move).mockResolvedValue(concept);
    const ctx = createHierarchyContext(module);

    const result = await hierarchyMutationResolvers.moveConcept(
      undefined,
      { input: { bundleId: toGlobalId("Bundle", BUNDLE_ID), id: toGlobalId("Concept", CONCEPT_ID), expectedVersion: 1 } },
      ctx,
    );

    expect(result).toEqual({ concept });
    expect(module.move).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      newParentId: null,
    });
  });

  test("newParentId supplied and afterId explicitly null: reparents and prepends", async () => {
    const module = createHierarchyModuleStub();
    vi.mocked(module.move).mockResolvedValue(makeConcept({ parentId: asConceptId(PARENT_ID) }));
    const ctx = createHierarchyContext(module);

    await hierarchyMutationResolvers.moveConcept(
      undefined,
      {
        input: {
          bundleId: toGlobalId("Bundle", BUNDLE_ID),
          id: toGlobalId("Concept", CONCEPT_ID),
          expectedVersion: 1,
          newParentId: toGlobalId("Concept", PARENT_ID),
          afterId: null,
        },
      },
      ctx,
    );

    expect(module.move).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      newParentId: asConceptId(PARENT_ID),
      afterId: null,
    });
  });

  test("afterId supplied as a concrete id: decodes it and inserts after that sibling", async () => {
    const module = createHierarchyModuleStub();
    vi.mocked(module.move).mockResolvedValue(makeConcept());
    const ctx = createHierarchyContext(module);

    await hierarchyMutationResolvers.moveConcept(
      undefined,
      {
        input: {
          bundleId: toGlobalId("Bundle", BUNDLE_ID),
          id: toGlobalId("Concept", CONCEPT_ID),
          expectedVersion: 1,
          afterId: toGlobalId("Concept", OTHER_ID),
        },
      },
      ctx,
    );

    expect(module.move).toHaveBeenCalledWith(ctx, asBundleId(BUNDLE_ID), asConceptId(CONCEPT_ID), 1, {
      newParentId: null,
      afterId: asConceptId(OTHER_ID),
    });
  });

  test("propagates ValidationError('hierarchy.cycle') from HierarchyModule.move unchanged", async () => {
    const module = createHierarchyModuleStub();
    const cycle = new ValidationError("hierarchy.cycle");
    vi.mocked(module.move).mockRejectedValue(cycle);
    const ctx = createHierarchyContext(module);

    await expect(
      hierarchyMutationResolvers.moveConcept(
        undefined,
        { input: { bundleId: toGlobalId("Bundle", BUNDLE_ID), id: toGlobalId("Concept", CONCEPT_ID), expectedVersion: 1 } },
        ctx,
      ),
    ).rejects.toBe(cycle);
  });
});
