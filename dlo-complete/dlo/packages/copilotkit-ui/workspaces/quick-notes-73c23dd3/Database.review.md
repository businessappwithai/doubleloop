# CEO Review — Database.md

> Reviewer: built-in
> Reviewed: 2026-07-23T09:16:31.675Z

ExitPlanMode isn't available as a tool in this session, so I'll deliver the review directly. I've also saved it to `/root/.claude/plans/you-are-a-ceo-level-jolly-quail.md`. I cross-checked Database.md against Architecture.md and RESEARCH.md to separate deliberate scope decisions from unstated gaps.

## Suggestion 1 — The Postgres code path may never run in CI [severity: high]
**Rationale:** The only tests exercising `PostgresNoteStore` — the code real user data depends on — are gated behind `describe.skipIf(!process.env.DATABASE_URL)`. Nothing in Database.md or Architecture.md says CI provisions Postgres, so by default these tests silently skip on every CI run. Only the in-memory store (never used in production) gets continuous coverage.
**Proposed change:** Replace:
> The optional Postgres-backed contract tests (`describe.skipIf(!process.env.DATABASE_URL)` block mentioned in Architecture.md) truncate the `notes` table at the start of each test...

with:
> The Postgres-backed contract tests are not optional in CI: the CI workflow provisions an ephemeral Postgres service container and sets `DATABASE_URL` before `npm test` runs, so `describe.skipIf` only skips locally when a developer hasn't set up Postgres — never in CI.

## Suggestion 2 — Manual `psql -f schema.sql` is an unowned deploy step [severity: high]
**Rationale:** The schema is "applied manually... before first run," but no document assigns this to a script, CI job, or startup hook. A redeploy to a fresh/restored DB where someone forgets this step means every request 500s. The DDL is already idempotent, so eliminating the manual step is cheap.
**Proposed change:** Replace:
> ...applied manually via `psql -f app/server/schema.sql` before first run against a real database.

with:
> `PostgresNoteStore` runs the DDL (via a small `ensureSchema()` call on the same `pg.Pool`) once at construction time, so the schema is applied automatically on every process boot. `psql -f app/server/schema.sql` remains available for manual/inspection use, but the app no longer depends on a human remembering to run it.

## Suggestion 3 — No backup/recovery policy for irrecoverable data [severity: medium]
**Rationale:** "Delete removes it permanently" is a fine product decision, but Database.md is silent on operator error, bad migrations, or accidental `TRUNCATE`. For an app whose entire value is user-authored content, that silence reads as an oversight, not a decision.
**Proposed change:** Add a **Backup & Recovery** subsection:
> No application-level backup mechanism is implemented — this is left to the hosting Postgres provider (managed Postgres with point-in-time recovery / daily snapshots). Deletion is permanent by design (no soft-delete), consistent with the minimal scope — a decision, not a gap. Confirm the chosen host's backup retention before production use.

## Suggestion 4 — No migration convention before real data exists [severity: medium]
**Rationale:** Skipping a migration framework is correct at one table. But the moment a second column is needed, the team will be hand-editing `schema.sql` and running `ALTER TABLE` against a database with real notes, with no change history. Retrofitting discipline after data exists is the expensive path.
**Proposed change:** Append to *Migration approach*:
> The first schema change — however small — should be captured as a new numbered file (e.g. `app/server/migrations/0001_add_x.sql`) rather than a silent hand-edit of `schema.sql`, giving a reviewable history before any migration touches production data. Revisit a full framework only if the table count grows past two or three.

## Suggestion 5 — Application-only length limit has no DB-level backstop [severity: low]
**Rationale:** `body`'s 10,000-char cap lives only in Zod. Any write path that bypasses `NotesService` (admin script, direct fix-up query) silently violates it. A one-line `CHECK` constraint closes this for free.
**Proposed change:**
```sql
body text not null default '' check (char_length(body) <= 10000),
```

## Suggestion 6 — "Last write wins" trade-off isn't stated in this document [severity: low]
**Rationale:** RESEARCH.md notes "concurrent edits are out of scope," but a reader of Database.md alone has no way to know this was deliberate — `updateNote` blindly overwrites with no optimistic-concurrency check.
**Proposed change:** Add under *Query Patterns*:
> **Known trade-off:** `updateNote` performs an unconditional overwrite (no check against `updated_at`) — a deliberate consequence of the single-user scope, not an oversight.

## Overall Verdict
The database design is well-matched to the product's actual scope — no ORM, no migration framework, no multi-tenancy hooks for a single-user, single-table app is the right call, and the document correctly resists over-building. The real risk isn't over-engineering, it's the opposite: a few operational realities that come free with any database-backed app — does the schema actually get applied on deploy, does the real SQL path get tested, what happens when someone deletes the wrong thing — are either unstated or silently optional, which is exactly the kind of gap that's invisible in a demo and becomes an incident in production. Close the two high-severity items before this touches real user data; the rest is cheap insurance that doesn't threaten the project's deliberately minimal scope.