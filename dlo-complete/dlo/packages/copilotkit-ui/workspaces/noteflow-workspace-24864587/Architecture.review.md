# CEO Review — Architecture.md

> Reviewer: built-in
> Reviewed: 2026-07-25T17:41:01.834Z

## Suggestion 1 — Concurrent editing on the same block/page is undefined [severity: high]

**Rationale:** This is a multi-user workspace with a full sharing/permission model (`page_shares`, roles, `grantShare`), which means the product explicitly expects two or more people to have simultaneous write access to the same page. Nothing in the document says what happens when two users edit the same block at the same time. `BlockService.updateBlockContent` and `splitBlock`/`mergeIntoPrevious` all look like blind overwrites against `blocks.content`. Without a version/lock check, the second writer silently destroys the first writer's edit — for a notes product, silent data loss on the exact feature (block content) that makes the product valuable is the worst possible failure mode, and it will surface in the first real multi-user session, not in a rare edge case.

**Proposed change:** In the `services/blocks` section, change:
> **Interface:** `insertBlock`, `updateBlockContent`, `splitBlock(blockId, offset)`, `mergeIntoPrevious(blockId)`, `indent(blockId)`, `outdent(blockId)`, `moveBlock(blockId, newParentId, afterKey)`, `listBlocks(pageId)`.

to:
> **Interface:** `insertBlock`, `updateBlockContent(blockId, content, expectedVersion)` (throws `ConflictError` on version mismatch — optimistic concurrency via a `version` integer column bumped on every write), `splitBlock`, `mergeIntoPrevious`, `indent`, `outdent`, `moveBlock`, `listBlocks(pageId)`.

Add a one-line note to the `blocks` schema fragment: `version: integer('version').notNull().default(1)`. Explicitly state whether last-write-wins-with-conflict-surfaced (client retries/merges) or last-write-wins-silent is the v1 policy — right now it's neither stated nor implemented, it's just absent.

## Suggestion 2 — Session persistence contradicts the "stateless, horizontally scalable" deployment claim [severity: high]

**Rationale:** The Deployment Shape section says the app is "stateless — safe to run multiple instances behind a load balancer since sessions are cookie-based and all state lives in Postgres." But `AuthService.verifySession(token)` and `logout(sessionId)` imply a server-side session record that must be looked up and revocable — and there is no `SessionRepository` anywhere in the repository list (`UserRepository`, `WorkspaceRepository`, `PageRepository`, `BlockRepository`, `DatabasePropertyRepository`, `ViewRepository`, `PageShareRepository`). If sessions are actually just a signed stateless token (no server lookup), then `logout`/revocation can't work as named. If they are server-side (which the interface implies), the schema and repository for it are missing. This is a real gap between a design decision that's load-bearing for the "multi-instance" claim and what's actually specified.

**Proposed change:** Add to the repository list under `db/schema.ts` + `repositories/*`:
> `SessionRepository` — `findByToken(token)`, `insert(session)`, `revoke(sessionId)`, `revokeAllForUser(userId)`.

And clarify in the `services/auth` section: "`AuthService.verifySession` looks up an opaque token against `sessions` (hashed at rest, TTL + sliding expiry); the cookie carries only the opaque token, never a self-verifying JWT, so `logout`/`revokeAllForUser` (e.g. on password change) actually take effect across all instances." This keeps the stateless-app / stateful-session-store distinction honest.

## Suggestion 3 — No backup/disaster-recovery story for the single copy of all user data [severity: high]

**Rationale:** This is a workspace/notes product — the Postgres database *is* the entire product from the user's perspective (every page, every block, every workspace). The Production section covers TLS, migrations-as-release-step, and structured logging, but says nothing about backups, point-in-time recovery, or what happens on data loss/corruption. For a strategy review this is the single biggest business risk in the document: losing a customer's workspace is an extinction-level event for trust, and it's currently a silent gap rather than a stated decision.

**Proposed change:** In the "Production" subsection, after the Database bullet, add:
> - Backup/recovery: managed Postgres provider's continuous WAL archiving + point-in-time recovery enabled from day one (e.g. daily base backup + WAL retention ≥ 7 days); recovery procedure documented and dry-run tested before first paying customer. Soft-delete (`deletedAt`) covers user-initiated undo; it does not substitute for PITR against operator error, migration bugs, or provider incidents.

## Suggestion 4 — Databases/Views may be over-scoped for a v1 alongside full real-time-grade page/block editing [severity: medium]

**Rationale:** The document treats page-tree + block editor (Notion's core loop) and a full structured-database subsystem (custom property schemas, type migration with empty-column-only rules, multi-view with filter/sort/group-by, board grouping with deleted-property fallback) as equally first-class, both shipping in the same architecture. That's two large, independently complex products (a document editor and a lightweight Airtable) being built simultaneously with no phasing signal. If the objective is to validate the core note-taking/page-tree loop first, `DatabaseService`/`ViewService` are prime candidates to sequence into a v1.1 rather than launch scope — as written there's no indication this tradeoff was considered.

**Proposed change:** Add a short "Scope sequencing" note near the top of the Modules section:
> Modules are grouped by launch priority: `page-tree`, `blocks`, `permissions`, `search` are v1 (the core editing loop must be solid and multiplayer-safe before anything else ships). `databases` and `views` are structurally independent (own repositories, own services, referenced by no other v1 service) and can be feature-flagged out of the initial release without touching the page/block/permission code paths, if timeline pressure requires cutting scope.

This doesn't force a decision, but it makes explicit that the architecture *supports* cutting scope here — which is the CEO-relevant fact currently missing.

## Suggestion 5 — File/image attachment handling is absent [severity: medium]

**Rationale:** The block model covers text, rich-text runs, and (implicitly, via `blockTypeEnum`) other block types, but nothing in Modules, the schema fragment, or Deployment addresses file/image upload, storage, or serving — no object storage dependency, no `attachments` table, no size/type validation. A workspace/notes tool without the ability to paste in an image or attach a file is a materially weaker product than the category leader, and if this was simply never discussed with research/objectives it's worth an explicit in-or-out call now rather than discovering it mid-build.

**Proposed change:** Add a line to the Technology Choices table:
> | File storage | *(decision needed — out of scope for v1, or S3-compatible object storage + `attachments` table keyed to `blockId`)* | Flag for objectives clarification: is image/file attachment a v1 requirement? |

and either remove image blocks from the implied `blockTypeEnum` scope or add the storage dependency — right now it's ambiguous by omission, not by decision.

## Suggestion 6 — No rate limiting or brute-force protection on auth [severity: low]

**Rationale:** `AuthService.login` is a plain method call with no mention of throttling, lockout, or CAPTCHA. Argon2id is the right hashing choice, but without rate limiting on the login endpoint, credential-stuffing/brute-force is trivial against a self-hosted instance with no other perimeter defense mentioned.

**Proposed change:** Add to `services/auth`:
> **Dependencies:** `UserRepository`, a per-IP+per-account sliding-window rate limiter (in-process token bucket keyed in Postgres or a small `login_attempts` table — no Redis dependency needed at this scale) applied in `withAppContext` ahead of the `login` handler; lock the account for N minutes after 5 consecutive failures and log the event at `warn`.

## Overall Verdict

The architecture is unusually rigorous on internal structure — the container/DI discipline, the typed error hierarchy, the fractional-indexing and permission-rules isolation, and especially the testing strategy are all genuinely strong and will pay off in maintainability. But the document reviews as an internals-first architecture that hasn't yet been stress-tested against the product's actual risk surface: it has no answer for concurrent multi-user editing (the core promise of a shared workspace), no backup/DR plan for what is the single most valuable asset the product holds, and a session design that quietly contradicts its own "stateless" deployment claim. None of these are hard to fix, but each is the kind of gap that turns into a production incident or a scope surprise late in the build rather than a five-minute architecture-review comment now. Before this moves to build, get explicit answers on conflict resolution, session storage, and backups (Suggestions 1–3), and get an explicit scope call on databases/views and attachments (Suggestions 4–5) rather than letting them ride as implicit assumptions.