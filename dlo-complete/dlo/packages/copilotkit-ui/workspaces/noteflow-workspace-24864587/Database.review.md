# CEO Review — Database.md

> Reviewer: built-in
> Reviewed: 2026-07-25T17:41:08.859Z

## Suggestion 1 — Sharing requires the recipient to already have an account; there is no link-based/public share [severity: high]

**Rationale:** `page_shares` grants permission only via `user_id`, meaning a workspace member can only share a page with someone who has already signed up. For a Notion/Coda-style workspace product, "share this page with anyone via a link" (including view-only public links, or invite-by-email that auto-creates a pending grant) is one of the primary organic-growth loops — a large fraction of new signups in this product category come from clicking a shared link, not from a marketing funnel. Shipping v1 without it means the product cannot generate its own distribution, and retrofitting it later requires a new table plus new resolution logic in `PermissionService`, which is exactly the kind of thing that's cheap to design for now and expensive to bolt on after rows and API contracts exist.

**Proposed change:** Add a `page_share_links` table alongside `page_shares` before v1 ships, even if the UI for it lands slightly later:
```sql
CREATE TABLE page_share_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  token       text NOT NULL,
  permission  share_permission NOT NULL,
  created_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX page_share_links_token_unique ON page_share_links (token);
```
Update the "Property types (v1 scope decision)" framing to explicitly call out that link-sharing was considered and either included or consciously deferred with a stated reason — right now the document is silent on it entirely, which reads as an oversight rather than a decision.

## Suggestion 2 — No path to honor a "delete my account" / GDPR erasure request [severity: high]

**Rationale:** `users` has no `deleted_at`, and `workspaces.owner_id` is `ON DELETE RESTRICT` with the document itself noting "there is no user-deletion route in v1 anyway." That's fine as a v1 UX decision, but it's a compliance gap, not just a feature gap: `users` stores `email` and `password_hash`, and if this product has any EU/UK users, GDPR Article 17 obligates you to be able to erase personal data on request within a bounded time, regardless of whether the *product* exposes a self-serve "delete account" button. Today there is no operational path at all — not even a manual one — to erase a user's `email`/`password_hash`/`display_name` without first building an ownership-transfer flow for every workspace they own. This is the kind of gap that turns into a fire drill the first time legal/support gets a real request, not a theoretical one.

**Proposed change:** Add an `anonymize_user(uuid)` operational procedure (or documented manual runbook) now, even without a UI, and note it explicitly in this document:
```sql
-- Manual/ops-only erasure path, not exposed via API in v1.
UPDATE users
SET email = 'deleted-' || id || '@deleted.invalid',
    password_hash = '', display_name = 'Deleted User'
WHERE id = $1;
```
And add a line under "Authorization boundary" or a new "Data retention & erasure" subsection stating: workspaces the user solely owns must be transferred or archived by an admin before erasure; this is a documented manual runbook for v1, promoted to a self-serve route in a later milestone. Silence on this in a document that is otherwise this rigorous about edge cases (dangling `group_by`, cycle prevention) is the actual risk — it signals nobody thought about it, not that it was triaged and deferred.

## Suggestion 3 — Concurrent edits to the same block have no conflict detection, in a product literally named "Workspace" [severity: high]

**Rationale:** `blocks` and `pages` are updated with plain `UPDATE ... WHERE id = $1` (see Query Pattern 3) and `updated_at` is trigger-maintained but never read back to detect a stale write. If two collaborators (or two tabs) edit the same block's `content` concurrently, the second write silently clobbers the first with no warning to either user — a classic last-write-wins data-loss bug. This is a materially different risk profile than a single-player note app precisely because the product is positioned as a *workspace* with `workspace_members` and `page_shares` — i.e., multi-user editing is a stated use case, not a hypothetical one. Shipping this without any optimistic-concurrency guard means the first real collaboration session that hits a conflict produces silent data loss, which is a trust-destroying bug class to discover in production rather than in design review.

**Proposed change:** Add a monotonic `version integer NOT NULL DEFAULT 1` column to `blocks` (and `pages` if body-level concurrent edits to `properties`/`title` are also expected), and require writes to be conditional:
```sql
ALTER TABLE blocks ADD COLUMN version integer NOT NULL DEFAULT 1;
```
```sql
UPDATE blocks SET content = $2, version = version + 1, updated_at = now()
WHERE id = $1 AND version = $3
RETURNING version;
```
If zero rows are returned, the service layer surfaces a conflict to the client instead of silently overwriting. Document this explicitly as the v1 conflict-handling strategy (even if the initial UI response to a conflict is just "reload the page"), rather than leaving concurrent-write behavior unspecified.

## Suggestion 4 — Soft-delete has no retention/purge policy, so `pages`/`blocks` grow unbounded forever [severity: medium]

**Rationale:** The document says purge is "explicitly out of scope for v1 routes" and that the `ON DELETE CASCADE`/`SET NULL` behavior "is never triggered by normal app flows." That means every deleted page and block lives in the table forever, with no scheduled job, no TTL, and no stated plan for when purge gets built. Combined with Suggestion 2 (no erasure path), this compounds a specific risk: a user's soft-deleted content — including content they explicitly deleted — persists indefinitely with no operational owner. This is a sequencing gap, not a v1-must-have: it's fine to defer *building* the purge job, but the document should say when/what triggers building it (e.g., "before general availability" or "when trash storage exceeds X"), rather than leaving it open-ended.

**Proposed change:** Add one sentence to the "Soft delete" bullet under Overview: *"A scheduled purge job (hard-delete of `pages`/`blocks` where `deleted_at < now() - interval '30 days'`) is required before public launch/GA and is tracked as a follow-up milestone, not a v1 route — trash is not a substitute for a retention policy."* This converts an implicit "we'll get to it" into an explicit commitment with a trigger condition, which is the difference between an intentional scope cut and a gap nobody owns.

## Suggestion 5 — The "DDL below is canonical, drizzle-kit is expected to match it" claim has no verification step [severity: medium]

**Rationale:** The document states the hand-written DDL block is "the canonical shape the first generated migration must produce" and that generated SQL is "expected to match it column-for-column" — but nothing in the Migration approach or CI enforces this. `drizzle-kit generate` derives SQL from `schema.ts`, not from this markdown file, so the two can drift silently the moment someone edits `schema.ts` without also updating this document (or vice versa). For a document whose entire value proposition is "here is the source of truth for the schema," an unenforced canonical-shape claim is worse than no claim — it invites someone to trust this file after it's gone stale.

**Proposed change:** Replace the claim in "Migration approach" —
> "The DDL block below is the canonical shape the first generated migration must produce — drizzle-kit's generated SQL is expected to match it column-for-column."

with a verifiable commitment:
> "The DDL block below is generated *from* the first `drizzle-kit generate` output, not hand-written independently — after running `drizzle-kit generate`, this document's DDL section is copy-pasted from `drizzle/migrations/0000_*.sql` (with only comments added). A CI check (`scripts/verify-schema-doc.ts`) diffs this block against the latest committed migration file and fails the build on drift."
This makes the "canonical" claim self-enforcing instead of aspirational.

## Suggestion 6 — Page/block version history is absent, and the document doesn't say whether that's intentional [severity: low]

**Rationale:** Competing products in this category (Notion, Coda, Confluence) all ship page-history/version-restore as a baseline expectation, not a premium feature — users routinely rely on it to recover from bad edits or accidental deletes that trash doesn't cover once already-deleted content is purged (Suggestion 4). Its absence here may well be a correct v1 scope cut (it's a genuinely expensive feature — either row-level snapshots or an event log), but the document doesn't say that; it just doesn't mention it, same failure pattern as Suggestion 1.

**Proposed change:** Add one line to the Overview scope-decision bullets, matching the style already used for the `relation` property type: *"Version history (per-page snapshot/restore beyond the trash) is out of v1 scope; if added later, the natural implementation is an append-only `page_revisions(page_id, snapshot jsonb, created_at)` table populated by a service-layer hook on save, not a DB trigger, to keep snapshot cadence a product decision rather than a schema constraint."* This costs one sentence and converts a silent gap into a documented, deliberate cut — consistent with how well the rest of the document already handles scope boundaries (e.g. the `relation` property type note).

## Overall Verdict

This is an unusually well-engineered schema for a v1 — the fractional-index ordering, partial unique indexes, generated tsvector columns, and cycle-prevention reasoning are all genuinely good work, and scope cuts like deferring `relation` properties and row-level security are well-justified. But a CEO review isn't grading the SQL, it's asking "what breaks the business," and on that axis there are real gaps: no link-based sharing (caps organic growth in a product category that lives on it), no data-erasure path (compliance exposure the moment a real user asks), and no conflict detection on concurrent edits (silent data loss in the exact multi-user scenario the product is named after). None of these require rearchitecting anything — they're additive tables/columns that are far cheaper to design now than to retrofit after the schema is load-bearing in production. The pattern to fix across all six suggestions is the same: this document is excellent at documenting scope cuts it made *on purpose* (relation types, RLS) and silent about scope gaps that look like they weren't considered at all (sharing, erasure, conflicts, retention, history) — closing that gap in the writing, even where the answer is "deferred, here's why," would make this a materially stronger document without changing a line of the DDL.