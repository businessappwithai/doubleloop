// src/modules/documents/document-repository.ts — parameterised SQL over `concept_documents`
// (Database.md "concept_documents", Implementation.md m11). This is the only file in the module
// that imports the `Db` port; `document-module.ts` never sees a query string. `content_blocks`
// and `body_markdown` are read back as `unknown`/`string` respectively and handed to the caller
// unvalidated — this repository's job is data access, not trust-boundary validation, which is
// `document-module.ts`'s `ValidationError('document.corruptPayload')` check (Database.md's
// `content_blocks` CHECK only guarantees "is a JSON object with a `root` key", not that it matches
// this module's block schema, so the zod check downstream is load-bearing, not redundant).
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { asBundleId, asConceptId, asRevisionId, type ActorId, type BundleId, type ConceptId, type RevisionId } from "../../core/ids";
import { ConflictError, NotFoundError } from "../../core/errors";
import type { Db } from "../../server/ports";
import { blocksToMarkdown, countWords, type BlockPayload } from "./blocks";
import { applyBlocksToDoc, applyUpdateToDoc, createDoc, docToBlocks, encodeStateAsUpdate, encodeStateVector } from "./crdt";

/** Database.md `revision_source` enum, verbatim. */
export type RevisionSource = "editor" | "git_import" | "git_export" | "api" | "migration";

const COLUMNS =
  "concept_id, bundle_id, crdt_state, crdt_state_vector, content_blocks, body_markdown, " +
  "body_sha256, block_count, word_count, version, created_at, updated_at";

interface RawConceptDocumentRow {
  readonly concept_id: string;
  readonly bundle_id: string;
  readonly crdt_state: Uint8Array;
  readonly crdt_state_vector: Uint8Array;
  readonly content_blocks: unknown;
  readonly body_markdown: string;
  readonly body_sha256: string;
  readonly block_count: number;
  readonly word_count: number;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ConceptDocumentRow {
  readonly conceptId: ConceptId;
  readonly bundleId: BundleId;
  readonly crdtState: Uint8Array;
  readonly crdtStateVector: Uint8Array;
  /** Unvalidated JSONB read-back — `document-module.ts` is the trust boundary for this field. */
  readonly contentBlocks: unknown;
  readonly bodyMarkdown: string;
  readonly bodySha256: string;
  readonly blockCount: number;
  readonly wordCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateConceptDocumentInput {
  readonly conceptId: ConceptId;
  readonly bundleId: BundleId;
}

export interface AppendUpdateInput {
  readonly conceptId: ConceptId;
  readonly update: Uint8Array;
  readonly expectedVersion: number;
}

export interface WriteContentInput {
  readonly conceptId: ConceptId;
  readonly contentBlocks: BlockPayload;
  readonly expectedVersion: number;
}

export interface InsertRevisionInput {
  readonly id: RevisionId;
  readonly conceptId: ConceptId;
  readonly revisionNo: number;
  readonly source: RevisionSource;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly frontmatter: Record<string, unknown>;
  readonly contentBlocks: BlockPayload;
  readonly bodySha256: string;
  readonly authorId: ActorId | null;
}

export interface ConceptRevisionRow {
  readonly id: RevisionId;
  readonly conceptId: ConceptId;
  readonly revisionNo: number;
  readonly source: RevisionSource;
  readonly createdAt: string;
}

interface RawConceptRevisionRow {
  readonly id: string;
  readonly concept_id: string;
  readonly revision_no: number;
  readonly source: RevisionSource;
  readonly created_at: Date;
}

export interface DocumentRepository {
  /** `null` when no row exists for `conceptId` — the caller decides whether that is a 404. */
  findByConceptId(conceptId: ConceptId): Promise<ConceptDocumentRow | null>;
  /** Inserts an empty document row (DB defaults: empty CRDT state, `{"root":{...,"children":[]}}`). */
  create(input: CreateConceptDocumentInput): Promise<ConceptDocumentRow>;
  /**
   * Reconstructs the current merged `Y.Doc` from `crdt_state`, applies `update`, re-derives
   * `content_blocks`/`body_markdown`/`body_sha256`/`block_count`/`word_count` from the merged
   * document, and commits under an optimistic-concurrency guard.
   * Throws `NotFoundError('document.notFound')` if the row does not exist, and `ConflictError`
   * (`details.reason === "document.staleVersion"`) if `expectedVersion` no longer matches.
   */
  appendUpdate(input: AppendUpdateInput): Promise<ConceptDocumentRow>;
  /**
   * Replaces `content_blocks` wholesale — the non-CRDT write path (Database.md `concept_documents.version`:
   * "Optimistic concurrency for non-CRDT writes, e.g. a Markdown import that replaces the body").
   * Re-seeds `crdt_state`/`crdt_state_vector` from `contentBlocks` so the two representations never
   * diverge. Throws `ConflictError` (`details.reason === "document.staleVersion"`) on a version
   * mismatch, mirroring {@link appendUpdate}.
   */
  writeContent(input: WriteContentInput): Promise<ConceptDocumentRow>;
  /** `content_blocks @> predicate`, scoped by `bundleId` — the `jsonb_path_ops` containment query. */
  findByContentContainment(bundleId: BundleId, predicate: Record<string, unknown>): Promise<ConceptDocumentRow[]>;
  /**
   * Appends an immutable snapshot to `concept_revisions`. Deliberately its own statement rather
   * than folded into {@link appendUpdate}'s transaction: `title`/`frontmatter` live in tables this
   * module does not own (`concepts`, `concept_frontmatter` — Architecture.md "no module imports
   * another module's repo"), so the caller (`document-module.ts`, itself called by the
   * orchestrator once it has assembled cross-module data) supplies them after the document write
   * has already committed.
   */
  insertRevision(input: InsertRevisionInput): Promise<ConceptRevisionRow>;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function mapRow(raw: RawConceptDocumentRow): ConceptDocumentRow {
  return {
    conceptId: asConceptId(raw.concept_id),
    bundleId: asBundleId(raw.bundle_id),
    crdtState: raw.crdt_state,
    crdtStateVector: raw.crdt_state_vector,
    contentBlocks: raw.content_blocks,
    bodyMarkdown: raw.body_markdown,
    bodySha256: raw.body_sha256,
    blockCount: raw.block_count,
    wordCount: raw.word_count,
    version: raw.version,
    createdAt: raw.created_at.toISOString(),
    updatedAt: raw.updated_at.toISOString(),
  };
}

function deriveWriteFromBlocks(blocks: BlockPayload): {
  contentBlocksJson: string;
  bodyMarkdown: string;
  bodySha256: string;
  blockCount: number;
  wordCount: number;
} {
  const bodyMarkdown = blocksToMarkdown(blocks);
  return {
    contentBlocksJson: JSON.stringify(blocks),
    bodyMarkdown,
    bodySha256: sha256Hex(bodyMarkdown),
    blockCount: blocks.root.children.length,
    wordCount: countWords(bodyMarkdown),
  };
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}

export function createDocumentRepository(db: Db): DocumentRepository {
  return {
    async findByConceptId(conceptId) {
      const result = await db.query<RawConceptDocumentRow>(`SELECT ${COLUMNS} FROM concept_documents WHERE concept_id = $1`, [
        conceptId,
      ]);
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async create({ conceptId, bundleId }) {
      try {
        const result = await db.query<RawConceptDocumentRow>(
          `INSERT INTO concept_documents (concept_id, bundle_id) VALUES ($1, $2) RETURNING ${COLUMNS}`,
          [conceptId, bundleId],
        );
        const row = result.rows[0];
        if (!row) {
          throw new NotFoundError("concept_documents insert returned no row", {
            details: { reason: "document.insertFailed", conceptId },
          });
        }
        return mapRow(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError("document.alreadyExists", {
            details: { reason: "document.alreadyExists", conceptId },
            cause: err,
          });
        }
        throw err;
      }
    },

    async appendUpdate({ conceptId, update, expectedVersion }) {
      return db.withTransaction(async (tx) => {
        const current = await tx.query<RawConceptDocumentRow>(`SELECT ${COLUMNS} FROM concept_documents WHERE concept_id = $1`, [
          conceptId,
        ]);
        const existing = current.rows[0];
        if (!existing) {
          throw new NotFoundError("concept document not found", {
            details: { reason: "document.notFound", conceptId },
          });
        }

        const doc = createDoc();
        if (existing.crdt_state.length > 0) {
          applyUpdateToDoc(doc, existing.crdt_state);
        }
        applyUpdateToDoc(doc, update);

        const mergedState = encodeStateAsUpdate(doc);
        const stateVector = encodeStateVector(doc);
        const blocks = docToBlocks(doc);
        const write = deriveWriteFromBlocks(blocks);

        const result = await tx.query<RawConceptDocumentRow>(
          `UPDATE concept_documents
             SET crdt_state = $1, crdt_state_vector = $2, content_blocks = $3::jsonb, body_markdown = $4,
                 body_sha256 = $5, block_count = $6, word_count = $7, version = version + 1
           WHERE concept_id = $8 AND version = $9
           RETURNING ${COLUMNS}`,
          [
            Buffer.from(mergedState),
            Buffer.from(stateVector),
            write.contentBlocksJson,
            write.bodyMarkdown,
            write.bodySha256,
            write.blockCount,
            write.wordCount,
            conceptId,
            expectedVersion,
          ],
        );
        const updated = result.rows[0];
        if (!updated) {
          throw new ConflictError("document.staleVersion", {
            details: { reason: "document.staleVersion", conceptId, expectedVersion },
          });
        }
        return mapRow(updated);
      });
    },

    async writeContent({ conceptId, contentBlocks, expectedVersion }) {
      const doc = createDoc();
      applyBlocksToDoc(doc, contentBlocks);
      const crdtState = encodeStateAsUpdate(doc);
      const stateVector = encodeStateVector(doc);
      const write = deriveWriteFromBlocks(contentBlocks);

      const result = await db.query<RawConceptDocumentRow>(
        `UPDATE concept_documents
           SET crdt_state = $1, crdt_state_vector = $2, content_blocks = $3::jsonb, body_markdown = $4,
               body_sha256 = $5, block_count = $6, word_count = $7, version = version + 1
         WHERE concept_id = $8 AND version = $9
         RETURNING ${COLUMNS}`,
        [
          Buffer.from(crdtState),
          Buffer.from(stateVector),
          write.contentBlocksJson,
          write.bodyMarkdown,
          write.bodySha256,
          write.blockCount,
          write.wordCount,
          conceptId,
          expectedVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ConflictError("document.staleVersion", {
          details: { reason: "document.staleVersion", conceptId, expectedVersion },
        });
      }
      return mapRow(row);
    },

    async findByContentContainment(bundleId, predicate) {
      const result = await db.query<RawConceptDocumentRow>(
        `SELECT ${COLUMNS} FROM concept_documents WHERE bundle_id = $1 AND content_blocks @> $2::jsonb`,
        [bundleId, JSON.stringify(predicate)],
      );
      return result.rows.map(mapRow);
    },

    async insertRevision(input) {
      const result = await db.query<RawConceptRevisionRow>(
        `INSERT INTO concept_revisions
           (id, concept_id, revision_no, source, title, body_markdown, frontmatter, content_blocks, body_sha256, author_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         RETURNING id, concept_id, revision_no, source, created_at`,
        [
          input.id,
          input.conceptId,
          input.revisionNo,
          input.source,
          input.title,
          input.bodyMarkdown,
          JSON.stringify(input.frontmatter),
          JSON.stringify(input.contentBlocks),
          input.bodySha256,
          input.authorId,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new NotFoundError("concept_revisions insert returned no row", {
          details: { reason: "document.revisionInsertFailed", conceptId: input.conceptId },
        });
      }
      return {
        id: asRevisionId(row.id),
        conceptId: asConceptId(row.concept_id),
        revisionNo: row.revision_no,
        source: row.source,
        createdAt: row.created_at.toISOString(),
      };
    },
  };
}
