# Architecture — NoteFlow Workspace

## Technology Choices

| Concern | Choice | Justification |
|---|---|---|
| Application framework | **TanStack Start** (React 18, Vite, file-based routing, typed server functions) | Objectives and research both mandate it. One TypeScript project serves UI and RPC; `createServerFn` gives end-to-end type safety from a route handler to the browser without hand-rolling a REST/OpenAPI layer. Streaming SSR suits a page tree + editor shell that must feel instant. |
| Database | **PostgreSQL 17** | Mandated. `tsvector`/GIN indexes give native full-text search (req. 6) without a search service; JSONB gives us block `content` and property payloads without schema churn; recursive CTEs give us page-tree and subtree soft-delete cheaply. |
| ORM / migrations | **Drizzle ORM** + `drizzle-kit` | Mandated. SQL-shaped typed query builder (not a heavy active-record layer), first-class Postgres generated columns (needed for the search vector), and a migration folder that's easy to review in PRs. |
| Validation | **Zod** | Single schema source shared between server-function input validation and (where useful) client-side form validation. Block `content`, rich-text runs, and database `properties` are all validated against per-type Zod schemas before they touch a repository. |
| Auth | Cookie sessions (`iron-session`-style signed/opaque token) + **argon2id** password hashing | Matches the research's security posture; no third-party auth service needed for a self-hosted app, avoids introducing an unmandated dependency. |
| Fractional ordering | Custom `lib/fractional-index` (base-62 lexicographic keys) | Research explicitly requires single-row-write reordering; no existing dependency is pulled in for something this small and this central to correctness. |
| Rich text | Custom inline-run model (`{ text, annotations, link }[]`) stored as JSONB | Research explicitly rejects HTML storage; a small typed renderer/serializer is cheaper to keep correct and testable than adopting a general rich-text framework whose extension model fights the block model. |
| Package manager / test runner | pnpm workspace conventions, **vitest** | Matches the surrounding monorepo tooling; vitest shares Vite's config/transform pipeline with TanStack Start, so no second bundler config is needed for tests. |

The research document is authoritative and does not mandate a different stack, so the framework default (TanStack Start + PostgreSQL) stands unmodified.

## Central Orchestrator

There is no long-running pipeline process in this application — it is a request-driven web app — so the "central orchestrator" role is filled by a **single dependency-injection container** that every server function goes through. It is the one module allowed to construct services, and the one place that wires cross-cutting concerns (auth, logging, error translation) around every mutation and query.

**File:** `src/server/container.ts`

**Responsibilities**
- Own the single Postgres connection pool (via `postgres-js` + Drizzle) for the process lifetime.
- Construct every repository exactly once, then construct every service with its repositories injected — services never construct their own repositories.
- Expose services only through narrow, declared interfaces (see Modules below); nothing outside `container.ts` may `new` a service or repository.
- Provide `withAppContext(handler)` — the single wrapper every TanStack Start server function is defined through. It: resolves the session from the request cookie, attaches `{ user, workspaceId }` to an `AsyncLocalStorage`-backed request context, catches thrown `AppError`s and translates them to typed HTTP responses, and logs one structured entry per call (route, user id, duration, outcome).
- Own the module registration manifest: a fixed, explicit construction order (repositories → domain services → composite services) so dependency direction is enforced by the file itself, not by convention.

**Public interface**

```ts
// src/server/container.ts
export interface AppContainer {
  auth: AuthService;
  permissions: PermissionService;
  workspaces: WorkspaceService;
  pageTree: PageTreeService;
  blocks: BlockService;
  databases: DatabaseService;
  views: ViewService;
  search: SearchService;
}

export function getContainer(): AppContainer;      // lazy singleton, built once per process
export function withAppContext<T>(
  fn: (ctx: RequestContext, container: AppContainer) => Promise<T>
): (input: unknown) => Promise<T>;                  // wraps every server function
```

**How modules register**: there is no dynamic plugin registry — the container is a single factory function (`buildContainer()`) that constructs modules bottom-up (`db` → repositories → `PermissionService` → everything else, since permission checks are a dependency of every mutating service) and returns the frozen `AppContainer`. Adding a module means adding one field to `AppContainer`, one repository constructor call, and one service constructor call in that factory — nothing implicit. Every route (`src/routes/**`) and every server function (`src/routes/**/*.server.ts` or inline `createServerFn`) is required to obtain services only via `withAppContext`; a lint rule (see Best Practices) forbids importing a repository or service constructor directly from a route file.

## Modules

Each module is a folder under `src/server/` (services, repositories) or `src/lib/` (pure logic), with one `index.ts` exporting its public interface. Modules talk to each other **only** through the interfaces below or through the container — never by importing one another's internals.

### `lib/fractional-index` (pure, no deps)
- **Responsibility:** generate and compare ordering keys so a reorder/drag operation writes exactly one row.
- **Interface:** `keyBetween(before: string | null, after: string | null): string`, `isValidKey(key: string): boolean`.
- **Dependencies:** none.

### `lib/rich-text` (pure, no deps)
- **Responsibility:** typed model and (de)serialization for inline runs; applying/toggling annotations (bold/italic/strikethrough/code/link) over a text range.
- **Interface:** `applyAnnotation(runs: InlineRun[], range: Range, annotation: Annotation): InlineRun[]`, `toPlainText(runs: InlineRun[]): string` (feeds search indexing), `runsSchema: ZodType<InlineRun[]>`.
- **Dependencies:** none.

### `lib/permission-rules` (pure, no deps)
- **Responsibility:** the *decision* — given a workspace role, a chain of ancestor page shares, and a requested action, is it allowed? Pure function, no I/O.
- **Interface:** `resolveEffectivePermission(input: { workspaceRole: Role; ancestorShares: PageShare[] }): Permission`, `canPerform(permission: Permission, action: 'read'|'write'): boolean`.
- **Dependencies:** none.

### `db/schema.ts` + `repositories/*`
- **Responsibility:** the only place SQL/Drizzle query-builder calls live. One repository per aggregate: `UserRepository`, `WorkspaceRepository`, `PageRepository`, `BlockRepository`, `DatabasePropertyRepository`, `ViewRepository`, `PageShareRepository`. Repositories never enforce authorization and never contain business rules (cycle checks, type-conformance checks) — they persist and query only.
- **Interface (example, `PageRepository`):** `findById`, `findChildren(parentId)`, `findSubtreeIds(pageId)`, `insert`, `updateFields`, `softDelete(ids: string[])`, `restore(id)`, `move(id, newParentId, newPosition)`. Every method takes/returns typed rows from `db/schema.ts`, never raw SQL fragments to callers.
- **Dependencies:** the shared Drizzle client only (injected by the container).

### `services/auth` — `AuthService`
- **Responsibility:** signup, login, session issuance/verification, password hashing.
- **Interface:** `signUp(input)`, `login(input)`, `verifySession(token)`, `logout(sessionId)`.
- **Dependencies:** `UserRepository`.

### `services/permissions` — `PermissionService`
- **Responsibility:** the I/O side of authorization — load a page's ancestor chain and shares, load the caller's workspace role, delegate the decision to `lib/permission-rules`, and expose one guard every mutating service calls before touching data.
- **Interface:** `assertCan(userId, pageId, action: 'read'|'write'): Promise<void>` (throws `ForbiddenError`), `getEffectivePermission(userId, pageId): Promise<Permission>`.
- **Dependencies:** `PageRepository`, `PageShareRepository`, `WorkspaceRepository`.

### `services/workspace` — `WorkspaceService`
- **Responsibility:** workspace CRUD, membership management, role assignment.
- **Interface:** `createWorkspace`, `addMember`, `changeRole`, `listMembers`, `listWorkspacesForUser`.
- **Dependencies:** `WorkspaceRepository`.

### `services/page-tree` — `PageTreeService`
- **Responsibility:** create/rename/move/nest/reorder pages; soft-delete and restore a page **and its subtree**; cycle rejection on move.
- **Interface:** `createPage`, `renamePage`, `movePage(pageId, newParentId, afterKey)`, `softDeletePage(pageId)` (cascades via repository), `restorePage(pageId)` (root-fallback per business rule), `getTree(workspaceId)`, `listTrash(workspaceId)`.
- **Dependencies:** `PageRepository`, `PermissionService`, `lib/fractional-index`.

### `services/blocks` — `BlockService`
- **Responsibility:** block CRUD and the editor semantics: split on Enter, merge on Backspace-at-0, indent/outdent (Tab/Shift+Tab), reorder/move across parents, depth-limit enforcement (cap 10).
- **Interface:** `insertBlock`, `updateBlockContent`, `splitBlock(blockId, offset)`, `mergeIntoPrevious(blockId)`, `indent(blockId)`, `outdent(blockId)`, `moveBlock(blockId, newParentId, afterKey)`, `listBlocks(pageId)`.
- **Dependencies:** `BlockRepository`, `PageRepository` (to resolve the owning page for permission checks), `PermissionService`, `lib/fractional-index`, `lib/rich-text`.

### `services/databases` — `DatabaseService`
- **Responsibility:** database-property schema CRUD on a database page; validating a row's `properties` JSONB against that schema (including `select`/`multi_select` option membership); the empty-column-only type-migration rule.
- **Interface:** `defineProperty`, `updateProperty`, `deleteProperty`, `changePropertyType` (rejects if any row has a non-null value), `setRowProperties(pageId, properties)` (validates before writing), `getSchema(databasePageId)`.
- **Dependencies:** `DatabasePropertyRepository`, `PageRepository`, `PermissionService`.

### `services/views` — `ViewService`
- **Responsibility:** CRUD for table/board/list view configs (filters, sorts, `group_by`, visible properties); executing a view's query against rows; graceful fallback when `group_by` points at a deleted property.
- **Interface:** `createView`, `updateView`, `deleteView`, `runView(viewId): Promise<ViewResult>` (rows +, for board, grouped buckets).
- **Dependencies:** `ViewRepository`, `PageRepository`, `DatabasePropertyRepository`, `PermissionService`.

### `services/search` — `SearchService`
- **Responsibility:** full-text query across page titles and block `search_vector`, scoped to a workspace and to pages the caller can read.
- **Interface:** `search(workspaceId, userId, query: string): Promise<SearchHit[]>`.
- **Dependencies:** `PageRepository`, `BlockRepository`, `PermissionService`.

### `services/sharing` — folded into `PermissionService` as the write side
- **Responsibility:** grant/revoke a `page_shares` row (`read`/`write`) — kept in `PermissionService` rather than a separate module because every write to shares must immediately be reflected by the same module that evaluates them, avoiding a stale-cache class of bug.
- **Interface (addition to `PermissionService`):** `grantShare(pageId, userId, permission)`, `revokeShare(pageId, userId)`, `listShares(pageId)`.

## Plumbing & Conventions

### Folder layout

```
src/
  routes/                     # file-based routes + server functions (thin: parse → withAppContext → delegate)
    __root.tsx
    _authed/
      workspace.$slug/
        index.tsx
        page.$pageId.tsx
    api/                      # explicit REST endpoints only where a public contract is wanted
  server/
    container.ts              # the central orchestrator
    context.ts                # AsyncLocalStorage-backed RequestContext
    env.ts                    # zod-validated process.env
    errors.ts                 # AppError hierarchy
    logger.ts                 # pino instance + request-scoped child logger
    services/
      auth/
      permissions/
      workspace/
      page-tree/
      blocks/
      databases/
      views/
      search/
    repositories/
      user.repository.ts
      workspace.repository.ts
      page.repository.ts
      block.repository.ts
      database-property.repository.ts
      view.repository.ts
      page-share.repository.ts
    db/
      client.ts
      schema.ts
      migrations/
  lib/
    fractional-index/
    rich-text/
    permission-rules/
  components/                 # React components (editor, sidebar tree, table/board views)
tests/                        # mirrors src/ 1:1 — see Testing Strategy
```

### Error handling

`src/server/errors.ts` defines a base class and one subclass per failure mode; every thrown error is typed and carries a machine-readable `code`:

```ts
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
}
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND'; readonly httpStatus = 404;
}
export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN'; readonly httpStatus = 403;
}
export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR'; readonly httpStatus = 422;
  constructor(readonly issues: ZodIssue[]) { super('Invalid input'); }
}
export class CycleError extends AppError {
  readonly code = 'CYCLE_REJECTED'; readonly httpStatus = 409;
}
export class ConflictError extends AppError {
  readonly code = 'CONFLICT'; readonly httpStatus = 409; // e.g. position-key collision
}
```

`withAppContext` is the only place these are caught and turned into a response; services and repositories only throw, never format HTTP.

### Configuration

`src/server/env.ts` parses `process.env` once at boot through a Zod schema (`DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV`, `PORT`) and exports a frozen `env` object. Nothing else reads `process.env` directly — enforced by convention and caught in code review, matching the "fail loudly, never silently fall back" posture from the objectives.

### Logging

`pino`, JSON in production / pretty in development. `withAppContext` creates one child logger per request carrying `{ requestId, userId, route }`; services accept an optional logger via the request context rather than importing a global.

### Dependency wiring (server function example)

```ts
// src/routes/_authed/workspace.$slug/page.$pageId.tsx
export const movePage = createServerFn({ method: 'POST' })
  .validator(zodValidator(MovePageInput))
  .handler(withAppContext(async (ctx, { pageTree }, input) => {
    return pageTree.movePage(input.pageId, input.newParentId, input.afterKey, ctx.user.id);
  }));
```

The route file never imports `PageRepository` or constructs `PageTreeService` — only `withAppContext` and the validated input shape.

### Representative Drizzle schema fragment

```ts
// src/server/db/schema.ts
export const blocks = pgTable('blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  pageId: uuid('page_id').notNull().references(() => pages.id),
  parentBlockId: uuid('parent_block_id').references((): AnyPgColumn => blocks.id),
  type: blockTypeEnum('type').notNull(),
  content: jsonb('content').notNull(),
  position: text('position').notNull(),
  searchVector: tsVector('search_vector').generatedAlwaysAs(
    (): SQL => sql`to_tsvector('english', coalesce(content->>'plainText', ''))`
  ),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  byPagePosition: index('blocks_page_position_idx').on(t.pageId, t.position),
  byParent: index('blocks_parent_idx').on(t.parentBlockId),
  searchIdx: index('blocks_search_idx').using('gin', t.searchVector),
}));
```

## Testing Strategy

**Runner / assertion library:** `vitest` (`vitest run`, never bare `vitest`, never in watch mode) with `@testing-library/react` + `jsdom` for components.

**Dev dependencies to add:** `vitest`, `@vitejs/plugin-react` (already implied by TanStack Start's Vite setup), `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`, `pg-mem` (in-memory Postgres-compatible engine used as the fake driver for Drizzle in repository tests).

**Config files:**
- `vitest.config.ts` — `environment: 'jsdom'`, `setupFiles: ['./vitest.setup.ts']`, path aliases mirrored from `tsconfig.json`, `test.include: ['tests/**/*.test.{ts,tsx}']`, `coverage.provider: 'v8'`.
- `vitest.setup.ts` — imports `@testing-library/jest-dom`, calls `afterEach(cleanup)`, installs a fixed fake clock helper (`vi.useFakeTimers` is opt-in per test, not global, since fractional-index generation is deterministic and clock-independent).

**File-naming / location convention (one, fixed):** tests live under `tests/`, mirroring `src/` path-for-path, with a `.test.ts`/`.test.tsx` suffix. Example: `src/server/services/page-tree/page-tree.service.ts` → `tests/server/services/page-tree/page-tree.service.test.ts`. `src/lib/fractional-index/index.ts` → `tests/lib/fractional-index/index.test.ts`.

**`package.json` test script:**
```json
{ "scripts": { "test": "vitest run" } }
```
No `--passWithNoTests` or equivalent is ever passed — an empty suite is a failing suite. CI must run this script.

**Coverage per layer:**

| Layer | What must be covered | How externals are faked |
|---|---|---|
| Pure libs (`lib/fractional-index`, `lib/rich-text`, `lib/permission-rules`) | Exhaustive input/output tables: `keyBetween(null, null)`, `keyBetween(a, b)` ordering invariants, collision regeneration; every `Annotation` toggle on/off and across a run boundary; every `(role, shareChain, action)` combination including no-share/ancestor-share/direct-share. Boundary: empty run arrays, zero-length ranges, deepest-nesting cap (10) and depth 11 rejected. | None needed — pure functions, no fakes required. |
| Repositories (`repositories/*`) | One test file per repository: insert → findById round-trip, `findSubtreeIds` on a 3-level tree, `softDelete` cascading to descendants, unique-`position`-within-parent constraint violation surfaced as a typed error, `move` rejecting a cycle at the query level as a defense-in-depth check. | Drizzle wired against `pg-mem` (in-memory, deterministic, no network, no real Postgres process) instantiated fresh in `beforeEach` and torn down in `afterEach`; migrations applied against the in-memory instance once per test file. |
| Services (`services/*`) | Every exported method: happy path with real return values asserted field-by-field; every branch (e.g. `restorePage` when parent is deleted vs. present; `changePropertyType` when rows are empty vs. populated — assert the exact `ConflictError`); boundary/empty (`getTree` on a workspace with zero pages, `runView` with zero rows, `search` with an empty query string); failure modes asserted via `await expect(fn()).rejects.toThrow(ForbiddenError)` / `.toMatchObject({ code: 'CYCLE_REJECTED' })`, never bare `.rejects.toThrow()`. | Repositories replaced with hand-written fakes implementing the same narrow interface (in-memory arrays), so service tests assert business logic in isolation from SQL. `PermissionService` is faked (or its rule table injected) in tests for services that depend on it, so authorization branches are tested directly rather than through a real permission graph. |
| Server functions / route handlers (`routes/**`) | Call the exported handler directly with a constructed `Request`/input object; assert status/thrown-error-shape for: success, not-found, validation failure (malformed input against the Zod schema), forbidden. | `withAppContext` accepts an injectable container in tests (`withAppContext(handler, { containerOverride })`), so a route test supplies fake services rather than the real container/db. |
| React components (editor blocks, sidebar tree, slash menu, table/board view) | Render via `@testing-library/react`; simulate `userEvent` for Enter/Backspace/Tab/Shift+Tab in the block editor, `/` opening the slash menu and filtering by keystroke, drag-and-drop reorder firing the expected `moveBlock`/`movePage` call, board view rendering one column per select option plus an "ungrouped" column. Assert on rendered DOM (`getByRole`, `getByText`), not implementation details. | Server functions/services passed as injected props or mocked via `vi.mock` at the module boundary; no real network fetch — assert the mock was called with the expected typed payload. |

**Determinism / no real externals, workspace-wide rule:**
- Network: never — server functions under test call faked services; the app itself makes no outbound network calls.
- Database: `pg-mem` for repositories; hand-written fakes for everything above the repository layer. No test opens a connection to the Docker Postgres instance used for local development.
- Child processes: none are spawned by this application; not applicable.
- Clock: any code depending on `now()` (e.g. `createdAt` defaults) is tested through the returned row's shape, not by asserting a literal timestamp, except where `vi.useFakeTimers()` is explicitly installed for a specific ordering test.
- Randomness: `crypto.randomUUID()` calls in tests either accept an injected id or are asserted only for shape (`expect(id).toMatch(/^[0-9a-f-]{36}$/)`), never for an exact value.

## Best Practices

**Type safety**
- `tsconfig.json` extends the workspace's strict base (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`) — index access on arrays/records is narrowed before use, optional fields are spread conditionally rather than assigned `undefined`.
- Zod schemas are the single source of truth for every server-function input and for `block.content`/`database properties` shapes; TypeScript types are inferred from the schema (`z.infer<...>`), never hand-duplicated.
- Repositories return Drizzle-inferred row types; services never widen them to `any`.
- A lint rule (`eslint-plugin-boundaries` or an equivalent custom rule) forbids `routes/**` importing from `repositories/**` directly, and forbids any `services/**` module importing another `services/**` module's internals instead of its exported interface.

**Security**
- Every mutating service method calls `PermissionService.assertCan(...)` before touching a repository — this is enforced by code review checklist and by a service-layer test asserting `ForbiddenError` for every mutation with an unauthorized actor.
- Session cookie: `httpOnly`, `sameSite=lax`, `secure` in production; password hashing via argon2id with a workspace-wide pepper from `env.SESSION_SECRET`.
- All server-function input validated with Zod before it reaches a service; unknown block `type` or property `type` values are rejected, not coerced.
- Parameterized queries only (Drizzle query builder — no raw SQL string concatenation); the one hand-written `sql` fragment (the generated `search_vector` column) uses `sql\`...\`` templating with no interpolated user input.
- Destructive operations (hard purge of trashed pages) are a separate, explicitly-named service method from soft-delete, gated by workspace-owner role.

**Performance**
- Reordering (pages and blocks) is always a single-row `UPDATE position` via fractional indexing — no sibling renumbering.
- `pages(workspace_id, parent_page_id)`, `pages(database_id)`, `blocks(page_id, position)`, `blocks(parent_block_id)`, and GIN indexes on `blocks.content` and `blocks.search_vector` are created in the initial migration (per the research's index list).
- View queries (`ViewService.runView`) push filters/sorts/group-by down into the SQL query rather than fetching all rows and filtering in memory.
- Page-tree loads use a single recursive CTE per workspace rather than N+1 per-node queries.

## Deployment Shape

**Local development**
- `pnpm -C <app> dev` starts the TanStack Start Vite dev server (default port 3000, configurable via `PORT`).
- PostgreSQL 17 runs via `docker-compose.yml` (a dedicated `postgres:17` service, separate from any other Postgres instance on the host); `drizzle-kit push`/`drizzle-kit migrate` applies `src/server/db/migrations/` against it.
- `.env` (gitignored) supplies `DATABASE_URL`, `SESSION_SECRET`; `src/server/env.ts` fails fast at boot if either is missing.

**Production**
- Build: `vinxi build` (TanStack Start's build) produces a Node server bundle plus the client asset bundle.
- Run: the built server (`node .output/server/index.mjs` or equivalent) behind a reverse proxy (TLS termination, gzip); stateless — safe to run multiple instances behind a load balancer since sessions are cookie-based and all state lives in Postgres.
- Database: a managed PostgreSQL 17 instance; migrations run as an explicit release-step (`drizzle-kit migrate`) before the new server version receives traffic, never on request-path.
- Configuration: `DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV=production`, `PORT` supplied as platform environment variables/secrets — never committed, never in a config file.
- Observability: structured `pino` logs to stdout for the platform's log aggregator; no additional infra required for v1.

<!-- QA edit -->
