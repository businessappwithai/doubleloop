// src/modules/concepts/concept-repository.ts — parameterised SQL access to the `concepts` table
// (Database.md "concepts"; Implementation.md m10). Mirrors `bundle-repository.ts`'s shape: every
// statement uses only `$n` placeholders, every read path filters `deleted_at IS NULL`, and every
// version-guarded write raises `ConflictError('concept.staleVersion')` on a zero `rowCount` —
// covering a stale read, a concurrent edit, and an unknown id identically, exactly like
// Database.md's documented optimistic-concurrency behaviour. `siblingSortKeys` and
// `parentPathAndDepth` exist so `concept-module.ts` can compute a new concept's `sort_key`
// (append-as-last-child, via `hierarchy/sort-key.ts`'s pure `keyBetween`) and `path`/`depth`
// without importing the sibling `hierarchy` module — this file queries the same `concepts` table
// directly instead, which is what Architecture.md's "no module imports another feature module"
// rule actually forbids (importing another module's *service*), not two modules independently
// reading one table.
import type { Connection, ConnectionArgs, ConnectionRow } from "../../core/connection";
import { buildConnection } from "../../core/connection";
import { ConflictError } from "../../core/errors";
import type { Db } from "../../server/ports";

const CONCEPT_COLUMNS =
  "id, bundle_id, parent_id, slug, path, title, sort_key, depth, is_index, child_count, created_by, version, created_at, updated_at, deleted_at";

/** Raw row shape as returned by the `concepts` table — DB column names. */
export interface ConceptRow {
  readonly id: string;
  readonly bundle_id: string;
  readonly parent_id: string | null;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly sort_key: string;
  readonly depth: number;
  readonly is_index: boolean;
  readonly child_count: number;
  readonly created_by: string;
  readonly version: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly deleted_at: Date | string | null;
}

export interface InsertConceptRow {
  readonly id: string;
  readonly bundleId: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly sortKey: string;
  readonly depth: number;
  readonly isIndex: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface ConceptRepository {
  insert(row: InsertConceptRow): Promise<ConceptRow>;
  findById(bundleId: string, id: string): Promise<ConceptRow | null>;
  findByPath(bundleId: string, path: string): Promise<ConceptRow | null>;
  listConnection(bundleId: string, args: ConnectionArgs): Promise<Connection<ConceptRow & ConnectionRow>>;
  /** The live sibling with the greatest `sort_key` under `parentId` (`null` = bundle root), or `null` if there are none. */
  lastSiblingSortKey(bundleId: string, parentId: string | null): Promise<string | null>;
  /** Raises `ConflictError('concept.staleVersion')` when no live row matches `id` + `expectedVersion`. */
  updateTitle(bundleId: string, id: string, expectedVersion: number, title: string, now: Date): Promise<ConceptRow>;
  /** Raises `ConflictError('concept.staleVersion')` when no live row matches `id` + `expectedVersion`. */
  setIsIndex(
    bundleId: string,
    id: string,
    expectedVersion: number,
    isIndex: boolean,
    now: Date,
  ): Promise<ConceptRow>;
  /** Raises `ConflictError('concept.staleVersion')` when no live row matches `id` + `expectedVersion`. */
  softDelete(bundleId: string, id: string, expectedVersion: number, now: Date): Promise<ConceptRow>;
}

function assertRow(rowCount: number, code: string, details: Record<string, unknown>): void {
  if (rowCount === 0) {
    throw new ConflictError(code, { details });
  }
}

export function createConceptRepository(db: Db): ConceptRepository {
  return {
    async insert(row) {
      const result = await db.query<ConceptRow>(
        `INSERT INTO concepts (id, bundle_id, parent_id, slug, path, title, sort_key, depth, is_index, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING ${CONCEPT_COLUMNS}`,
        [
          row.id,
          row.bundleId,
          row.parentId,
          row.slug,
          row.path,
          row.title,
          row.sortKey,
          row.depth,
          row.isIndex,
          row.createdBy,
          row.createdAt,
        ],
      );
      return result.rows[0]!;
    },

    async findById(bundleId, id) {
      const result = await db.query<ConceptRow>(
        `SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE id = $1 AND bundle_id = $2 AND deleted_at IS NULL`,
        [id, bundleId],
      );
      return result.rows[0] ?? null;
    },

    async findByPath(bundleId, path) {
      const result = await db.query<ConceptRow>(
        `SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE bundle_id = $1 AND path = $2 AND deleted_at IS NULL`,
        [bundleId, path],
      );
      return result.rows[0] ?? null;
    },

    async listConnection(bundleId, args) {
      const result = await db.query<ConceptRow>(
        `SELECT ${CONCEPT_COLUMNS} FROM concepts
         WHERE bundle_id = $1 AND deleted_at IS NULL
         ORDER BY sort_key COLLATE "C", id`,
        [bundleId],
      );
      const rows = result.rows.map((row) => ({ ...row, sortKey: row.sort_key }));
      return buildConnection(rows, args);
    },

    async lastSiblingSortKey(bundleId, parentId) {
      const result = await db.query<{ sort_key: string }>(
        `SELECT sort_key FROM concepts
         WHERE bundle_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL
         ORDER BY sort_key COLLATE "C" DESC
         LIMIT 1`,
        [bundleId, parentId],
      );
      return result.rows[0]?.sort_key ?? null;
    },

    async updateTitle(bundleId, id, expectedVersion, title, now) {
      const result = await db.query<ConceptRow>(
        `UPDATE concepts
         SET title = $4, version = version + 1, updated_at = $5
         WHERE id = $1 AND bundle_id = $2 AND version = $3 AND deleted_at IS NULL
         RETURNING ${CONCEPT_COLUMNS}`,
        [id, bundleId, expectedVersion, title, now],
      );
      assertRow(result.rowCount, "concept.staleVersion", { id, expectedVersion });
      return result.rows[0]!;
    },

    async setIsIndex(bundleId, id, expectedVersion, isIndex, now) {
      const result = await db.query<ConceptRow>(
        `UPDATE concepts
         SET is_index = $4, version = version + 1, updated_at = $5
         WHERE id = $1 AND bundle_id = $2 AND version = $3 AND deleted_at IS NULL
         RETURNING ${CONCEPT_COLUMNS}`,
        [id, bundleId, expectedVersion, isIndex, now],
      );
      assertRow(result.rowCount, "concept.staleVersion", { id, expectedVersion });
      return result.rows[0]!;
    },

    async softDelete(bundleId, id, expectedVersion, now) {
      const result = await db.query<ConceptRow>(
        `UPDATE concepts
         SET deleted_at = $4, version = version + 1, updated_at = $4
         WHERE id = $1 AND bundle_id = $2 AND version = $3 AND deleted_at IS NULL
         RETURNING ${CONCEPT_COLUMNS}`,
        [id, bundleId, expectedVersion, now],
      );
      assertRow(result.rowCount, "concept.staleVersion", { id, expectedVersion });
      return result.rows[0]!;
    },
  };
}
