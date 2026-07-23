# CEO Review — Database.md

> Reviewer: built-in
> Reviewed: 2026-07-23T09:32:19.370Z

I've completed the review — here it is. (Note: this environment doesn't expose an `ExitPlanMode` tool, so I'm delivering the result directly; the full text is also saved at `/root/.claude/plans/you-are-a-ceo-level-dreamy-quiche.md`.)

## Suggestion 1 — No user ownership model; single-user assumption is undeclared [severity: high]
**Rationale:** The `notes` table has no `user_id` column and no auth is mentioned anywhere. That's fine only if Quick Notes is permanently single-user/local — but the doc never states that as a deliberate decision, it reads as an omission. Retrofitting ownership onto a populated table later (backfill a NOT NULL FK, add RLS, rewrite every query) is painful and risky.
**Proposed change:** Add to the Overview, after "Migration approach":
> **Multi-tenancy stance:** Quick Notes is intentionally single-user/local with no auth in this milestone. The `notes` table has no `user_id` column by design. If multi-user support is ever added, this requires a versioned migration (add `user_id uuid NOT NULL REFERENCES users(id)`, backfill, index `(user_id, updated_at DESC)`, filter all five queries by owner) — not an in-place DDL edit like the rest of this doc assumes.

## Suggestion 2 — Hard delete with zero recovery path [severity: high]
**Rationale:** `DELETE FROM notes WHERE id = $1` is permanent. For an app whose entire value proposition is "don't lose your notes," a misclick or client bug destroys data with no trash, undo, or backup story mentioned. Cheap to fix now, expensive after users have lost content.
**Proposed change:** Replace query pattern 5:
> ```sql
> DELETE FROM notes WHERE id = $1;
> ```
with:
> ```sql
> UPDATE notes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id;
> ```
> Add a nullable `deleted_at timestamptz` column; list query gains `WHERE deleted_at IS NULL`. Hard-delete rows older than 30 days via a scheduled job.

## Suggestion 3 — Last-write-wins on concurrent edits, with no detection [severity: medium]
**Rationale:** The update query has no concurrency guard. Two tabs editing the same note silently clobber each other with no warning and no version history to recover from.
**Proposed change:** Update query pattern 4:
> ```sql
> UPDATE notes SET title = $2, body = $3, updated_at = $4
> WHERE id = $1 AND updated_at = $5
> RETURNING id, title, body, created_at, updated_at;
> ```
> Client sends the `updated_at` it last read; 0 rows returned → `NoteService` raises `CONFLICT` instead of overwriting silently. If out of scope, state that explicitly as an accepted risk.

## Suggestion 4 — Unbounded list query has no safety net [severity: medium]
**Rationale:** "Appropriate for a small personal note set" is asserted, not enforced — no `LIMIT`, no ceiling. A pathological row count (bulk import, script bug) silently degrades the list endpoint with no warning anywhere in the code.
**Proposed change:** Query pattern 1 gains `LIMIT 1000`:
> ```sql
> SELECT id, title, body, created_at, updated_at FROM notes
> ORDER BY updated_at DESC LIMIT 1000;
> ```
> Not pagination — just a defensive ceiling so a pathological count degrades gracefully instead of silently.

## Suggestion 5 — No backup / point-in-time recovery policy stated [severity: medium]
**Rationale:** Combined with hard deletes and silent overwrite conflicts, this doc currently has zero recovery story for any class of data loss. A CEO should be able to answer "if we lose a customer's notes, how do we get them back?" from this document — right now they can't.
**Proposed change:** Add a "Backup & Recovery" section after "Seed & Fixture Strategy":
> **Production:** `DATABASE_URL` points at [hosting provider] with automated daily backups and N-day PITR enabled. **Recovery SLA:** a lost note can be restored from the most recent backup within [X hours] — manual/operational until Suggestion 2 lands.

## Suggestion 6 — No stated trigger for graduating off "no migration framework" [severity: low]
**Rationale:** Editing the DDL block in place is right for today but isn't named as unsafe once a change is destructive against populated data (column rename/drop/retype, adding NOT NULL without a default) — exactly the situation Suggestion 1's multi-user migration would hit.
**Proposed change:** Append to "Migration approach":
> **This stops being safe the moment a change is destructive against populated data** — renaming/dropping a column, retyping a column, or adding a `NOT NULL` column without a default. Adopt a real migration tool (e.g. `node-pg-migrate`) at that point.

## Overall Verdict
The schema is well-executed for what it explicitly claims to be — a small, single-user, single-table notes app — with sensible indexing, clean parameterized queries, and a right-sized migration approach. The real gap is strategic, not technical: the doc never states its single-user/no-recovery scope as a deliberate, bounded decision, leaving the two highest-stakes risks — no path to multi-user ownership and no recovery story for hard deletes or silent overwrites — unaddressed. None of these require significant upfront investment; they should be resolved as conscious decisions now, while the schema is still one table, rather than discovered later as production incidents.