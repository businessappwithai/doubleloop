# CEO Review — Architecture.md

> Reviewer: built-in
> Reviewed: 2026-07-23T09:16:07.948Z

I've written the full review. Since this is a document-analysis task rather than a code-planning task, here it is directly:

## Suggestion 1 — No-auth decision is stated as scope, not validated against deployment context [severity: high]
**Rationale:** The doc says "No auth is in scope (single-user app per the research)" as a settled fact, but never states *who* deploys this or *where* it's reachable from. If it ends up behind a public URL — which "behind whatever process manager/hosting the deploy target uses" doesn't rule out — zero auth means anyone with the URL can read, edit, and delete every note. This is the biggest risk in the document, and it's invisible because it's phrased as an accepted constraint rather than a flagged risk with a boundary condition.

**Proposed change:** In "Best Practices → Security," change "No auth is in scope (single-user app per the research)" to: "No auth is in scope for v1, on the explicit assumption that the app is deployed to a private/trusted network (localhost, VPN, or an internal-only host) and never exposed on the open internet. **This assumption must be re-validated before any public or multi-tenant deployment** — if that changes, auth becomes a blocking prerequisite, not a follow-up."

## Suggestion 2 — PostgresNoteStore, the actual production code path, is never exercised in CI [severity: high]
**Rationale:** The Postgres store's contract tests only run "behind a `DATABASE_URL`-gated `describe.skipIf` block, so CI without a database still passes." That means the code that actually runs in production — real SQL, real parameter binding, real index usage — has no automated coverage unless `DATABASE_URL` happens to be set in CI. Tests exist but don't test what ships.

**Proposed change:** Replace the skip-gated block with a shared `note-store-contract.test.ts` run against **both** `InMemoryNoteStore` and `PostgresNoteStore`, with CI provisioning an ephemeral Postgres (a `postgres:16` service container or `testcontainers`) so the Postgres path always runs, never skipped. Local `npm test` without `DATABASE_URL` can still exercise the in-memory store standalone for fast iteration, but CI is the source of truth and must cover both.

## Suggestion 3 — No stated trigger for introducing schema migrations [severity: medium]
**Rationale:** "No migration framework — a single static DDL file matches the single-table scope" is the right v1 call, but without a stated trigger, the first production schema change will be improvised under time pressure via hand-edited `psql`, with no record of what ran where.

**Proposed change:** Append to "Deployment Shape → Database": "**Revisit trigger:** the moment a second table, a second environment with independently-evolving schema, or any schema change against a Postgres instance holding real data is needed, introduce a minimal migration tool (e.g. `node-pg-migrate`) rather than hand-editing `schema.sql`. Decide this now, not under pressure later."

## Suggestion 4 — No product framing, so scope calls read as assumptions rather than decisions [severity: medium]
**Rationale:** Every "out of scope" call (pagination, auth, migrations, multi-environment config) is individually reasonable, but the doc never states who the user is or how many notes are expected — the exact context that justifies each cut. Without it, a future reader can't tell an intentional tradeoff from an oversight, or when it's been outgrown.

**Proposed change:** Add a new section after "Technology Choices," **"Assumptions & Non-Goals,"** stating: single-user private deployment; expected scale (low hundreds of notes, revisit if reaching the thousands); and an explicit non-goals list (auth, multi-user sharing, offline, rich text, search, tagging, version history, concurrent-edit resolution).

## Suggestion 5 — Concurrent edits silently overwrite each other, unacknowledged [severity: low]
**Rationale:** `updateNote` has no optimistic-concurrency check — two tabs editing the same note silently last-write-wins clobber each other. Fine under a genuine single-user, single-tab assumption, but currently reads as an unconsidered gap rather than an accepted one.

**Proposed change:** Add one line to the Non-Goals section (or "Performance"): "**Concurrency:** `updateNote` performs an unconditional overwrite (no `updated_at` precondition). Accepted under the single-user, single-session assumption above; revisit with a version-check + conflict error if multi-tab/multi-user editing becomes possible."

## Suggestion 6 — No stated build sequencing despite the architecture naturally supporting one [severity: low]
**Rationale:** The `InMemoryNoteStore`/`PostgresNoteStore` split means the team could ship a fully demoable app before Postgres is wired up — but nothing says to build it that way, risking both stores being built in parallel and doubling integration risk.

**Proposed change:** Add a "Build Sequence" note: "(1) `NoteStore` contract + `InMemoryNoteStore` + `NotesService` + both routes, fully working with zero external dependencies; (2) `PostgresNoteStore` + `schema.sql`, wired via the existing factory with no upstream changes. This validates the orchestrator/routes contract early and keeps Postgres integration a late, additive step."

## Overall Verdict
The architecture itself is well-scoped and disciplined — the central-orchestrator pattern, the two-level dependency tree, and the restraint on ORM/DI/migration tooling are all correct calls for an app this size, and the document avoids gold-plating. The real gap is framing, not engineering: several consequential scope decisions (no auth, no pagination, no migrations, no concurrency handling) are presented as settled facts rather than assumptions tied to a stated deployment context — and the one that matters most, auth, is the one most likely to be wrong if this ever leaves a single private user's laptop. Fix that framing gap and close the CI blind spot on the Postgres path, and this is a genuinely well-executed small-app architecture ready to build.