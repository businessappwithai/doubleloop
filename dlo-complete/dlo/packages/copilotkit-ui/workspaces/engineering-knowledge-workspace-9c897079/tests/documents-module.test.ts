// tests/documents-module.test.ts — module m11 (documents). Exercises `createDocumentModule`
// against a hand-stubbed `DocumentRepository` (no SQL, no FakeDb) plus the deterministic
// `SeqIds` from tests/helpers/fake-ports.ts. Covers create/load/applyCrdtUpdate/save/renderMarkdown
// happy paths on real returned records, `NotFoundError` propagation, a corrupt JSONB payload
// raising `ValidationError('document.corruptPayload')` instead of being coerced, a stale-version
// conflict passed through unchanged, and that every write records a `concept_revisions` snapshot.
import { describe, test, expect, vi } from "vitest";
import { createSeqIds } from "./helpers/fake-ports";
import { createDocumentModule, type DocumentModuleDeps } from "../src/modules/documents/document-module";
import type { ConceptDocumentRow, DocumentRepository } from "../src/modules/documents/document-repository";
import { asActorId, asBundleId, asConceptId, asRevisionId } from "../src/core/ids";
import { ConflictError, NotFoundError, ValidationError } from "../src/core/errors";
import { EMPTY_BLOCK_PAYLOAD, type BlockPayload } from "../src/modules/documents/blocks";
import type { Logger } from "../src/server/ports";

const CONCEPT_ID = asConceptId("30000000-0000-4000-8000-000000000001");
const BUNDLE_ID = asBundleId("10000000-0000-4000-8000-000000000001");
const ACTOR_ID = asActorId("20000000-0000-4000-8000-000000000001");
const REVISION_ID = "40000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-01-01T00:00:00.000Z").toISOString();

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

function makeRow(overrides: Partial<ConceptDocumentRow> = {}): ConceptDocumentRow {
  return {
    conceptId: CONCEPT_ID,
    bundleId: BUNDLE_ID,
    crdtState: new Uint8Array(),
    crdtStateVector: new Uint8Array([1, 2, 3]),
    contentBlocks: EMPTY_BLOCK_PAYLOAD,
    bodyMarkdown: "",
    bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    blockCount: 0,
    wordCount: 0,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createRepoStub(): DocumentRepository {
  return {
    findByConceptId: vi.fn(),
    create: vi.fn(),
    appendUpdate: vi.fn(),
    writeContent: vi.fn(),
    findByContentContainment: vi.fn(),
    insertRevision: vi.fn(),
  };
}

function createModule(overrides: Partial<DocumentModuleDeps> = {}) {
  const repo = overrides.repo ?? createRepoStub();
  const ids = overrides.ids ?? createSeqIds();
  const logger = overrides.logger ?? createSilentLogger();
  return { module: createDocumentModule({ repo, ids, logger }), repo, ids, logger };
}

describe("createDocumentModule.create", () => {
  test("returns the mapped ConceptDocument for a newly created row", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.create).mockResolvedValue(makeRow());

    const document = await module.create({ conceptId: CONCEPT_ID, bundleId: BUNDLE_ID });

    expect(document).toEqual({
      conceptId: CONCEPT_ID,
      bundleId: BUNDLE_ID,
      contentBlocks: EMPTY_BLOCK_PAYLOAD,
      bodyMarkdown: "",
      bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      blockCount: 0,
      wordCount: 0,
      crdtStateVectorB64: Buffer.from([1, 2, 3]).toString("base64"),
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(repo.create).toHaveBeenCalledWith({ conceptId: CONCEPT_ID, bundleId: BUNDLE_ID });
  });

  test("propagates ConflictError('document.alreadyExists') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const conflict = new ConflictError("document.alreadyExists", {
      details: { reason: "document.alreadyExists", conceptId: CONCEPT_ID },
    });
    vi.mocked(repo.create).mockRejectedValue(conflict);

    await expect(module.create({ conceptId: CONCEPT_ID, bundleId: BUNDLE_ID })).rejects.toBe(conflict);
  });
});

describe("createDocumentModule.load", () => {
  test("returns the mapped ConceptDocument for an existing row", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByConceptId).mockResolvedValue(makeRow({ version: 3 }));

    const document = await module.load(CONCEPT_ID);
    expect(document.version).toBe(3);
    expect(repo.findByConceptId).toHaveBeenCalledWith(CONCEPT_ID);
  });

  test("raises NotFoundError('document.notFound') when no row exists", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByConceptId).mockResolvedValue(null);

    try {
      await module.load(CONCEPT_ID);
      throw new Error("expected load to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).details["reason"]).toBe("document.notFound");
    }
  });

  test("raises ValidationError('document.corruptPayload') when content_blocks fails the block schema", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByConceptId).mockResolvedValue(makeRow({ contentBlocks: { not: "a valid payload" } }));

    try {
      await module.load(CONCEPT_ID);
      throw new Error("expected load to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("document.corruptPayload");
      expect((err as ValidationError).details["reason"]).toBe("document.corruptPayload");
      expect((err as ValidationError).details["conceptId"]).toBe(CONCEPT_ID);
      expect(Array.isArray((err as ValidationError).details["issues"])).toBe(true);
    }
  });

  test("raises ValidationError('document.corruptPayload') when content_blocks is null", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByConceptId).mockResolvedValue(makeRow({ contentBlocks: null }));

    await expect(module.load(CONCEPT_ID)).rejects.toThrow(ValidationError);
  });
});

describe("createDocumentModule.applyCrdtUpdate", () => {
  test("merges the update, returns the mapped document, and records a revision", async () => {
    const { module, repo, ids } = createModule();
    const payload: BlockPayload = { root: { type: "root", children: [{ type: "paragraph", text: "hi" }] } };
    const updatedRow = makeRow({ version: 2, contentBlocks: payload, bodyMarkdown: "hi\n", blockCount: 1, wordCount: 1 });
    vi.mocked(repo.appendUpdate).mockResolvedValue(updatedRow);
    vi.mocked(repo.insertRevision).mockResolvedValue({
      id: asRevisionId(REVISION_ID),
      conceptId: CONCEPT_ID,
      revisionNo: 2,
      source: "editor",
      createdAt: NOW,
    });

    const update = new Uint8Array([9, 9, 9]);
    const document = await module.applyCrdtUpdate({
      conceptId: CONCEPT_ID,
      title: "A Concept",
      update,
      expectedVersion: 1,
      actorId: ACTOR_ID,
    });

    expect(document.version).toBe(2);
    expect(document.contentBlocks).toEqual(payload);
    expect(repo.appendUpdate).toHaveBeenCalledWith({ conceptId: CONCEPT_ID, update, expectedVersion: 1 });
    expect(repo.insertRevision).toHaveBeenCalledWith({
      id: (ids as ReturnType<typeof createSeqIds>).issued[0],
      conceptId: CONCEPT_ID,
      revisionNo: 2,
      source: "editor",
      title: "A Concept",
      bodyMarkdown: "hi\n",
      frontmatter: {},
      contentBlocks: payload,
      bodySha256: updatedRow.bodySha256,
      authorId: ACTOR_ID,
    });
  });

  test("uses the explicit source and frontmatter when provided", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.appendUpdate).mockResolvedValue(makeRow({ version: 2 }));
    vi.mocked(repo.insertRevision).mockResolvedValue({
      id: asRevisionId(REVISION_ID),
      conceptId: CONCEPT_ID,
      revisionNo: 2,
      source: "git_import",
      createdAt: NOW,
    });

    await module.applyCrdtUpdate({
      conceptId: CONCEPT_ID,
      title: "A Concept",
      update: new Uint8Array(),
      expectedVersion: 1,
      actorId: null,
      source: "git_import",
      frontmatter: { status: "draft" },
    });

    expect(repo.insertRevision).toHaveBeenCalledWith(
      expect.objectContaining({ source: "git_import", frontmatter: { status: "draft" }, authorId: null }),
    );
  });

  test("propagates NotFoundError('document.notFound') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const notFound = new NotFoundError("concept document not found", {
      details: { reason: "document.notFound", conceptId: CONCEPT_ID },
    });
    vi.mocked(repo.appendUpdate).mockRejectedValue(notFound);

    await expect(
      module.applyCrdtUpdate({
        conceptId: CONCEPT_ID,
        title: "t",
        update: new Uint8Array(),
        expectedVersion: 1,
        actorId: null,
      }),
    ).rejects.toBe(notFound);
    expect(repo.insertRevision).not.toHaveBeenCalled();
  });

  test("propagates ConflictError('document.staleVersion') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const conflict = new ConflictError("document.staleVersion", {
      details: { reason: "document.staleVersion", conceptId: CONCEPT_ID, expectedVersion: 1 },
    });
    vi.mocked(repo.appendUpdate).mockRejectedValue(conflict);

    await expect(
      module.applyCrdtUpdate({
        conceptId: CONCEPT_ID,
        title: "t",
        update: new Uint8Array(),
        expectedVersion: 1,
        actorId: null,
      }),
    ).rejects.toBe(conflict);
  });

  test("propagates ValidationError('document.malformedCrdtUpdate') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const malformed = new ValidationError("document.malformedCrdtUpdate", {
      details: { reason: "document.malformedCrdtUpdate", operation: "applyUpdateToDoc" },
    });
    vi.mocked(repo.appendUpdate).mockRejectedValue(malformed);

    await expect(
      module.applyCrdtUpdate({
        conceptId: CONCEPT_ID,
        title: "t",
        update: new Uint8Array([255]),
        expectedVersion: 1,
        actorId: null,
      }),
    ).rejects.toBe(malformed);
  });
});

describe("createDocumentModule.save", () => {
  test("writes the content, returns the mapped document, and records a revision with source 'api' by default", async () => {
    const { module, repo } = createModule();
    const payload: BlockPayload = { root: { type: "root", children: [{ type: "divider" }] } };
    vi.mocked(repo.writeContent).mockResolvedValue(makeRow({ version: 2, contentBlocks: payload, bodyMarkdown: "---\n", blockCount: 1 }));
    vi.mocked(repo.insertRevision).mockResolvedValue({
      id: asRevisionId(REVISION_ID),
      conceptId: CONCEPT_ID,
      revisionNo: 2,
      source: "api",
      createdAt: NOW,
    });

    const document = await module.save({
      conceptId: CONCEPT_ID,
      title: "A Concept",
      contentBlocks: payload,
      expectedVersion: 1,
      actorId: ACTOR_ID,
    });

    expect(document.contentBlocks).toEqual(payload);
    expect(repo.writeContent).toHaveBeenCalledWith({ conceptId: CONCEPT_ID, contentBlocks: payload, expectedVersion: 1 });
    expect(repo.insertRevision).toHaveBeenCalledWith(expect.objectContaining({ source: "api" }));
  });

  test("propagates ConflictError('document.staleVersion') from the repository unchanged", async () => {
    const { module, repo } = createModule();
    const conflict = new ConflictError("document.staleVersion", {
      details: { reason: "document.staleVersion", conceptId: CONCEPT_ID, expectedVersion: 4 },
    });
    vi.mocked(repo.writeContent).mockRejectedValue(conflict);

    await expect(
      module.save({
        conceptId: CONCEPT_ID,
        title: "t",
        contentBlocks: EMPTY_BLOCK_PAYLOAD,
        expectedVersion: 4,
        actorId: null,
      }),
    ).rejects.toBe(conflict);
    expect(repo.insertRevision).not.toHaveBeenCalled();
  });
});

describe("createDocumentModule.renderMarkdown", () => {
  test("returns the rendered Markdown for the document's current content blocks", async () => {
    const { module, repo } = createModule();
    const payload: BlockPayload = {
      root: { type: "root", children: [{ type: "heading", level: 1, text: "Title" }, { type: "paragraph", text: "body" }] },
    };
    vi.mocked(repo.findByConceptId).mockResolvedValue(makeRow({ contentBlocks: payload }));

    await expect(module.renderMarkdown(CONCEPT_ID)).resolves.toBe("# Title\n\nbody\n");
  });

  test("returns the empty string for an empty document", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByConceptId).mockResolvedValue(makeRow());

    await expect(module.renderMarkdown(CONCEPT_ID)).resolves.toBe("");
  });

  test("raises NotFoundError('document.notFound') when no row exists", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByConceptId).mockResolvedValue(null);

    await expect(module.renderMarkdown(CONCEPT_ID)).rejects.toThrow(NotFoundError);
  });

  test("raises ValidationError('document.corruptPayload') when content_blocks fails the block schema", async () => {
    const { module, repo } = createModule();
    vi.mocked(repo.findByConceptId).mockResolvedValue(makeRow({ contentBlocks: 42 }));

    await expect(module.renderMarkdown(CONCEPT_ID)).rejects.toThrow(ValidationError);
  });
});
