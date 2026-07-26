# Implementation Plan — NoteFlow Workspace

## Build Order

**1. Foundation (m1–m2, serial).** The scaffold module produces an installable, buildable TanStack Start project — `package.json` with every dependency this plan will need (Drizzle, postgres-js, argon2, zod, vitest, testing-library), config files, and the routing entry point. The test-harness module installs and wires vitest + jsdom + testing-library immediately after, with one smoke test, so every module from m4 onward can ship real tests against a working runner and no module is ever tempted to skip tests "until the harness exists."

**2. Data layer and pure logic (m3, m4–m7, m8 — parallel where independent).** `db-schema-and-client` turns the Database.md DDL into Drizzle table definitions, a generated migration, and the single postgres-js pool. In parallel, three pure `lib/` modules (fractional-index, rich-text, permission-rules) and the shared typed-error module need only the test harness, not the database, so they build concurrently with the schema work. `repositories` (m8) is the first module that needs the schema, so it waits on m3, m7 (errors) and m2.

**3. Domain services (m9–m16).** Each service in Architecture.md's `AppContainer` becomes one module. `AuthService` and `WorkspaceService` depend only on repositories and errors, so they run in parallel with `PermissionService` (which additionally needs `lib/permission-rules`). Everything that mutates content — `PageTreeService`, `BlockService`, `DatabaseService`, `ViewService`, `SearchService` — depends on `PermissionService` because every mutating service calls `assertCan` before touching data, per Architecture's dependency-injection rule. `ViewService` additionally depends on `DatabaseService` because a view's `group_by`/`visible_properties` must validate against that database's declared property schema.

**4. Integration (m17).** `container.ts` and `withAppContext` are built last among the backend modules, once every service exists, because the container's whole job is to construct all of them in the fixed bottom-up order Architecture.md mandates and expose the single entry point every route uses. Splitting this from the schema module (m3) avoids two modules ever writing to the same file.

**5. UI (m18–m22).** Auth pages come first since every other route requires a session. The page-tree sidebar (m19) is the shell every other UI module renders inside, so the block editor, database views, and search/sharing UI (m20–m22) fan out in parallel once it exists — they touch disjoint route files and disjoint component trees.

## Modules

### m1 — Project scaffold
**Build:** TanStack Start project skeleton: `package.json` (all runtime deps — `@tanstack/react-start`, `react`, `react-dom`, `drizzle-orm`, `postgres`, `argon2`, `zod`; all scripts — `dev`, `build`, `typecheck`, `test`, `db:generate`, `db:migrate`), `app.config.ts`, `tsconfig.json` (strict), `.env.example`, and the minimal `src/routes/__root.tsx` + `src/routes/index.tsx` entry so the app builds and serves a placeholder page.
**Files:** `package.json`, `app.config.ts`, `tsconfig.json`, `.env.example`, `src/routes/__root.tsx`, `src/routes/index.tsx`, `.gitignore`
**Depends on:** none
**Acceptance:** `npm install` succeeds; `npm run build` succeeds; `npm run typecheck` succeeds; app serves `/` with a placeholder page.

### m2 — Test harness
**Build:** vitest + jsdom + `@testing-library/react` wired for this project: `vitest.config.ts` (jsdom environment, path aliases matching `tsconfig.json`), `vitest.setup.ts` (`@testing-library/jest-dom` matchers, cleanup), and one smoke test proving the runner works. `package.json`'s `test` script must run `vitest run` non-interactively with no `--passWithNoTests` flag.
**Files:** `vitest.config.ts`, `vitest.setup.ts`, `tests/smoke.test.ts`, `package.json` (test deps + script, modifies m1's file)
**Depends on:** m1
**Acceptance:** `npm test` runs `tests/smoke.test.ts` and exits 0; an intentionally empty test directory would fail the run (no pass-with-no-tests flag present in config).

### m3 — Database schema, migration, and connection pool
**Build:** Drizzle schema in `src/server/db/schema.ts` exactly matching the Database.md DDL: `users`, `sessions`, `workspaces`, `workspace_members`, `pages`, `blocks`, `database_properties`, `views`, `page_shares`, plus enums `workspace_role`, `property_type`, `view_kind`, `block_type`, `share_permission`. Include the generated `search_vector` columns (`pages.search_vector` from `title`; `blocks.search_vector` from an app-maintained `plain_text` column), the two partial unique indexes on `pages.position`, and per-parent uniqueness on `blocks.position`. Run `drizzle-kit generate` to produce the migration SQL under `drizzle/migrations/`. Add `src/server/db/client.ts` creating the single `postgres-js` pool (env-driven connection string, no hardcoded credentials).
**Files:** `src/server/db/schema.ts`, `src/server/db/client.ts`, `drizzle.config.ts`, `drizzle/migrations/0000_init.sql`, `tests/server/db/schema.test.ts`
**Depends on:** m1
**Acceptance:** `drizzle-kit generate` produces SQL matching the DDL column-for-column; unit tests in `tests/server/db/schema.test.ts` pass and cover: every table exports the expected column set/types, the enum value sets, and that `client.ts` throws a typed error (not a silent fallback) when `DATABASE_URL` is unset — no real connection is opened in the test.

### m4 — lib/fractional-index
**Build:** Base-62 lexicographic fractional-index key generation per Architecture: `keyBetween(before, after)` producing a key strictly between two optional bounds, `isValidKey(key)`. Must handle `null`/`null` (first key ever), `null`/`x` (insert-before-first), `x`/`null` (insert-after-last), and dense collision cases requiring key regeneration.
**Files:** `src/lib/fractional-index/index.ts`, `tests/lib/fractional-index.test.ts`
**Depends on:** m2
**Acceptance:** unit tests in `tests/lib/fractional-index.test.ts` pass and cover: both-null, before-only, after-only, adjacent-key regeneration, invalid-key rejection, and that generated keys always sort correctly under a string comparator across 100+ sequential inserts.

### m5 — lib/rich-text
**Build:** Typed inline-run model `{ text: string; annotations: {bold,italic,strikethrough,code}; link?: string }[]` plus `applyAnnotation(runs, range, annotation)` (splits/merges runs at range boundaries), `toPlainText(runs)`, and `runsSchema: ZodType<InlineRun[]>` rejecting malformed runs (unknown annotation keys, negative ranges, non-string text).
**Files:** `src/lib/rich-text/index.ts`, `tests/lib/rich-text.test.ts`
**Depends on:** m2
**Acceptance:** unit tests in `tests/lib/rich-text.test.ts` pass and cover: annotating a sub-range that splits an existing run, toggling an annotation off, overlapping annotations, `toPlainText` on empty/multi-run input, and `runsSchema` accept/reject cases including an unknown annotation key.

### m6 — lib/permission-rules
**Build:** Pure authorization decision function per Architecture: `resolveEffectivePermission({ workspaceRole, ancestorShares })` returning the nearest-ancestor-override-else-workspace-role permission, and `canPerform(permission, action)`. No I/O.
**Files:** `src/lib/permission-rules/index.ts`, `tests/lib/permission-rules.test.ts`
**Depends on:** m2
**Acceptance:** unit tests in `tests/lib/permission-rules.test.ts` pass and cover: owner/member/guest workspace roles with no shares, a direct share overriding the role, an ancestor share two levels up overriding a closer non-matching level, conflicting shares at different ancestor depths (nearest wins), and `canPerform` for every `Permission`×`'read'|'write'` combination.

### m7 — Shared typed errors
**Build:** `AppError` base class carrying a machine-readable `code`, and subclasses `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, `UnauthorizedError` — the vocabulary every repository and service throws instead of raw `Error`, per the "typed failures" principle.
**Files:** `src/server/errors.ts`, `tests/server/errors.test.ts`
**Depends on:** m2
**Acceptance:** unit tests in `tests/server/errors.test.ts` pass and cover: each subclass sets its documented `code`, `instanceof AppError` holds for all of them, and each carries a message.

### m8 — Repositories layer
**Build:** One repository per aggregate, SQL/Drizzle-only, no business rules or auth: `UserRepository`, `SessionRepository`, `WorkspaceRepository` (+ `WorkspaceMemberRepository` methods), `PageRepository` (`findById`, `findChildren`, `findSubtreeIds` via recursive CTE, `insert`, `updateFields`, `softDelete`, `restore`, `move`), `BlockRepository` (same shape for blocks, plus `plain_text`/`search_vector` maintenance on write), `DatabasePropertyRepository`, `ViewRepository`, `PageShareRepository`. Each throws `NotFoundError` from m7 on missing-row lookups.
**Files:** `src/server/db/repositories/user.ts`, `src/server/db/repositories/session.ts`, `src/server/db/repositories/workspace.ts`, `src/server/db/repositories/page.ts`, `src/server/db/repositories/block.ts`, `src/server/db/repositories/database-property.ts`, `src/server/db/repositories/view.ts`, `src/server/db/repositories/page-share.ts`, `src/server/db/repositories/index.ts`, `tests/server/db/repositories/user.test.ts`, `tests/server/db/repositories/session.test.ts`, `tests/server/db/repositories/workspace.test.ts`, `tests/server/db/repositories/page.test.ts`, `tests/server/db/repositories/block.test.ts`, `tests/server/db/repositories/database-property.test.ts`, `tests/server/db/repositories/view.test.ts`, `tests/server/db/repositories/page-share.test.ts`
**Depends on:** m3, m7, m2
**Acceptance:** unit tests in the eight `tests/server/db/repositories/*.test.ts` files pass and cover, per repository, the happy path of every exported method plus the `NotFoundError` path — the Drizzle client is mocked with `vi.mock`, no real Postgres connection is opened.

### m9 — AuthService
**Build:** `signUp` (argon2id hash, unique-email check → `ConflictError`), `login` (verify hash, issue opaque session token, store its SHA-256 hash via `SessionRepository`), `verifySession(token)` (hash lookup, expiry check), `logout(sessionId)`.
**Files:** `src/server/services/auth/index.ts`, `tests/server/services/auth.test.ts`
**Depends on:** m8, m7
**Acceptance:** unit tests in `tests/server/services/auth.test.ts` pass and cover: successful signup/login, duplicate-email `ConflictError`, wrong-password rejection, expired-session rejection in `verifySession`, and logout invalidating the session — `UserRepository`/`SessionRepository` are injected fakes, argon2 is exercised for real (deterministic pure function, no I/O).

### m10 — PermissionService
**Build:** I/O side of authorization: `assertCan(userId, pageId, action)` loads the page's ancestor chain (via `PageRepository`) and shares (via `PageShareRepository`) and the caller's workspace role (via `WorkspaceRepository`), delegates the decision to `lib/permission-rules`, throws `ForbiddenError` on denial. `getEffectivePermission(userId, pageId)` returns the resolved `Permission` without throwing.
**Files:** `src/server/services/permissions/index.ts`, `tests/server/services/permissions.test.ts`
**Depends on:** m8, m6, m7
**Acceptance:** unit tests in `tests/server/services/permissions.test.ts` pass and cover: allow/deny for read and write actions, a guest denied without a share, a guest allowed via a direct share, an ancestor-share override, and `getEffectivePermission` returning without throwing — all repositories injected as fakes.

### m11 — WorkspaceService
**Build:** `createWorkspace` (unique slug, creator becomes `owner`), `addMember`, `changeRole`, `listMembers`, `listWorkspacesForUser`.
**Files:** `src/server/services/workspace/index.ts`, `tests/server/services/workspace.test.ts`
**Depends on:** m8, m7
**Acceptance:** unit tests in `tests/server/services/workspace.test.ts` pass and cover: create with duplicate slug → `ConflictError`, add/change/list member happy paths, changing the last owner's role is rejected, and `listWorkspacesForUser` for zero and multiple workspaces.

### m12 — PageTreeService
**Build:** `createPage`, `renamePage`, `movePage(pageId, newParentId, afterKey)` (recursive-CTE ancestor walk rejecting cycles, uses `lib/fractional-index` for the new position), `softDeletePage` (cascades to subtree via repository), `restorePage` (root-fallback if parent is deleted, per business rule), `getTree(workspaceId)`, `listTrash(workspaceId)`. Calls `PermissionService.assertCan` before every mutation.
**Files:** `src/server/services/page-tree/index.ts`, `tests/server/services/page-tree.test.ts`
**Depends on:** m8, m10, m4, m7
**Acceptance:** unit tests in `tests/server/services/page-tree.test.ts` pass and cover: create/rename/move happy paths, move rejecting a cycle (moving a page under its own descendant), soft-delete cascading to a fake subtree, restore with a live parent vs. a deleted parent (root fallback), and every mutation calling `assertCan` with `'write'` before touching the repository — denial short-circuits before any repository call.

### m13 — BlockService
**Build:** `insertBlock`, `updateBlockContent` (validates via `runsSchema`, recomputes `plain_text` via `toPlainText`), `splitBlock(blockId, offset)` (Enter semantics), `mergeIntoPrevious(blockId)` (Backspace-at-0 semantics), `indent`/`outdent` (Tab/Shift+Tab, enforcing the depth-10 cap → `ValidationError` beyond it), `moveBlock`, `listBlocks(pageId)`. Resolves the owning page via `PageRepository` for permission checks.
**Files:** `src/server/services/blocks/index.ts`, `tests/server/services/blocks.test.ts`
**Depends on:** m8, m10, m4, m5, m7
**Acceptance:** unit tests in `tests/server/services/blocks.test.ts` pass and cover: split producing two correctly-ordered blocks, merge concatenating text and removing the merged block, indent re-parenting under the previous sibling, outdent re-parenting under the grandparent, indent rejected at depth 10 with `ValidationError`, and every mutation calling `assertCan('write')` first.
**maxAttempts:** 4

### m14 — DatabaseService
**Build:** Database-property schema CRUD on a database page (`addProperty`, `renameProperty`, `changePropertyType` — allowed only when the column is empty across all rows, else `ValidationError`, per the research's business rule), and row-property validation (`setRowProperties`) enforcing each value against its property's declared type, with `select`/`multi_select` values restricted to the property's declared `options`.
**Files:** `src/server/services/databases/index.ts`, `tests/server/services/databases.test.ts`
**Depends on:** m8, m10, m7
**Acceptance:** unit tests in `tests/server/services/databases.test.ts` pass and cover: add/rename property happy paths, `changePropertyType` allowed on an empty column and rejected with `ValidationError` on a non-empty one, `setRowProperties` accepting a conforming value per type (all seven: text/number/select/multi_select/date/checkbox/url), rejecting a mismatched type, and rejecting a `select` value outside declared `options`.

### m15 — ViewService
**Build:** `createView(kind: 'table'|'board'|'list')`, `updateFilters`, `updateSorts`, `setGroupBy` (validates the property exists on the database via `DatabaseService`; falls back to ungrouped if the referenced property is later deleted, per the edge case), `reorderViews`, `listViews(databasePageId)`.
**Files:** `src/server/services/views/index.ts`, `tests/server/services/views.test.ts`
**Depends on:** m8, m10, m14, m7
**Acceptance:** unit tests in `tests/server/services/views.test.ts` pass and cover: create each of the three view kinds, `setGroupBy` with a valid property, `setGroupBy` rejecting a property from a different database, a board view whose `group_by` property no longer exists resolving to ungrouped rather than throwing, and filter/sort update happy paths.

### m16 — SearchService
**Build:** `searchWorkspace(workspaceId, query)` running a `websearch_to_tsquery` match against `pages.search_vector` (titles) and `blocks.search_vector` (body text, joined back to the owning page), merged and ranked, filtered to pages the caller can read via `PermissionService`.
**Files:** `src/server/services/search/index.ts`, `tests/server/services/search.test.ts`
**Depends on:** m8, m10, m7
**Acceptance:** unit tests in `tests/server/services/search.test.ts` pass and cover: a title match, a body-text match, results merged/ranked when both match, an empty-query and no-results case, and a matching page the caller cannot read being excluded from results.

### m17 — Container and request context
**Build:** `src/server/container.ts` per Architecture: `buildContainer()` constructing `db/client.ts`'s pool, then every repository, then `PermissionService`, then the remaining services in dependency order, returning the frozen `AppContainer`; `getContainer()` lazy singleton; `withAppContext(fn)` resolving the session from the request cookie via `AuthService.verifySession`, attaching `{ user, workspaceId }` on an `AsyncLocalStorage` context, catching thrown `AppError`s and translating each subclass to its HTTP status, and logging one structured entry per call.
**Files:** `src/server/container.ts`, `src/server/context.ts`, `tests/server/container.test.ts`
**Depends on:** m9, m10, m11, m12, m13, m14, m15, m16
**Acceptance:** unit tests in `tests/server/container.test.ts` pass and cover: `getContainer()` returning the same instance on repeated calls, `withAppContext` rejecting a missing/invalid session cookie, each `AppError` subclass translating to its documented status code, a successful call attaching `{user, workspaceId}` visible to the wrapped handler, and one structured log entry emitted per call — all real service construction, no network/DB I/O in the test.

### m18 — Auth routes and UI
**Build:** Signup/login/logout pages (`src/routes/signup.tsx`, `src/routes/login.tsx`) and server functions wrapping `AuthService` via `withAppContext`, setting/clearing the `httpOnly`, `sameSite=lax` session cookie; a workspace-picker landing route for a multi-workspace user.
**Files:** `src/routes/signup.tsx`, `src/routes/login.tsx`, `src/routes/workspaces.tsx`, `src/routes/logout.ts`, `tests/routes/signup.test.tsx`, `tests/routes/login.test.tsx`, `tests/routes/workspaces.test.tsx`
**Depends on:** m17
**Acceptance:** unit tests in the three `tests/routes/*.test.tsx` files pass and cover: successful signup redirecting to the workspace picker, login with wrong credentials showing an inline error, logout clearing the session cookie, and the workspace picker listing zero vs. multiple workspaces — `@testing-library/react` render + interaction, server functions mocked at the module boundary.

### m19 — Page tree sidebar and page CRUD routes
**Build:** `src/routes/workspace/$slug/index.tsx` rendering the sidebar tree (`PageTreeService.getTree`) with create/rename/nest/drag-to-reorder (calling `movePage` with `lib/fractional-index`-computed keys), soft-delete to a trash view, and restore.
**Files:** `src/routes/workspace/$slug/index.tsx`, `src/components/PageTree.tsx`, `src/components/TrashPanel.tsx`, `tests/components/PageTree.test.tsx`, `tests/components/TrashPanel.test.tsx`
**Depends on:** m17, m18
**Acceptance:** unit tests in `tests/components/PageTree.test.tsx` and `tests/components/TrashPanel.test.tsx` pass and cover: rendering a nested tree, create/rename interactions firing the expected server-function calls, a drag-reorder interaction computing and submitting a fractional-index key, soft-delete moving an item into the trash panel, and restore returning it to the tree — server functions mocked, DOM interactions via `@testing-library/react`.

### m20 — Block editor UI
**Build:** `src/routes/workspace/$slug/page/$pageId.tsx` rendering ordered blocks with per-type components (paragraph, heading 1-3, bulleted/numbered list, to-do, quote, code, divider), Enter/Backspace/Tab/Shift-Tab handlers calling `BlockService`'s split/merge/indent/outdent, a slash-command menu (`/`) inserting a block type at the cursor, and an inline rich-text toolbar (bold/italic/strikethrough/code/link) calling `lib/rich-text.applyAnnotation`.
**Files:** `src/routes/workspace/$slug/page/$pageId.tsx`, `src/components/BlockEditor.tsx`, `src/components/SlashMenu.tsx`, `src/components/RichTextToolbar.tsx`, `tests/components/BlockEditor.test.tsx`, `tests/components/SlashMenu.test.tsx`, `tests/components/RichTextToolbar.test.tsx`
**Depends on:** m19
**Acceptance:** unit tests in the three `tests/components/*.test.tsx` files pass and cover: Enter splitting the focused block into two, Backspace at offset 0 merging into the previous block, Tab/Shift-Tab re-parenting, typing `/` opening the slash menu and each menu item inserting its block type, and toggling bold/italic/link from the toolbar over a selected range — server-function calls mocked, DOM/keyboard events via `@testing-library/react`.
**maxAttempts:** 4

### m21 — Database views UI
**Build:** Table view (rows/columns, inline cell editing per property type) and board view (grouped by a select property, drag between groups updating that row's property) for a database page, plus a property editor (add/rename/change-type) and saved filter/sort controls per view.
**Files:** `src/routes/workspace/$slug/database/$pageId.tsx`, `src/components/DatabaseTableView.tsx`, `src/components/DatabaseBoardView.tsx`, `src/components/PropertyEditor.tsx`, `src/components/ViewFilterSortBar.tsx`, `tests/components/DatabaseTableView.test.tsx`, `tests/components/DatabaseBoardView.test.tsx`, `tests/components/PropertyEditor.test.tsx`, `tests/components/ViewFilterSortBar.test.tsx`
**Depends on:** m19
**Acceptance:** unit tests in the four `tests/components/*.test.tsx` files pass and cover: table view rendering typed cells and committing an edit per property type, board view grouping rows by select value and a drag-between-groups interaction submitting the row's new property value, adding a property and rejecting a type change on a non-empty column with a visible error, and applying a filter/sort updating the visible row set — server functions mocked.

### m22 — Search and page-sharing UI
**Build:** A workspace-wide search box (calls `SearchService.searchWorkspace`, debounced, ranked results linking to pages) and a per-page share dialog (add/remove a user's `read`/`write` share, calling `PageShareRepository` via a server function that enforces `PermissionService`).
**Files:** `src/components/SearchBox.tsx`, `src/components/ShareDialog.tsx`, `src/routes/workspace/$slug/page/$pageId.share.ts`, `tests/components/SearchBox.test.tsx`, `tests/components/ShareDialog.test.tsx`
**Depends on:** m19
**Acceptance:** unit tests in `tests/components/SearchBox.test.tsx` and `tests/components/ShareDialog.test.tsx` pass and cover: typing a query rendering ranked results, an empty-results state, adding a share and it appearing in the list, removing a share, and a non-owner attempting to open the share dialog being denied — server functions mocked.

## Machine-Readable Plan

```json implementation-plan
{
  "planVersion": 1,
  "generatedBy": "DLO Design Analyst",
  "modules": [
    {
      "moduleId": "m1",
      "title": "Project scaffold",
      "stackTarget": "fullstack",
      "prompt": "Scaffold a TanStack Start project: package.json with all runtime deps (@tanstack/react-start, react, react-dom, drizzle-orm, postgres, argon2, zod) and scripts (dev, build, typecheck, test, db:generate, db:migrate), app.config.ts, strict tsconfig.json, .env.example, and src/routes/__root.tsx + src/routes/index.tsx serving a placeholder page. Must install and build cleanly.",
      "dependsOn": [],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["package.json", "app.config.ts", "tsconfig.json", ".env.example", "src/routes/__root.tsx", "src/routes/index.tsx", ".gitignore"],
      "acceptance": ["npm install succeeds", "npm run build succeeds", "npm run typecheck succeeds", "GET / renders the placeholder page"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "app builds", "kind": "command", "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m2",
      "title": "Test harness",
      "stackTarget": "fullstack",
      "prompt": "Install and configure vitest + jsdom + @testing-library/react. Create vitest.config.ts (jsdom environment, aliases matching tsconfig.json paths), vitest.setup.ts (jest-dom matchers, cleanup after each test), and tests/smoke.test.ts with one passing assertion. Set package.json's test script to `vitest run` with no --passWithNoTests flag, so an empty suite fails.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["vitest.config.ts", "vitest.setup.ts", "tests/smoke.test.ts", "package.json"],
      "acceptance": ["npm test runs tests/smoke.test.ts and exits 0", "package.json test script contains no --passWithNoTests flag"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "smoke test passes", "kind": "command", "argv": ["npx", "vitest", "run", "tests/smoke.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m3",
      "title": "Database schema, migration, and connection pool",
      "stackTarget": "backend",
      "prompt": "Write src/server/db/schema.ts as Drizzle table definitions matching Database.md's DDL exactly: users, sessions, workspaces, workspace_members, pages, blocks, database_properties, views, page_shares, with enums workspace_role, property_type, view_kind, block_type, share_permission. Include pages.search_vector (generated from title) and blocks.search_vector (generated from an app-maintained plain_text column). Run drizzle-kit generate to produce drizzle/migrations/0000_init.sql. Add src/server/db/client.ts creating the single postgres-js pool from env vars, throwing a typed error if DATABASE_URL is unset. Write tests/server/db/schema.test.ts asserting table/column/enum shapes and client.ts's unset-env error path (no real connection).",
      "dependsOn": ["m1"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/db/schema.ts", "src/server/db/client.ts", "drizzle.config.ts", "drizzle/migrations/0000_init.sql", "tests/server/db/schema.test.ts"],
      "acceptance": ["drizzle-kit generate output matches the DDL column-for-column", "unit tests in tests/server/db/schema.test.ts pass and cover every table's columns/types, enum value sets, and client.ts's unset-DATABASE_URL typed-error path"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/db/schema.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m4",
      "title": "lib/fractional-index",
      "stackTarget": "backend",
      "prompt": "Implement src/lib/fractional-index/index.ts: base-62 lexicographic ordering keys. Export keyBetween(before: string|null, after: string|null): string and isValidKey(key: string): boolean. Must handle both-null (first key), before-only, after-only, and dense adjacent-key collisions by regenerating a longer key. Write tests/lib/fractional-index.test.ts covering all four cases plus that 100+ sequential inserts always sort correctly under string comparison.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/lib/fractional-index/index.ts", "tests/lib/fractional-index.test.ts"],
      "acceptance": ["unit tests in tests/lib/fractional-index.test.ts pass and cover both-null/before-only/after-only/collision-regeneration and 100+-insert sort ordering"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/lib/fractional-index.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m5",
      "title": "lib/rich-text",
      "stackTarget": "backend",
      "prompt": "Implement src/lib/rich-text/index.ts: InlineRun type { text, annotations: {bold,italic,strikethrough,code}, link? }. Export applyAnnotation(runs, range, annotation) splitting/merging runs at range boundaries and toggling the annotation, toPlainText(runs): string, and runsSchema: ZodType<InlineRun[]> rejecting malformed runs. Write tests/lib/rich-text.test.ts covering split-on-partial-range, annotation toggle-off, overlapping annotations, toPlainText on empty/multi-run input, and runsSchema accept/reject including an unknown annotation key.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/lib/rich-text/index.ts", "tests/lib/rich-text.test.ts"],
      "acceptance": ["unit tests in tests/lib/rich-text.test.ts pass and cover range-splitting, annotation toggling, toPlainText edge cases, and runsSchema accept/reject paths"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/lib/rich-text.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m6",
      "title": "lib/permission-rules",
      "stackTarget": "backend",
      "prompt": "Implement src/lib/permission-rules/index.ts, pure and I/O-free. Export resolveEffectivePermission({ workspaceRole, ancestorShares }): Permission returning the nearest-ancestor-share override else the workspace role, and canPerform(permission, action: 'read'|'write'): boolean. Write tests/lib/permission-rules.test.ts covering owner/member/guest with no shares, a direct share override, an ancestor share two levels up winning over a farther non-matching level, and canPerform for every permission x action combination.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/lib/permission-rules/index.ts", "tests/lib/permission-rules.test.ts"],
      "acceptance": ["unit tests in tests/lib/permission-rules.test.ts pass and cover role-only resolution, direct-share override, nearest-ancestor-wins, and full canPerform matrix"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/lib/permission-rules.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m7",
      "title": "Shared typed errors",
      "stackTarget": "backend",
      "prompt": "Implement src/server/errors.ts: an AppError base class carrying a machine-readable `code` string and message, and subclasses NotFoundError, ForbiddenError, ValidationError, ConflictError, UnauthorizedError, each with its own fixed code. Write tests/server/errors.test.ts asserting each subclass's code, that instanceof AppError holds, and message propagation.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["src/server/errors.ts", "tests/server/errors.test.ts"],
      "acceptance": ["unit tests in tests/server/errors.test.ts pass and cover every subclass's code, instanceof AppError, and message propagation"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/errors.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m8",
      "title": "Repositories layer",
      "stackTarget": "backend",
      "prompt": "Implement one repository per aggregate under src/server/db/repositories/: user.ts, session.ts, workspace.ts (incl. workspace_members), page.ts (findById, findChildren, findSubtreeIds via recursive CTE, insert, updateFields, softDelete, restore, move), block.ts (same shape, maintains plain_text/search_vector), database-property.ts, view.ts, page-share.ts, plus index.ts. No business rules or auth here — persistence only; throw NotFoundError from src/server/errors.ts on missing rows. Write one test file per repository under tests/server/db/repositories/, mocking the Drizzle client with vi.mock (no real Postgres connection).",
      "dependsOn": ["m3", "m7", "m2"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": ["src/server/db/repositories/user.ts", "src/server/db/repositories/session.ts", "src/server/db/repositories/workspace.ts", "src/server/db/repositories/page.ts", "src/server/db/repositories/block.ts", "src/server/db/repositories/database-property.ts", "src/server/db/repositories/view.ts", "src/server/db/repositories/page-share.ts", "src/server/db/repositories/index.ts", "tests/server/db/repositories/user.test.ts", "tests/server/db/repositories/session.test.ts", "tests/server/db/repositories/workspace.test.ts", "tests/server/db/repositories/page.test.ts", "tests/server/db/repositories/block.test.ts", "tests/server/db/repositories/database-property.test.ts", "tests/server/db/repositories/view.test.ts", "tests/server/db/repositories/page-share.test.ts"],
      "acceptance": ["unit tests in the eight tests/server/db/repositories/*.test.ts files pass and cover, per repository, every exported method's happy path plus its NotFoundError path, with the Drizzle client mocked"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/db/repositories/user.test.ts", "tests/server/db/repositories/session.test.ts", "tests/server/db/repositories/workspace.test.ts", "tests/server/db/repositories/page.test.ts", "tests/server/db/repositories/block.test.ts", "tests/server/db/repositories/database-property.test.ts", "tests/server/db/repositories/view.test.ts", "tests/server/db/repositories/page-share.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m9",
      "title": "AuthService",
      "stackTarget": "backend",
      "prompt": "Implement src/server/services/auth/index.ts using UserRepository and SessionRepository (injected): signUp (argon2id hash, ConflictError on duplicate email), login (verify hash, issue an opaque session token, store its SHA-256 hash), verifySession(token) (hash lookup + expiry check), logout(sessionId). Write tests/server/services/auth.test.ts with injected fake repositories covering signup, duplicate-email conflict, wrong-password rejection, expired-session rejection, and logout.",
      "dependsOn": ["m8", "m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/services/auth/index.ts", "tests/server/services/auth.test.ts"],
      "acceptance": ["unit tests in tests/server/services/auth.test.ts pass and cover signup, login, duplicate-email ConflictError, wrong-password rejection, expired-session rejection, and logout"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/services/auth.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m10",
      "title": "PermissionService",
      "stackTarget": "backend",
      "prompt": "Implement src/server/services/permissions/index.ts using PageRepository, PageShareRepository, WorkspaceRepository (injected) and lib/permission-rules. assertCan(userId, pageId, action) loads the ancestor chain, shares, and workspace role, delegates the decision, throws ForbiddenError on denial. getEffectivePermission(userId, pageId) returns the resolved Permission. Write tests/server/services/permissions.test.ts with fake repositories covering allow/deny for read and write, guest denied without a share, guest allowed via direct share, ancestor-share override, and getEffectivePermission's non-throwing path.",
      "dependsOn": ["m8", "m6", "m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/services/permissions/index.ts", "tests/server/services/permissions.test.ts"],
      "acceptance": ["unit tests in tests/server/services/permissions.test.ts pass and cover allow/deny per action, guest-without-share denial, guest-with-share allowance, ancestor-override, and getEffectivePermission"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/services/permissions.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m11",
      "title": "WorkspaceService",
      "stackTarget": "backend",
      "prompt": "Implement src/server/services/workspace/index.ts using WorkspaceRepository (injected): createWorkspace (unique slug check, ConflictError on duplicate, creator becomes owner), addMember, changeRole (reject changing the last owner's role), listMembers, listWorkspacesForUser. Write tests/server/services/workspace.test.ts with a fake repository covering create/duplicate-slug, add/change/list member, last-owner-role-change rejection, and listWorkspacesForUser for zero and multiple workspaces.",
      "dependsOn": ["m8", "m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/services/workspace/index.ts", "tests/server/services/workspace.test.ts"],
      "acceptance": ["unit tests in tests/server/services/workspace.test.ts pass and cover create/duplicate-slug, member management, last-owner-role-change rejection, and listWorkspacesForUser boundaries"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/services/workspace.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m12",
      "title": "PageTreeService",
      "stackTarget": "backend",
      "prompt": "Implement src/server/services/page-tree/index.ts using PageRepository, PermissionService, and lib/fractional-index (injected): createPage, renamePage, movePage(pageId, newParentId, afterKey) rejecting cycles via ancestor walk, softDeletePage (cascades via repository), restorePage (root-fallback if parent deleted), getTree(workspaceId), listTrash(workspaceId). Call assertCan('write') before every mutation. Write tests/server/services/page-tree.test.ts with fakes covering create/rename/move, cycle rejection, cascade soft-delete, root-fallback restore, and that assertCan denial short-circuits before any repository write.",
      "dependsOn": ["m8", "m10", "m4", "m7"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": ["src/server/services/page-tree/index.ts", "tests/server/services/page-tree.test.ts"],
      "acceptance": ["unit tests in tests/server/services/page-tree.test.ts pass and cover create/rename/move, cycle rejection, cascading soft-delete, root-fallback restore, and permission-denial short-circuiting"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/services/page-tree.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m13",
      "title": "BlockService",
      "stackTarget": "backend",
      "prompt": "Implement src/server/services/blocks/index.ts using BlockRepository, PageRepository, PermissionService, lib/fractional-index, lib/rich-text (injected): insertBlock, updateBlockContent (validate via runsSchema, recompute plain_text), splitBlock(blockId, offset), mergeIntoPrevious(blockId), indent/outdent (depth cap 10, ValidationError beyond it), moveBlock, listBlocks(pageId). Call assertCan('write') before every mutation. Write tests/server/services/blocks.test.ts with fakes covering split, merge, indent, outdent, depth-cap rejection, and permission checks.",
      "dependsOn": ["m8", "m10", "m4", "m5", "m7"],
      "estimatedComplexity": "hard",
      "maxAttempts": 4,
      "touches": ["src/server/services/blocks/index.ts", "tests/server/services/blocks.test.ts"],
      "acceptance": ["unit tests in tests/server/services/blocks.test.ts pass and cover split, merge, indent, outdent, depth-10 rejection, and assertCan('write') being called before every mutation"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/services/blocks.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m14",
      "title": "DatabaseService",
      "stackTarget": "backend",
      "prompt": "Implement src/server/services/databases/index.ts using DatabasePropertyRepository, PageRepository, PermissionService (injected): addProperty, renameProperty, changePropertyType (allowed only when the column is empty across all rows, else ValidationError), setRowProperties (validate each value against its property's type for text/number/select/multi_select/date/checkbox/url, restrict select/multi_select to declared options). Write tests/server/services/databases.test.ts covering add/rename, changePropertyType allowed-empty vs rejected-non-empty, per-type value validation for all seven types, and select-option rejection.",
      "dependsOn": ["m8", "m10", "m7"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": ["src/server/services/databases/index.ts", "tests/server/services/databases.test.ts"],
      "acceptance": ["unit tests in tests/server/services/databases.test.ts pass and cover property CRUD, changePropertyType empty-vs-non-empty column, all seven property-type validations, and select-option rejection"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/services/databases.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m15",
      "title": "ViewService",
      "stackTarget": "backend",
      "prompt": "Implement src/server/services/views/index.ts using ViewRepository, DatabaseService, PermissionService (injected): createView(kind: 'table'|'board'|'list'), updateFilters, updateSorts, setGroupBy (validates the property belongs to the database, falls back to ungrouped if later deleted), reorderViews, listViews(databasePageId). Write tests/server/services/views.test.ts covering creation of each kind, setGroupBy valid/cross-database-rejected, group-by-property-deleted falling back to ungrouped, and filter/sort updates.",
      "dependsOn": ["m8", "m10", "m14", "m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/services/views/index.ts", "tests/server/services/views.test.ts"],
      "acceptance": ["unit tests in tests/server/services/views.test.ts pass and cover each view kind's creation, setGroupBy valid/invalid, ungrouped fallback on deleted group-by property, and filter/sort updates"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/services/views.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m16",
      "title": "SearchService",
      "stackTarget": "backend",
      "prompt": "Implement src/server/services/search/index.ts using PageRepository, BlockRepository, PermissionService (injected): searchWorkspace(workspaceId, query) matching pages.search_vector (titles) and blocks.search_vector (body, joined to owning page) via websearch_to_tsquery, merged/ranked, filtered to pages the caller can read. Write tests/server/services/search.test.ts covering a title-only match, a body-only match, a merged/ranked dual match, empty-query/no-results, and a matching-but-unreadable page being excluded.",
      "dependsOn": ["m8", "m10", "m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/services/search/index.ts", "tests/server/services/search.test.ts"],
      "acceptance": ["unit tests in tests/server/services/search.test.ts pass and cover title match, body match, merged ranking, empty/no-results, and permission-filtered exclusion"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/services/search.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m17",
      "title": "Container and request context",
      "stackTarget": "backend",
      "prompt": "Implement src/server/container.ts per Architecture.md: buildContainer() constructs the db pool then every repository then PermissionService then the remaining services in dependency order, returning the frozen AppContainer; getContainer() lazy singleton. Implement src/server/context.ts's AsyncLocalStorage-backed RequestContext and withAppContext(fn) resolving the session cookie via AuthService.verifySession, attaching {user, workspaceId}, catching AppError subclasses and translating each to its HTTP status, logging one structured entry per call. Write tests/server/container.test.ts covering singleton identity, missing/invalid-cookie rejection, each AppError-to-status translation, successful context attachment, and one log entry per call.",
      "dependsOn": ["m9", "m10", "m11", "m12", "m13", "m14", "m15", "m16"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": ["src/server/container.ts", "src/server/context.ts", "tests/server/container.test.ts"],
      "acceptance": ["unit tests in tests/server/container.test.ts pass and cover getContainer() singleton identity, invalid-session rejection, AppError-to-status-code translation for every subclass, successful context attachment, and per-call structured logging"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/server/container.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m18",
      "title": "Auth routes and UI",
      "stackTarget": "fullstack",
      "prompt": "Build src/routes/signup.tsx, src/routes/login.tsx, src/routes/workspaces.tsx, and src/routes/logout.ts: forms and server functions wrapping AuthService via withAppContext, setting/clearing an httpOnly, sameSite=lax session cookie; workspaces.tsx lists the user's workspaces via WorkspaceService. Write tests/routes/signup.test.tsx, login.test.tsx, workspaces.test.tsx using @testing-library/react with server functions mocked, covering signup success/redirect, login failure inline error, logout clearing the cookie, and zero/multiple workspaces listing.",
      "dependsOn": ["m17"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/routes/signup.tsx", "src/routes/login.tsx", "src/routes/workspaces.tsx", "src/routes/logout.ts", "tests/routes/signup.test.tsx", "tests/routes/login.test.tsx", "tests/routes/workspaces.test.tsx"],
      "acceptance": ["unit tests in the three tests/routes/*.test.tsx files pass and cover signup success/redirect, login failure error message, logout cookie-clearing, and workspace-list boundaries"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/routes/signup.test.tsx", "tests/routes/login.test.tsx", "tests/routes/workspaces.test.tsx"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m19",
      "title": "Page tree sidebar and page CRUD routes",
      "stackTarget": "fullstack",
      "prompt": "Build src/routes/workspace/$slug/index.tsx, src/components/PageTree.tsx, src/components/TrashPanel.tsx: sidebar tree from PageTreeService.getTree with create/rename/nest/drag-to-reorder (calling movePage with fractional-index keys), soft-delete into a trash view, and restore. Write tests/components/PageTree.test.tsx and TrashPanel.test.tsx with server functions mocked, covering nested-tree render, create/rename interactions, drag-reorder key computation and submission, soft-delete moving items into trash, and restore.",
      "dependsOn": ["m17", "m18"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": ["src/routes/workspace/$slug/index.tsx", "src/components/PageTree.tsx", "src/components/TrashPanel.tsx", "tests/components/PageTree.test.tsx", "tests/components/TrashPanel.test.tsx"],
      "acceptance": ["unit tests in tests/components/PageTree.test.tsx and TrashPanel.test.tsx pass and cover nested-tree rendering, create/rename interactions, drag-reorder submission, soft-delete, and restore"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/components/PageTree.test.tsx", "tests/components/TrashPanel.test.tsx"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m20",
      "title": "Block editor UI",
      "stackTarget": "fullstack",
      "prompt": "Build src/routes/workspace/$slug/page/$pageId.tsx, src/components/BlockEditor.tsx, SlashMenu.tsx, RichTextToolbar.tsx: render ordered blocks per type (paragraph, heading 1-3, bulleted/numbered list, to-do, quote, code, divider); Enter/Backspace/Tab/Shift-Tab call BlockService split/merge/indent/outdent; typing '/' opens a menu inserting a block type; a selection toolbar calls applyAnnotation for bold/italic/strikethrough/code/link. Write tests/components/BlockEditor.test.tsx, SlashMenu.test.tsx, RichTextToolbar.test.tsx with server functions mocked, covering split, merge, indent/outdent, each slash-menu insertion, and each toolbar toggle.",
      "dependsOn": ["m19"],
      "estimatedComplexity": "hard",
      "maxAttempts": 4,
      "touches": ["src/routes/workspace/$slug/page/$pageId.tsx", "src/components/BlockEditor.tsx", "src/components/SlashMenu.tsx", "src/components/RichTextToolbar.tsx", "tests/components/BlockEditor.test.tsx", "tests/components/SlashMenu.test.tsx", "tests/components/RichTextToolbar.test.tsx"],
      "acceptance": ["unit tests in the three tests/components/*.test.tsx files pass and cover Enter-split, Backspace-merge, Tab/Shift-Tab indent/outdent, each slash-menu block-type insertion, and each rich-text toolbar toggle"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/components/BlockEditor.test.tsx", "tests/components/SlashMenu.test.tsx", "tests/components/RichTextToolbar.test.tsx"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m21",
      "title": "Database views UI",
      "stackTarget": "fullstack",
      "prompt": "Build src/routes/workspace/$slug/database/$pageId.tsx, src/components/DatabaseTableView.tsx, DatabaseBoardView.tsx, PropertyEditor.tsx, ViewFilterSortBar.tsx: table view with inline cell editing per property type, board view grouped by a select property with drag-between-groups updating that property, a property editor (add/rename/change-type), and saved filter/sort controls. Write tests/components/DatabaseTableView.test.tsx, DatabaseBoardView.test.tsx, PropertyEditor.test.tsx, ViewFilterSortBar.test.tsx with server functions mocked, covering typed-cell editing, drag-between-groups, property add/rename and change-type-on-non-empty error, and filter/sort application.",
      "dependsOn": ["m19"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": ["src/routes/workspace/$slug/database/$pageId.tsx", "src/components/DatabaseTableView.tsx", "src/components/DatabaseBoardView.tsx", "src/components/PropertyEditor.tsx", "src/components/ViewFilterSortBar.tsx", "tests/components/DatabaseTableView.test.tsx", "tests/components/DatabaseBoardView.test.tsx", "tests/components/PropertyEditor.test.tsx", "tests/components/ViewFilterSortBar.test.tsx"],
      "acceptance": ["unit tests in the four tests/components/*.test.tsx files pass and cover typed cell edits, board drag-between-groups, property add/rename/change-type-error, and filter/sort application"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/components/DatabaseTableView.test.tsx", "tests/components/DatabaseBoardView.test.tsx", "tests/components/PropertyEditor.test.tsx", "tests/components/ViewFilterSortBar.test.tsx"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m22",
      "title": "Search and page-sharing UI",
      "stackTarget": "fullstack",
      "prompt": "Build src/components/SearchBox.tsx, ShareDialog.tsx, and src/routes/workspace/$slug/page/$pageId.share.ts: a debounced workspace-wide search box calling SearchService with ranked results linking to pages, and a per-page share dialog to add/remove a user's read/write share via a server function enforcing PermissionService. Write tests/components/SearchBox.test.tsx and ShareDialog.test.tsx with server functions mocked, covering ranked results render, empty-results state, add/remove share, and a non-owner denied opening the dialog.",
      "dependsOn": ["m19"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/components/SearchBox.tsx", "src/components/ShareDialog.tsx", "src/routes/workspace/$slug/page/$pageId.share.ts", "tests/components/SearchBox.test.tsx", "tests/components/ShareDialog.test.tsx"],
      "acceptance": ["unit tests in tests/components/SearchBox.test.tsx and ShareDialog.test.tsx pass and cover ranked-results rendering, empty-results state, share add/remove, and non-owner denial"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "this module's unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/components/SearchBox.test.tsx", "tests/components/ShareDialog.test.tsx"], "expect": {"exitCode": 0}}
      ]
    }
  ]
}
```