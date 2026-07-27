// src/modules/hierarchy/hierarchy-module.ts — the `HierarchyModule` domain service
// (Implementation.md m10). Owns the one piece of business logic `hierarchy-repository.ts`
// deliberately does not: rejecting a move that would make a node its own ancestor. It does this
// with a single call to `repo.ancestorPath(bundleId, newParentId)` — that query is *inclusive* of
// `newParentId` itself (see `hierarchy-repository.ts`'s header comment), so checking whether the
// moved node's id appears anywhere in that inclusive ancestor chain catches both shapes of cycle
// with one code path: self-parenting (`newParentId === id`, where the inclusive chain's own last
// row already is `id`) and "move a node under its own descendant" (where walking `newParentId`'s
// ancestors back up to the root passes through `id`). `move()` never re-derives a cycle check
// independently of this query — the Postgres `concepts_no_cycle` constraint trigger is the final
// backstop, not a second implementation of the same rule.
//
// Sort-key placement: `afterId` is a genuine three-state argument, not a boolean flag —
// `undefined` (the argument omitted) appends as the last child, `null` prepends as the first
// child, and a concrete id inserts immediately after that sibling. `boundsFor` resolves all three
// against `repo.siblings`, which already excludes the node being moved so a same-parent reorder
// never bounds a key against its own current position.
import type { RequestContext } from "../../core/context";
import { NotFoundError, ValidationError } from "../../core/errors";
import type { BundleId, ConceptId } from "../../core/ids";
import { asActorId, asBundleId, asConceptId } from "../../core/ids";
import type { Concept } from "../../core/types";
import type { Clock, Logger } from "../../server/ports";
import type { Connection, ConnectionArgs } from "../../core/connection";
import { keyBetween } from "./sort-key";
import type { HierarchyConceptRow, HierarchyRepository, SiblingRow } from "./hierarchy-repository";

export interface MoveConceptPatch {
  readonly newParentId: ConceptId | null;
  /**
   * `undefined` = append as the last child (default). `null` = prepend as the first child. A
   * concrete id = insert immediately after that sibling.
   */
  readonly afterId?: ConceptId | null;
}

export interface HierarchyModule {
  children(ctx: RequestContext, bundleId: BundleId, parentId: ConceptId | null, args: ConnectionArgs): Promise<Connection<Concept>>;
  /** Root-first ancestor chain of `id`, **excluding** `id` itself. */
  ancestors(ctx: RequestContext, bundleId: BundleId, id: ConceptId): Promise<Concept[]>;
  /**
   * Throws `NotFoundError('concept.notFound')` for an unknown `id`,
   * `NotFoundError('hierarchy.parentNotFound')` for an unknown `newParentId`,
   * `ValidationError('hierarchy.cycle')` for a move that would make `id` its own ancestor,
   * `NotFoundError('hierarchy.afterConceptNotFound')` when `afterId` does not name a live sibling
   * of the destination, and `ConflictError('concept.staleVersion')` when `expectedVersion` no
   * longer matches.
   */
  move(
    ctx: RequestContext,
    bundleId: BundleId,
    id: ConceptId,
    expectedVersion: number,
    patch: MoveConceptPatch,
  ): Promise<Concept>;
}

export interface CreateHierarchyModuleDeps {
  readonly repo: HierarchyRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapRow(row: HierarchyConceptRow): Concept {
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

/** Resolves `afterId`'s three states against the destination's current live siblings. */
function boundsFor(
  siblings: readonly SiblingRow[],
  afterId: ConceptId | null | undefined,
): { lower: string | null; upper: string | null } {
  if (afterId === undefined) {
    const last = siblings[siblings.length - 1];
    return { lower: last ? last.sortKey : null, upper: null };
  }
  if (afterId === null) {
    const first = siblings[0];
    return { lower: null, upper: first ? first.sortKey : null };
  }
  const index = siblings.findIndex((sibling) => sibling.id === afterId);
  if (index === -1) {
    throw new NotFoundError("hierarchy.afterConceptNotFound", { details: { afterId } });
  }
  const lower = siblings[index]!.sortKey;
  const upperSibling = siblings[index + 1];
  return { lower, upper: upperSibling ? upperSibling.sortKey : null };
}

export function createHierarchyModule(deps: CreateHierarchyModuleDeps): HierarchyModule {
  const { repo, clock, logger } = deps;

  return {
    async children(_ctx, bundleId, parentId, args) {
      const connection = await repo.childrenConnection(bundleId, parentId, args);
      return {
        edges: connection.edges.map((edge) => ({ node: mapRow(edge.node), cursor: edge.cursor })),
        pageInfo: connection.pageInfo,
        totalCount: connection.totalCount,
      };
    },

    async ancestors(_ctx, bundleId, id) {
      const chain = await repo.ancestorPath(bundleId, id);
      return chain.filter((row) => row.id !== id).map(mapRow);
    },

    async move(_ctx, bundleId, id, expectedVersion, patch) {
      const target = await repo.findById(bundleId, id);
      if (target === null) {
        throw new NotFoundError("concept.notFound", { details: { bundleId, id } });
      }

      let parent: HierarchyConceptRow | null = null;
      if (patch.newParentId !== null) {
        parent = await repo.findById(bundleId, patch.newParentId);
        if (parent === null) {
          throw new NotFoundError("hierarchy.parentNotFound", {
            details: { bundleId, newParentId: patch.newParentId },
          });
        }
        const ancestry = await repo.ancestorPath(bundleId, patch.newParentId);
        if (ancestry.some((row) => row.id === id)) {
          throw new ValidationError("hierarchy.cycle", { details: { bundleId, id, newParentId: patch.newParentId } });
        }
      }

      const siblings = await repo.siblings(bundleId, patch.newParentId, id);
      const { lower, upper } = boundsFor(siblings, patch.afterId);
      const sortKey = keyBetween(lower, upper);
      const depth = parent === null ? 0 : parent.depth + 1;
      const path = parent === null ? target.slug : `${parent.path}/${target.slug}`;

      const updated = await repo.moveSubtree(
        bundleId,
        id,
        expectedVersion,
        { parentId: patch.newParentId, sortKey, depth, path },
        clock.now(),
      );
      logger.info("hierarchy.moved", { bundleId, id, newParentId: patch.newParentId });
      return mapRow(updated);
    },
  };
}
