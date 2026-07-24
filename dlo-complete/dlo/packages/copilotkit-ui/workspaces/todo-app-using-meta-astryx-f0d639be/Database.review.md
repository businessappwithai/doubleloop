# CEO Review — Database.md

> Reviewer: built-in
> Reviewed: 2026-07-24T10:52:12.776Z

## Suggestion 1 — Delete-time position compaction is an anti-pattern [severity: high]
**Rationale:** The `DELETE + compact positions` pattern rewrites every subsequent row's `position` on every single delete. This is O(n) writes for what should be an O(1) operation, and it's a real correctness risk under concurrency: two users (or two tabs) deleting different todos from the same list concurrently will race on the same `UPDATE ... WHERE position > X`, producing duplicate or skipped positions once both transactions commit. There is also no product reason to keep positions contiguous — `ORDER BY position` works fine with gaps.

**Proposed change:** Replace this section:
```sql
BEGIN;
DELETE FROM todos WHERE id = $1;
UPDATE todos SET position = position - 1
  WHERE user_id = $2 AND position > (SELECT position FROM todos WHERE id = $1);
COMMIT;
```
with a no-compaction delete (`DELETE FROM todos WHERE id = $1;` — no transaction needed), and note explicitly: *"Positions are intentionally allowed to have gaps after deletion; ordering only requires relative order, not contiguity. If gap accumulation becomes a concern, reindex lazily (e.g., renumber by 1000s) in a background job, never inline with delete."* For the drag-and-drop reorder case specifically, consider fractional positions (float or numeric) instead of integer + full-batch-update, so a single-item move only touches one row instead of updating every affected id in the transaction.

## Suggestion 2 — Multi-tenant scaffolding is scope creep given "auth is if/when added" [severity: high]
**Rationale:** The schema pays the full cost of multi-tenancy today — nullable `user_id` FKs on every table, `ON DELETE CASCADE`, and a magic-UUID sentinel (`00000000-...`) baked into a unique index to represent "no owner" — for a feature explicitly deferred as "if/when added." This is the worst of both worlds: every query in the "Query Patterns" section already has to reason about `user_id IS NULL` branches, and the sentinel-UUID trick is a hack that will need to be unwound (migrating NULL-owned rows to a real default-user row, or vice versa) the moment auth actually lands. Either commit to multi-user now with a real timeline, or keep the schema single-user and add `user_id` via a normal additive migration later — don't carry the complexity without the feature.

**Proposed change:** In "Data Models → users", replace: *"Auth is not yet implemented... but todos and categories reference it via nullable FK so ownership scoping can be enabled without a breaking schema change"* with an explicit decision, e.g.: *"Auth is out of scope for v1. `user_id` columns and the `users` table are deferred entirely; all todos/categories are unscoped. When auth ships, `user_id` will be added via an additive migration with a backfill step."* If multi-user truly is near-term roadmap, drop the NULL-sentinel and instead seed one real `system`/`default` user row so shared categories are `user_id = <default-user-id>` — turning every `OR user_id IS NULL` clause into a plain equality/JOIN.

## Suggestion 3 — Default categories only exist via a dev-only seed script [severity: high]
**Rationale:** The doc classifies the insertion of the four shared default categories (`Work`, `Personal`, `Ideas`, `Urgent`) as part of `src/lib/db/seed.ts`, described as the "Local development seed... run via `pnpm db:seed`." But the same paragraph then claims these rows let "a fresh install [have] a usable palette without requiring a signed-in user" — implying production needs them too. If `db:seed` is dev tooling that never runs in the deploy pipeline, production ships with zero default categories and a broken first-run UX (empty color palette, no "Work/Personal" chips) until the seed is manually run or a user creates categories from scratch.

**Proposed change:** Split the seed strategy: move the 4 shared/global category rows into a data migration under `src/lib/db/migrations/` (runs in every environment, including the pre-deploy production step described in "Migration approach"), and restrict `seed.ts` to demo-only data (the demo user + 8 sample todos), explicitly local-dev-only. Update the doc's "Default/shared categories" bullet to state which mechanism owns them.

## Suggestion 4 — DDL block risks becoming a second, drifting source of truth [severity: medium]
**Rationale:** "Migration approach" states migrations are generated via `drizzle-kit generate` from `schema.ts`, yet the "DDL" section separately claims to be "the authoritative source of truth for the initial migration." These are two independently hand-maintained representations of the same schema. The first time someone edits `schema.ts` without updating this doc (or vice versa), a reader won't know which one reflects reality — and the doc gives no process for keeping them in sync.

**Proposed change:** Reword the DDL section header from *"The DDL below is the authoritative source of truth"* to: *"The DDL below is a snapshot generated by `drizzle-kit generate` from `src/lib/db/schema.ts` at time of writing — `schema.ts` is the actual source of truth. Regenerate/diff this block whenever schema.ts changes, or replace this section with a link to the generated migration file rather than duplicating SQL by hand."*

## Suggestion 5 — Unbounded `listTodos` query has no explicit scale decision [severity: medium]
**Rationale:** The "List todos" query has no `LIMIT`/cursor and returns the full list every time. For a todo app this is very likely fine at realistic scale (dozens to low hundreds of items per user), but the doc doesn't say that's a deliberate choice — it just omits pagination, which reads as an oversight rather than a decision, and will surprise whoever picks this up later if a power-user accumulates thousands of todos.

**Proposed change:** Add one sentence after the query: *"No pagination is applied — this is an intentional scope decision for expected list sizes (dozens–low hundreds of todos per user). If usage patterns change (e.g., bulk-import, long-lived todo lists), revisit with a cursor on `(position)` or `(user_id, created_at)`."*

## Suggestion 6 — `categories` lacks `updated_at`, unlike `users` and `todos` [severity: low]
**Rationale:** `users` and `todos` both get `updated_at` + a maintenance trigger, but `categories` has neither — despite `name`, `color_hex`, and `icon` almost certainly being editable given the "category colors" theming feature. This is a minor but real inconsistency that will make future debugging ("when did this category's color change?") harder than it needs to be, for the cost of one column and one trigger.

**Proposed change:** Add `updated_at timestamptz NOT NULL DEFAULT now()` to the `categories` table definition and a matching `trg_categories_updated_at` trigger using the existing `set_updated_at()` function, mirroring the pattern already used for `users`/`todos`.

## Overall Verdict
The schema is competent SQL — sensible indexing, sane FK cascade choices, a reasonable seed/fixture split for tests — but it's solving two problems it hasn't fully committed to: multi-tenancy (nullable `user_id` everywhere plus a NULL-sentinel hack) for a deferred auth feature, and ordered-list maintenance via an anti-pattern (eager position compaction) that will bite under any real concurrency. Both should be resolved with an explicit decision rather than left as half-measures before this ships, and the dev-seed-vs-production-defaults gap is a genuine "day one will look broken" risk that's cheap to close now. Everything else here is incremental hygiene, not a blocker.