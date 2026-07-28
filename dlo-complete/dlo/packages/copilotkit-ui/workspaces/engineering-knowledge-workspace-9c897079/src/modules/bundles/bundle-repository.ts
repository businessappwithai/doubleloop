// src/modules/bundles/bundle-repository.ts — parameterised SQL access to the `bundles` table
// (Database.md "bundles" table; Implementation.md m9). Every statement uses only `$n`
// placeholders (Database.md "Central Orchestrator" rule, enforced at runtime by `pg-db.ts`), and
// every read path filters `deleted_at IS NULL` per Database.md's "Soft delete" convention, so a
// trashed bundle is invisible to `findById`/`findBySlug`/`listConnection` without every call site
// repeating the filter. `update` and `softDelete` both guard on `version = $2`
// (Database.md "Optimistic concurrency") and raise `ConflictError('bundle.staleVersion')` on a
// zero `rowCount` — that covers a stale read, a concurrent archive, and an unknown id identically,
// which is the documented behaviour for a versioned write. `listConnection` fetches the bundle's
// entire live row set ordered exactly like `bundles_workspace_list_idx`
// (`workspace_id, title COLLATE "C", id`) and hands it to `buildConnection` whole — per
// `core/connection.ts`'s contract, that function is only pure if it receives the full,
// already-scoped result set, not a single DB-fetched page.
import type { Connection, ConnectionArgs, ConnectionRow } from "../../core/connection";
import { buildConnection } from "../../core/connection";
import { ConflictError } from "../../core/errors";
import type { Db } from "../../server/ports";

const BUNDLE_COLUMNS =
  "id, workspace_id, slug, title, description, okf_version, default_trust, created_by, concept_count, version, created_at, updated_at, deleted_at";

/** Raw row shape as returned by the `bundles` table — DB column names, DB enum spelling. */
export interface BundleRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly okf_version: string;
  readonly default_trust: string;
  readonly created_by: string;
  readonly concept_count: number;
  readonly version: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly deleted_at: Date | string | null;
}

export interface InsertBundleRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly okfVersion: string;
  /** DB enum spelling (e.g. `"machine_confirmed"`) — the caller (bundle-module.ts) converts. */
  readonly defaultTrust: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface BundleRepository {
  insert(row: InsertBundleRow): Promise<BundleRow>;
  findById(id: string): Promise<BundleRow | null>;
  findBySlug(workspaceId: string, slug: string): Promise<BundleRow | null>;
  listConnection(workspaceId: string, args: ConnectionArgs): Promise<Connection<BundleRow & ConnectionRow>>;
  /** Raises `ConflictError('bundle.staleVersion')` when no live row matches `id` + `expectedVersion`. */
  update(id: string, expectedVersion: number, title: string, now: Date): Promise<BundleRow>;
  /** Raises `ConflictError('bundle.staleVersion')` when no live row matches `id` + `expectedVersion`. */
  softDelete(id: string, expectedVersion: number, now: Date): Promise<BundleRow>;
}

export function createBundleRepository(db: Db): BundleRepository {
  return {
    async insert(row) {
      const result = await db.query<BundleRow>(
        `INSERT INTO bundles (id, workspace_id, slug, title, description, okf_version, default_trust, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         RETURNING ${BUNDLE_COLUMNS}`,
        [
          row.id,
          row.workspaceId,
          row.slug,
          row.title,
          row.description,
          row.okfVersion,
          row.defaultTrust,
          row.createdBy,
          row.createdAt,
        ],
      );
      return result.rows[0]!;
    },

    async findById(id) {
      const result = await db.query<BundleRow>(
        `SELECT ${BUNDLE_COLUMNS} FROM bundles WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async findBySlug(workspaceId, slug) {
      const result = await db.query<BundleRow>(
        `SELECT ${BUNDLE_COLUMNS} FROM bundles WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
        [workspaceId, slug],
      );
      return result.rows[0] ?? null;
    },

    async listConnection(workspaceId, args) {
      const result = await db.query<BundleRow>(
        `SELECT ${BUNDLE_COLUMNS} FROM bundles
         WHERE workspace_id = $1 AND deleted_at IS NULL
         ORDER BY title COLLATE "C", id`,
        [workspaceId],
      );
      const rows = result.rows.map((row) => ({ ...row, sortKey: row.title }));
      return buildConnection(rows, args);
    },

    async update(id, expectedVersion, title, now) {
      const result = await db.query<BundleRow>(
        `UPDATE bundles
         SET title = $3, version = version + 1, updated_at = $4
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING ${BUNDLE_COLUMNS}`,
        [id, expectedVersion, title, now],
      );
      if (result.rowCount === 0) {
        throw new ConflictError("bundle.staleVersion", { details: { id, expectedVersion } });
      }
      return result.rows[0]!;
    },

    async softDelete(id, expectedVersion, now) {
      const result = await db.query<BundleRow>(
        `UPDATE bundles
         SET deleted_at = $3, version = version + 1, updated_at = $3
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING ${BUNDLE_COLUMNS}`,
        [id, expectedVersion, now],
      );
      if (result.rowCount === 0) {
        throw new ConflictError("bundle.staleVersion", { details: { id, expectedVersion } });
      }
      return result.rows[0]!;
    },
  };
}
