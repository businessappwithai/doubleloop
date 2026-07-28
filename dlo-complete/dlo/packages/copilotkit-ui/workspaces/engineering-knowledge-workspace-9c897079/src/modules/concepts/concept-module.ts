// src/modules/concepts/concept-module.ts — the `ConceptModule` domain service (Architecture.md
// "no module imports another module's repository internals"; Implementation.md m10). Owns slug
// normalisation and title validation (the same shape of rule `bundle-module.ts` enforces for
// `bundles`, deliberately re-implemented here rather than imported — Database.md's `concepts.slug`
// CHECK is textually identical to `bundles.slug`'s, but importing `bundle-module.ts` would make
// `concepts` depend on the `bundles` feature module, which Architecture.md forbids), path/depth
// derivation from the parent concept (root: `path = slug`, `depth = 0`; child: parent's `path` +
// `/` + `slug`, parent's `depth + 1`), and append-as-last-child `sort_key` allocation via
// `hierarchy/sort-key.ts`'s pure `keyBetween` over `concept-repository.ts`'s own
// `lastSiblingSortKey` read — this file never imports `hierarchy-module.ts` or
// `hierarchy-repository.ts` (that would be importing another module's service); it only imports
// the pure, dependency-free `keyBetween` function, exactly like a shared utility.
// `NotFoundError('concept.notFound')` covers a missing/soft-deleted concept and a missing parent;
// `ConflictError('concept.staleVersion')` and `ConflictError('concept.slugTaken')` are the two
// typed write failures. Timestamps come from the injected `Clock` and ids from the injected
// `IdGenerator`, never `Date.now()` or a random uuid call, so every code path here is deterministic
// under test.
import type { Connection, ConnectionArgs } from "../../core/connection";
import type { RequestContext } from "../../core/context";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors";
import type { BundleId, ConceptId } from "../../core/ids";
import { asActorId, asBundleId, asConceptId } from "../../core/ids";
import type { Concept } from "../../core/types";
import { keyBetween } from "../hierarchy/sort-key";
import type { Clock, IdGenerator, Logger } from "../../server/ports";
import type { ConceptRepository, ConceptRow } from "./concept-repository";

const MAX_SLUG_LENGTH = 96;
const MAX_TITLE_LENGTH = 300;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Postgres error code for a unique-constraint violation (`concepts_sibling_slug_live_key`). */
const UNIQUE_VIOLATION_CODE = "23505";

export interface CreateConceptInput {
  readonly bundleId: BundleId;
  readonly parentId: ConceptId | null;
  readonly slug: string;
  readonly title: string;
  readonly isIndex?: boolean;
}

export interface UpdateConceptMetadataPatch {
  readonly title?: string;
  readonly isIndex?: boolean;
}

export interface ConceptModule {
  /** Throws `NotFoundError('concept.notFound')` for a missing or soft-deleted concept. */
  get(ctx: RequestContext, bundleId: BundleId, id: ConceptId): Promise<Concept>;
  /** Throws `NotFoundError('concept.notFound')` for a missing or soft-deleted concept. */
  getByPath(ctx: RequestContext, bundleId: BundleId, path: string): Promise<Concept>;
  list(ctx: RequestContext, bundleId: BundleId, args: ConnectionArgs): Promise<Connection<Concept>>;
  /**
   * Throws `ValidationError` on an invalid slug/title, `NotFoundError('concept.parentNotFound')`
   * for a `parentId` that does not resolve to a live concept, and `ConflictError('concept.slugTaken')`
   * on a duplicate sibling slug.
   */
  create(ctx: RequestContext, input: CreateConceptInput): Promise<Concept>;
  /**
   * Applies `patch.title` and/or `patch.isIndex`, chaining the optimistic-concurrency version
   * across both writes when both are supplied. Throws `ValidationError('concept.emptyUpdate')`
   * when neither field is supplied and `ConflictError('concept.staleVersion')` when
   * `expectedVersion` no longer matches.
   */
  updateMetadata(
    ctx: RequestContext,
    bundleId: BundleId,
    id: ConceptId,
    expectedVersion: number,
    patch: UpdateConceptMetadataPatch,
  ): Promise<Concept>;
  /** Throws `ConflictError('concept.staleVersion')` when `expectedVersion` no longer matches. */
  archive(ctx: RequestContext, bundleId: BundleId, id: ConceptId, expectedVersion: number): Promise<Concept>;
}

export interface CreateConceptModuleDeps {
  readonly repo: ConceptRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/**
 * Normalises `raw` into a valid `concepts.slug`: lower-cased, non-`[a-z0-9]` runs collapsed to a
 * single hyphen, leading/trailing hyphens trimmed. Throws `ValidationError('concept.invalidSlug')`
 * if the result is empty, exceeds {@link MAX_SLUG_LENGTH}, or still fails the DB's own
 * `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'` check (Database.md `concepts`).
 */
export function normalizeSlug(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0 || normalized.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(normalized)) {
    throw new ValidationError("concept.invalidSlug", { details: { slug: raw, normalized } });
  }
  return normalized;
}

/** Throws `ValidationError('concept.invalidTitle')` for a blank or over-length title. */
function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_TITLE_LENGTH) {
    throw new ValidationError("concept.invalidTitle", { details: { title } });
  }
  return trimmed;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapRow(row: ConceptRow): Concept {
  return {
    id: asConceptId(row.id),
    bundleId: asBundleId(row.bundle_id),
    parentId: row.parent_id === null ? null : asConceptId(row.parent_id),
    slug: row.slug,
    path: row.path,
    title: row.title,
    sortKey: row.sort_key,
    depth: row.depth,
    isIndex: row.is_index,
    childCount: row.child_count,
    createdBy: asActorId(row.created_by),
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: row.deleted_at === null ? null : toIso(row.deleted_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION_CODE;
}

export function createConceptModule(deps: CreateConceptModuleDeps): ConceptModule {
  const { repo, clock, ids, logger } = deps;

  return {
    async get(_ctx, bundleId, id) {
      const row = await repo.findById(bundleId, id);
      if (row === null) {
        throw new NotFoundError("concept.notFound", { details: { bundleId, id } });
      }
      return mapRow(row);
    },

    async getByPath(_ctx, bundleId, path) {
      const row = await repo.findByPath(bundleId, path);
      if (row === null) {
        throw new NotFoundError("concept.notFound", { details: { bundleId, path } });
      }
      return mapRow(row);
    },

    async list(_ctx, bundleId, args) {
      const connection = await repo.listConnection(bundleId, args);
      return {
        edges: connection.edges.map((edge) => ({ node: mapRow(edge.node), cursor: edge.cursor })),
        pageInfo: connection.pageInfo,
        totalCount: connection.totalCount,
      };
    },

    async create(ctx, input) {
      const slug = normalizeSlug(input.slug);
      const title = validateTitle(input.title);

      let parent: ConceptRow | null = null;
      if (input.parentId !== null) {
        parent = await repo.findById(input.bundleId, input.parentId);
        if (parent === null) {
          throw new NotFoundError("concept.parentNotFound", {
            details: { bundleId: input.bundleId, parentId: input.parentId },
          });
        }
      }

      const path = parent === null ? slug : `${parent.path}/${slug}`;
      const depth = parent === null ? 0 : parent.depth + 1;
      const lastSortKey = await repo.lastSiblingSortKey(input.bundleId, input.parentId);
      const sortKey = keyBetween(lastSortKey, null);
      const now = clock.now();
      const id = ids.uuid();

      try {
        const row = await repo.insert({
          id,
          bundleId: input.bundleId,
          parentId: input.parentId,
          slug,
          path,
          title,
          sortKey,
          depth,
          isIndex: input.isIndex ?? false,
          createdBy: ctx.actor.id,
          createdAt: now,
        });
        logger.info("concept.created", { id: row.id, bundleId: input.bundleId, parentId: input.parentId, slug });
        return mapRow(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError("concept.slugTaken", {
            details: { bundleId: input.bundleId, parentId: input.parentId, slug },
            cause: err,
          });
        }
        throw err;
      }
    },

    async updateMetadata(_ctx, bundleId, id, expectedVersion, patch) {
      if (patch.title === undefined && patch.isIndex === undefined) {
        throw new ValidationError("concept.emptyUpdate", { details: { bundleId, id } });
      }

      let version = expectedVersion;
      let row: ConceptRow | undefined;

      if (patch.title !== undefined) {
        const title = validateTitle(patch.title);
        row = await repo.updateTitle(bundleId, id, version, title, clock.now());
        version = row.version;
      }

      if (patch.isIndex !== undefined) {
        row = await repo.setIsIndex(bundleId, id, version, patch.isIndex, clock.now());
        version = row.version;
      }

      logger.info("concept.metadataUpdated", { bundleId, id, patch });
      return mapRow(row!);
    },

    async archive(_ctx, bundleId, id, expectedVersion) {
      const row = await repo.softDelete(bundleId, id, expectedVersion, clock.now());
      logger.info("concept.archived", { bundleId, id });
      return mapRow(row);
    },
  };
}
