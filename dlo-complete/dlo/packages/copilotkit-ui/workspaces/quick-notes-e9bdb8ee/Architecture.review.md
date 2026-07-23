# CEO Review — Architecture.md

> Reviewer: built-in
> Reviewed: 2026-07-23T09:31:47.955Z

## Suggestion 1 — Unauthenticated write access has no bound or deployment story [severity: high]

**Rationale:** The doc states "No auth by design... this is a single-user demo app, not exposed as multi-tenant" — but it never says *where this is deployed* or *who can reach it*. If it's deployed with a public URL (even for internal demo purposes), any visitor can create unlimited notes with no rate limit, no auth, and no cap on note count or storage. That's an unbounded cost/DoS vector hiding behind a "no auth by design" line that reads like a security decision but is actually silent on exposure. This is the kind of gap that turns into a 2am incident post-launch, not a design nit.

**Proposed change:** In the Deployment Shape section, add an explicit access-control statement, e.g.:

> "**Access:** this app has no authentication and MUST be deployed behind a private network boundary (VPN, internal-only ingress, or platform-level basic auth) — it must never be given a publicly routable URL. If public demo access is required, add a reverse-proxy auth gate (e.g. Basic Auth via the hosting platform) before launch, and cap total note count (e.g. reject `createNote` once `listNotes().length >= 10,000`) to bound storage cost."

Also add this as an explicit line item to the Security bullet under Best Practices, not just implied by "single-user."

## Suggestion 2 — CI never exercises the real Postgres path [severity: high]

**Rationale:** `PostgresNoteRepository` and the `ensureSchema` DDL are the code that actually runs in production, but the doc explicitly says "CI runs the in-memory path only." That means the SQL (parameterized queries, `CREATE TABLE IF NOT EXISTS`, the `updated_at DESC` index) is untested by automation and only "exercised... if a `DATABASE_URL` is available locally" — i.e., optionally, by whichever engineer happens to have Postgres running. A typo in a column name or a broken migration-free schema change would ship straight to production undetected. For a 4-6 module app this is a small, cheap fix to skip.

**Proposed change:** Replace:

> "CI runs the in-memory path only, keeping `npm test` dependency-free per the research's graceful-degradation requirement"

with a two-tier test story:

> "`npm test` locally/in dev runs the in-memory path only (dependency-free, fast). CI additionally runs a second job (`npm run test:pg`) against an ephemeral Postgres service container (GitHub Actions `services: postgres:16`), running the same contract suite against `PostgresNoteRepository` plus a smoke test that `ensureSchema` succeeds against a fresh database. This keeps local dev dependency-free while guaranteeing the actual production code path is never merged untested."

## Suggestion 3 — Delete is instant and irreversible, with no confirmation or recovery path [severity: medium]

**Rationale:** For a notes app, the single worst product experience is "I lost my note." `NoteRepository.remove()` is a hard delete with no soft-delete, no undo, and the doc doesn't even specify a client-side confirm dialog in `NoteList`'s delete button spec ("delete button" is listed with no mention of a confirm step). This is a real risk to the core value prop, not a hypothetical edge case — every notes app that ships this way generates support complaints.

**Proposed change:** In the `note-repository` module description, change:

> `remove(id: string): Promise<boolean>;`

to keep the hard-delete interface (soft-delete is likely over-scoped here) but add an explicit UX requirement in the UI components section:

> "`NoteListItem`'s delete button triggers a native `window.confirm('Delete this note?')` (or equivalent inline confirm state) before calling `onDelete(id)` — no note is deleted without an explicit second action."

This is a one-line addition that closes the most common accidental-data-loss path without adding backend complexity.

## Suggestion 4 — "No pagination needed at this scale" has no defined scale or growth trigger [severity: medium]

**Rationale:** `listNotes()` returns every note in the table, unbounded, on every list-view load. The justification given ("bodies are capped at 10,000 chars — no pagination needed") only bounds *per-note* size, not *note count*. Nothing stops a user from accumulating 50,000 notes, at which point the list view loads the entire table on every visit. The doc treats this as a settled decision rather than a scale assumption that should be explicit and revisited.

**Proposed change:** Add a bullet to Performance under Best Practices:

> "**Scale assumption:** this design assumes O(hundreds) of notes per instance, consistent with a single-user demo. `listNotes()` is unpaginated by design at this scale. If note count is expected to exceed ~1,000, add `LIMIT`/`OFFSET` or keyset pagination to `note-repository.list()` and a 'load more' control in `NoteList` — flagged here so it isn't silently forgotten if usage grows."

This turns a hidden assumption into a documented, revisitable one — which is what a scale-sensitive reviewer actually wants to see.

## Suggestion 5 — Concurrent edits silently last-write-wins with no version check [severity: low]

**Rationale:** `updateNote`/`repo.update()` has no optimistic concurrency mechanism (no version/`updatedAt` precondition). If a note is open in two tabs (easy to do accidentally — e.g. back button + edit), the second save silently clobbers the first with no warning. Low severity because it's a single-user app and the failure mode is "annoying," not catastrophic, but it costs almost nothing to at least detect.

**Proposed change:** Add to the `note-repository` interface docs:

> "`update()` is last-write-wins by design (no optimistic locking) — acceptable for a single-user app where concurrent edits are rare and low-stakes. If this assumption changes (e.g. shared/multi-device use becomes common), add a `updatedAt` precondition check in `NoteService.updateNote` that throws `NoteServiceError('CONFLICT', ...)` when the stored `updatedAt` doesn't match the client's last-seen value."

Documenting the tradeoff explicitly (rather than leaving it unaddressed) is the actual fix here — no code change needed today.

## Suggestion 6 — No backup/durability statement for the only source of truth [severity: low]

**Rationale:** "A single Postgres instance is the only external dependency" is stated matter-of-factly, but there's no mention of backups, point-in-time recovery, or what happens if that instance is lost. For a demo app this may be fine to skip entirely, but "the only external dependency" holding 100% of user data with zero mention of durability is the kind of gap a CEO should force a conscious answer to, even if the answer is "acceptable, this is a demo."

**Proposed change:** Add one line to Deployment Shape:

> "**Durability:** no backup strategy is implemented — data loss on Postgres instance failure is accepted as in-scope risk for a demo app. If this app moves beyond demo status, enable managed daily backups on the Postgres provider (RDS/Cloud SQL/etc.) before real user data accumulates."

## Overall Verdict

The engineering discipline here is genuinely strong for a 4-6 module app — clean layering, no premature ORM/UI-library adoption, sensible test strategy, and a well-justified in-memory fallback for zero-friction dev. The gaps are not in the code architecture but in what the architecture doc *doesn't say*: who can reach this app and what stops them from abusing it, whether the Postgres path is actually tested by CI or just "should work," and what happens on the two failure modes that matter most for a notes app — accidental deletion and data durability. None of these require new modules or a bigger stack; they're mostly one-paragraph additions that convert silent assumptions into explicit, reviewable decisions. Fix the deployment-exposure gap (#1) and the CI coverage gap (#2) before shipping anywhere near a real URL; the rest are cheap insurance worth adding opportunistically.