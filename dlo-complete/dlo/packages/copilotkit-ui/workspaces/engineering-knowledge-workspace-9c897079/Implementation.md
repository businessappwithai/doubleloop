# Implementation Plan — Engineering Knowledge Workspace

> **Status:** Build contract for the execution fleet. Each module below is dispatched to an
> independent Claude Code subagent. A subagent sees *only* its own `prompt`, `touches`,
> `acceptance` and `exitClauses` — so each prompt is written to be self-sufficient.
>
> **Conformance:** Architecture.md governs structure (central orchestrator, module isolation,
> ports/adapters, no cross-module imports). Database.md governs the persistence layer (DDL,
> migration files, `Db` port, optimistic concurrency, advisory locks). Where this plan names a
> file path, that path is normative.
>
> **Test rule (non-negotiable, repeated here because it is the most-violated rule):** every
> module after the scaffold ships its own unit tests, in the files listed in its `touches`, and
> its exit clause runs exactly those files. Tests assert real return values, cover every branch,
> boundary/empty inputs, and failure modes (assert the typed error and its `code`, not merely
> that something threw). Tests are hermetic: no live network, no real Postgres, no real
> websocket, no real `git`, no real clock. `describe.skip` / `it.skip` / `it.todo` are forbidden,
> and `--passWithNoTests` is forbidden.

---

## Build Order

The plan is built in six waves. Waves are separated by genuine data dependencies; everything
inside a wave runs in parallel and no two modules in a wave touch the same file.

**Wave 0 — the floor (m1 → m2, strictly serial).**
`m1` scaffolds a TanStack Start + React 19 + TypeScript-strict application that installs,
typechecks and builds *from module 1*. It declares the entire dependency set up front — Astryx +
StyleX, Lexical, Yjs, Relay, `graphql`, `pg`, `yaml`, `zod`, `ws`, Vitest — so that no later
module ever has to edit `package.json` dependencies and race another module for that file.
`m2` then installs the test harness (Vitest + jsdom + Testing Library), the setup file, the shared
test utilities, and the `test` script. Every subsequent module depends on `m2`, because every
subsequent module ships tests. These two are the only modules permitted to touch `package.json`.

**Wave 1 — pure foundations (m3, m4, m7, m8, in parallel).**
Nothing here performs I/O, so all four can be built simultaneously and tested exhaustively with
plain input/output tables. `m3` is the domain vocabulary: branded ids, `AppError` hierarchy with
machine-readable codes, `RequestContext`/`Actor`. `m4` is `loadConfig` (zod over `process.env`)
and the injectable structured logger. `m7` is the Relay convention layer — base64 global-id
encode/decode and the cursor `Connection` builder — kept pure and shared by every server module
and by the client. `m8` is the OKF core: YAML frontmatter parse/serialize with strict
`trust`/`lifecycle` validation, and the Markdown-document split/join. `m8` is isomorphic on
purpose: the Git-sync worker and the browser frontmatter panel use the same code, so the file
written to Git and the form rendered on screen can never disagree.

**Wave 2 — the I/O seam (m5, then m6).**
`m5` defines `Ports` and every adapter (`PgDb`, `NodeClock`, `RandomIds`, `NodeFs`, `NodeGit`)
plus — critically — `tests/helpers/fake-ports.ts`, the in-memory `Db` and deterministic clock that
every later module's tests consume. Building the fakes *with* the adapters is what makes the rest
of the suite hermetic by construction. `m6` follows immediately with the seven numbered SQL
migrations transcribed verbatim from Database.md's DDL block, plus the checksum-guarded,
advisory-locked, forward-only migration runner.

**Wave 3 — the domain modules (m9, m10, m11, m12, in parallel; then m13, m14).**
Each is an independent slice: repository (parameterised SQL against the `Db` port) + module
service (domain logic, optimistic-concurrency conflict handling) + `SchemaContribution` (SDL
fragment + resolver map) + `ModuleDescriptor`. They do not import each other — Architecture.md
forbids it — so they parallelise cleanly. `m9` bundles, `m10` concepts + hierarchy (fractional
`sort_key`, materialised `path`, advisory-locked moves, cursor-paginated children), `m11`
documents (Lexical block payload + Yjs binary update persistence and merge), `m12` search (GIN
`jsonb_path_ops` containment, `okf_english` full-text, `pg_trgm` fuzzy title match). `m13`
(collaboration + the standalone `ws` relay process) needs `m11`'s document store; `m14` (Git-sync
export worker) needs `m8`, `m10` and `m11` to render a concept back to an OKF `.md` file.

**Wave 4 — assembly (m15).**
The single point where everything is wired: the module registry with cycle detection, the
orchestrator that constructs ports once and injects them, the merged executable schema, the
per-request context, the `AppError` → GraphQL-extension mapping, and the `/api/graphql` server
route. `m15` also emits `schema.graphql`, which the client's Relay compiler consumes.

**Wave 5 — the client (m16, m17 in parallel → m18 → m19, m20 in parallel → m21).**
`m16` is the Astryx/StyleX shell: theme tokens, dark mode via the token cascade, `AppFrame`,
sidebar chrome, document header, toolbar shell. `m17` is the Relay client runtime (Environment,
Store, network layer over `/api/graphql`, optimistic-update helpers) and depends only on `m7`'s
conventions, so it builds alongside `m16`. `m18` is the Lexical block editor — custom
`CodeBlockNode`/`DividerNode`, the markdown-shortcut `NodeTransform`s, and `@lexical/markdown`
import/export. `m19` (Yjs provider + awareness/presence) and `m20` (frontmatter panel) both hang
off the editor and the shell and run in parallel. `m21` closes the loop: the lazily-paginated
sidebar tree, the concept route that composes editor + panel + presence, the search UI, and the
Relay artifact generation — and its exit clause runs the **entire** suite, so the last module
cannot pass while any earlier module's tests are broken.

**Why tests are never a trailing module.** A cheap-model fleet regresses silently. Binding each
module's exit clause to its own test files means a defect is attributed to the module that caused
it, at the moment it is introduced, instead of surfacing as an unattributable pile at the end.

---

## Modules

### m1 — Project scaffold: TanStack Start + React 19 + StyleX/Astryx

**Build.** A TanStack Start application that installs, typechecks and builds immediately.
`package.json` declares the *complete* dependency set for the whole project (see the Architecture
"Technology Choices" tables): `@tanstack/react-start`, `@tanstack/react-router`, `react@^19`,
`react-dom@^19`, `@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@astryxdesign/build`,
`@astryxdesign/cli`, `@stylexjs/stylex`, `lexical` + `@lexical/react|markdown|yjs|rich-text|list|code|link|utils|selection`,
`yjs`, `y-websocket`, `y-protocols`, `react-relay`, `relay-runtime`, `graphql`, `pg`, `yaml`,
`zod`, `ws`; dev: `typescript`, `vite`, `relay-compiler`, `babel-plugin-relay`, `@types/*`,
`vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`.
Scripts: `dev`, `build`, `start`, `typecheck`, `test`, `relay`, `schema:emit`, `migrate`, `collab`.
`app.config.ts` registers the StyleX/Astryx Vite plugin from `@astryxdesign/build`.
`tsconfig.json` mirrors the repo's strict settings: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`, `moduleResolution: bundler`, JSX
`react-jsx`. Entry files: `src/router.tsx`, `src/client.tsx`, `src/ssr.tsx`, `src/routes/__root.tsx`
(imports the Astryx theme stylesheet), `src/routes/index.tsx` (renders a real landing view — no
placeholder text).

**Files.** `package.json`, `app.config.ts`, `tsconfig.json`, `.gitignore`, `.env.example`,
`README.md`, `src/router.tsx`, `src/client.tsx`, `src/ssr.tsx`, `src/routes/__root.tsx`,
`src/routes/index.tsx`, `src/styles/global.css`.

**Depends on.** — (root)

**Acceptance.**
- `npm install` completes and `npx tsc --noEmit` exits 0.
- `npm run build` exits 0 and produces the TanStack Start output directory.
- `package.json` contains every dependency listed above; no later module needs to add one.
- No file contains `TODO`, `FIXME`, or a stubbed function body.

---

### m2 — Test harness: Vitest + jsdom + Testing Library

**Build.** `vitest.config.ts` (jsdom environment, `globals: true`, `setupFiles`, `include:
['tests/**/*.test.{ts,tsx}']`, coverage via v8, and **no** `passWithNoTests`). `vitest.setup.ts`
imports `@testing-library/jest-dom/vitest`, installs an `afterEach` cleanup, fails the run on
unexpected `console.error`, and stubs `matchMedia`/`ResizeObserver` for jsdom. Shared utilities in
`tests/helpers/test-utils.tsx`: a `renderWithShell` wrapper, a deterministic `fixedClock`, and a
`flushMicrotasks` helper. Update `package.json` so `test` is `vitest run` and add `test:watch`
and `test:coverage`. `tests/harness.test.ts` proves the harness itself works: jsdom is active,
`jest-dom` matchers are registered, fake timers advance deterministically, and the config object
does not enable `passWithNoTests`.

**Files.** `vitest.config.ts`, `vitest.setup.ts`, `tests/helpers/test-utils.tsx`,
`tests/harness.test.ts`, `package.json` (scripts only).

**Depends on.** m1

**Acceptance.**
- `npm test` runs non-interactively, exits 0, and reports ≥ 1 passing test.
- Unit tests in `tests/harness.test.ts` pass and cover: jsdom availability, jest-dom matcher
  registration, fake-timer determinism, and the assertion that the Vitest config does not set
  `passWithNoTests`.
- `grep -R "passWithNoTests" .` finds no occurrence outside documentation.

---

### m3 — Core domain: branded ids, typed errors, request context

**Build.** `src/core/ids.ts`: branded `BundleId`, `ConceptId`, `ActorId`, `RevisionId` with
`asBundleId`-style constructors that reject non-UUID input with `ValidationError`. `src/core/errors.ts`:
abstract `AppError` (readonly `code`, `httpStatus`, `details`, `cause`) and the concrete subclasses
`ValidationError`, `NotFoundError`, `ConflictError`, `ConfigError`, `MigrationError`,
`ForbiddenError`, `InternalError`; plus `isAppError` and `toErrorExtensions`. `src/core/types.ts`:
the OKF domain unions `TrustLevel` (`unverified | machine-confirmed | human-reviewed`),
`Lifecycle` (`draft | active | deprecated | archived`), and the `Bundle`/`Concept`/`Provenance`
record types. `src/core/context.ts`: `Actor`, `RequestContext`, `createRequestContext`.

**Files.** `src/core/ids.ts`, `src/core/errors.ts`, `src/core/types.ts`, `src/core/context.ts`,
`tests/core-ids.test.ts`, `tests/core-errors.test.ts`, `tests/core-types.test.ts`,
`tests/core-context.test.ts`.

**Depends on.** m2

**Acceptance.**
- Unit tests in `tests/core-ids.test.ts`, `tests/core-errors.test.ts`, `tests/core-types.test.ts`
  and `tests/core-context.test.ts` pass and cover id branding + rejection of empty/malformed/
  wrong-version UUIDs, every error subclass's `code` and `httpStatus`, `cause` preservation,
  `isAppError` against non-errors, and every `TrustLevel`/`Lifecycle` guard arm.
- `npx tsc --noEmit` exits 0.

---

### m4 — Configuration and structured logging

**Build.** `src/config/config.ts`: `AppConfig` and `loadConfig(env: Record<string,string|undefined>)`
— a pure function over an injected environment map (never `process.env` directly) parsed with zod.
Covers `env`, `instanceId`, `port`, `db.url`, `db.poolMax` (≥ 2), `db.ssl`, `db.autoMigrate`
(true only when `env === 'development'`), `collab.wsUrl`, `collab.port`, `gitSync.repoPath`,
`gitSync.branch`, `gitSync.intervalMs`, `logLevel`. Every failure throws
`ConfigError` with a code such as `config.invalidDbUrl` and the offending key list.
`src/lib/logger.ts`: `createLogger({ level, sink, clock })` emitting one JSON object per line,
level filtering, `child(bindings)` for per-request loggers, and redaction of `password`,
`token`, `apiKey`, `authorization` and the credentials inside a connection URL.

**Files.** `src/config/config.ts`, `src/lib/logger.ts`, `tests/config.test.ts`, `tests/logger.test.ts`.

**Depends on.** m2, m3

**Acceptance.**
- Unit tests in `tests/config.test.ts` and `tests/logger.test.ts` pass and cover: a complete valid
  env; each missing required key; `poolMax` at 1 (reject), 2 (accept); `autoMigrate=true` in
  production (reject with `config.autoMigrateForbidden`); every log level boundary; `child`
  binding inheritance; and redaction of each secret key and of URL credentials.
- Tests assert `ConfigError` and its `code`, not a generic throw.
- `npx tsc --noEmit` exits 0.

---

### m5 — Ports and adapters, plus the in-memory fakes the whole suite depends on

**Build.** `src/server/ports.ts`: the `Db` interface exactly as specified in Database.md
(`query`, `withTransaction` with `Isolation` and `readOnly`, savepoint-based nesting), plus
`Clock`, `IdGenerator`, `Logger`, `FsPort`, `GitPort`, and the aggregate `Ports`.
`src/server/adapters/pg-db.ts` is the **only** file in the repository that imports `pg`: it builds
the single `Pool` with the documented timeouts, applies the per-connection session settings
(`statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`, `search_path`) on the
`connect` event, asserts `server_version_num >= 170000` and otherwise throws
`ConfigError('db.unsupportedVersion')`, and rejects any SQL string containing a non-`$n`
interpolation. `node-clock.ts`, `random-ids.ts`, `node-fs.ts` (workspace-root-confined; `..`
escapes throw `ValidationError('fs.pathEscape')`), `node-git.ts` (`execFile` with an argv array,
never a shell string). `tests/helpers/fake-ports.ts` provides `createFakeDb` (a scriptable
query-matcher with transaction/rollback recording), `createFakeClock`, `createSeqIds`,
`createMemoryFs`, `createFakeGit`, and `createFakePorts`.

**Files.** `src/server/ports.ts`, `src/server/adapters/pg-db.ts`, `src/server/adapters/node-clock.ts`,
`src/server/adapters/random-ids.ts`, `src/server/adapters/node-fs.ts`, `src/server/adapters/node-git.ts`,
`tests/helpers/fake-ports.ts`, `tests/pg-db.test.ts`, `tests/adapters-fs-git.test.ts`,
`tests/adapters-clock-ids.test.ts`.

**Depends on.** m2, m3, m4

**Acceptance.**
- Unit tests in `tests/pg-db.test.ts`, `tests/adapters-fs-git.test.ts` and
  `tests/adapters-clock-ids.test.ts` pass and cover: `pg` fully mocked via `vi.mock('pg')`; commit
  on resolve; rollback on reject; savepoint on nested `withTransaction`; client release on both
  paths; version-guard rejection; session-setting SQL issued on connect; `FsPort` rejecting `..`
  escapes and absolute paths outside the root; `GitPort` invoking `execFile` with an argv array
  (asserted argv) and mapping non-zero exit to a typed error.
- No test opens a socket, spawns a process, or touches a real filesystem outside a temp dir
  created in `beforeEach` and removed in `afterEach`.
- `npx tsc --noEmit` exits 0.

---

### m6 — SQL migrations and the migration runner

**Build.** Transcribe Database.md's `## DDL` block into the seven numbered files, split exactly as
that document specifies: `001_extensions_enums_functions.sql` (`pg_trgm`, `btree_gin`, `unaccent`,
the `okf_english` text-search configuration, the trust/lifecycle enums, `schema_migrations`),
`002_identity_and_workspaces.sql`, `003_bundles_and_concepts.sql` (relational columns,
`COLLATE "C"` on `slug`/`path`/`sort_key`, `version integer NOT NULL DEFAULT 1`),
`004_concept_documents_and_crdt.sql` (JSONB block payload + `bytea` Yjs state, `jsonb_typeof`
CHECK constraints), `005_frontmatter_links_revisions.sql`, `006_search_indexes.sql` (GIN
`jsonb_path_ops`, `btree_gin` composite `(bundle_id, body_tsv)`, trigram indexes),
`007_collaboration_and_git_sync.sql`. Plus `sql/seed/001_dev_seed.sql`.
`src/server/migrate.ts` exports `planMigrations(files, applied)` (pure — ordering, gap detection,
checksum comparison) and `runMigrations(db, files, opts)`: takes `pg_advisory_lock(4479823001)`,
applies each file in its own transaction in strict numeric order, records
`version`/`name`/`checksum`/`applied_at`/`duration_ms`, throws `MigrationError('migration.gap')`
on a numeric gap and `MigrationError('migration.checksumMismatch')` on an edited file, and in
check-only mode returns the pending list instead of applying. Down-migrations do not exist.

**Files.** `sql/migrations/001_extensions_enums_functions.sql`,
`sql/migrations/002_identity_and_workspaces.sql`, `sql/migrations/003_bundles_and_concepts.sql`,
`sql/migrations/004_concept_documents_and_crdt.sql`,
`sql/migrations/005_frontmatter_links_revisions.sql`, `sql/migrations/006_search_indexes.sql`,
`sql/migrations/007_collaboration_and_git_sync.sql`, `sql/seed/001_dev_seed.sql`,
`src/server/migrate.ts`, `tests/migrate-plan.test.ts`, `tests/migrate-run.test.ts`,
`tests/migrations-sql.test.ts`.

**Depends on.** m5

**Acceptance.**
- Unit tests in `tests/migrate-plan.test.ts`, `tests/migrate-run.test.ts` and
  `tests/migrations-sql.test.ts` pass and cover: empty applied-set; all-applied (no-op); a numeric
  gap → `MigrationError('migration.gap')`; a changed checksum → `MigrationError('migration.checksumMismatch')`;
  advisory lock acquired before and released after; one transaction per file; check-only mode
  returning pending versions without executing DDL; and a static scan asserting every migration
  file is present, numbered contiguously, and contains no `DROP TABLE`.
- The runner is tested against the fake `Db` from `tests/helpers/fake-ports.ts` — no real Postgres.
- `npx tsc --noEmit` exits 0.

---

### m7 — Relay conventions: global object identification and connections

**Build.** `src/core/global-id.ts`: `toGlobalId(typeName, localId)` producing
`base64("TypeName:uuid")`, `fromGlobalId(id)` returning `{ typeName, localId }` and throwing
`ValidationError('globalId.malformed')` on non-base64, missing separator, empty parts, or an
unknown type name (validated against an exported `NODE_TYPES` tuple). `src/core/connection.ts`:
`encodeCursor`/`decodeCursor` (opaque, base64 over `sortKey|id`), `buildConnection(rows, args)`
implementing the Relay pagination algorithm — `first`/`after`/`last`/`before`, `edges`, `node`,
`cursor`, `pageInfo { hasNextPage, hasPreviousPage, startCursor, endCursor }`, `totalCount` —
plus `validateConnectionArgs` rejecting negative `first`/`last`, `first` above the 200 limit, and
`first` together with `last`. `src/graphql/schema.root.graphql`: the `Node` interface, `PageInfo`,
the OKF enums, root `Query`/`Mutation`, and the custom scalars. `scripts/emit-schema.ts`
concatenates the root document with every `src/modules/**/*.graphql` fragment into `schema.graphql`.

**Files.** `src/core/global-id.ts`, `src/core/connection.ts`, `src/graphql/schema.root.graphql`,
`scripts/emit-schema.ts`, `tests/global-id.test.ts`, `tests/connection.test.ts`,
`tests/emit-schema.test.ts`.

**Depends on.** m2, m3

**Acceptance.**
- Unit tests in `tests/global-id.test.ts`, `tests/connection.test.ts` and
  `tests/emit-schema.test.ts` pass and cover: round-trip for every entry in `NODE_TYPES`; malformed
  base64, missing colon, empty type, unknown type; empty row set (`hasNextPage=false`, null
  cursors); exactly-`first` rows; `first + 1` rows (`hasNextPage=true`); backward `last`/`before`;
  negative and over-limit arguments; `first` and `last` together; and schema emission ordering plus
  the duplicate-type-definition failure.
- `npx tsc --noEmit` exits 0.

---

### m8 — OKF core: YAML frontmatter and Markdown document handling

**Build.** Isomorphic, dependency-light, used by both the Git-sync worker and the browser panel.
`src/core/okf/schema.ts`: the zod schema for OKF frontmatter — `id`, `title`, `trust`
(`unverified | machine-confirmed | human-reviewed`), `lifecycle`, `provenance { source, author,
retrievedAt, checksum? }`, `tags`, `links`, `updatedAt` — with unknown keys preserved rather than
stripped. `src/core/okf/frontmatter.ts`: `parseFrontmatter(raw)` using `yaml` in strict mode
(duplicate keys rejected), returning a typed value or throwing `ValidationError` with a per-field
issue list; `serializeFrontmatter(fm)` producing stable key ordering and a byte-identical
round-trip. `src/core/okf/markdown-document.ts`: `splitDocument(text)` separating the `---`
delimited frontmatter block from the body (handling: no frontmatter, unterminated delimiter, CRLF
line endings, leading BOM, empty body), `joinDocument({ frontmatter, body })`, and
`conceptFileName(concept)` returning `index.md` for a concept with children and `<slug>.md`
otherwise.

**Files.** `src/core/okf/schema.ts`, `src/core/okf/frontmatter.ts`,
`src/core/okf/markdown-document.ts`, `tests/okf-schema.test.ts`, `tests/okf-frontmatter.test.ts`,
`tests/okf-markdown-document.test.ts`.

**Depends on.** m2, m3

**Acceptance.**
- Unit tests in `tests/okf-schema.test.ts`, `tests/okf-frontmatter.test.ts` and
  `tests/okf-markdown-document.test.ts` pass and cover: each valid `trust` and `lifecycle` value;
  an invalid value for each; a missing required field; unknown-key preservation; duplicate YAML
  keys → `ValidationError('frontmatter.duplicateKey')`; malformed YAML; a document with no
  frontmatter; an unterminated `---`; CRLF and BOM inputs; an empty body; and a
  serialize→parse→serialize byte-identical round trip.
- `npx tsc --noEmit` exits 0.

---

### m9 — Bundles module

**Build.** `src/modules/bundles/bundle-repository.ts` — parameterised SQL only, against the `Db`
port: `insert`, `findById`, `findBySlug`, `listConnection(args)` (delegating to
`buildConnection`), `update` with `WHERE id = $1 AND version = $2` raising
`ConflictError('bundle.staleVersion')` on `rowCount === 0`, and `softDelete`.
`bundle-module.ts` — the `BundleModule` service: slug normalisation and uniqueness mapping
(`23505` → `ConflictError('bundle.slugTaken')`), `NotFoundError('bundle.notFound')`, timestamps
from the injected `Clock`, ids from the injected `IdGenerator`. `bundle-schema.graphql` +
`bundle-schema.ts` — the SDL fragment (`Bundle implements Node`, `BundleConnection`, the
`bundles` query, `createBundle`/`renameBundle`/`archiveBundle` mutations) and its resolver map,
resolving `id` through `toGlobalId`. `index.ts` — the `ModuleDescriptor` (`name: 'bundles'`,
`dependsOn: []`).

**Files.** `src/modules/bundles/bundle-repository.ts`, `src/modules/bundles/bundle-module.ts`,
`src/modules/bundles/bundle-schema.graphql`, `src/modules/bundles/bundle-schema.ts`,
`src/modules/bundles/index.ts`, `tests/bundles-repository.test.ts`, `tests/bundles-module.test.ts`,
`tests/bundles-resolvers.test.ts`.

**Depends on.** m5, m6, m7

**Acceptance.**
- Unit tests in `tests/bundles-repository.test.ts`, `tests/bundles-module.test.ts` and
  `tests/bundles-resolvers.test.ts` pass and cover: create/read/list/update happy paths asserted on
  real returned records; empty list; pagination past the end; unknown id → `NotFoundError` with
  code; duplicate slug → `ConflictError('bundle.slugTaken')`; stale version → `ConflictError('bundle.staleVersion')`;
  and every resolver field including the global-id encoding.
- Every SQL string is asserted to use only `$n` placeholders.
- `npx tsc --noEmit` exits 0.

---

### m10 — Concepts and hierarchy module

**Build.** The tree. `src/modules/concepts/concept-repository.ts` (CRUD over `concepts`, optimistic
concurrency, `findByPath`), `concept-module.ts` (slug/title rules, trust and lifecycle
transitions, `NotFoundError('concept.notFound')`, `ConflictError('concept.staleVersion')`).
`src/modules/hierarchy/sort-key.ts` — a pure fractional-index allocator: `keyBetween(a, b)`
producing a byte-ordered (`COLLATE "C"`-safe) key, handling first child, append, insert between
adjacent keys, and exhaustion by lengthening rather than colliding.
`hierarchy-repository.ts` — `childrenConnection(parentId, args)` for the lazily-paginated sidebar,
the recursive-CTE ancestor path query, and `moveSubtree` which takes
`pg_advisory_xact_lock(hashtextextended($1::text,0))` on the bundle, reallocates the destination
`sort_key`, and rewrites descendant `path` values in one statement. `hierarchy-module.ts` rejects
a move that would make a node its own ancestor with `ValidationError('hierarchy.cycle')`.
Plus the SDL fragment (`Concept implements Node`, `ConceptConnection`, `children(first, after)`,
`moveConcept`, `createConcept`, `updateConceptMetadata`) and the two `ModuleDescriptor`s.

**Files.** `src/modules/concepts/concept-repository.ts`, `src/modules/concepts/concept-module.ts`,
`src/modules/concepts/concept-schema.graphql`, `src/modules/concepts/concept-schema.ts`,
`src/modules/concepts/index.ts`, `src/modules/hierarchy/sort-key.ts`,
`src/modules/hierarchy/hierarchy-repository.ts`, `src/modules/hierarchy/hierarchy-module.ts`,
`src/modules/hierarchy/hierarchy-schema.graphql`, `src/modules/hierarchy/hierarchy-schema.ts`,
`src/modules/hierarchy/index.ts`, `tests/concepts-repository.test.ts`, `tests/concepts-module.test.ts`,
`tests/hierarchy-sort-key.test.ts`, `tests/hierarchy-repository.test.ts`,
`tests/hierarchy-module.test.ts`, `tests/concepts-resolvers.test.ts`.

**Depends on.** m5, m6, m7

**Acceptance.**
- Unit tests in the six listed `tests/*.test.ts` files pass and cover: concept CRUD happy paths;
  stale-version conflict; unknown id; `keyBetween` for first/append/between/repeated-subdivision and
  the strict byte-ordering invariant asserted over 100 sequential insertions; children pagination
  with 0, 1, exactly-`first`, and `first + 1` children; ancestor path resolution at depth 1 and 5;
  a move that creates a cycle → `ValidationError('hierarchy.cycle')`; a move to a non-existent
  parent → `NotFoundError`; and the assertion that `moveSubtree` issues the advisory lock before
  any write.
- `npx tsc --noEmit` exits 0.

---

### m11 — Documents module: Lexical block payload and Yjs CRDT persistence

**Build.** `src/modules/documents/crdt.ts` — pure Yjs helpers over `Uint8Array`:
`mergeUpdates(updates)`, `encodeStateVector(doc)`, `diffUpdate(update, stateVector)`,
`applyUpdateToDoc`, and `docToBlocks(doc)` converting the `Y.XmlFragment` into the serialisable
block payload. `document-repository.ts` — `concept_documents` access: read/write the JSONB block
payload and the `bytea` Yjs state, `appendUpdate` inside `withTransaction` (read current state,
merge, write with `version` guard → `ConflictError('document.staleVersion')`), and a
`jsonb_path_ops` containment query helper. `document-module.ts` — validates every JSONB read-back
with zod (`ValidationError('document.corruptPayload')` on mismatch, never a silent coercion),
produces a revision row on each committed snapshot, and exposes `renderMarkdown(conceptId)` built
on `@lexical/markdown`-compatible block→markdown conversion. Plus the SDL fragment
(`ConceptDocument`, `saveDocument`, `applyCrdtUpdate` returning the merged state) and the
`ModuleDescriptor`.

**Files.** `src/modules/documents/crdt.ts`, `src/modules/documents/blocks.ts`,
`src/modules/documents/document-repository.ts`, `src/modules/documents/document-module.ts`,
`src/modules/documents/document-schema.graphql`, `src/modules/documents/document-schema.ts`,
`src/modules/documents/index.ts`, `tests/documents-crdt.test.ts`, `tests/documents-blocks.test.ts`,
`tests/documents-repository.test.ts`, `tests/documents-module.test.ts`.

**Depends on.** m5, m6, m7, m8

**Acceptance.**
- Unit tests in `tests/documents-crdt.test.ts`, `tests/documents-blocks.test.ts`,
  `tests/documents-repository.test.ts` and `tests/documents-module.test.ts` pass and cover: two
  in-process `Y.Doc`s converging to identical state after concurrent inserts (real Yjs, no
  network); merging an empty update list; an empty document; a malformed `Uint8Array` →
  `ValidationError`; block payload round-trip for paragraph, heading, list, code, quote and
  divider; a JSONB payload failing zod → `ValidationError('document.corruptPayload')`; and stale
  version → `ConflictError('document.staleVersion')`.
- `npx tsc --noEmit` exits 0.

---

### m12 — Search module: JSONB containment, full text, trigram

**Build.** `src/modules/search/query-builder.ts` — a pure builder producing the SQL text and
parameter array for a search request: `@>` containment against the `jsonb_path_ops` index for
structured block predicates, `body_tsv @@ websearch_to_tsquery('okf_english', $n)` for prose,
`title ILIKE '%' || $n || '%'` backed by `pg_trgm` for the fuzzy jump-to filter, all scoped by
`bundle_id` so the `btree_gin` composite index is usable; plus rank ordering and cursor
pagination. It rejects an empty query with `ValidationError('search.emptyQuery')` and a term list
above the limit with `ValidationError('search.tooManyTerms')`. `search-repository.ts` executes it
through the `Db` port; `search-module.ts` maps rows to `SearchHit` with highlighted snippets and
builds a `SearchHitConnection`. Plus the SDL fragment and the `ModuleDescriptor`.

**Files.** `src/modules/search/query-builder.ts`, `src/modules/search/search-repository.ts`,
`src/modules/search/search-module.ts`, `src/modules/search/search-schema.graphql`,
`src/modules/search/search-schema.ts`, `src/modules/search/index.ts`,
`tests/search-query-builder.test.ts`, `tests/search-repository.test.ts`, `tests/search-module.test.ts`.

**Depends on.** m5, m6, m7

**Acceptance.**
- Unit tests in `tests/search-query-builder.test.ts`, `tests/search-repository.test.ts` and
  `tests/search-module.test.ts` pass and cover: text-only, containment-only, and combined queries
  asserted on the exact generated SQL and parameter array; the `bundle_id` scope always present;
  an empty query string → `ValidationError('search.emptyQuery')`; whitespace-only input; a term
  list over the limit; zero results (empty connection, null cursors); pagination past the end; and
  a snippet-highlighting boundary where the match is at position 0 and at the end of the body.
- No test contains an interpolated value inside a SQL string.
- `npx tsc --noEmit` exits 0.

---

### m13 — Collaboration module and the Yjs websocket relay

**Build.** `src/modules/collab/collab-module.ts` — room lifecycle keyed by concept global id:
`joinRoom`, `leaveRoom`, `listPresence`, and `persistSnapshot` delegating to the document module's
interface (injected, never imported directly). Presence entries carry `actorId`, `displayName`,
`color`, `lastSeenAt` from the injected `Clock`; entries older than the idle threshold are evicted.
`src/server/collab-server.ts` — a standalone Node entry point (`npm run collab`) built on `ws`
that accepts a connection, authorises the room, relays binary `y-protocols` sync and awareness
messages to every other peer in the room, and debounces snapshot persistence. The transport is
injected as a `WebSocketServerFactory` so tests drive it with an in-memory fake. Plus the SDL
fragment (`presence(conceptId)` query, `PresenceEntry` type) and the `ModuleDescriptor`.

**Files.** `src/modules/collab/collab-module.ts`, `src/modules/collab/presence.ts`,
`src/modules/collab/collab-schema.graphql`, `src/modules/collab/collab-schema.ts`,
`src/modules/collab/index.ts`, `src/server/collab-server.ts`, `tests/collab-presence.test.ts`,
`tests/collab-module.test.ts`, `tests/collab-server.test.ts`.

**Depends on.** m5, m11

**Acceptance.**
- Unit tests in `tests/collab-presence.test.ts`, `tests/collab-module.test.ts` and
  `tests/collab-server.test.ts` pass and cover: first join creating a room; second join joining the
  existing room; last leave disposing it; idle eviction at exactly the threshold and one
  millisecond past it (fake clock); a binary message from peer A relayed to B and C but not back to
  A; an unauthorised room → `ForbiddenError('collab.roomForbidden')`; a malformed frame discarded
  without killing the room; and debounced snapshot persistence firing once for a burst of updates.
- No test opens a real socket; `ws` is replaced by an injected in-memory fake.
- `npx tsc --noEmit` exits 0.

---

### m14 — Git-synchronisation worker: export to OKF Markdown

**Build.** `src/modules/git-sync/exporter.ts` — pure: given a bundle's concepts, their frontmatter
and their rendered bodies, produce the complete `Array<{ path, contents }>` OKF file set —
directory layout mirroring the hierarchy, `index.md` for any concept with children,
`<slug>.md` otherwise, frontmatter serialised via `m8`, and relative cross-links rewritten from
concept ids to relative file paths. `git-sync-module.ts` — the worker: opens a
`repeatable read`, `readOnly` transaction for a consistent snapshot, writes the file set through
the `FsPort` (confined to `config.gitSync.repoPath`), stages, commits and pushes through the
`GitPort`, records a run row, and on failure records the failure and rethrows a typed error rather
than swallowing it. A no-change run commits nothing and is recorded as `skipped`. Scheduling is
driven by an injected timer, never `setInterval` at module scope. Plus the SDL fragment
(`gitSyncRuns` query, `triggerGitSync` mutation) and the `ModuleDescriptor`.

**Files.** `src/modules/git-sync/exporter.ts`, `src/modules/git-sync/link-rewriter.ts`,
`src/modules/git-sync/git-sync-module.ts`, `src/modules/git-sync/git-sync-schema.graphql`,
`src/modules/git-sync/git-sync-schema.ts`, `src/modules/git-sync/index.ts`,
`tests/git-sync-exporter.test.ts`, `tests/git-sync-link-rewriter.test.ts`,
`tests/git-sync-module.test.ts`.

**Depends on.** m5, m8, m10, m11

**Acceptance.**
- Unit tests in `tests/git-sync-exporter.test.ts`, `tests/git-sync-link-rewriter.test.ts` and
  `tests/git-sync-module.test.ts` pass and cover: an empty bundle (zero files); a flat bundle; a
  nested bundle producing `index.md` at each branch; a leaf producing `<slug>.md`; absolute and
  relative link rewriting including a link to a missing concept (left intact and reported); a
  no-change run recorded as `skipped` with no commit; a `GitPort` push failure surfacing a typed
  error and a recorded failure row; and a path traversal attempt rejected by the `FsPort`.
- The snapshot transaction is asserted to be opened with `repeatable read` and `readOnly: true`.
- No real `git` process runs; the fake `GitPort` records argv arrays.
- `npx tsc --noEmit` exits 0.

---

### m15 — Orchestrator, module registry, GraphQL schema assembly and the API route

**Build.** `src/server/registry.ts` — `ModuleDescriptor`, `ModuleRegistry`, `DEFAULT_REGISTRY`
listing all eight descriptors, and `resolveWiringOrder(registry)` doing a topological sort that
throws `ConfigError('registry.cycle')` on a cycle and `ConfigError('registry.unknownDependency')`
on a dangling name. `src/server/schema.ts` — collects each module's `SchemaContribution`, merges
the SDL fragments with the root document, builds the executable schema once, and implements the
`Node` field by decoding the global id and dispatching to the owning module (unknown type →
`NotFoundError`). `src/server/graphql-errors.ts` — `AppError` → GraphQL `extensions { code,
details }`; an unknown throwable becomes `InternalError` with the cause logged and never leaked.
`src/server/orchestrator.ts` — `createOrchestrator(config, ports, registry?)` implementing the
Architecture's published interface exactly: constructs adapters and modules, memoizes `schema()`,
`createRequestContext`, `execute` (never throws — always returns a GraphQL result), `start()`
(migration **check**, or apply only when `config.db.autoMigrate`, then schema warm-up, collab hook
and Git-sync schedule) and `stop()` (drain, close pool, clear timers). It holds no domain logic.
`src/routes/api/graphql.ts` — the TanStack Start server route: method check, body parse, request-id
assignment, actor resolution, delegation, JSON response.

**Files.** `src/server/registry.ts`, `src/server/schema.ts`, `src/server/graphql-errors.ts`,
`src/server/orchestrator.ts`, `src/routes/api/graphql.ts`, `schema.graphql`,
`tests/registry.test.ts`, `tests/server-schema.test.ts`, `tests/graphql-errors.test.ts`,
`tests/orchestrator.test.ts`, `tests/graphql-route.test.ts`.

**Depends on.** m4, m6, m9, m10, m11, m12, m13, m14

**Acceptance.**
- Unit tests in the five listed `tests/*.test.ts` files pass and cover: topological wiring order;
  a two-module cycle → `ConfigError('registry.cycle')`; a dangling dependency; schema built once
  and memoized; `node(id:)` dispatch for every entry in `NODE_TYPES` plus an unknown type; each
  `AppError` subclass mapped to its `extensions.code`; a non-`AppError` throwable mapped to
  `InternalError` with no message leakage; `start()` failing on pending migrations in production
  and applying them when `autoMigrate` is true; `stop()` closing the pool and clearing timers even
  after a start failure; and the route returning 405 for GET, 400 for a malformed body, and 200
  with `errors` (not a thrown exception) for an invalid query.
- The route handler is invoked directly with a `Request` object; no HTTP server is started.
- `npm run schema:emit` exits 0 and writes a `schema.graphql` that `graphql`'s `buildSchema`
  accepts (asserted in `tests/server-schema.test.ts`).
- `npx tsc --noEmit` exits 0.

---

### m16 — Astryx UI shell: theme tokens, dark mode, application frame

**Build.** `src/styles/tokens.stylex.ts` — StyleX `defineVars` for the workspace's own spacing,
radius, elevation and semantic colour tokens, layered on the `@astryxdesign/theme-neutral`
cascade so dark mode is a token override, not a second stylesheet.
`src/styles/theme.ts` — `resolveTheme(preference, systemPrefersDark)` returning `'light' | 'dark'`
for `'light' | 'dark' | 'system'`, and `applyTheme(root, theme)` stamping `data-theme`.
Components composed from Astryx primitives (`Stack`, `Card`, `Text`, `Item`, `List`, `Icon`,
`Badge`, `Field`): `AppFrame.tsx` (three-pane frame: sidebar rail, main column, inspector),
`SidebarChrome.tsx` (header, filter field, scroll region, footer slot), `DocumentHeader.tsx`
(title, trust `Badge`, lifecycle, breadcrumb from the ancestor path), `ToolbarShell.tsx`,
`ThemeToggle.tsx`. `src/routes/__root.tsx` is updated to mount the theme provider and `AppFrame`.

**Files.** `src/styles/tokens.stylex.ts`, `src/styles/theme.ts`,
`src/components/shell/AppFrame.tsx`, `src/components/shell/SidebarChrome.tsx`,
`src/components/shell/DocumentHeader.tsx`, `src/components/shell/ToolbarShell.tsx`,
`src/components/shell/ThemeToggle.tsx`, `src/components/shell/index.ts`,
`src/routes/__root.tsx` (modified), `tests/theme.test.ts`, `tests/shell-app-frame.test.tsx`,
`tests/shell-document-header.test.tsx`, `tests/shell-theme-toggle.test.tsx`.

**Depends on.** m1, m2

**Acceptance.**
- Unit tests in `tests/theme.test.ts`, `tests/shell-app-frame.test.tsx`,
  `tests/shell-document-header.test.tsx` and `tests/shell-theme-toggle.test.tsx` pass and cover:
  `resolveTheme` for all three preferences against both system values; `applyTheme` stamping and
  restamping `data-theme`; `AppFrame` rendering all three panes and collapsing the inspector when
  the slot is absent; `DocumentHeader` rendering each `TrustLevel` badge and each `Lifecycle`
  value; an empty breadcrumb; a 6-level breadcrumb; and `ThemeToggle` cycling
  light → dark → system via `user-event` with the accessible name asserted at each step.
- `npm run build` exits 0 (proves StyleX compiles).
- `npx tsc --noEmit` exits 0.

---

### m17 — Relay client runtime: environment, network layer, optimistic updates

**Build.** `relay.config.js` pointing the compiler at `src/`, `schema.graphql`, and
`src/__generated__`. `src/relay/fetch.ts` — `createFetchFn({ endpoint, fetchImpl, onError })`
posting operation text and variables to `/api/graphql`, mapping a non-2xx response to a typed
`NetworkError`, a malformed body to `ValidationError('relay.malformedResponse')`, and a GraphQL
`errors` array carrying `extensions.code` into an `AppError`-shaped rejection so
`ConflictError('concept.staleVersion')` reaches the UI intact. `src/relay/environment.ts` —
`createRelayEnvironment(deps)` building `Environment` + `RecordSource` + `Store` with a bounded
GC scheduler; server and browser instances are created through the same factory so no module-level
singleton leaks between tests. `src/relay/optimistic.ts` — `withOptimistic(config)` wrapping
`commitMutation` with an `optimisticUpdater`, connection edge insert/remove helpers built on
`ConnectionHandler`, and automatic rollback assertions on error.

**Files.** `relay.config.js`, `src/relay/fetch.ts`, `src/relay/environment.ts`,
`src/relay/optimistic.ts`, `tests/relay-fetch.test.ts`, `tests/relay-environment.test.ts`,
`tests/relay-optimistic.test.ts`.

**Depends on.** m2, m7

**Acceptance.**
- Unit tests in `tests/relay-fetch.test.ts`, `tests/relay-environment.test.ts` and
  `tests/relay-optimistic.test.ts` pass and cover: a successful response; HTTP 500; HTTP 404; a
  non-JSON body; a GraphQL `errors` payload with `extensions.code` preserved; a request carrying
  variables asserted on the injected `fetchImpl` call; two `createRelayEnvironment` calls producing
  independent stores; an optimistic edge insert visible before the response; and rollback restoring
  the prior store state after a rejected mutation.
- `fetch` is injected, never global; no test performs a network call.
- `npx tsc --noEmit` exits 0.

---

### m18 — Lexical block editor: custom nodes, markdown shortcuts, serialization

**Build.** `src/editor/nodes/code-block-node.tsx` — a `DecoratorNode` with an explicitly
initialised `language` property in its constructor (required for `@lexical/yjs` serialisation),
`createDOM`/`updateDOM`, `exportJSON`/`importJSON`, and `exportDOM`.
`src/editor/nodes/divider-node.tsx` — a `DecoratorNode` rendering a themed rule.
`src/editor/config/editor-config.ts` — the node registry (paragraph, `HeadingNode`, `QuoteNode`,
`ListNode`/`ListItemNode`, `LinkNode`, plus the two custom nodes), the StyleX-token-driven theme
map, and an `onError` that throws rather than swallowing.
`src/editor/transforms/markdown-shortcuts.ts` — `registerMarkdownShortcuts(editor)` using
`editor.registerNodeTransform` for `# `…`###### `, `- `/`* `, `1. `, `> `, ``` and `---`, each
returning an unregister function. `src/editor/markdown/transformers.ts` +
`src/editor/markdown/serialize.ts` — the `@lexical/markdown` transformer set extended for the
custom nodes, `editorStateToMarkdown` and `markdownToEditorState`.
`src/editor/BlockEditor.tsx` and `src/editor/Toolbar.tsx` — the composed editor and its
Astryx-shelled toolbar.

**Files.** `src/editor/nodes/code-block-node.tsx`, `src/editor/nodes/divider-node.tsx`,
`src/editor/config/editor-config.ts`, `src/editor/transforms/markdown-shortcuts.ts`,
`src/editor/markdown/transformers.ts`, `src/editor/markdown/serialize.ts`,
`src/editor/BlockEditor.tsx`, `src/editor/Toolbar.tsx`, `src/editor/index.ts`,
`tests/editor-nodes.test.tsx`, `tests/editor-markdown-shortcuts.test.ts`,
`tests/editor-serialize.test.ts`, `tests/editor-block-editor.test.tsx`, `tests/editor-toolbar.test.tsx`.

**Depends on.** m2, m8, m16

**Acceptance.**
- Unit tests in the five listed test files pass and cover: `CodeBlockNode` clone/`exportJSON`/
  `importJSON` round-trip and the constructor-initialised `language` property (asserted, because an
  uninitialised property silently breaks Yjs sync); `DividerNode` DOM output; every markdown
  shortcut arm (`#` through `######`, unordered list, ordered list, quote, code fence, divider) plus
  a near-miss string that must **not** transform; markdown → editor state → markdown round-trip for
  a document containing every block type; an empty document; a document of only whitespace;
  malformed markdown; toolbar button state reflecting the current selection; and the unregister
  function actually detaching the transform.
- Tests use a headless Lexical editor created per test — no shared editor instance.
- `npx tsc --noEmit` exits 0.

---

### m19 — Yjs collaboration client: provider, awareness, presence UI

**Build.** `src/collab/provider.ts` — `createCollabProvider({ room, wsUrl, doc, WebSocketPolyfill,
onStatus })` wrapping `y-websocket` with the socket constructor injected so tests supply a fake;
exposes `connect`, `disconnect`, `status`, and reconnect backoff that is capped and driven by an
injected timer. `src/collab/awareness.ts` — `setLocalPresence`, `subscribePresence`, a stable
`colorForActor(actorId)` derived deterministically from the id, and eviction of stale peers.
`src/collab/CollaborationPluginBridge.tsx` — mounts `@lexical/react`'s collaboration plugin against
the provider and the editor from m18, with the initial-editor-state seeding rule (only the first
peer in an empty room seeds). `src/collab/PresenceBar.tsx` — Astryx-composed avatar stack with
overflow count and an accessible label per peer.

**Files.** `src/collab/provider.ts`, `src/collab/awareness.ts`,
`src/collab/CollaborationPluginBridge.tsx`, `src/collab/PresenceBar.tsx`, `src/collab/index.ts`,
`tests/collab-client-provider.test.ts`, `tests/collab-client-awareness.test.ts`,
`tests/collab-presence-bar.test.tsx`, `tests/collab-plugin-bridge.test.tsx`.

**Depends on.** m2, m16, m18

**Acceptance.**
- Unit tests in the four listed test files pass and cover: provider connect/disconnect status
  transitions; reconnect backoff growing and capping (fake timers, asserted delays); a socket error
  surfaced through `onStatus` rather than thrown; `colorForActor` deterministic for the same id and
  distinct across ids; presence add/update/remove; stale-peer eviction at the threshold;
  `PresenceBar` with 0, 1, 5 and 12 peers (overflow count asserted); and the bridge seeding the
  editor only when the room is empty.
- No real WebSocket is constructed — the polyfill is injected in every test.
- `npx tsc --noEmit` exits 0.

---

### m20 — OKF frontmatter editing panel

**Build.** `src/features/frontmatter/form-state.ts` — a pure reducer over the frontmatter form:
`init(frontmatter)`, `setField`, `addTag`, `removeTag`, `setTrust`, `setLifecycle`,
`validate(state)` returning field-level issues by reusing `m8`'s zod schema, and `toFrontmatter`
which refuses to produce a value while issues exist. `src/features/frontmatter/fields.ts` — the
declarative field descriptors (label, help text, control kind, options) driving the render.
`src/features/frontmatter/FrontmatterPanel.tsx` — the Astryx `Field`-composed panel: trust and
lifecycle selects, provenance group, tag editor, dirty indicator, save/revert, and inline
per-field errors wired to `aria-describedby`.

**Files.** `src/features/frontmatter/form-state.ts`, `src/features/frontmatter/fields.ts`,
`src/features/frontmatter/FrontmatterPanel.tsx`, `src/features/frontmatter/index.ts`,
`tests/frontmatter-form-state.test.ts`, `tests/frontmatter-fields.test.ts`,
`tests/frontmatter-panel.test.tsx`.

**Depends on.** m2, m8, m16

**Acceptance.**
- Unit tests in `tests/frontmatter-form-state.test.ts`, `tests/frontmatter-fields.test.ts` and
  `tests/frontmatter-panel.test.tsx` pass and cover: `init` from a complete and from a minimal
  frontmatter; every reducer action asserted on the resulting state; duplicate tag rejected;
  removing the last tag; each `TrustLevel` and `Lifecycle` selectable; `validate` producing an
  issue per invalid field; `toFrontmatter` refusing while invalid; dirty-state transitions; revert
  restoring the initial state; and the panel rendering an inline error linked by
  `aria-describedby`, driven with `user-event`.
- `npx tsc --noEmit` exits 0.

---

### m21 — Workspace routes: paginated sidebar tree, concept page, search

**Build.** The application surface, and the module that generates the Relay artifacts.
`src/features/sidebar/use-tree-pagination.ts` — a hook over the `children` Connection: expand,
collapse, `loadMore` honouring `pageInfo.hasNextPage`, deduplicating in-flight page requests,
and surfacing an error state without collapsing already-loaded nodes.
`src/features/sidebar/SidebarTree.tsx` — the lazily-paginated tree: keyboard navigation, expand
markers, a load-more affordance per level, and empty/loading/error states.
`src/features/search/SearchPanel.tsx` — the search input (debounced by an injected timer), result
list with highlighted snippets, and empty/no-results states.
Routes: `src/routes/index.tsx` (rewritten as the bundle picker),
`src/routes/bundles.$bundleId.tsx`, `src/routes/concepts.$conceptId.tsx` (composes
`DocumentHeader` + `BlockEditor` + `CollaborationPluginBridge` + `PresenceBar` +
`FrontmatterPanel`), and `src/routes/search.tsx`. Run `npm run schema:emit && npm run relay` and
commit the artifacts under `src/__generated__/`.

**Files.** `src/features/sidebar/use-tree-pagination.ts`, `src/features/sidebar/SidebarTree.tsx`,
`src/features/sidebar/index.ts`, `src/features/search/SearchPanel.tsx`,
`src/features/search/index.ts`, `src/routes/index.tsx` (modified),
`src/routes/bundles.$bundleId.tsx`, `src/routes/concepts.$conceptId.tsx`, `src/routes/search.tsx`,
`src/__generated__/` (Relay compiler output), `tests/use-tree-pagination.test.ts`,
`tests/sidebar-tree.test.tsx`, `tests/search-panel.test.tsx`, `tests/route-concept.test.tsx`,
`tests/route-bundles.test.tsx`.

**Depends on.** m15, m16, m17, m18, m19, m20

**Acceptance.**
- Unit tests in the five listed test files pass and cover: expand/collapse; `loadMore` appending a
  page and stopping at `hasNextPage === false`; a duplicate concurrent `loadMore` issuing one
  request; a page-fetch error preserving loaded nodes; a bundle with zero concepts; a node with
  exactly one child; keyboard arrow navigation; debounced search issuing one query per burst; a
  no-results state; and the concept route rendering header, editor, presence bar and frontmatter
  panel together against a Relay mock environment.
- All Relay data is served by `relay-test-utils`' mock environment — no network.
- `npm run relay` exits 0 and `npx tsc --noEmit` exits 0 with the generated artifacts present.
- `npm test` — the **entire** suite — exits 0.

---

## Machine-Readable Plan

```json implementation-plan
{
  "planVersion": 1,
  "generatedBy": "DLO Design Analyst",
  "modules": [
    {
      "moduleId": "m1",
      "title": "Project scaffold: TanStack Start + React 19 + StyleX/Astryx",
      "stackTarget": "fullstack",
      "prompt": "Scaffold a TanStack Start app (React 19, strict TypeScript, Vite). Create package.json declaring EVERY dependency the project will ever need: @tanstack/react-start, @tanstack/react-router, react@^19, react-dom@^19, @astryxdesign/core, @astryxdesign/theme-neutral, @astryxdesign/build, @astryxdesign/cli, @stylexjs/stylex, lexical + @lexical/react|markdown|yjs|rich-text|list|code|link|utils|selection, yjs, y-websocket, y-protocols, react-relay, relay-runtime, graphql, pg, yaml, zod, ws; dev: typescript, vite, relay-compiler, babel-plugin-relay, vitest, jsdom, @testing-library/react, @testing-library/user-event, @testing-library/jest-dom, @types/*. Scripts: dev, build, start, typecheck, test, relay, schema:emit, migrate, collab. Add app.config.ts wiring the StyleX plugin from @astryxdesign/build, a tsconfig.json with strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noUnusedLocals, noUnusedParameters, noImplicitReturns, noFallthroughCasesInSwitch, useUnknownInCatchVariables, and the entry files src/router.tsx, src/client.tsx, src/ssr.tsx, src/routes/__root.tsx, src/routes/index.tsx. Real content only: no TODOs, no placeholder components.",
      "dependsOn": [],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "package.json",
        "app.config.ts",
        "tsconfig.json",
        ".gitignore",
        ".env.example",
        "README.md",
        "src/router.tsx",
        "src/client.tsx",
        "src/ssr.tsx",
        "src/routes/__root.tsx",
        "src/routes/index.tsx",
        "src/styles/global.css"
      ],
      "acceptance": [
        "npm install completes without error",
        "npx tsc --noEmit exits 0",
        "npm run build exits 0",
        "package.json declares every runtime and dev dependency listed in the prompt, so no later module edits dependencies",
        "no source file contains TODO, FIXME, or an empty function body"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "production build succeeds", "kind": "command",
         "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m2",
      "title": "Test harness: Vitest + jsdom + Testing Library",
      "stackTarget": "fullstack",
      "prompt": "Install and configure the test harness. Create vitest.config.ts (environment jsdom, globals true, setupFiles ./vitest.setup.ts, include tests/**/*.test.{ts,tsx}, v8 coverage) and NEVER set passWithNoTests. Create vitest.setup.ts importing @testing-library/jest-dom/vitest, calling cleanup in afterEach, failing the run on unexpected console.error, and stubbing matchMedia and ResizeObserver for jsdom. Create tests/helpers/test-utils.tsx exporting renderWithShell, a deterministic fixedClock and flushMicrotasks. Set the package.json test script to `vitest run` and add test:watch and test:coverage. Write tests/harness.test.ts asserting jsdom is active, jest-dom matchers are registered, fake timers advance deterministically, and the loaded Vitest config does not enable passWithNoTests. Every later module depends on this harness.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": [
        "vitest.config.ts",
        "vitest.setup.ts",
        "tests/helpers/test-utils.tsx",
        "tests/harness.test.ts",
        "package.json"
      ],
      "acceptance": [
        "unit tests in tests/harness.test.ts pass and cover jsdom availability, jest-dom matcher registration, fake-timer determinism, and the absence of passWithNoTests in the Vitest config",
        "npm test runs non-interactively, exits 0, and reports at least one passing test",
        "grep -R passWithNoTests over the repository finds no occurrence in configuration or scripts",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "harness tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/harness.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m3",
      "title": "Core domain: branded ids, typed errors, request context",
      "stackTarget": "backend",
      "prompt": "Build the pure domain core. src/core/ids.ts: branded BundleId, ConceptId, ActorId, RevisionId with constructors that reject non-UUID input with ValidationError. src/core/errors.ts: abstract AppError with readonly code, httpStatus, details, cause, plus ValidationError, NotFoundError, ConflictError, ConfigError, MigrationError, ForbiddenError, InternalError, and the helpers isAppError and toErrorExtensions. src/core/types.ts: TrustLevel (unverified | machine-confirmed | human-reviewed), Lifecycle (draft | active | deprecated | archived), Bundle, Concept, Provenance, plus type guards. src/core/context.ts: Actor, RequestContext, createRequestContext. No I/O anywhere. Write exhaustive unit tests in tests/core-ids.test.ts, tests/core-errors.test.ts, tests/core-types.test.ts and tests/core-context.test.ts covering happy paths on real values, every guard branch, empty and malformed input, and each error subclass code, httpStatus and cause preservation. Assert the typed error, never a bare throw.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": [
        "src/core/ids.ts",
        "src/core/errors.ts",
        "src/core/types.ts",
        "src/core/context.ts",
        "tests/core-ids.test.ts",
        "tests/core-errors.test.ts",
        "tests/core-types.test.ts",
        "tests/core-context.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/core-ids.test.ts, tests/core-errors.test.ts, tests/core-types.test.ts and tests/core-context.test.ts pass and cover id branding, rejection of empty/malformed/wrong-version UUIDs, every AppError subclass code and httpStatus, cause preservation, isAppError against non-errors, and every TrustLevel and Lifecycle guard arm",
        "npx tsc --noEmit exits 0",
        "no test asserts merely that a function threw; each asserts the error class and its code"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "core domain tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/core-ids.test.ts", "tests/core-errors.test.ts", "tests/core-types.test.ts", "tests/core-context.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m4",
      "title": "Configuration loader and structured logger",
      "stackTarget": "backend",
      "prompt": "Build src/config/config.ts exporting AppConfig and loadConfig(env) — a PURE function over an injected environment record, never process.env — parsed with zod. Cover env, instanceId, port, db.url, db.poolMax (minimum 2), db.ssl, db.autoMigrate (permitted only when env is development), collab.wsUrl, collab.port, gitSync.repoPath, gitSync.branch, gitSync.intervalMs, logLevel. Every failure throws ConfigError with a specific code such as config.invalidDbUrl or config.autoMigrateForbidden and the offending keys. Build src/lib/logger.ts exporting createLogger({level, sink, clock}) that emits one JSON object per line, filters by level, supports child(bindings), and redacts password, token, apiKey, authorization and credentials embedded in URLs. Write unit tests in tests/config.test.ts and tests/logger.test.ts covering a valid env, each missing required key, poolMax at 1 and 2, autoMigrate in production, every level boundary, child binding inheritance, and each redaction case. Assert ConfigError and its code.",
      "dependsOn": ["m2", "m3"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": [
        "src/config/config.ts",
        "src/lib/logger.ts",
        "tests/config.test.ts",
        "tests/logger.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/config.test.ts and tests/logger.test.ts pass and cover a complete valid environment, each missing required key, poolMax boundary values 1 and 2, autoMigrate rejected in production, every log-level boundary, child binding inheritance, and redaction of each secret key and of URL credentials",
        "loadConfig never reads process.env directly (asserted by test with an injected env record)",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "config and logger tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/config.test.ts", "tests/logger.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m5",
      "title": "Ports, adapters, and the in-memory test fakes",
      "stackTarget": "backend",
      "prompt": "Define src/server/ports.ts with the Db interface from Database.md (query with $n placeholders only; withTransaction supporting isolation, readOnly, and SAVEPOINT-based nesting) plus Clock, IdGenerator, Logger, FsPort, GitPort and the aggregate Ports. Implement src/server/adapters/pg-db.ts as the ONLY file importing pg: one Pool with the documented timeouts, per-connection session settings (statement_timeout 10000, idle_in_transaction_session_timeout 15000, lock_timeout 3000, search_path public) applied on connect, and a server_version_num >= 170000 guard throwing ConfigError('db.unsupportedVersion'). Implement node-clock, random-ids, node-fs (confined to a root; reject .. escapes with ValidationError('fs.pathEscape')) and node-git (execFile with an argv array, never a shell string). Also write tests/helpers/fake-ports.ts exporting createFakeDb, createFakeClock, createSeqIds, createMemoryFs, createFakeGit and createFakePorts — every later module's tests use these. Write unit tests in tests/pg-db.test.ts (vi.mock('pg')), tests/adapters-fs-git.test.ts and tests/adapters-clock-ids.test.ts covering commit, rollback, nested savepoint, client release on both paths, the version guard, path escapes, and argv assertions. Never spawn a real process or open a real connection.",
      "dependsOn": ["m2", "m3", "m4"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/server/ports.ts",
        "src/server/adapters/pg-db.ts",
        "src/server/adapters/node-clock.ts",
        "src/server/adapters/random-ids.ts",
        "src/server/adapters/node-fs.ts",
        "src/server/adapters/node-git.ts",
        "tests/helpers/fake-ports.ts",
        "tests/pg-db.test.ts",
        "tests/adapters-fs-git.test.ts",
        "tests/adapters-clock-ids.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/pg-db.test.ts, tests/adapters-fs-git.test.ts and tests/adapters-clock-ids.test.ts pass and cover transaction commit, rollback on rejection, nested savepoint, client release on both paths, the PostgreSQL 17 version guard, session settings issued on connect, FsPath escape rejection, and GitPort argv-array invocation with non-zero exit mapped to a typed error",
        "pg is fully mocked with vi.mock('pg'); no test opens a socket or spawns a process",
        "tests/helpers/fake-ports.ts exports createFakeDb, createFakeClock, createSeqIds, createMemoryFs, createFakeGit and createFakePorts",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "ports and adapters tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/pg-db.test.ts", "tests/adapters-fs-git.test.ts", "tests/adapters-clock-ids.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m6",
      "title": "SQL migrations and the migration runner",
      "stackTarget": "backend",
      "prompt": "Write the seven forward-only migrations exactly as Database.md splits them: 001_extensions_enums_functions.sql (pg_trgm, btree_gin, unaccent, the okf_english text-search configuration, enums, schema_migrations), 002_identity_and_workspaces.sql, 003_bundles_and_concepts.sql (COLLATE \"C\" on slug/path/sort_key, version integer NOT NULL DEFAULT 1), 004_concept_documents_and_crdt.sql (JSONB block payload, bytea Yjs state, jsonb_typeof CHECK constraints), 005_frontmatter_links_revisions.sql, 006_search_indexes.sql (GIN jsonb_path_ops, btree_gin composite, trigram indexes), 007_collaboration_and_git_sync.sql, plus sql/seed/001_dev_seed.sql. Implement src/server/migrate.ts exporting the pure planMigrations(files, applied) and runMigrations(db, files, opts): take pg_advisory_lock(4479823001), apply each file in its own transaction in strict numeric order, record version/name/checksum/applied_at/duration_ms, throw MigrationError('migration.gap') on a gap and MigrationError('migration.checksumMismatch') on an edited file, and support a check-only mode returning the pending list. No down-migrations. Write unit tests in tests/migrate-plan.test.ts, tests/migrate-run.test.ts and tests/migrations-sql.test.ts against the fake Db from tests/helpers/fake-ports.ts — never a real database.",
      "dependsOn": ["m5"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "sql/migrations/001_extensions_enums_functions.sql",
        "sql/migrations/002_identity_and_workspaces.sql",
        "sql/migrations/003_bundles_and_concepts.sql",
        "sql/migrations/004_concept_documents_and_crdt.sql",
        "sql/migrations/005_frontmatter_links_revisions.sql",
        "sql/migrations/006_search_indexes.sql",
        "sql/migrations/007_collaboration_and_git_sync.sql",
        "sql/seed/001_dev_seed.sql",
        "src/server/migrate.ts",
        "tests/migrate-plan.test.ts",
        "tests/migrate-run.test.ts",
        "tests/migrations-sql.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/migrate-plan.test.ts, tests/migrate-run.test.ts and tests/migrations-sql.test.ts pass and cover an empty applied set, an all-applied no-op, a numeric gap raising MigrationError('migration.gap'), a checksum mismatch raising MigrationError('migration.checksumMismatch'), advisory lock acquired before and released after, one transaction per file, check-only mode returning pending versions without executing DDL, and a static scan asserting the seven migration files exist, are contiguously numbered, and contain no DROP TABLE",
        "the runner is exercised only against the fake Db; no real PostgreSQL connection is opened",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "migration tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/migrate-plan.test.ts", "tests/migrate-run.test.ts", "tests/migrations-sql.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m7",
      "title": "Relay conventions: global object identification and connections",
      "stackTarget": "fullstack",
      "prompt": "Implement the Relay convention layer as pure code shared by server and client. src/core/global-id.ts: NODE_TYPES tuple, toGlobalId(typeName, localId) producing base64 of 'TypeName:uuid', and fromGlobalId throwing ValidationError('globalId.malformed') on non-base64, a missing separator, empty parts, or an unknown type. src/core/connection.ts: encodeCursor/decodeCursor (opaque base64 over sortKey and id), validateConnectionArgs rejecting negative first/last, first above the 200 limit, and first together with last, and buildConnection(rows, args) returning edges with node and cursor plus pageInfo (hasNextPage, hasPreviousPage, startCursor, endCursor) and totalCount, implementing forward and backward pagination. Add src/graphql/schema.root.graphql (Node interface, PageInfo, OKF enums, Query, Mutation, scalars) and scripts/emit-schema.ts concatenating the root document with every src/modules/**/*.graphql fragment into schema.graphql. Write unit tests in tests/global-id.test.ts, tests/connection.test.ts and tests/emit-schema.test.ts covering round-trips for every NODE_TYPES entry, each malformed-id case, empty result sets, exactly-first and first-plus-one, backward pagination, every invalid argument combination, and duplicate-type detection during emission.",
      "dependsOn": ["m2", "m3"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/core/global-id.ts",
        "src/core/connection.ts",
        "src/graphql/schema.root.graphql",
        "scripts/emit-schema.ts",
        "tests/global-id.test.ts",
        "tests/connection.test.ts",
        "tests/emit-schema.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/global-id.test.ts, tests/connection.test.ts and tests/emit-schema.test.ts pass and cover global-id round-trip for every NODE_TYPES entry, malformed base64, missing separator, empty type, unknown type, an empty row set with null cursors, exactly-first rows, first-plus-one setting hasNextPage, backward last/before pagination, negative and over-limit arguments, first combined with last, and duplicate-type detection during schema emission",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "relay convention tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/global-id.test.ts", "tests/connection.test.ts", "tests/emit-schema.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m8",
      "title": "OKF core: YAML frontmatter and Markdown document handling",
      "stackTarget": "fullstack",
      "prompt": "Implement the isomorphic OKF core used by both the Git-sync worker and the browser panel. src/core/okf/schema.ts: a zod schema for OKF frontmatter — id, title, trust (unverified | machine-confirmed | human-reviewed), lifecycle, provenance {source, author, retrievedAt, checksum?}, tags, links, updatedAt — preserving unknown keys instead of stripping them. src/core/okf/frontmatter.ts: parseFrontmatter(raw) using the yaml package in strict mode so duplicate keys raise ValidationError('frontmatter.duplicateKey'), returning a typed value or throwing ValidationError with per-field issues; serializeFrontmatter(fm) with stable key ordering and byte-identical round-tripping. src/core/okf/markdown-document.ts: splitDocument(text) separating the --- delimited frontmatter from the body (handling no frontmatter, an unterminated delimiter, CRLF, a leading BOM, an empty body), joinDocument, and conceptFileName returning index.md for a concept with children and <slug>.md otherwise. Write unit tests in tests/okf-schema.test.ts, tests/okf-frontmatter.test.ts and tests/okf-markdown-document.test.ts covering every valid and invalid enum value, missing required fields, unknown-key preservation, duplicate keys, malformed YAML, and each document-splitting edge case plus a serialize-parse-serialize round trip.",
      "dependsOn": ["m2", "m3"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/core/okf/schema.ts",
        "src/core/okf/frontmatter.ts",
        "src/core/okf/markdown-document.ts",
        "tests/okf-schema.test.ts",
        "tests/okf-frontmatter.test.ts",
        "tests/okf-markdown-document.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/okf-schema.test.ts, tests/okf-frontmatter.test.ts and tests/okf-markdown-document.test.ts pass and cover each valid trust and lifecycle value, an invalid value for each, a missing required field, unknown-key preservation, duplicate YAML keys raising ValidationError('frontmatter.duplicateKey'), malformed YAML, a document with no frontmatter, an unterminated delimiter, CRLF and BOM input, an empty body, conceptFileName for a leaf and for a parent, and a byte-identical serialize-parse-serialize round trip",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "OKF core tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/okf-schema.test.ts", "tests/okf-frontmatter.test.ts", "tests/okf-markdown-document.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m9",
      "title": "Bundles module: repository, service, schema contribution",
      "stackTarget": "backend",
      "prompt": "Build the bundles module. bundle-repository.ts uses ONLY parameterised SQL through the Db port: insert, findById, findBySlug, listConnection(args) delegating to buildConnection, update with WHERE id = $1 AND version = $2 raising ConflictError('bundle.staleVersion') when rowCount is 0, and softDelete. bundle-module.ts holds the domain logic: slug normalisation, unique-violation 23505 mapped to ConflictError('bundle.slugTaken'), NotFoundError('bundle.notFound'), timestamps from the injected Clock and ids from the injected IdGenerator. bundle-schema.graphql declares Bundle implements Node, BundleConnection, the bundles query and the createBundle, renameBundle and archiveBundle mutations; bundle-schema.ts is the resolver map encoding ids via toGlobalId. index.ts exports the ModuleDescriptor named bundles with no module dependencies. Import nothing from another feature module. Write unit tests in tests/bundles-repository.test.ts, tests/bundles-module.test.ts and tests/bundles-resolvers.test.ts against the fake Db and fake clock, covering happy paths on real returned records, an empty list, pagination past the end, unknown id, duplicate slug, stale version, and every resolver field.",
      "dependsOn": ["m5", "m6", "m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/modules/bundles/bundle-repository.ts",
        "src/modules/bundles/bundle-module.ts",
        "src/modules/bundles/bundle-schema.graphql",
        "src/modules/bundles/bundle-schema.ts",
        "src/modules/bundles/index.ts",
        "tests/bundles-repository.test.ts",
        "tests/bundles-module.test.ts",
        "tests/bundles-resolvers.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/bundles-repository.test.ts, tests/bundles-module.test.ts and tests/bundles-resolvers.test.ts pass and cover create, read, list and update happy paths asserted on real returned records, an empty list, pagination past the end, an unknown id raising NotFoundError('bundle.notFound'), a duplicate slug raising ConflictError('bundle.slugTaken'), a stale version raising ConflictError('bundle.staleVersion'), and every resolver field including global-id encoding",
        "tests assert that every SQL string uses only $n placeholders and contains no interpolated values",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "bundles module tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/bundles-repository.test.ts", "tests/bundles-module.test.ts", "tests/bundles-resolvers.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m10",
      "title": "Concepts and hierarchy module: tree, sort keys, paginated children",
      "stackTarget": "backend",
      "prompt": "Build the concept and hierarchy modules. concept-repository.ts and concept-module.ts provide CRUD over concepts with optimistic concurrency (ConflictError('concept.staleVersion')), findByPath, slug and title rules, and trust/lifecycle transitions. hierarchy/sort-key.ts is a PURE fractional-index allocator: keyBetween(a, b) producing byte-ordered keys safe under COLLATE \"C\", handling first child, append, insert between adjacent keys, and exhaustion by lengthening rather than colliding. hierarchy-repository.ts provides childrenConnection(parentId, args) for the lazily paginated sidebar, a recursive-CTE ancestor path query, and moveSubtree which first takes pg_advisory_xact_lock(hashtextextended($1::text,0)) on the bundle, reallocates the destination sort_key and rewrites descendant paths. hierarchy-module.ts rejects a move making a node its own ancestor with ValidationError('hierarchy.cycle'). Add the SDL fragments and ModuleDescriptors. Import no other feature module. Write unit tests in tests/concepts-repository.test.ts, tests/concepts-module.test.ts, tests/hierarchy-sort-key.test.ts, tests/hierarchy-repository.test.ts, tests/hierarchy-module.test.ts and tests/concepts-resolvers.test.ts against the fake Db, covering CRUD, stale versions, the sort-key ordering invariant over 100 insertions, children pagination with 0/1/exactly-first/first-plus-one, ancestor paths at depth 1 and 5, cycle rejection, and the advisory lock ordering.",
      "dependsOn": ["m5", "m6", "m7"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/modules/concepts/concept-repository.ts",
        "src/modules/concepts/concept-module.ts",
        "src/modules/concepts/concept-schema.graphql",
        "src/modules/concepts/concept-schema.ts",
        "src/modules/concepts/index.ts",
        "src/modules/hierarchy/sort-key.ts",
        "src/modules/hierarchy/hierarchy-repository.ts",
        "src/modules/hierarchy/hierarchy-module.ts",
        "src/modules/hierarchy/hierarchy-schema.graphql",
        "src/modules/hierarchy/hierarchy-schema.ts",
        "src/modules/hierarchy/index.ts",
        "tests/concepts-repository.test.ts",
        "tests/concepts-module.test.ts",
        "tests/hierarchy-sort-key.test.ts",
        "tests/hierarchy-repository.test.ts",
        "tests/hierarchy-module.test.ts",
        "tests/concepts-resolvers.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/concepts-repository.test.ts, tests/concepts-module.test.ts, tests/hierarchy-sort-key.test.ts, tests/hierarchy-repository.test.ts, tests/hierarchy-module.test.ts and tests/concepts-resolvers.test.ts pass and cover concept CRUD happy paths, stale-version conflict, unknown id, keyBetween for first/append/between/repeated subdivision with a strict byte-ordering invariant over 100 sequential insertions, children pagination with 0, 1, exactly-first and first-plus-one children, ancestor path resolution at depth 1 and depth 5, a move creating a cycle raising ValidationError('hierarchy.cycle'), and a move to a missing parent raising NotFoundError",
        "tests assert that moveSubtree issues the advisory lock before any write statement",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "concepts and hierarchy tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/concepts-repository.test.ts", "tests/concepts-module.test.ts", "tests/hierarchy-sort-key.test.ts", "tests/hierarchy-repository.test.ts", "tests/hierarchy-module.test.ts", "tests/concepts-resolvers.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m11",
      "title": "Documents module: Lexical block payload and Yjs CRDT persistence",
      "stackTarget": "backend",
      "prompt": "Build the documents module. crdt.ts holds pure Yjs helpers over Uint8Array: mergeUpdates, encodeStateVector, diffUpdate, applyUpdateToDoc and docToBlocks converting the Y.XmlFragment into the serialisable block payload. blocks.ts defines the zod block-payload schema (paragraph, heading, list, code, quote, divider) and block-to-markdown conversion. document-repository.ts reads and writes concept_documents — the JSONB block payload and the bytea Yjs state — and appendUpdate runs inside withTransaction, merging the current state and writing under a version guard that raises ConflictError('document.staleVersion'); it also exposes a jsonb_path_ops containment helper. document-module.ts validates every JSONB read-back with zod, raising ValidationError('document.corruptPayload') instead of coercing, writes a revision row per committed snapshot, and exposes renderMarkdown(conceptId). Add the SDL fragment (ConceptDocument, saveDocument, applyCrdtUpdate) and the ModuleDescriptor. Write unit tests in tests/documents-crdt.test.ts, tests/documents-blocks.test.ts, tests/documents-repository.test.ts and tests/documents-module.test.ts covering two in-process Y.Docs converging after concurrent inserts, empty updates, malformed binary input, a round trip for every block type, a corrupt JSONB payload, and stale-version conflict. No network, no real database.",
      "dependsOn": ["m5", "m6", "m7", "m8"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/modules/documents/crdt.ts",
        "src/modules/documents/blocks.ts",
        "src/modules/documents/document-repository.ts",
        "src/modules/documents/document-module.ts",
        "src/modules/documents/document-schema.graphql",
        "src/modules/documents/document-schema.ts",
        "src/modules/documents/index.ts",
        "tests/documents-crdt.test.ts",
        "tests/documents-blocks.test.ts",
        "tests/documents-repository.test.ts",
        "tests/documents-module.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/documents-crdt.test.ts, tests/documents-blocks.test.ts, tests/documents-repository.test.ts and tests/documents-module.test.ts pass and cover two in-process Y.Docs converging to identical state after concurrent inserts, merging an empty update list, an empty document, malformed binary input raising ValidationError, a block-payload round trip for paragraph, heading, list, code, quote and divider, a JSONB payload failing zod raising ValidationError('document.corruptPayload'), and a stale version raising ConflictError('document.staleVersion')",
        "no test opens a network connection or a real database; the fake Db and real in-process Yjs are used",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "documents module tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/documents-crdt.test.ts", "tests/documents-blocks.test.ts", "tests/documents-repository.test.ts", "tests/documents-module.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m12",
      "title": "Search module: JSONB containment, full text, trigram",
      "stackTarget": "backend",
      "prompt": "Build the search module. query-builder.ts is a PURE builder returning the SQL text and parameter array for a search request: an @> containment predicate against the jsonb_path_ops index for structured block queries, body_tsv @@ websearch_to_tsquery('okf_english', $n) for prose, and title ILIKE '%' || $n || '%' backed by pg_trgm for the fuzzy jump-to filter, always scoped by bundle_id so the btree_gin composite index is usable, with rank ordering and cursor pagination. It raises ValidationError('search.emptyQuery') for an empty or whitespace-only query and ValidationError('search.tooManyTerms') above the term limit. search-repository.ts executes the built statement through the Db port; search-module.ts maps rows to SearchHit with highlighted snippets and returns a SearchHitConnection. Add the SDL fragment and ModuleDescriptor. Write unit tests in tests/search-query-builder.test.ts, tests/search-repository.test.ts and tests/search-module.test.ts asserting the exact generated SQL and parameter arrays for text-only, containment-only and combined queries, the always-present bundle scope, empty and whitespace-only input, an over-limit term list, zero results, pagination past the end, and snippet highlighting at position 0 and at the end of the body.",
      "dependsOn": ["m5", "m6", "m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/modules/search/query-builder.ts",
        "src/modules/search/search-repository.ts",
        "src/modules/search/search-module.ts",
        "src/modules/search/search-schema.graphql",
        "src/modules/search/search-schema.ts",
        "src/modules/search/index.ts",
        "tests/search-query-builder.test.ts",
        "tests/search-repository.test.ts",
        "tests/search-module.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/search-query-builder.test.ts, tests/search-repository.test.ts and tests/search-module.test.ts pass and cover text-only, containment-only and combined queries asserted on the exact SQL and parameter array, the bundle_id scope always present, an empty query raising ValidationError('search.emptyQuery'), whitespace-only input, an over-limit term list raising ValidationError('search.tooManyTerms'), zero results producing an empty connection with null cursors, pagination past the end, and snippet highlighting at position 0 and at the end of the body",
        "no SQL string in source or tests contains an interpolated value",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "search module tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/search-query-builder.test.ts", "tests/search-repository.test.ts", "tests/search-module.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m13",
      "title": "Collaboration module and the Yjs websocket relay server",
      "stackTarget": "backend",
      "prompt": "Build the collaboration module and the standalone relay. collab-module.ts manages rooms keyed by concept global id: joinRoom, leaveRoom, listPresence and persistSnapshot delegating through an injected document-module interface (never a direct import of another feature module). presence.ts tracks actorId, displayName, colour and lastSeenAt from the injected Clock and evicts entries past the idle threshold. src/server/collab-server.ts is a standalone Node entry point (npm run collab) built on ws that authorises a room, relays binary y-protocols sync and awareness frames to every other peer but not back to the sender, and debounces snapshot persistence; the server factory and timer are INJECTED so tests substitute an in-memory fake. Add the SDL fragment (presence query, PresenceEntry) and the ModuleDescriptor. Write unit tests in tests/collab-presence.test.ts, tests/collab-module.test.ts and tests/collab-server.test.ts covering first join creating a room, second join reusing it, last leave disposing it, idle eviction exactly at and one millisecond past the threshold with a fake clock, relay fan-out excluding the sender, an unauthorised room raising ForbiddenError('collab.roomForbidden'), a malformed frame discarded without killing the room, and debounced persistence firing once per burst. Never open a real socket.",
      "dependsOn": ["m5", "m11"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/modules/collab/collab-module.ts",
        "src/modules/collab/presence.ts",
        "src/modules/collab/collab-schema.graphql",
        "src/modules/collab/collab-schema.ts",
        "src/modules/collab/index.ts",
        "src/server/collab-server.ts",
        "tests/collab-presence.test.ts",
        "tests/collab-module.test.ts",
        "tests/collab-server.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/collab-presence.test.ts, tests/collab-module.test.ts and tests/collab-server.test.ts pass and cover first join creating a room, second join reusing it, last leave disposing it, idle eviction exactly at and one millisecond past the threshold, a binary frame from one peer relayed to the others but not to the sender, an unauthorised room raising ForbiddenError('collab.roomForbidden'), a malformed frame discarded without disposing the room, and debounced snapshot persistence firing once for a burst of updates",
        "the websocket server factory and all timers are injected; no test opens a real socket",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "collaboration tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/collab-presence.test.ts", "tests/collab-module.test.ts", "tests/collab-server.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m14",
      "title": "Git-synchronisation worker: export to OKF Markdown",
      "stackTarget": "backend",
      "prompt": "Build the Git-sync module. exporter.ts is PURE: given a bundle's concepts, frontmatter and rendered bodies it returns the full array of {path, contents} OKF files — a directory layout mirroring the hierarchy, index.md for any concept with children, <slug>.md otherwise, frontmatter serialised through the OKF core, and cross-links rewritten from concept ids to relative file paths by link-rewriter.ts (a link to a missing concept is left intact and reported, never dropped). git-sync-module.ts opens a repeatable read, readOnly transaction for a consistent snapshot, writes files through the FsPort confined to config.gitSync.repoPath, stages, commits and pushes through the GitPort, records a run row, and on failure records the failure and rethrows a typed error rather than swallowing it; a no-change run commits nothing and is recorded as skipped. Scheduling uses an injected timer, never a module-scope setInterval. Add the SDL fragment (gitSyncRuns query, triggerGitSync mutation) and the ModuleDescriptor. Write unit tests in tests/git-sync-exporter.test.ts, tests/git-sync-link-rewriter.test.ts and tests/git-sync-module.test.ts covering an empty bundle, a flat bundle, a nested bundle, absolute and relative link rewriting, a link to a missing concept, a skipped no-change run, a push failure, and a path traversal rejection. Use the fake GitPort and memory FsPort; never run real git.",
      "dependsOn": ["m5", "m8", "m10", "m11"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/modules/git-sync/exporter.ts",
        "src/modules/git-sync/link-rewriter.ts",
        "src/modules/git-sync/git-sync-module.ts",
        "src/modules/git-sync/git-sync-schema.graphql",
        "src/modules/git-sync/git-sync-schema.ts",
        "src/modules/git-sync/index.ts",
        "tests/git-sync-exporter.test.ts",
        "tests/git-sync-link-rewriter.test.ts",
        "tests/git-sync-module.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/git-sync-exporter.test.ts, tests/git-sync-link-rewriter.test.ts and tests/git-sync-module.test.ts pass and cover an empty bundle producing zero files, a flat bundle, a nested bundle producing index.md at each branch and <slug>.md at each leaf, absolute and relative link rewriting, a link to a missing concept left intact and reported, a no-change run recorded as skipped with no commit, a GitPort push failure surfacing a typed error and a recorded failure row, and a path traversal rejected by the FsPort",
        "tests assert the export snapshot transaction is opened with repeatable read isolation and readOnly true",
        "no real git process runs; the fake GitPort records argv arrays which the tests assert",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "git-sync tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/git-sync-exporter.test.ts", "tests/git-sync-link-rewriter.test.ts", "tests/git-sync-module.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m15",
      "title": "Orchestrator, registry, schema assembly and the GraphQL route",
      "stackTarget": "backend",
      "prompt": "Assemble the system exactly as Architecture.md specifies. registry.ts defines ModuleDescriptor, ModuleRegistry, DEFAULT_REGISTRY listing all eight module descriptors, and resolveWiringOrder doing a topological sort that throws ConfigError('registry.cycle') on a cycle and ConfigError('registry.unknownDependency') on a dangling name. schema.ts collects each module's SchemaContribution, merges the SDL fragments with the root document, builds the executable schema once, and implements the Node field by decoding the global id and dispatching to the owning module. graphql-errors.ts maps AppError to extensions {code, details} and any unknown throwable to InternalError with the cause logged and never leaked. orchestrator.ts exports createOrchestrator(config, ports, registry?) implementing the published interface: it constructs the adapters and modules, memoizes schema(), creates request contexts, executes operations without ever throwing, and implements start() (migration CHECK, applying only when config.db.autoMigrate) and stop(). It contains no domain logic. src/routes/api/graphql.ts is a thin TanStack Start server route. Write unit tests in tests/registry.test.ts, tests/server-schema.test.ts, tests/graphql-errors.test.ts, tests/orchestrator.test.ts and tests/graphql-route.test.ts covering wiring order, cycles, dangling dependencies, memoized schema, Node dispatch for every type and an unknown type, every error mapping, start failing on pending migrations in production, stop cleaning up after a failed start, and the route returning 405, 400 and a 200 with errors.",
      "dependsOn": ["m4", "m6", "m9", "m10", "m11", "m12", "m13", "m14"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/server/registry.ts",
        "src/server/schema.ts",
        "src/server/graphql-errors.ts",
        "src/server/orchestrator.ts",
        "src/routes/api/graphql.ts",
        "schema.graphql",
        "tests/registry.test.ts",
        "tests/server-schema.test.ts",
        "tests/graphql-errors.test.ts",
        "tests/orchestrator.test.ts",
        "tests/graphql-route.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/registry.test.ts, tests/server-schema.test.ts, tests/graphql-errors.test.ts, tests/orchestrator.test.ts and tests/graphql-route.test.ts pass and cover topological wiring order, a two-module cycle raising ConfigError('registry.cycle'), a dangling dependency, schema built once and memoized, node(id:) dispatch for every NODE_TYPES entry plus an unknown type, each AppError subclass mapped to its extensions.code, a non-AppError mapped to InternalError without message leakage, start() failing on pending migrations in production and applying them when autoMigrate is true, stop() closing the pool and clearing timers after a failed start, and the route returning 405 for GET, 400 for a malformed body and 200 with an errors array for an invalid query",
        "npm run schema:emit exits 0 and writes a schema.graphql that graphql buildSchema accepts",
        "the route handler is invoked directly with a Request object; no HTTP server is started and no real database is used",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "orchestrator and route tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/registry.test.ts", "tests/server-schema.test.ts", "tests/graphql-errors.test.ts", "tests/orchestrator.test.ts", "tests/graphql-route.test.ts"], "expect": {"exitCode": 0}},
        {"clauseId": "c3", "description": "schema emits successfully", "kind": "command",
         "argv": ["npm", "run", "schema:emit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m16",
      "title": "Astryx UI shell: theme tokens, dark mode, application frame",
      "stackTarget": "frontend",
      "prompt": "Build the Astryx-themed shell. src/styles/tokens.stylex.ts uses StyleX defineVars for spacing, radius, elevation and semantic colour tokens layered on the @astryxdesign/theme-neutral cascade so dark mode is a token override rather than a second stylesheet. src/styles/theme.ts exports resolveTheme(preference, systemPrefersDark) returning 'light' or 'dark' for 'light' | 'dark' | 'system', and applyTheme(root, theme) stamping data-theme. Compose the components from Astryx primitives (Stack, Card, Text, Item, List, Icon, Badge, Field): AppFrame.tsx as a three-pane frame (sidebar rail, main column, inspector) that collapses the inspector when its slot is absent, SidebarChrome.tsx, DocumentHeader.tsx showing title, trust Badge, lifecycle and breadcrumb, ToolbarShell.tsx and ThemeToggle.tsx. Update src/routes/__root.tsx to mount the theme provider and AppFrame. Write unit tests in tests/theme.test.ts, tests/shell-app-frame.test.tsx, tests/shell-document-header.test.tsx and tests/shell-theme-toggle.test.tsx using @testing-library/react and user-event, covering all three theme preferences against both system values, applyTheme stamping and restamping, all three panes rendering, the collapsed inspector, every TrustLevel and Lifecycle rendering, an empty and a six-level breadcrumb, and ThemeToggle cycling light to dark to system with the accessible name asserted at each step.",
      "dependsOn": ["m1", "m2"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/styles/tokens.stylex.ts",
        "src/styles/theme.ts",
        "src/components/shell/AppFrame.tsx",
        "src/components/shell/SidebarChrome.tsx",
        "src/components/shell/DocumentHeader.tsx",
        "src/components/shell/ToolbarShell.tsx",
        "src/components/shell/ThemeToggle.tsx",
        "src/components/shell/index.ts",
        "src/routes/__root.tsx",
        "tests/theme.test.ts",
        "tests/shell-app-frame.test.tsx",
        "tests/shell-document-header.test.tsx",
        "tests/shell-theme-toggle.test.tsx"
      ],
      "acceptance": [
        "unit tests in tests/theme.test.ts, tests/shell-app-frame.test.tsx, tests/shell-document-header.test.tsx and tests/shell-theme-toggle.test.tsx pass and cover resolveTheme for light, dark and system against both system values, applyTheme stamping and restamping data-theme, AppFrame rendering all three panes, the inspector collapsing when its slot is absent, DocumentHeader rendering each TrustLevel badge and each Lifecycle value, an empty breadcrumb, a six-level breadcrumb, and ThemeToggle cycling light to dark to system via user-event with the accessible name asserted at each step",
        "npm run build exits 0, proving StyleX compiles the token definitions",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "shell tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/theme.test.ts", "tests/shell-app-frame.test.tsx", "tests/shell-document-header.test.tsx", "tests/shell-theme-toggle.test.tsx"], "expect": {"exitCode": 0}},
        {"clauseId": "c3", "description": "StyleX build succeeds", "kind": "command",
         "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m17",
      "title": "Relay client runtime: environment, network layer, optimistic updates",
      "stackTarget": "frontend",
      "prompt": "Build the Relay client runtime. relay.config.js points the compiler at src/, schema.graphql and src/__generated__. src/relay/fetch.ts exports createFetchFn({endpoint, fetchImpl, onError}) which posts operation text and variables to /api/graphql, maps a non-2xx response to a typed NetworkError, a malformed body to ValidationError('relay.malformedResponse'), and a GraphQL errors array into an AppError-shaped rejection preserving extensions.code so ConflictError('concept.staleVersion') reaches the UI intact. src/relay/environment.ts exports createRelayEnvironment(deps) building Environment, RecordSource and Store with a bounded GC scheduler; there must be NO module-level singleton, so server and browser instances come from the same factory. src/relay/optimistic.ts exports withOptimistic(config) wrapping commitMutation with an optimisticUpdater plus ConnectionHandler-based edge insert and remove helpers. fetch is always injected, never global. Write unit tests in tests/relay-fetch.test.ts, tests/relay-environment.test.ts and tests/relay-optimistic.test.ts covering a successful response, HTTP 500, HTTP 404, a non-JSON body, a GraphQL errors payload with extensions.code preserved, variables asserted on the injected fetchImpl, two factory calls producing independent stores, an optimistic edge insert visible before the response, and rollback restoring prior store state after a rejected mutation.",
      "dependsOn": ["m2", "m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "relay.config.js",
        "src/relay/fetch.ts",
        "src/relay/environment.ts",
        "src/relay/optimistic.ts",
        "tests/relay-fetch.test.ts",
        "tests/relay-environment.test.ts",
        "tests/relay-optimistic.test.ts"
      ],
      "acceptance": [
        "unit tests in tests/relay-fetch.test.ts, tests/relay-environment.test.ts and tests/relay-optimistic.test.ts pass and cover a successful response, HTTP 500, HTTP 404, a non-JSON body raising ValidationError('relay.malformedResponse'), a GraphQL errors payload with extensions.code preserved, request variables asserted on the injected fetchImpl, two createRelayEnvironment calls producing independent stores, an optimistic edge insert visible before the server response, and rollback restoring the previous store state after a rejected mutation",
        "fetch is injected in every test; no network call is made and no module-level environment singleton exists",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "relay client tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/relay-fetch.test.ts", "tests/relay-environment.test.ts", "tests/relay-optimistic.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m18",
      "title": "Lexical block editor: custom nodes, markdown shortcuts, serialization",
      "stackTarget": "frontend",
      "prompt": "Build the Lexical block editor. code-block-node.tsx is a DecoratorNode whose language property is EXPLICITLY initialised in the constructor (an uninitialised property silently breaks @lexical/yjs sync), with createDOM, updateDOM, exportJSON, importJSON and exportDOM. divider-node.tsx is a DecoratorNode rendering a themed rule. editor-config.ts registers paragraph, HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode and the two custom nodes, maps the theme to StyleX tokens, and uses an onError that throws rather than swallowing. markdown-shortcuts.ts exports registerMarkdownShortcuts(editor) built on editor.registerNodeTransform for '# ' through '###### ', '- ', '* ', '1. ', '> ', a code fence and '---', returning an unregister function. transformers.ts and serialize.ts extend @lexical/markdown for the custom nodes and export editorStateToMarkdown and markdownToEditorState. BlockEditor.tsx and Toolbar.tsx compose the editor with the Astryx toolbar shell. Write unit tests in tests/editor-nodes.test.tsx, tests/editor-markdown-shortcuts.test.ts, tests/editor-serialize.test.ts, tests/editor-block-editor.test.tsx and tests/editor-toolbar.test.tsx covering node clone and JSON round trip, the initialised language property, every shortcut arm plus a near-miss that must NOT transform, a markdown round trip over every block type, an empty document, whitespace-only input, malformed markdown, toolbar state from the selection, and the unregister function detaching the transform. Create a fresh headless editor per test.",
      "dependsOn": ["m2", "m8", "m16"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/editor/nodes/code-block-node.tsx",
        "src/editor/nodes/divider-node.tsx",
        "src/editor/config/editor-config.ts",
        "src/editor/transforms/markdown-shortcuts.ts",
        "src/editor/markdown/transformers.ts",
        "src/editor/markdown/serialize.ts",
        "src/editor/BlockEditor.tsx",
        "src/editor/Toolbar.tsx",
        "src/editor/index.ts",
        "tests/editor-nodes.test.tsx",
        "tests/editor-markdown-shortcuts.test.ts",
        "tests/editor-serialize.test.ts",
        "tests/editor-block-editor.test.tsx",
        "tests/editor-toolbar.test.tsx"
      ],
      "acceptance": [
        "unit tests in tests/editor-nodes.test.tsx, tests/editor-markdown-shortcuts.test.ts, tests/editor-serialize.test.ts, tests/editor-block-editor.test.tsx and tests/editor-toolbar.test.tsx pass and cover CodeBlockNode clone plus exportJSON and importJSON round trip, the constructor-initialised language property, DividerNode DOM output, every markdown shortcut arm from '# ' to '###### ' plus list, ordered list, quote, code fence and divider, a near-miss string that must not transform, a markdown to editor-state to markdown round trip over every block type, an empty document, whitespace-only input, malformed markdown, toolbar button state reflecting the current selection, and the unregister function detaching the transform",
        "each test creates its own headless Lexical editor; no editor instance is shared between tests",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "editor tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/editor-nodes.test.tsx", "tests/editor-markdown-shortcuts.test.ts", "tests/editor-serialize.test.ts", "tests/editor-block-editor.test.tsx", "tests/editor-toolbar.test.tsx"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m19",
      "title": "Yjs collaboration client: provider, awareness, presence UI",
      "stackTarget": "frontend",
      "prompt": "Build the client collaboration layer. src/collab/provider.ts exports createCollabProvider({room, wsUrl, doc, WebSocketPolyfill, onStatus}) wrapping y-websocket with the socket constructor INJECTED so tests supply a fake; it exposes connect, disconnect and status, and reconnect backoff that grows, caps, and is driven by an injected timer. src/collab/awareness.ts exports setLocalPresence, subscribePresence, a deterministic colorForActor(actorId) and stale-peer eviction. src/collab/CollaborationPluginBridge.tsx mounts the @lexical/react collaboration plugin against the provider and the editor, seeding the initial editor state only when the room is empty. src/collab/PresenceBar.tsx is an Astryx-composed avatar stack with an overflow count and an accessible label per peer. Write unit tests in tests/collab-client-provider.test.ts, tests/collab-client-awareness.test.ts, tests/collab-presence-bar.test.tsx and tests/collab-plugin-bridge.test.tsx covering connect and disconnect status transitions, reconnect backoff growth and cap with fake timers and asserted delays, a socket error surfaced through onStatus rather than thrown, colorForActor determinism and distinctness, presence add, update and remove, stale eviction at the threshold, PresenceBar with 0, 1, 5 and 12 peers including the overflow count, and the bridge seeding only an empty room. Never construct a real WebSocket.",
      "dependsOn": ["m2", "m16", "m18"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/collab/provider.ts",
        "src/collab/awareness.ts",
        "src/collab/CollaborationPluginBridge.tsx",
        "src/collab/PresenceBar.tsx",
        "src/collab/index.ts",
        "tests/collab-client-provider.test.ts",
        "tests/collab-client-awareness.test.ts",
        "tests/collab-presence-bar.test.tsx",
        "tests/collab-plugin-bridge.test.tsx"
      ],
      "acceptance": [
        "unit tests in tests/collab-client-provider.test.ts, tests/collab-client-awareness.test.ts, tests/collab-presence-bar.test.tsx and tests/collab-plugin-bridge.test.tsx pass and cover connect and disconnect status transitions, reconnect backoff growing and capping with asserted delays under fake timers, a socket error surfaced through onStatus rather than thrown, colorForActor deterministic for one id and distinct across ids, presence add, update and remove, stale-peer eviction at the threshold, PresenceBar rendering 0, 1, 5 and 12 peers with the overflow count asserted, and the bridge seeding the editor only when the room is empty",
        "the WebSocket polyfill is injected in every test; no real socket is constructed",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "collaboration client tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/collab-client-provider.test.ts", "tests/collab-client-awareness.test.ts", "tests/collab-presence-bar.test.tsx", "tests/collab-plugin-bridge.test.tsx"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m20",
      "title": "OKF frontmatter editing panel",
      "stackTarget": "frontend",
      "prompt": "Build the structured frontmatter editor. src/features/frontmatter/form-state.ts is a PURE reducer: init(frontmatter), setField, addTag (rejecting duplicates), removeTag, setTrust, setLifecycle, validate(state) returning field-level issues by reusing the OKF zod schema, and toFrontmatter which refuses to produce a value while issues exist. src/features/frontmatter/fields.ts holds declarative field descriptors (label, help text, control kind, options) driving the render. src/features/frontmatter/FrontmatterPanel.tsx composes Astryx Field primitives into trust and lifecycle selects, a provenance group, a tag editor, a dirty indicator, save and revert actions, and inline per-field errors wired to aria-describedby. Write unit tests in tests/frontmatter-form-state.test.ts, tests/frontmatter-fields.test.ts and tests/frontmatter-panel.test.tsx covering init from a complete and from a minimal frontmatter, every reducer action asserted on the resulting state, a duplicate tag rejected, removing the last tag, each TrustLevel and Lifecycle selectable, validate producing an issue per invalid field, toFrontmatter refusing while invalid, dirty-state transitions, revert restoring the initial state, and the panel rendering an inline error linked by aria-describedby, driven with user-event.",
      "dependsOn": ["m2", "m8", "m16"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/features/frontmatter/form-state.ts",
        "src/features/frontmatter/fields.ts",
        "src/features/frontmatter/FrontmatterPanel.tsx",
        "src/features/frontmatter/index.ts",
        "tests/frontmatter-form-state.test.ts",
        "tests/frontmatter-fields.test.ts",
        "tests/frontmatter-panel.test.tsx"
      ],
      "acceptance": [
        "unit tests in tests/frontmatter-form-state.test.ts, tests/frontmatter-fields.test.ts and tests/frontmatter-panel.test.tsx pass and cover init from a complete and from a minimal frontmatter, every reducer action asserted on the resulting state, a duplicate tag rejected, removing the last tag, each TrustLevel and Lifecycle selectable, validate producing one issue per invalid field, toFrontmatter refusing while invalid, dirty-state transitions, revert restoring the initial state, and an inline error linked by aria-describedby driven with user-event",
        "npx tsc --noEmit exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "frontmatter panel tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/frontmatter-form-state.test.ts", "tests/frontmatter-fields.test.ts", "tests/frontmatter-panel.test.tsx"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m21",
      "title": "Workspace routes: paginated sidebar tree, concept page, search UI",
      "stackTarget": "frontend",
      "prompt": "Close the loop. src/features/sidebar/use-tree-pagination.ts is a hook over the children Connection: expand, collapse, loadMore honouring pageInfo.hasNextPage, deduplication of in-flight page requests, and an error state that does not collapse already-loaded nodes. src/features/sidebar/SidebarTree.tsx renders the lazily paginated tree with keyboard navigation, expand markers, a per-level load-more affordance, and empty, loading and error states. src/features/search/SearchPanel.tsx renders a search input debounced by an injected timer, a result list with highlighted snippets, and empty and no-results states. Rewrite src/routes/index.tsx as the bundle picker and add src/routes/bundles.$bundleId.tsx, src/routes/concepts.$conceptId.tsx (composing DocumentHeader, BlockEditor, CollaborationPluginBridge, PresenceBar and FrontmatterPanel) and src/routes/search.tsx. Run npm run schema:emit and npm run relay and commit the artifacts under src/__generated__/. Write unit tests in tests/use-tree-pagination.test.ts, tests/sidebar-tree.test.tsx, tests/search-panel.test.tsx, tests/route-concept.test.tsx and tests/route-bundles.test.tsx using relay-test-utils' mock environment — no network. Cover expand and collapse, loadMore appending a page and stopping at hasNextPage false, a duplicate concurrent loadMore issuing one request, a fetch error preserving loaded nodes, a bundle with zero concepts, a node with one child, keyboard navigation, debounced search issuing one query per burst, a no-results state, and the concept route rendering header, editor, presence bar and frontmatter panel together.",
      "dependsOn": ["m15", "m16", "m17", "m18", "m19", "m20"],
      "estimatedComplexity": "hard",
      "maxAttempts": 3,
      "touches": [
        "src/features/sidebar/use-tree-pagination.ts",
        "src/features/sidebar/SidebarTree.tsx",
        "src/features/sidebar/index.ts",
        "src/features/search/SearchPanel.tsx",
        "src/features/search/index.ts",
        "src/routes/index.tsx",
        "src/routes/bundles.$bundleId.tsx",
        "src/routes/concepts.$conceptId.tsx",
        "src/routes/search.tsx",
        "src/__generated__/",
        "tests/use-tree-pagination.test.ts",
        "tests/sidebar-tree.test.tsx",
        "tests/search-panel.test.tsx",
        "tests/route-concept.test.tsx",
        "tests/route-bundles.test.tsx"
      ],
      "acceptance": [
        "unit tests in tests/use-tree-pagination.test.ts, tests/sidebar-tree.test.tsx, tests/search-panel.test.tsx, tests/route-concept.test.tsx and tests/route-bundles.test.tsx pass and cover expand and collapse, loadMore appending a page and stopping at hasNextPage false, a duplicate concurrent loadMore issuing exactly one request, a page-fetch error preserving already-loaded nodes, a bundle with zero concepts, a node with exactly one child, keyboard arrow navigation, debounced search issuing one query per burst, a no-results state, and the concept route rendering the document header, editor, presence bar and frontmatter panel together",
        "all Relay data comes from relay-test-utils' mock environment; no test performs a network call",
        "npm run relay exits 0 and the generated artifacts under src/__generated__ are committed",
        "npx tsc --noEmit exits 0 with the generated artifacts present",
        "npm test runs the entire suite and exits 0"
      ],
      "exitClauses": [
        {"clauseId": "c1", "description": "relay artifacts generate", "kind": "command",
         "argv": ["npm", "run", "relay"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "typecheck passes", "kind": "command",
         "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c3", "description": "this module's unit tests pass", "kind": "command",
         "argv": ["npx", "vitest", "run", "tests/use-tree-pagination.test.ts", "tests/sidebar-tree.test.tsx", "tests/search-panel.test.tsx", "tests/route-concept.test.tsx", "tests/route-bundles.test.tsx"], "expect": {"exitCode": 0}},
        {"clauseId": "c4", "description": "the entire suite passes", "kind": "command",
         "argv": ["npm", "test"], "expect": {"exitCode": 0}},
        {"clauseId": "c5", "description": "production build succeeds", "kind": "command",
         "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    }
  ]
}
```