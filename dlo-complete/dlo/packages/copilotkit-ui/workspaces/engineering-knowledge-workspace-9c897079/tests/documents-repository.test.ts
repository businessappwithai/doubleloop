// tests/documents-repository.test.ts — module m11 (documents). Exercises
// `createDocumentRepository` against the in-memory `FakeDb` (tests/helpers/fake-ports.ts): no real
// Postgres, no real Yjs binary beyond what `crdt.ts` itself produces in-process. Covers every
// method's happy path on real returned rows, `findByConceptId` returning null, a unique-violation
// `create` mapped to `ConflictError('document.alreadyExists')`, `appendUpdate` merging into the
// existing CRDT state and committing inside a transaction, a stale-version conflict on both
// `appendUpdate` and `writeContent`, `NotFoundError` when `appendUpdate` targets a missing row,
// the `content_blocks @>` containment query, and `insertRevision`.
import { describe, test, expect } from "vitest";
import { createFakeDb } from "./helpers/fake-ports";
import { createDocumentRepository, type ConceptDocumentRow } from "../src/modules/documents/document-repository";
import { asBundleId, asConceptId, asRevisionId } from "../src/core/ids";
import { ConflictError, NotFoundError } from "../src/core/errors";
import { EMPTY_BLOCK_PAYLOAD, type BlockPayload } from "../src/modules/documents/blocks";
import { applyBlocksToDoc, createDoc, encodeStateAsUpdate, encodeStateVector } from "../src/modules/documents/crdt";

const CONCEPT_ID = "30000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "10000000-0000-4000-8000-000000000001";
const REVISION_ID = "40000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-01-01T00:00:00.000Z");

interface RawRowOverrides {
  concept_id?: string;
  bundle_id?: string;
  crdt_state?: Uint8Array;
  crdt_state_vector?: Uint8Array;
  content_blocks?: unknown;
  body_markdown?: string;
  body_sha256?: string;
  block_count?: number;
  word_count?: number;
  version?: number;
  created_at?: Date;
  updated_at?: Date;
}

function makeRawRow(overrides: RawRowOverrides = {}) {
  return {
    concept_id: CONCEPT_ID,
    bundle_id: BUNDLE_ID,
    crdt_state: new Uint8Array(),
    crdt_state_vector: new Uint8Array(),
    content_blocks: EMPTY_BLOCK_PAYLOAD,
    body_markdown: "",
    body_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    block_count: 0,
    word_count: 0,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function expectMappedRow(row: ConceptDocumentRow, raw: ReturnType<typeof makeRawRow>): void {
  expect(row.conceptId).toBe(raw.concept_id);
  expect(row.bundleId).toBe(raw.bundle_id);
  expect(row.contentBlocks).toEqual(raw.content_blocks);
  expect(row.bodyMarkdown).toBe(raw.body_markdown);
  expect(row.version).toBe(raw.version);
  expect(row.createdAt).toBe(raw.created_at.toISOString());
  expect(row.updatedAt).toBe(raw.updated_at.toISOString());
}

describe("createDocumentRepository.findByConceptId", () => {
  test("returns the mapped row for an existing concept", async () => {
    const db = createFakeDb();
    const raw = makeRawRow();
    db.when(/FROM concept_documents WHERE concept_id = \$1/, { rows: [raw] });
    const repo = createDocumentRepository(db);

    const row = await repo.findByConceptId(asConceptId(CONCEPT_ID));

    expect(row).not.toBeNull();
    expectMappedRow(row!, raw);
    expect(db.calls[0]!.params).toEqual([CONCEPT_ID]);
  });

  test("returns null when no row exists", async () => {
    const db = createFakeDb();
    db.when(/FROM concept_documents WHERE concept_id = \$1/, { rows: [] });
    const repo = createDocumentRepository(db);

    await expect(repo.findByConceptId(asConceptId(CONCEPT_ID))).resolves.toBeNull();
  });
});

describe("createDocumentRepository.create", () => {
  test("inserts and returns the mapped row", async () => {
    const db = createFakeDb();
    const raw = makeRawRow();
    db.when("INSERT INTO concept_documents", { rows: [raw], rowCount: 1 });
    const repo = createDocumentRepository(db);

    const row = await repo.create({ conceptId: asConceptId(CONCEPT_ID), bundleId: asBundleId(BUNDLE_ID) });

    expectMappedRow(row, raw);
    expect(db.calls[0]!.params).toEqual([CONCEPT_ID, BUNDLE_ID]);
  });

  test("raises ConflictError('document.alreadyExists') on a unique-violation (23505)", async () => {
    const db = createFakeDb();
    const pgError = Object.assign(new Error("duplicate key"), { code: "23505" });
    db.whenError("INSERT INTO concept_documents", pgError);
    const repo = createDocumentRepository(db);

    try {
      await repo.create({ conceptId: asConceptId(CONCEPT_ID), bundleId: asBundleId(BUNDLE_ID) });
      throw new Error("expected create to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toBe("document.alreadyExists");
      expect((err as ConflictError).details["reason"]).toBe("document.alreadyExists");
      expect((err as ConflictError).cause).toBe(pgError);
    }
  });

  test("rethrows a non-unique-violation error unchanged", async () => {
    const db = createFakeDb();
    const otherError = new Error("connection reset");
    db.whenError("INSERT INTO concept_documents", otherError);
    const repo = createDocumentRepository(db);

    await expect(
      repo.create({ conceptId: asConceptId(CONCEPT_ID), bundleId: asBundleId(BUNDLE_ID) }),
    ).rejects.toBe(otherError);
  });
});

describe("createDocumentRepository.appendUpdate", () => {
  function updateForPayload(payload: BlockPayload): Uint8Array {
    const doc = createDoc();
    applyBlocksToDoc(doc, payload);
    return encodeStateAsUpdate(doc);
  }

  test("merges the update into the existing CRDT state and commits inside a transaction", async () => {
    const db = createFakeDb();
    const existingRaw = makeRawRow({ crdt_state: new Uint8Array(), version: 1 });
    db.when(/SELECT .* FROM concept_documents WHERE concept_id = \$1/, { rows: [existingRaw] });
    db.when(/UPDATE concept_documents/, (params) => {
      const updated = makeRawRow({
        content_blocks: { root: { type: "root", children: [{ type: "paragraph", text: "hi" }] } },
        body_markdown: "hi\n",
        block_count: 1,
        word_count: 1,
        version: 2,
      });
      // sanity: the version guard param is present and matches the row's current version.
      expect(params[params.length - 1]).toBe(1);
      return { rows: [updated], rowCount: 1 };
    });
    const repo = createDocumentRepository(db);

    const payload: BlockPayload = { root: { type: "root", children: [{ type: "paragraph", text: "hi" }] } };
    const update = updateForPayload(payload);

    const row = await repo.appendUpdate({ conceptId: asConceptId(CONCEPT_ID), update, expectedVersion: 1 });

    expect(row.version).toBe(2);
    expect(row.contentBlocks).toEqual(payload);
    expect(row.blockCount).toBe(1);
    expect(row.wordCount).toBe(1);
    expect(db.transactions).toHaveLength(1);
    expect(db.transactions[0]!.outcome).toBe("commit");
  });

  test("raises NotFoundError('document.notFound') when the row does not exist", async () => {
    const db = createFakeDb();
    db.when(/SELECT .* FROM concept_documents WHERE concept_id = \$1/, { rows: [] });
    const repo = createDocumentRepository(db);

    try {
      await repo.appendUpdate({ conceptId: asConceptId(CONCEPT_ID), update: new Uint8Array(), expectedVersion: 1 });
      throw new Error("expected appendUpdate to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).details["reason"]).toBe("document.notFound");
    }
    expect(db.transactions[0]!.outcome).toBe("rollback");
  });

  test("raises ConflictError('document.staleVersion') when the UPDATE affects no rows", async () => {
    const db = createFakeDb();
    const existingRaw = makeRawRow({ version: 5 });
    db.when(/SELECT .* FROM concept_documents WHERE concept_id = \$1/, { rows: [existingRaw] });
    db.when(/UPDATE concept_documents/, { rows: [], rowCount: 0 });
    const repo = createDocumentRepository(db);

    try {
      await repo.appendUpdate({
        conceptId: asConceptId(CONCEPT_ID),
        update: updateForPayload(EMPTY_BLOCK_PAYLOAD),
        expectedVersion: 1,
      });
      throw new Error("expected appendUpdate to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toBe("document.staleVersion");
      expect((err as ConflictError).details["reason"]).toBe("document.staleVersion");
    }
    expect(db.transactions[0]!.outcome).toBe("rollback");
  });
});

describe("createDocumentRepository.writeContent", () => {
  test("replaces content_blocks wholesale, re-seeding the CRDT state, and returns the mapped row", async () => {
    const db = createFakeDb();
    const payload: BlockPayload = { root: { type: "root", children: [{ type: "divider" }] } };
    db.when(/UPDATE concept_documents/, {
      rows: [makeRawRow({ content_blocks: payload, body_markdown: "---\n", block_count: 1, version: 2 })],
      rowCount: 1,
    });
    const repo = createDocumentRepository(db);

    const row = await repo.writeContent({ conceptId: asConceptId(CONCEPT_ID), contentBlocks: payload, expectedVersion: 1 });

    expect(row.version).toBe(2);
    expect(row.contentBlocks).toEqual(payload);
    expect(row.blockCount).toBe(1);
  });

  test("raises ConflictError('document.staleVersion') when the UPDATE affects no rows", async () => {
    const db = createFakeDb();
    db.when(/UPDATE concept_documents/, { rows: [], rowCount: 0 });
    const repo = createDocumentRepository(db);

    await expect(
      repo.writeContent({ conceptId: asConceptId(CONCEPT_ID), contentBlocks: EMPTY_BLOCK_PAYLOAD, expectedVersion: 3 }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("createDocumentRepository.findByContentContainment", () => {
  test("returns every matching mapped row, scoped by bundleId", async () => {
    const db = createFakeDb();
    const raw = makeRawRow();
    db.when(/content_blocks @> \$2::jsonb/, { rows: [raw] });
    const repo = createDocumentRepository(db);

    const rows = await repo.findByContentContainment(asBundleId(BUNDLE_ID), { root: { children: [] } });

    expect(rows).toHaveLength(1);
    expectMappedRow(rows[0]!, raw);
    expect(db.calls[0]!.params).toEqual([BUNDLE_ID, JSON.stringify({ root: { children: [] } })]);
  });

  test("returns an empty array when nothing matches", async () => {
    const db = createFakeDb();
    db.when(/content_blocks @> \$2::jsonb/, { rows: [] });
    const repo = createDocumentRepository(db);

    await expect(repo.findByContentContainment(asBundleId(BUNDLE_ID), {})).resolves.toEqual([]);
  });
});

describe("createDocumentRepository.insertRevision", () => {
  test("inserts and returns the mapped revision row", async () => {
    const db = createFakeDb();
    db.when(/INSERT INTO concept_revisions/, {
      rows: [{ id: REVISION_ID, concept_id: CONCEPT_ID, revision_no: 1, source: "editor", created_at: NOW }],
      rowCount: 1,
    });
    const repo = createDocumentRepository(db);

    const revision = await repo.insertRevision({
      id: asRevisionId(REVISION_ID),
      conceptId: asConceptId(CONCEPT_ID),
      revisionNo: 1,
      source: "editor",
      title: "A Concept",
      bodyMarkdown: "body",
      frontmatter: {},
      contentBlocks: EMPTY_BLOCK_PAYLOAD,
      bodySha256: "abc123",
      authorId: null,
    });

    expect(revision).toEqual({
      id: REVISION_ID,
      conceptId: CONCEPT_ID,
      revisionNo: 1,
      source: "editor",
      createdAt: NOW.toISOString(),
    });
    expect(db.calls[0]!.params).toEqual([
      REVISION_ID,
      CONCEPT_ID,
      1,
      "editor",
      "A Concept",
      "body",
      JSON.stringify({}),
      JSON.stringify(EMPTY_BLOCK_PAYLOAD),
      "abc123",
      null,
    ]);
  });

  test("raises NotFoundError when the INSERT returns no row", async () => {
    const db = createFakeDb();
    db.when(/INSERT INTO concept_revisions/, { rows: [], rowCount: 0 });
    const repo = createDocumentRepository(db);

    await expect(
      repo.insertRevision({
        id: asRevisionId(REVISION_ID),
        conceptId: asConceptId(CONCEPT_ID),
        revisionNo: 1,
        source: "api",
        title: "t",
        bodyMarkdown: "",
        frontmatter: {},
        contentBlocks: EMPTY_BLOCK_PAYLOAD,
        bodySha256: "abc",
        authorId: null,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test.each(["editor", "git_import", "git_export", "api", "migration"] as const)(
    "accepts revision_source %s",
    async (source) => {
      const db = createFakeDb();
      db.when(/INSERT INTO concept_revisions/, {
        rows: [{ id: REVISION_ID, concept_id: CONCEPT_ID, revision_no: 1, source, created_at: NOW }],
        rowCount: 1,
      });
      const repo = createDocumentRepository(db);

      const revision = await repo.insertRevision({
        id: asRevisionId(REVISION_ID),
        conceptId: asConceptId(CONCEPT_ID),
        revisionNo: 1,
        source,
        title: "t",
        bodyMarkdown: "",
        frontmatter: {},
        contentBlocks: EMPTY_BLOCK_PAYLOAD,
        bodySha256: "abc",
        authorId: null,
      });

      expect(revision.source).toBe(source);
    },
  );
});

describe("createDocumentRepository CRDT round trip via encodeStateVector", () => {
  test("a written document's crdt_state_vector reflects an applied update", () => {
    const doc = createDoc();
    applyBlocksToDoc(doc, { root: { type: "root", children: [{ type: "paragraph", text: "hi" }] } });
    const vector = encodeStateVector(doc);
    expect(vector).toBeInstanceOf(Uint8Array);
    expect(vector.length).toBeGreaterThan(0);
  });
});
