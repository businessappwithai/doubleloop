// src/modules/hierarchy/hierarchy-repository.ts — parameterised SQL access to the `concepts`
// table for hierarchy concerns (Database.md "Query Patterns" §1/§2/§3/§11; Implementation.md m10).
// Deliberately re-declares its own `HierarchyConceptRow` shape and reads the same `concepts` table
// `concept-repository.ts` does, rather than importing that file — per that file's own header
// comment, two modules independently reading one table is exactly what Architecture.md's
// "no module imports another module's *service*" rule allows; a shared row type would make
// `hierarchy` depend on `concepts`'s internals instead.
//
// `moveSubtree` is the one multi-statement write in this module. It runs inside `db.withTransaction`
// and issues exactly three statements, in this order, matching Database.md "Query Patterns §11":
//   1. `pg_advisory_xact_lock(hashtextextended(bundleId, 0))` — serialises all hierarchy mutation
//      for the bundle, taken *before* any write so two concurrent moves in the same bundle can
//      never interleave their reparent + path-rewrite steps.
//   2. The reparenting `UPDATE` on the moved node itself, guarded by `version = $expectedVersion`
//      (Database.md "Optimistic concurrency") — `rowCount === 0` covers a stale read, a concurrent
//      edit, and an unknown id identically, exactly like `concept-repository.ts`, and raises
//      `ConflictError('concept.staleVersion')`.
//   3. A recursive-CTE `UPDATE` that rewrites every live descendant's `path`/`depth` in one
//      statement, so the rename fans out without N+1 queries.
// The Postgres `concepts_no_cycle` constraint trigger and the `concepts_parent_same_bundle_fkey`
// composite FK are the last line of defence against an illegal reparent slipping past
// `hierarchy-module.ts`'s own cycle check; this repository never re-implements that check itself.
import type { Connection, ConnectionArgs, ConnectionRow } from "../../core/connection";
import { buildConnection } from "../../core/connection";
import { ConflictError } from "../../core/errors";
import type { Db } from "../../server/ports";

const CONCEPT_COLUMNS =
  "id, bundle_id, parent_id, slug, path, title, sort_key, depth, is_index, child_count, created_by, version, created_at, updated_at, deleted_at";

/** Raw row shape as returned by the `concepts` table — DB column names. */
export interface HierarchyConceptRow {
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

export interface SiblingRow {
  readonly id: string;
  readonly sortKey: string;
}

export interface MoveSubtreeInput {
  readonly parentId: string | null;
  readonly sortKey: string;
  readonly depth: number;
  readonly path: string;
}

export interface HierarchyRepository {
  findById(bundleId: string, id: string): Promise<HierarchyConceptRow | null>;
  /** Lazily-paginated sidebar children of `parentId` (`null` = bundle root), sort-key ordered. */
  childrenConnection(
    bundleId: string,
    parentId: string | null,
    args: ConnectionArgs,
  ): Promise<Connection<HierarchyConceptRow & ConnectionRow>>;
  /**
   * The recursive-CTE ancestor path (Database.md "Query Patterns §3"), root-first, **inclusive**
   * of `id` itself as the last row — the same anchor-includes-self shape as the documented SQL.
   * Empty array when `id` does not resolve to a live concept.
   */
  ancestorPath(bundleId: string, id: string): Promise<HierarchyConceptRow[]>;
  /** Live children of `parentId`, excluding `excludeId`, ordered `sort_key COLLATE "C", id`. */
  siblings(bundleId: string, parentId: string | null, excludeId: string): Promise<SiblingRow[]>;
  /**
   * Advisory-locks the bundle, reparents `id` per `input`, and rewrites every live descendant's
   * `path`/`depth`. Throws `ConflictError('concept.staleVersion')` when no live row matches `id` +
   * `expectedVersion`.
   */
  moveSubtree(bundleId: string, id: string, expectedVersion: number, input: MoveSubtreeInput, now: Date): Promise<HierarchyConceptRow>;
}

export function createHierarchyRepository(db: Db): HierarchyRepository {
  return {
    async findById(bundleId, id) {
      const result = await db.query<HierarchyConceptRow>(
        `SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE id = $1 AND bundle_id = $2 AND deleted_at IS NULL`,
        [id, bundleId],
      );
      return result.rows[0] ?? null;
    },

    async childrenConnection(bundleId, parentId, args) {
      const result = await db.query<HierarchyConceptRow>(
        `SELECT ${CONCEPT_COLUMNS} FROM concepts
         WHERE bundle_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL
         ORDER BY sort_key COLLATE "C", id`,
        [bundleId, parentId],
      );
      const rows = result.rows.map((row) => ({ ...row, sortKey: row.sort_key }));
      return buildConnection(rows, args);
    },

    async ancestorPath(bundleId, id) {
      const result = await db.query<HierarchyConceptRow>(
        `WITH RECURSIVE ancestry AS (
           SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE id = $1 AND bundle_id = $2 AND deleted_at IS NULL
           UNION ALL
           SELECT p.id, p.bundle_id, p.parent_id, p.slug, p.path, p.title, p.sort_key, p.depth,
                  p.is_index, p.child_count, p.created_by, p.version, p.created_at, p.updated_at, p.deleted_at
             FROM concepts p
             JOIN ancestry a ON a.parent_id = p.id
            WHERE p.deleted_at IS NULL
         )
         SELECT * FROM ancestry ORDER BY depth ASC`,
        [id, bundleId],
      );
      return result.rows;
    },

    async siblings(bundleId, parentId, excludeId) {
      const result = await db.query<{ id: string; sort_key: string }>(
        `SELECT id, sort_key FROM concepts
         WHERE bundle_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND id <> $3 AND deleted_at IS NULL
         ORDER BY sort_key COLLATE "C", id`,
        [bundleId, parentId, excludeId],
      );
      return result.rows.map((row) => ({ id: row.id, sortKey: row.sort_key }));
    },

    async moveSubtree(bundleId, id, expectedVersion, input, now) {
      return db.withTransaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [bundleId]);

        const updateResult = await tx.query<HierarchyConceptRow>(
          `UPDATE concepts
             SET parent_id = $1, sort_key = $2, depth = $3, path = $4, version = version + 1, updated_at = $5
           WHERE id = $6 AND bundle_id = $7 AND version = $8 AND deleted_at IS NULL
           RETURNING ${CONCEPT_COLUMNS}`,
          [input.parentId, input.sortKey, input.depth, input.path, now, id, bundleId, expectedVersion],
        );
        const updated = updateResult.rows[0];
        if (!updated) {
          throw new ConflictError("concept.staleVersion", { details: { bundleId, id, expectedVersion } });
        }

        await tx.query(
          `WITH RECURSIVE subtree AS (
             SELECT id, $1::text AS new_path, $2::smallint AS new_depth
               FROM concepts WHERE id = $3
             UNION ALL
             SELECT ch.id, s.new_path || '/' || ch.slug, (s.new_depth + 1)::smallint
               FROM concepts ch
               JOIN subtree s ON ch.parent_id = s.id
              WHERE ch.deleted_at IS NULL
           )
           UPDATE concepts c
              SET path = s.new_path, depth = s.new_depth, version = c.version + 1, updated_at = $4
             FROM subtree s
            WHERE c.id = s.id AND c.id <> $3`,
          [input.path, input.depth, id, now],
        );

        return updated;
      });
    },
  };
}
