# CEO Review — Implementation.md

> Reviewer: built-in
> Reviewed: 2026-07-23T09:32:28.189Z

## Suggestion 1 — Schema bootstrap (`ensureSchema`) is built but never called [severity: high]
**Rationale:** m3 builds `ensureSchema(pool)` to run the idempotent DDL (pgcrypto extension, `notes` table, index), but no module in the build order — not m5's `getNoteService()`, not m10's integration pass — ever invokes it. As written, the first time this app runs against a real Postgres database with `DATABASE_URL` set, every query will fail because the `notes` table doesn't exist. The entire Postgres code path is dead on arrival unless someone runs the DDL by hand.

**Proposed change:** In m5's spec, change "Export singleton `getNoteService()` that picks `PostgresNoteRepository(getPool())` when `getConfig().databaseUrl` is set, else `InMemoryNoteRepository`, memoized module-level" to: "on first call, checks `getConfig().databaseUrl`: if set, calls `getPool()`, awaits `ensureSchema(pool)` once, then constructs `PostgresNoteRepository(pool)`; otherwise constructs `InMemoryNoteRepository`." Add an acceptance criterion that `ensureSchema` runs before the first query when `DATABASE_URL` is set.

## Suggestion 2 — Postgres path has zero automated test coverage [severity: high]
**Rationale:** `tests/note-repository.test.ts` and `tests/note-service.test.ts` are explicitly scoped to `InMemoryNoteRepository` only. `PostgresNoteRepository` — the code that actually runs in production — is never exercised by `npm test`. For a notes app whose entire value proposition is "don't lose my data," shipping the persistence layer untested is a strategic risk.

**Proposed change:** Add `tests/note-repository.postgres.test.ts` running the same CRUD suite against `PostgresNoteRepository` when `TEST_DATABASE_URL` is present (skip with a clear notice otherwise, not a silent pass). Reflect this in m4's and m10's acceptance criteria.

## Suggestion 3 — m10's declared file scope contradicts its own job description [severity: high]
**Rationale:** m10 must "fix any cross-module integration issues (import paths, type mismatches)" across the app, but its `touches` array is only `app.css`, `router.tsx`, `.env.example`. Real integration bugs between m5–m9 would require editing files m10 isn't authorized to touch. If the execution harness enforces `touches` as a hard boundary, m10 will be structurally unable to complete its own acceptance criteria — the single most concrete "this plan will fail in practice" finding here.

**Proposed change:** Expand m10's `touches` to include all route, service, repository, and component files, with a note: "m10 may touch any file produced by m1–m9 to resolve integration defects, but must not change any module's documented responsibility or public interface."

## Suggestion 4 — No stated position on auth/multi-tenancy [severity: medium]
**Rationale:** Every note is globally visible and editable/deletable by anyone who reaches the app — no user concept exists anywhere. That may be correct for an MVP, but nothing says so explicitly; a CEO needs to know if this is a decision or an oversight.

**Proposed change:** Add a "## Scope Assumptions" section stating this is a single-tenant, unauthenticated MVP, that auth/ownership/sharing are explicitly out of scope, and that it shouldn't be deployed behind a public unauthenticated URL without revisiting that.

## Suggestion 5 — Silent fallback to in-memory storage risks unnoticed data loss [severity: medium]
**Rationale:** `getNoteService()` silently picks in-memory storage whenever `DATABASE_URL` is unset — including by accident (typo, misconfigured deploy). Combined with Suggestion 1, it's plausible to ship an app that quietly never persists anything, discovered only when a user's notes vanish.

**Proposed change:** Add to m5's acceptance: log a clear warning (`console.warn('[note-service] DATABASE_URL not set — using in-memory storage, data will not persist')`) on first construction when `databaseUrl` is null. Add a matching m10 acceptance criterion that this warning prints on boot.

## Suggestion 6 — Route-level acceptance criteria are unverified by automated tests [severity: medium]
**Rationale:** m7–m9's user-facing acceptance criteria are only checked by `npx tsc --noEmit` plus a manual `npm run dev` click-through in m10. `npm test` never touches the route files or `createServerFn` wiring, so regressions in routing have no automated tripwire.

**Proposed change:** Add route-level `@testing-library/react` tests per route (e.g. `tests/routes/index.test.tsx` seeding an in-memory service and asserting list order + delete behavior), mirrored for m8/m9, and fold them into m10's `npm test` acceptance clause.

## Suggestion 7 — No stated handling for concurrent edits (last-write-wins) [severity: low]
**Rationale:** Two tabs editing the same note silently overwrite each other with no conflict detection — a plausible real scenario whose failure mode is silent data loss.

**Proposed change:** Add one line to the Scope Assumptions section: "Concurrent edits use last-write-wins semantics with no conflict detection; this is an accepted MVP limitation, not a defect."

## Overall Verdict

The scope itself is right-sized for an MVP notes app — no premature features, a clean layered architecture, and sensible parallelization in the build order. The real risk isn't over- or under-building, it's that the "production" code path (Postgres) is under-verified and partially disconnected: the schema bootstrap is written but never called, `PostgresNoteRepository` is never tested, and the module responsible for catching integration bugs (m10) is scoped to a file list too narrow to actually fix them. Fix those three high-severity items first, then close the medium/low gaps by making the unauthenticated, single-tenant, last-write-wins nature of this MVP an explicit written decision instead of a silent omission.

(Full review also saved to `/root/.claude/plans/you-are-a-ceo-level-stateless-widget.md`.)