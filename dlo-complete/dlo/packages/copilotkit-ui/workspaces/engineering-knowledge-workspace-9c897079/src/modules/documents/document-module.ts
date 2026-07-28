// src/modules/documents/document-module.ts — the `DocumentModule` domain service
// (Implementation.md m11). Owns the one trust-boundary rule the repository deliberately does not
// enforce: every `content_blocks` read-back is parsed with {@link blockPayloadSchema} before it is
// handed to a caller, never coerced. A row whose JSONB no longer matches the block schema (a hand
// edit, a future migration that changed the shape, `NULL`-turned-`{}` from a driver bug) surfaces
// as `ValidationError('document.corruptPayload')`, not a best-effort reinterpretation — silently
// accepting drift here is exactly how a corrupt editor state reaches the browser.
import { Buffer } from "node:buffer";
import type { ActorId, BundleId, ConceptId } from "../../core/ids";
import { asRevisionId } from "../../core/ids";
import { NotFoundError, ValidationError } from "../../core/errors";
import type { IdGenerator, Logger } from "../../server/ports";
import { blockPayloadSchema, blocksToMarkdown, type BlockPayload } from "./blocks";
import type { ConceptDocumentRow, DocumentRepository, RevisionSource } from "./document-repository";

export interface ConceptDocument {
  readonly conceptId: ConceptId;
  readonly bundleId: BundleId;
  readonly contentBlocks: BlockPayload;
  readonly bodyMarkdown: string;
  readonly bodySha256: string;
  readonly blockCount: number;
  readonly wordCount: number;
  /** Base64-encoded `Y.encodeStateVector` output — what a reconnecting client diffs against. */
  readonly crdtStateVectorB64: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDocumentInput {
  readonly conceptId: ConceptId;
  readonly bundleId: BundleId;
}

export interface ApplyCrdtUpdateInput {
  readonly conceptId: ConceptId;
  /** The concept's current title, needed only for the `concept_revisions` snapshot row. */
  readonly title: string;
  readonly update: Uint8Array;
  readonly expectedVersion: number;
  readonly actorId: ActorId | null;
  readonly source?: RevisionSource;
  readonly frontmatter?: Record<string, unknown>;
}

export interface SaveDocumentInput {
  readonly conceptId: ConceptId;
  readonly title: string;
  readonly contentBlocks: BlockPayload;
  readonly expectedVersion: number;
  readonly actorId: ActorId | null;
  readonly source?: RevisionSource;
  readonly frontmatter?: Record<string, unknown>;
}

export interface DocumentModule {
  /** `NotFoundError` is never raised here — creation always succeeds or throws `ConflictError('document.alreadyExists')`. */
  create(input: CreateDocumentInput): Promise<ConceptDocument>;
  /** Throws `NotFoundError('document.notFound')`. */
  load(conceptId: ConceptId): Promise<ConceptDocument>;
  /**
   * Merges `update` into the document's CRDT state, re-derives the block payload, commits under
   * optimistic concurrency, and records the result as a `concept_revisions` snapshot.
   * Throws `NotFoundError('document.notFound')`, `ValidationError` with
   * `details.reason === "document.malformedCrdtUpdate"`, or `ConflictError` with
   * `details.reason === "document.staleVersion"`.
   */
  applyCrdtUpdate(input: ApplyCrdtUpdateInput): Promise<ConceptDocument>;
  /**
   * The non-CRDT write path (a Markdown import, or any caller that already has a full block
   * payload rather than a Yjs binary update). Also re-seeds the CRDT state from `contentBlocks`
   * and records a `concept_revisions` snapshot. Throws `ConflictError`
   * (`details.reason === "document.staleVersion"`) on a version mismatch.
   */
  save(input: SaveDocumentInput): Promise<ConceptDocument>;
  /** Throws `NotFoundError('document.notFound')` or `ValidationError('document.corruptPayload')`. */
  renderMarkdown(conceptId: ConceptId): Promise<string>;
}

export interface DocumentModuleDeps {
  readonly repo: DocumentRepository;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

function parseContentBlocks(row: ConceptDocumentRow): BlockPayload {
  const result = blockPayloadSchema.safeParse(row.contentBlocks);
  if (!result.success) {
    throw new ValidationError("document.corruptPayload", {
      details: {
        reason: "document.corruptPayload",
        conceptId: row.conceptId,
        issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  return result.data;
}

function toConceptDocument(row: ConceptDocumentRow): ConceptDocument {
  return {
    conceptId: row.conceptId,
    bundleId: row.bundleId,
    contentBlocks: parseContentBlocks(row),
    bodyMarkdown: row.bodyMarkdown,
    bodySha256: row.bodySha256,
    blockCount: row.blockCount,
    wordCount: row.wordCount,
    crdtStateVectorB64: Buffer.from(row.crdtStateVector).toString("base64"),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadOrThrow(repo: DocumentRepository, conceptId: ConceptId): Promise<ConceptDocumentRow> {
  const row = await repo.findByConceptId(conceptId);
  if (!row) {
    throw new NotFoundError("concept document not found", {
      details: { reason: "document.notFound", conceptId },
    });
  }
  return row;
}

interface RevisionMeta {
  readonly conceptId: ConceptId;
  readonly title: string;
  readonly actorId: ActorId | null;
  readonly source: RevisionSource | undefined;
  readonly frontmatter: Record<string, unknown> | undefined;
}

export function createDocumentModule({ repo, ids, logger }: DocumentModuleDeps): DocumentModule {
  async function recordRevision(document: ConceptDocument, meta: RevisionMeta): Promise<void> {
    await repo.insertRevision({
      id: asRevisionId(ids.uuid()),
      conceptId: meta.conceptId,
      revisionNo: document.version,
      source: meta.source ?? "editor",
      title: meta.title,
      bodyMarkdown: document.bodyMarkdown,
      frontmatter: meta.frontmatter ?? {},
      contentBlocks: document.contentBlocks,
      bodySha256: document.bodySha256,
      authorId: meta.actorId,
    });
  }

  return {
    async create({ conceptId, bundleId }) {
      const row = await repo.create({ conceptId, bundleId });
      logger.info("document.created", { conceptId, bundleId });
      return toConceptDocument(row);
    },

    async load(conceptId) {
      const row = await loadOrThrow(repo, conceptId);
      return toConceptDocument(row);
    },

    async applyCrdtUpdate(input) {
      const updatedRow = await repo.appendUpdate({
        conceptId: input.conceptId,
        update: input.update,
        expectedVersion: input.expectedVersion,
      });
      const document = toConceptDocument(updatedRow);
      await recordRevision(document, {
        conceptId: input.conceptId,
        title: input.title,
        actorId: input.actorId,
        source: input.source,
        frontmatter: input.frontmatter,
      });
      logger.info("document.crdtUpdateApplied", { conceptId: input.conceptId, version: updatedRow.version });

      return document;
    },

    async save(input) {
      const updatedRow = await repo.writeContent({
        conceptId: input.conceptId,
        contentBlocks: input.contentBlocks,
        expectedVersion: input.expectedVersion,
      });
      const document = toConceptDocument(updatedRow);
      await recordRevision(document, {
        conceptId: input.conceptId,
        title: input.title,
        actorId: input.actorId,
        source: input.source ?? "api",
        frontmatter: input.frontmatter,
      });
      logger.info("document.saved", { conceptId: input.conceptId, version: updatedRow.version });

      return document;
    },

    async renderMarkdown(conceptId) {
      const row = await loadOrThrow(repo, conceptId);
      return blocksToMarkdown(parseContentBlocks(row));
    },
  };
}
