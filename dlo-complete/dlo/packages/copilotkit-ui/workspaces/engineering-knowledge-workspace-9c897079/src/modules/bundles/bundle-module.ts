// src/modules/bundles/bundle-module.ts — the `BundleModule` domain service (Architecture.md
// "3. BundleModule"; Implementation.md m9). Owns everything `bundle-repository.ts` does not:
// slug normalisation, title validation, the `23505` unique-violation → `ConflictError('bundle.slugTaken')`
// mapping (the repository only knows SQL, not what a duplicate key *means*), `NotFoundError('bundle.notFound')`
// for a missing/soft-deleted bundle, and the DB↔domain `TrustLevel` spelling translation (the
// `trust_level` Postgres enum uses underscores — `machine_confirmed` — while the pure domain
// union in `core/types.ts` uses hyphens — `machine-confirmed` — a mismatch that file's own header
// comment calls out explicitly as a persistence-mapping concern for whichever module touches it).
// Timestamps come from the injected `Clock` and ids from the injected `IdGenerator`, never `Date.now()`
// or a random uuid call, so every code path here is deterministic under test.
import type { Connection, ConnectionArgs } from "../../core/connection";
import type { RequestContext } from "../../core/context";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors";
import type { BundleId } from "../../core/ids";
import { asActorId, asBundleId } from "../../core/ids";
import type { Bundle, TrustLevel } from "../../core/types";
import type { Clock, IdGenerator, Logger } from "../../server/ports";
import type { BundleRepository, BundleRow } from "./bundle-repository";

const DEFAULT_OKF_VERSION = "1.0";
const DEFAULT_TRUST: TrustLevel = "unverified";
const MAX_SLUG_LENGTH = 96;
const MAX_TITLE_LENGTH = 300;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Postgres error code for a unique-constraint violation (`bundles_workspace_slug_live_key`). */
const UNIQUE_VIOLATION_CODE = "23505";

export interface CreateBundleInput {
  readonly workspaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly okfVersion?: string;
  readonly defaultTrust?: TrustLevel;
}

export interface BundleModule {
  /** Throws `NotFoundError('bundle.notFound')` for a missing or soft-deleted bundle. */
  get(ctx: RequestContext, id: BundleId): Promise<Bundle>;
  list(ctx: RequestContext, workspaceId: string, args: ConnectionArgs): Promise<Connection<Bundle>>;
  /** Throws `ValidationError` on an invalid slug/title, `ConflictError('bundle.slugTaken')` on a duplicate. */
  create(ctx: RequestContext, input: CreateBundleInput): Promise<Bundle>;
  /** Throws `ConflictError('bundle.staleVersion')` when `expectedVersion` no longer matches. */
  rename(ctx: RequestContext, id: BundleId, expectedVersion: number, title: string): Promise<Bundle>;
  /** Throws `ConflictError('bundle.staleVersion')` when `expectedVersion` no longer matches. */
  archive(ctx: RequestContext, id: BundleId, expectedVersion: number): Promise<Bundle>;
}

export interface CreateBundleModuleDeps {
  readonly repo: BundleRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/**
 * Normalises `raw` into a valid `bundles.slug`: lower-cased, non-`[a-z0-9]` runs collapsed to a
 * single hyphen, leading/trailing hyphens trimmed. Throws `ValidationError('bundle.invalidSlug')`
 * if the result is empty, exceeds {@link MAX_SLUG_LENGTH}, or still fails the DB's own
 * `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'` check (Database.md `bundles`).
 */
export function normalizeSlug(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0 || normalized.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(normalized)) {
    throw new ValidationError("bundle.invalidSlug", { details: { slug: raw, normalized } });
  }
  return normalized;
}

/** Throws `ValidationError('bundle.invalidTitle')` for a blank or over-length title. */
function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_TITLE_LENGTH) {
    throw new ValidationError("bundle.invalidTitle", { details: { title } });
  }
  return trimmed;
}

const DB_TRUST_TO_DOMAIN: Readonly<Record<string, TrustLevel>> = {
  unverified: "unverified",
  machine_confirmed: "machine-confirmed",
  human_reviewed: "human-reviewed",
};

const DOMAIN_TRUST_TO_DB: Readonly<Record<TrustLevel, string>> = {
  unverified: "unverified",
  "machine-confirmed": "machine_confirmed",
  "human-reviewed": "human_reviewed",
};

/** Throws `ValidationError('bundle.corruptTrust')` for a value outside the `trust_level` enum. */
export function dbTrustToDomain(value: string): TrustLevel {
  const mapped = DB_TRUST_TO_DOMAIN[value];
  if (mapped === undefined) {
    throw new ValidationError("bundle.corruptTrust", { details: { value } });
  }
  return mapped;
}

export function domainTrustToDb(value: TrustLevel): string {
  return DOMAIN_TRUST_TO_DB[value];
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapRow(row: BundleRow): Bundle {
  return {
    id: asBundleId(row.id),
    workspaceId: row.workspace_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    okfVersion: row.okf_version,
    defaultTrust: dbTrustToDomain(row.default_trust),
    createdBy: asActorId(row.created_by),
    conceptCount: row.concept_count,
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: row.deleted_at === null ? null : toIso(row.deleted_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION_CODE;
}

export function createBundleModule(deps: CreateBundleModuleDeps): BundleModule {
  const { repo, clock, ids, logger } = deps;

  return {
    async get(_ctx, id) {
      const row = await repo.findById(id);
      if (row === null) {
        throw new NotFoundError("bundle.notFound", { details: { id } });
      }
      return mapRow(row);
    },

    async list(_ctx, workspaceId, args) {
      const connection = await repo.listConnection(workspaceId, args);
      return {
        edges: connection.edges.map((edge) => ({ node: mapRow(edge.node), cursor: edge.cursor })),
        pageInfo: connection.pageInfo,
        totalCount: connection.totalCount,
      };
    },

    async create(ctx, input) {
      const slug = normalizeSlug(input.slug);
      const title = validateTitle(input.title);
      const now = clock.now();
      const id = ids.uuid();
      try {
        const row = await repo.insert({
          id,
          workspaceId: input.workspaceId,
          slug,
          title,
          description: input.description ?? "",
          okfVersion: input.okfVersion ?? DEFAULT_OKF_VERSION,
          defaultTrust: domainTrustToDb(input.defaultTrust ?? DEFAULT_TRUST),
          createdBy: ctx.actor.id,
          createdAt: now,
        });
        logger.info("bundle.created", { id: row.id, workspaceId: input.workspaceId, slug });
        return mapRow(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError("bundle.slugTaken", {
            details: { workspaceId: input.workspaceId, slug },
            cause: err,
          });
        }
        throw err;
      }
    },

    async rename(_ctx, id, expectedVersion, title) {
      const validTitle = validateTitle(title);
      const row = await repo.update(id, expectedVersion, validTitle, clock.now());
      logger.info("bundle.renamed", { id, title: validTitle });
      return mapRow(row);
    },

    async archive(_ctx, id, expectedVersion) {
      const row = await repo.softDelete(id, expectedVersion, clock.now());
      logger.info("bundle.archived", { id });
      return mapRow(row);
    },
  };
}
