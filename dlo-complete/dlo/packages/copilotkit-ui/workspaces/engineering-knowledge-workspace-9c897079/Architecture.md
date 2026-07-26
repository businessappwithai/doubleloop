# Architecture — Engineering Knowledge Workspace

> **Status:** Build contract. Every implementation subagent MUST conform to this document.
> **Scope:** A collaborative, block-based engineering knowledge workspace specialised for
> Google Cloud's Open Knowledge Format (OKF): Knowledge Bundles containing hierarchical
> Concepts (Markdown + YAML frontmatter), edited in a Lexical block editor, synchronised
> with Yjs CRDTs, served by a GraphQL/Relay-conventions API over PostgreSQL 17, and
> exported back to `.md` files by a Git-synchronisation worker.

---

## Technology Choices

The research mandates a specific stack. It is honored exactly; nothing is substituted. Where
the research is silent (test runner, GraphQL server library, YAML parser, migration tool), a
choice is made here and justified.

### Mandated (from research — non-negotiable)

| Concern | Choice | Version | Justification (from research) |
|---|---|---|---|
| Application framework | **TanStack Start** (`@tanstack/react-start`) | `1.168.32` | Research §"Verified package availability" names it as the application framework: React 19, file-based routing, server functions, Vite. Also the DLO framework default. |
| UI runtime | **React 19** + TypeScript (strict) | `react@^19`, `react-dom@^19` | Astryx peer requirement is `react >=19`. |
| Design system | **Meta Astryx** (`@astryxdesign/core`, `@astryxdesign/cli`, `@astryxdesign/theme-neutral`) | `0.1.8` | Research Part II §1. Open-internals composition, token cascade theming with built-in dark mode, AI-fluent manifests. |
| CSS engine | **StyleX** (`@stylexjs/stylex`) + `@astryxdesign/build` | `0.19.0` / `0.1.8` | Astryx peer dependency; compile-time atomic CSS, zero runtime style cost. |
| Editor engine | **Meta Lexical** (`lexical`, `@lexical/react`, `@lexical/markdown`, `@lexical/utils`, `@lexical/rich-text`, `@lexical/list`, `@lexical/code`, `@lexical/link`, `@lexical/selection`) | `0.48.0` | Research Part II §2. Immutable `EditorState`, custom `ElementNode`/`DecoratorNode` blocks, `registerNodeTransform` for markdown shortcuts, `@lexical/markdown` for strict Markdown serialization. |
| CRDT collaboration | **Yjs** (`yjs`, `@lexical/yjs`, `y-websocket`, `y-protocols`) | `13.6.31` / `0.48.0` / `3.0.0` | Research Part II §3. YATA gives deterministic, server-free conflict resolution; `Y.XmlFragment` ↔ Lexical element nodes. |
| Data layer conventions | **GraphQL with Relay conventions** — `Node` interface, base64 global IDs, cursor Connections | — | Research Part II §4 and Part III §4. Normalized client cache, lazy hierarchy pagination, optimistic updates. |
| Persistence | **PostgreSQL 17**, hybrid relational + `JSONB`, GIN `jsonb_path_ops` | `pg@^8` driver | Research Part II §5. Stable entities relational; fluid CRDT/block payload in `JSONB`; `@>` containment queries index-accelerated. |

### Chosen here (research silent — decisions with rationale)

| Concern | Choice | Justification |
|---|---|---|
| Test runner | **Vitest** (`vitest`) + `@testing-library/react` + `@testing-library/user-event` + `jsdom` | Native to the Vite toolchain TanStack Start already uses — one transform pipeline, one config graph, no separate Babel/Jest setup. `expect` is Chai/Jest-compatible; `vi.mock`/`vi.useFakeTimers` give module-boundary faking, which the testing strategy depends on. |
| GraphQL server | **`graphql-js` (`graphql@^16`) executed by a hand-written TanStack Start server route** at `/api/graphql` | Avoids a heavyweight server framework inside TanStack Start's Nitro-style handler. `graphql`'s `execute()` is a pure function of `(schema, document, contextValue)` — trivially unit-testable without HTTP. |
| GraphQL client | **`react-relay` + `relay-runtime` + `relay-compiler`** | `21.0.1`; mandated conventions are Relay's, and Relay's normalized store + `optimisticUpdater` are exactly what the research prescribes. |
| Postgres driver | **`pg`** (node-postgres) with an explicit `Db` port interface | Mature, parameterised queries only. All data-access code depends on the *interface*, never on `pg` itself — this is what makes data-access tests hermetic. |
| Migrations | **Plain numbered SQL files** + a tiny `migrate` runner | No migration framework lock-in; `sql/migrations/00N_*.sql` is reviewable, diffable, and replayable. |
| YAML frontmatter | **`yaml`** (eemeli's `yaml@^2`) | Round-trips comments and ordering, exposes a strict parse mode, and unlike `js-yaml` it does not need a schema shim to reject duplicate keys. |
| Websocket server | **`ws`** + `y-websocket`'s server utilities, run as a separate Node process | Keeps the CRDT relay out of the request/response app server; horizontally separable. |
| Validation | **`zod@^3`** at every trust boundary (env, GraphQL input, frontmatter, JSONB read-back) | Parse, don't validate. Every boundary produces a typed value or a typed error. |
| Logging | **Hand-rolled structured JSON logger** (`src/lib/logger.ts`) | ~60 lines, injectable, no transport side effects in tests. A dependency here would be larger than the code. |

### Explicitly rejected

- **Prisma / Drizzle / any ORM** — the schema is deliberately hybrid; hand-written SQL with `jsonb_path_ops` containment predicates is the point, and an ORM obscures it.
- **Tailwind / CSS modules** — Astryx + StyleX is mandated. Astryx's zero-lock-in `className` escape hatch exists but is not used; a second styling system would fracture the token cascade.
- **Apollo Client / urql** — Relay conventions are mandated and Relay's store is what makes optimistic updates roll back automatically.
- **Jest** — a second transform pipeline alongside Vite, for no gain.
- **`--passWithNoTests`** — forbidden by the objectives; an empty suite MUST fail.

---

## Central Orchestrator

There is exactly one module that wires the system together: **`src/server/orchestrator.ts`**,
exporting the class `Orchestrator` and the factory `createOrchestrator(config, ports)`.

### Rules (enforced by review and by boundary tests)

1. **No module imports another feature module.** A module imports only: `src/core/**` (pure
   types + pure functions), its own directory, and the interfaces it declares. Cross-module
   collaboration happens through the orchestrator, which holds the only instance of each
   module.
2. **The orchestrator constructs; it does not compute.** It owns no domain logic. Every method
   on it is a thin delegation that (a) resolves a request context, (b) calls one module method,
   (c) maps a domain error to a transport-neutral result. If a method on the orchestrator grows
   a conditional over domain state, that logic belongs in a module.
3. **The orchestrator is the only place that constructs adapters** (`PgDb`, `NodeClock`,
   `NodeGit`, `RandomIds`). Nothing else calls `new PgDb(...)` — that is what makes every other
   test hermetic.
4. **Nothing above the orchestrator knows about `pg`, `ws`, `child_process`, `fs`, or `Date`.**

### Responsibilities

- Parse and validate configuration once (`loadConfig`), then hold it immutably.
- Instantiate the **ports** (side-effecting adapters) — `Db`, `Clock`, `IdGenerator`, `Logger`, `GitPort`, `FsPort`.
- Instantiate every **module**, injecting only the ports and module interfaces each one declares.
- Expose a **registry**: modules register themselves via a factory descriptor so the wiring is
  data, not a wall of `new` calls, and so tests can register fakes for a subset.
- Build the executable GraphQL schema by collecting each module's `SchemaContribution`
  (SDL fragment + resolver map) and merging them once.
- Own the request lifecycle: create a per-request `RequestContext` (request id, actor, logger
  child, unit-of-work handle), run the operation, translate `AppError` → GraphQL error
  extensions.
- Own lifecycle: `start()` (run migrations check, warm the schema, start the collaboration
  server hook and the Git worker schedule) and `stop()` (drain, close pool, stop timers).

### Public interface

```ts
// src/server/orchestrator.ts
import type { GraphQLSchema } from "graphql";
import type { AppConfig } from "../config/config.js";
import type { Ports } from "./ports.js";
import type { RequestContext, Actor } from "../core/context.js";
import type { ModuleDescriptor, ModuleRegistry } from "./registry.js";

export interface OrchestratorModules {
  readonly bundles: BundleModule;
  readonly concepts: ConceptModule;
  readonly hierarchy: HierarchyModule;
  readonly documents: DocumentModule;   // CRDT payload + block content
  readonly frontmatter: FrontmatterModule;
  readonly search: SearchModule;
  readonly collab: CollabModule;
  readonly gitSync: GitSyncModule;
}

export interface Orchestrator {
  readonly config: AppConfig;
  readonly modules: OrchestratorModules;

  /** Merged executable schema; built once, memoized. */
  schema(): GraphQLSchema;

  /** Creates the per-request context handed to every resolver. */
  createRequestContext(input: {
    requestId: string;
    actor: Actor;
  }): RequestContext;

  /** Executes one GraphQL operation. Never throws; returns a GraphQL result. */
  execute(input: {
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
    ctx: RequestContext;
  }): Promise<GraphQLExecutionResult>;

  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createOrchestrator(
  config: AppConfig,
  ports: Ports,
  registry?: ModuleRegistry,   // defaults to DEFAULT_REGISTRY
): Orchestrator;
```

### How modules register

Registration is declarative. Each module ships a `ModuleDescriptor` next to its implementation;
the default registry is an array of descriptors. A test can swap any single descriptor.

```ts
// src/server/registry.ts
export interface ModuleDescriptor<TName extends keyof OrchestratorModules = keyof OrchestratorModules> {
  readonly name: TName;
  /** Names of other modules this one is allowed to see. Cycles are rejected at wiring time. */
  readonly dependsOn: readonly (keyof OrchestratorModules)[];
  /** Builds the module. `deps` contains exactly the modules named in `dependsOn`. */
  readonly create: (args: {
    ports: Ports;
    config: AppConfig;
    deps: Partial<OrchestratorModules>;
  }) => OrchestratorModules[TName];
  /** Optional GraphQL contribution merged into the single executable schema. */
  readonly schema?: SchemaContribution;
}

export interface SchemaContribution {
  readonly typeDefs: string;                       // SDL fragment
  readonly resolvers: Record<string, Record<string, GraphQLFieldResolver<never, RequestContext>>>;
}

export type ModuleRegistry = readonly ModuleDescriptor[];

/** Topologically sorts by `dependsOn`; throws ConfigError('module.cycle') on a cycle
 *  and ConfigError('module.missingDependency') on an unregistered name. */
export function wireModules(
  registry: ModuleRegistry,
  ports: Ports,
  config: AppConfig,
): OrchestratorModules;
```

```ts
// src/modules/concepts/module.ts  — registration is a one-liner per module
export const conceptModuleDescriptor: ModuleDescriptor<"concepts"> = {
  name: "concepts",
  dependsOn: ["frontmatter", "documents"],
  create: ({ ports, deps }) =>
    createConceptModule({
      repo: createConceptRepo(ports.db),
      frontmatter: deps.frontmatter!,
      documents: deps.documents!,
      clock: ports.clock,
      ids: ports.ids,
      logger: ports.logger.child({ module: "concepts" }),
    }),
  schema: { typeDefs: conceptTypeDefs, resolvers: conceptResolvers },
};
```

`wireModules` is pure given its inputs and is unit-tested directly: cycle detection, missing
dependency, correct topological order, and that a module only receives the deps it declared.

---

## Modules

Every module below has: a **single responsibility**, a **narrow interface** (the only surface
other code may touch), and **explicit dependencies**. All identifiers below are the exact names
implementations must use.

### Layering

```
core/            pure: types, global-id codec, markdown/frontmatter transforms, errors, cursors
  ↑
ports/           interfaces only: Db, Clock, IdGenerator, Logger, GitPort, FsPort
  ↑
modules/*/repo   data access — depends on Db only, one repo per module, parameterised SQL
  ↑
modules/*/service business logic — depends on its repo + declared module interfaces
  ↑
server/orchestrator  wiring, schema merge, request lifecycle
  ↑
app/routes, app/components   UI — depends on Relay + Astryx only
```

Import direction is one-way. `core` imports nothing from the app. No module imports another
module's `repo` or internals — only its published interface, and only if declared in `dependsOn`.

---

### 1. `core` — pure domain kernel

**Responsibility.** Types, branded IDs, the Relay global-ID codec, cursor codec, the
Markdown↔block transforms, frontmatter parse/serialize, and the error hierarchy. Zero I/O, zero
dependencies except `zod`, `yaml`, and `@lexical/markdown`'s pure transformer definitions.

**Interface** (`src/core/index.ts`)

```ts
// Branded ids — a raw string can never be passed where a BundleId is expected.
export type BundleId  = string & { readonly __brand: "BundleId" };
export type ConceptId = string & { readonly __brand: "ConceptId" };
export type UserId    = string & { readonly __brand: "UserId" };

export type TrustLevel = "unverified" | "machine-confirmed" | "human-reviewed";
export type Lifecycle  = "draft" | "active" | "deprecated" | "archived";

export interface Frontmatter {
  readonly title: string;
  readonly trust: TrustLevel;
  readonly lifecycle: Lifecycle;
  readonly provenance: Provenance;
  readonly tags: readonly string[];
  readonly extra: Readonly<Record<string, unknown>>; // unknown keys preserved verbatim
}
export interface Provenance {
  readonly source: string;
  readonly author: string;
  readonly generatedBy: string | null;
  readonly reviewedAt: string | null;   // ISO-8601
}

// Relay Global Object Identification
export function encodeGlobalId(type: NodeTypeName, localId: string): string;      // base64("Concept:uuid")
export function decodeGlobalId(gid: string): { type: NodeTypeName; localId: string }; // throws InvalidGlobalIdError

// Connection cursors — opaque, stable, and totally ordered
export function encodeCursor(key: SortKey): string;
export function decodeCursor(cursor: string): SortKey;                            // throws InvalidCursorError
export function buildConnection<T>(rows: readonly T[], args: ConnectionArgs, toKey: (t: T) => SortKey): Connection<T>;

// OKF document text
export function parseOkfDocument(raw: string): { frontmatter: Frontmatter; body: string }; // throws FrontmatterError
export function serializeOkfDocument(fm: Frontmatter, body: string): string;

// Errors
export abstract class AppError extends Error { abstract readonly code: string; readonly details: Readonly<Record<string, unknown>>; }
export class NotFoundError extends AppError { readonly code = "not_found"; }
export class ValidationError extends AppError { readonly code = "validation"; }
export class ConflictError extends AppError { readonly code = "conflict"; }
export class ConfigError extends AppError { readonly code: string; }              // code namespaced: "config.*", "module.*"
export class InvalidGlobalIdError extends ValidationError {}
export class InvalidCursorError extends ValidationError {}
export class FrontmatterError extends ValidationError {}
export class StorageError extends AppError { readonly code = "storage"; }
export class GitSyncError extends AppError { readonly code = "git_sync"; }
```

**Dependencies:** `zod`, `yaml`. Nothing else. Ever.

---

### 2. `ports` — side-effect interfaces

**Responsibility.** Declare the only four things that touch the outside world. Adapters live in
`src/adapters/`; only the orchestrator imports adapters.

```ts
// src/server/ports.ts
export interface Db {
  /** Parameterised query. `$1`-style placeholders only; string interpolation is a review failure. */
  query<R extends QueryRow = QueryRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number }>;
  /** Runs `fn` inside BEGIN/COMMIT; ROLLBACK on any throw, and the error is rethrown unchanged. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
export interface Clock { now(): Date; }
export interface IdGenerator { uuid(): string; }
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}
export interface FsPort {
  writeFile(path: string, contents: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
}
export interface GitPort {
  status(repoDir: string): Promise<{ dirty: boolean; files: readonly string[] }>;
  add(repoDir: string, paths: readonly string[]): Promise<void>;
  commit(repoDir: string, message: string, author: { name: string; email: string }): Promise<{ sha: string }>;
  push(repoDir: string, remote: string, branch: string): Promise<void>;
}
export interface Ports { db: Db; clock: Clock; ids: IdGenerator; logger: Logger; fs: FsPort; git: GitPort; }
```

Adapters: `src/adapters/pg-db.ts`, `src/adapters/node-clock.ts`, `src/adapters/uuid-ids.ts`,
`src/adapters/node-fs.ts`, `src/adapters/git-cli.ts` (spawned with `execFile` and an **argv
array — never a shell string**).

---

### 3. `BundleModule` — knowledge bundles

**Responsibility.** CRUD and listing of Knowledge Bundles (the self-contained collection), plus
the bundle's Git remote binding.

```ts
export interface BundleModule {
  get(ctx: RequestContext, id: BundleId): Promise<Bundle>;                       // NotFoundError
  list(ctx: RequestContext, args: ConnectionArgs): Promise<Connection<Bundle>>;
  create(ctx: RequestContext, input: CreateBundleInput): Promise<Bundle>;        // ValidationError, ConflictError(slug taken)
  rename(ctx: RequestContext, id: BundleId, title: string): Promise<Bundle>;
  setGitRemote(ctx: RequestContext, id: BundleId, remote: GitRemote | null): Promise<Bundle>;
  delete(ctx: RequestContext, id: BundleId): Promise<void>;                      // ConflictError if concepts remain
}
```

**Depends on:** `BundleRepo` (own), `Clock`, `IdGenerator`, `Logger`. **No other module.**

---

### 4. `ConceptModule` — concepts (OKF markdown documents)

**Responsibility.** Concept lifecycle: create, read, rename, move, soft-delete. Owns the
concept's relational metadata row and delegates the block payload to `DocumentModule` and the
YAML to `FrontmatterModule`.

```ts
export interface ConceptModule {
  get(ctx: RequestContext, id: ConceptId): Promise<Concept>;                     // NotFoundError
  create(ctx: RequestContext, input: CreateConceptInput): Promise<Concept>;      // ValidationError, NotFoundError(parent)
  rename(ctx: RequestContext, id: ConceptId, title: string): Promise<Concept>;
  /** Reparents. Rejects cycles (a concept cannot become its own ancestor). */
  move(ctx: RequestContext, id: ConceptId, newParent: ConceptId | null): Promise<Concept>; // ConflictError("hierarchy.cycle")
  setIndexDocument(ctx: RequestContext, id: ConceptId, isIndex: boolean): Promise<Concept>; // ConflictError if sibling index exists
  delete(ctx: RequestContext, id: ConceptId, cascade: boolean): Promise<void>;   // ConflictError if children && !cascade
  /** Full OKF text: frontmatter + serialized markdown body. Used by GitSyncModule. */
  renderOkf(ctx: RequestContext, id: ConceptId): Promise<{ path: string; contents: string }>;
}
```

**Depends on:** `ConceptRepo` (own), `FrontmatterModule`, `DocumentModule`, `Clock`,
`IdGenerator`, `Logger`. Declared in `dependsOn: ["frontmatter", "documents"]`.

---

### 5. `HierarchyModule` — tree traversal and pagination

**Responsibility.** The one place that knows how the concept tree is traversed and paginated.
Implements the lazily-paginated sidebar: children-of-node Connections, ancestor path
(breadcrumbs), and progressive disclosure via `index.md`.

```ts
export interface HierarchyModule {
  children(ctx: RequestContext, parent: { bundle: BundleId; concept: ConceptId | null }, args: ConnectionArgs): Promise<Connection<Concept>>;
  ancestors(ctx: RequestContext, id: ConceptId): Promise<readonly Concept[]>;    // root-first, excludes self
  /** Relative/absolute OKF markdown link → ConceptId, or null if unresolvable. */
  resolveLink(ctx: RequestContext, from: ConceptId, href: string): Promise<ConceptId | null>;
  /** Materialised slug path, e.g. "runtime/scheduler/index.md". */
  pathOf(ctx: RequestContext, id: ConceptId): Promise<string>;
}
```

**Depends on:** `HierarchyRepo` (own; recursive CTE queries), `Logger`. **No other module** —
it reads the same tables through its own repo rather than calling `ConceptModule`, which keeps
the dependency graph acyclic.

---

### 6. `DocumentModule` — block content and CRDT payload

**Responsibility.** The `JSONB` payload: the serialized Lexical editor state, the Yjs update
vector, and the derived plaintext used for search. It is the only module that reads or writes
`concepts.content`.

```ts
export interface DocumentModule {
  load(ctx: RequestContext, id: ConceptId): Promise<DocumentPayload>;            // NotFoundError
  /**
   * Persists a new editor state. `expectedVersion` implements optimistic
   * concurrency: a mismatch throws ConflictError("document.staleVersion").
   */
  save(ctx: RequestContext, id: ConceptId, input: SaveDocumentInput): Promise<DocumentPayload>;
  /** Applies a binary Yjs update (base64 over the wire) and returns the merged state vector. */
  applyCrdtUpdate(ctx: RequestContext, id: ConceptId, updateB64: string): Promise<{ stateVectorB64: string; version: number }>;
  /** Markdown ⇄ editor state, delegating to core's pure transforms. */
  toMarkdown(state: SerializedEditorState): string;
  fromMarkdown(markdown: string): SerializedEditorState;
}

export interface DocumentPayload {
  readonly conceptId: ConceptId;
  readonly editorState: SerializedEditorState;  // Lexical JSON
  readonly crdtUpdateB64: string;               // Y.encodeStateAsUpdate output, base64
  readonly plainText: string;                   // derived, for search
  readonly version: number;
}
```

**Depends on:** `DocumentRepo` (own), `core` markdown transforms, `Clock`, `Logger`.

---

### 7. `FrontmatterModule` — structured OKF metadata

**Responsibility.** Validate, normalize, and persist YAML frontmatter (provenance, trust,
lifecycle, tags). Enforces the OKF trust enum and lifecycle transitions.

```ts
export interface FrontmatterModule {
  get(ctx: RequestContext, id: ConceptId): Promise<Frontmatter>;
  /** Partial update; unknown keys in `extra` are preserved, never dropped. */
  update(ctx: RequestContext, id: ConceptId, patch: FrontmatterPatch): Promise<Frontmatter>; // ValidationError
  /** Pure: rejects an illegal transition, e.g. archived → draft. */
  validateTransition(from: Frontmatter, patch: FrontmatterPatch): Frontmatter;   // ValidationError("frontmatter.illegalTransition")
  serialize(fm: Frontmatter): string;   // YAML block including the `---` fences
}
```

**Depends on:** `FrontmatterRepo` (own), `core` (`parseOkfDocument`, zod schemas), `Clock`, `Logger`.

---

### 8. `SearchModule` — containment + full-text search

**Responsibility.** The only module that writes search SQL. Two query shapes: JSONB containment
via the GIN `jsonb_path_ops` index (`content @> $1`), and full-text over the derived
`plain_text` column via `tsvector`.

```ts
export interface SearchModule {
  /** Full-text over concept body + title. Returns ranked Connection. */
  search(ctx: RequestContext, q: SearchQuery, args: ConnectionArgs): Promise<Connection<SearchHit>>;
  /** Containment: "every concept whose block tree contains this JSON fragment." */
  containing(ctx: RequestContext, bundle: BundleId, fragment: Json, args: ConnectionArgs): Promise<Connection<Concept>>;
  /** Pure: user query string → normalized tsquery input. Rejects empty/whitespace-only. */
  normalizeQuery(raw: string): string;                                           // ValidationError("search.emptyQuery")
}
```

**Depends on:** `SearchRepo` (own), `Logger`.

---

### 9. `CollabModule` — Yjs room lifecycle

**Responsibility.** Server-side room registry and persistence hooks for the y-websocket
provider: bind a room name to a `ConceptId`, load the persisted update on room open, debounce
and flush updates back through `DocumentModule`, and expose awareness/presence counts.

```ts
export interface CollabModule {
  roomNameFor(id: ConceptId): string;                                            // pure: "concept:<uuid>"
  conceptIdFor(roomName: string): ConceptId;                                     // pure; ValidationError on malformed
  /** Called when a room is first opened: returns the persisted Yjs update, or null. */
  onRoomOpen(ctx: RequestContext, room: string): Promise<Uint8Array | null>;
  /** Called on each debounced flush. Idempotent: applying the same update twice is a no-op by CRDT law. */
  onRoomUpdate(ctx: RequestContext, room: string, update: Uint8Array): Promise<void>;
  presence(room: string): PresenceSnapshot;                                      // pure read of in-memory awareness
}
```

**Depends on:** `DocumentModule`, `Clock`, `Logger`. Declared `dependsOn: ["documents"]`.
The `ws` server itself lives in `src/collab-server/main.ts` and calls **only** this interface —
it contains no domain logic and no SQL.

---

### 10. `GitSyncModule` — OKF export worker

**Responsibility.** Export the persisted state of a bundle to OKF `.md` files on disk
(frontmatter + body), stage, commit, and push. Never invoked implicitly — the orchestrator
schedules it, and a GraphQL mutation triggers it on demand.

```ts
export interface GitSyncModule {
  /** Pure: the full file plan for a bundle. Deterministic ordering by path. */
  planExport(concepts: readonly ConceptExportRow[]): readonly ExportFile[];
  /** Writes the plan through FsPort. Returns files written and files removed. */
  writeExport(ctx: RequestContext, repoDir: string, plan: readonly ExportFile[]): Promise<ExportResult>;
  /** Full run: read bundle → plan → write → add → commit → push. */
  syncBundle(ctx: RequestContext, id: BundleId): Promise<SyncReport>;            // GitSyncError with a `stage` detail
}
export interface ExportFile { readonly path: string; readonly contents: string; }
```

**Depends on:** `ConceptModule` (for `renderOkf`), `HierarchyModule` (for `pathOf`), `FsPort`,
`GitPort`, `Clock`, `Logger`. Declared `dependsOn: ["concepts", "hierarchy"]`.

---

### 11. UI modules (`src/app/**`)

The UI is modular under the same rule: a component imports Astryx, Relay hooks, and its own
directory — never a server module, never `pg`.

| Module | Responsibility | Interface |
|---|---|---|
| `AppShell` (`app/components/shell/`) | Astryx frame: header, sidebar slot, content slot, theme toggle (dark mode via the Astryx token cascade). | `<AppShell sidebar={…} header={…}>{children}</AppShell>` |
| `SidebarTree` (`app/components/sidebar/`) | Lazily-paginated hierarchy. Uses `usePaginationFragment` over the `children` Connection; expands one level per click. | `<SidebarTree bundleId rootConnectionRef onSelect />` |
| `ConceptEditor` (`app/components/editor/`) | The Lexical composer: nodes, theme, plugins, markdown shortcuts, Yjs collaboration plugin. | `<ConceptEditor conceptId room readOnly?/>` |
| `editor/nodes/` | Custom `ElementNode`/`DecoratorNode` subclasses: `CalloutNode`, `DividerNode`, `CodeBlockNode`. Each initialises **every** custom property in its constructor (research §3: `@lexical/yjs` will not serialize an uninitialised property). | class exports + `$create*`/`$is*` helpers |
| `editor/plugins/MarkdownShortcutsPlugin` | Registers `registerNodeTransform`s implementing `# `, `## `, `- `, `1. `, `> `, ` ``` `, `---`. | `<MarkdownShortcutsPlugin />` |
| `FrontmatterPanel` (`app/components/frontmatter/`) | Astryx `Field`/form controls for provenance/trust/lifecycle/tags; commits via a Relay mutation with `optimisticResponse`. | `<FrontmatterPanel conceptRef />` |
| `PresenceBar` (`app/components/presence/`) | Renders Yjs awareness states as Astryx avatars/badges. | `<PresenceBar states={…} />` |
| `SearchPanel` (`app/components/search/`) | Debounced query → Relay refetch; renders ranked hits. | `<SearchPanel bundleId />` |

---

## Plumbing & Conventions

### Folder layout

```
engineering-knowledge-workspace/
├─ package.json
├─ tsconfig.json                     # strict; noUncheckedIndexedAccess; exactOptionalPropertyTypes
├─ vite.config.ts                    # TanStack Start + StyleX (via @astryxdesign/build)
├─ vitest.config.ts                  # jsdom, globals:false, setupFiles
├─ vitest.setup.ts                   # RTL cleanup, jest-dom matchers, fail-on-console
├─ relay.config.js
├─ schema.graphql                    # emitted by `pnpm schema:emit`; relay-compiler input
├─ docker-compose.yml                # postgres:17
├─ sql/
│  └─ migrations/001_init.sql … 004_search.sql
├─ src/
│  ├─ core/                          # pure kernel (no I/O)
│  │  ├─ ids.ts  cursors.ts  errors.ts  frontmatter.ts  markdown.ts  types.ts  context.ts
│  ├─ config/config.ts               # zod-validated env
│  ├─ lib/logger.ts
│  ├─ server/
│  │  ├─ ports.ts  registry.ts  orchestrator.ts  schema.ts  errors-to-graphql.ts
│  ├─ adapters/
│  │  ├─ pg-db.ts  node-clock.ts  uuid-ids.ts  node-fs.ts  git-cli.ts
│  ├─ modules/
│  │  ├─ bundles/{module.ts,service.ts,repo.ts,schema.ts,types.ts}
│  │  ├─ concepts/…  hierarchy/…  documents/…  frontmatter/…  search/…  collab/…  git-sync/…
│  ├─ collab-server/main.ts          # `ws` + y-websocket; calls CollabModule only
│  └─ app/
│     ├─ routes/__root.tsx  index.tsx  bundles.$bundleId.tsx  bundles.$bundleId.concepts.$conceptId.tsx
│     ├─ routes/api.graphql.ts       # server route: POST → orchestrator.execute
│     ├─ components/{shell,sidebar,editor,frontmatter,presence,search}/
│     ├─ relay/environment.ts
│     └─ theme/tokens.stylex.ts
└─ tests/
   ├─ core/…  modules/…  server/…  components/…  adapters/…
   ├─ fakes/{fake-db.ts,fake-clock.ts,fake-ids.ts,fake-logger.ts,fake-fs.ts,fake-git.ts}
   └─ fixtures/{concepts.ts,frontmatter.ts,editor-states.ts}
```

### Configuration

Environment only. Never a config file, never a commit, never a log line.

```ts
// src/config/config.ts
import { z } from "zod";
import { ConfigError } from "../core/errors.js";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  COLLAB_WS_URL: z.string().url(),
  COLLAB_WS_PORT: z.coerce.number().int().positive().default(1234),
  GIT_SYNC_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  GIT_SYNC_INTERVAL_MS: z.coerce.number().int().min(1000).default(300_000),
  GIT_AUTHOR_NAME: z.string().min(1).default("okf-sync"),
  GIT_AUTHOR_EMAIL: z.string().email().default("okf-sync@localhost"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = Readonly<z.infer<typeof EnvSchema>>;

/** Pure over its argument — tests call it with a literal object, never process.env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError("Invalid configuration", {
      code: "config.invalid",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return Object.freeze(parsed.data);
}
```

### Error handling

One hierarchy, one translation point. Domain code throws typed `AppError`s; only
`errors-to-graphql.ts` converts them, and it never leaks an internal message for an unknown
error.

```ts
// src/server/errors-to-graphql.ts
import { GraphQLError } from "graphql";
import { AppError } from "../core/errors.js";

export function toGraphQLError(err: unknown, requestId: string): GraphQLError {
  if (err instanceof AppError) {
    return new GraphQLError(err.message, {
      extensions: { code: err.code, details: err.details, requestId },
    });
  }
  return new GraphQLError("Internal server error", {
    extensions: { code: "internal", requestId },
  });
}
```

```ts
// src/core/errors.ts (shape)
export abstract class AppError extends Error {
  abstract readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
    Error.captureStackTrace?.(this, new.target);
  }
}
```

**Rules.** No `catch {}` that swallows. No `console.*` in `src/` — the logger port only. Every
`catch` either rethrows or converts to a typed `AppError` carrying `cause`.

### Logging

```ts
// src/lib/logger.ts
import type { Logger } from "../server/ports.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

export function createLogger(opts: {
  level: Level;
  clock: { now(): Date };
  sink?: (line: string) => void;   // injected: tests pass an array push, never stdout
  base?: Record<string, unknown>;
}): Logger {
  const sink = opts.sink ?? ((l: string) => process.stdout.write(l + "\n"));
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[opts.level]) return;
    sink(JSON.stringify({ ts: opts.clock.now().toISOString(), level, msg, ...opts.base, ...fields }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info:  (m, f) => emit("info",  m, f),
    warn:  (m, f) => emit("warn",  m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...opts, base: { ...opts.base, ...fields } }),
  };
}
```

Never log `DATABASE_URL`, tokens, or full document bodies — ids and counts only.

### Dependency wiring (the composition root)

```ts
// src/server/bootstrap.ts — the ONLY module that constructs adapters.
import { loadConfig } from "../config/config.js";
import { createLogger } from "../lib/logger.js";
import { PgDb } from "../adapters/pg-db.js";
import { nodeClock } from "../adapters/node-clock.js";
import { uuidIds } from "../adapters/uuid-ids.js";
import { nodeFs } from "../adapters/node-fs.js";
import { gitCli } from "../adapters/git-cli.js";
import { createOrchestrator, type Orchestrator } from "./orchestrator.js";

let singleton: Orchestrator | null = null;

export function getOrchestrator(): Orchestrator {
  if (singleton) return singleton;
  const config = loadConfig();
  const clock = nodeClock();
  singleton = createOrchestrator(config, {
    db: new PgDb(config.DATABASE_URL),
    clock,
    ids: uuidIds(),
    logger: createLogger({ level: config.LOG_LEVEL, clock }),
    fs: nodeFs(),
    git: gitCli(),
  });
  return singleton;
}
```

### The GraphQL server route (thin)

```ts
// src/app/routes/api.graphql.ts
import { createServerFileRoute } from "@tanstack/react-start/server";
import { getOrchestrator } from "../../server/bootstrap.js";
import { requestBodySchema } from "../../server/schema.js";

export const ServerRoute = createServerFileRoute("/api/graphql").methods({
  POST: async ({ request }) => {
    const orchestrator = getOrchestrator();
    const parsed = requestBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ errors: [{ message: "Malformed GraphQL request", extensions: { code: "validation" } }] }, { status: 400 });
    }
    const requestId = crypto.randomUUID();
    const ctx = orchestrator.createRequestContext({ requestId, actor: await resolveActor(request) });
    const result = await orchestrator.execute({ ...parsed.data, ctx });
    return Response.json(result, { status: 200, headers: { "x-request-id": requestId } });
  },
});
```

### Database schema (representative)

```sql
-- sql/migrations/001_init.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE bundles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  git_remote  TEXT,
  git_branch  TEXT NOT NULL DEFAULT 'main',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE concepts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id   UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES concepts(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  is_index    BOOLEAN NOT NULL DEFAULT FALSE,
  trust       TEXT NOT NULL DEFAULT 'unverified'
                CHECK (trust IN ('unverified','machine-confirmed','human-reviewed')),
  lifecycle   TEXT NOT NULL DEFAULT 'draft'
                CHECK (lifecycle IN ('draft','active','deprecated','archived')),
  frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,   -- provenance, tags, unknown OKF keys
  content     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- serialized Lexical state + Yjs update (base64)
  plain_text  TEXT NOT NULL DEFAULT '',             -- derived from content, for FTS
  version     INTEGER NOT NULL DEFAULT 0,           -- optimistic concurrency
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bundle_id, parent_id, slug)
);

-- Research Part II §5: jsonb_path_ops for @> containment — smaller and faster than the default class.
CREATE INDEX concepts_content_gin   ON concepts USING GIN (content     jsonb_path_ops);
CREATE INDEX concepts_frontmatter_gin ON concepts USING GIN (frontmatter jsonb_path_ops);
CREATE INDEX concepts_fts ON concepts USING GIN (to_tsvector('english', title || ' ' || plain_text));
CREATE INDEX concepts_tree ON concepts (bundle_id, parent_id, slug);
```

### GraphQL conventions (Relay, mandated)

```graphql
interface Node { id: ID! }                       # base64("Type:localId")

type Concept implements Node {
  id: ID!
  title: String!
  slug: String!
  isIndex: Boolean!
  frontmatter: Frontmatter!
  document: Document!
  parent: Concept
  children(first: Int, after: String, last: Int, before: String): ConceptConnection!
  ancestors: [Concept!]!
}
type ConceptConnection { edges: [ConceptEdge!]!, pageInfo: PageInfo!, totalCount: Int! }
type ConceptEdge { node: Concept!, cursor: String! }
type PageInfo { hasNextPage: Boolean!, hasPreviousPage: Boolean!, startCursor: String, endCursor: String }

type Query {
  node(id: ID!): Node
  bundle(id: ID!): Bundle
  bundles(first: Int, after: String): BundleConnection!
  search(bundleId: ID!, query: String!, first: Int, after: String): SearchConnection!
}
type Mutation {
  createConcept(input: CreateConceptInput!): CreateConceptPayload!
  updateFrontmatter(input: UpdateFrontmatterInput!): UpdateFrontmatterPayload!
  saveDocument(input: SaveDocumentInput!): SaveDocumentPayload!
  moveConcept(input: MoveConceptInput!): MoveConceptPayload!
  syncBundleToGit(input: SyncBundleInput!): SyncBundlePayload!
}
```

Every mutation payload returns the mutated `Node` (so Relay's normalized store updates every
subscriber by global id) plus a `clientMutationId`.

---

## Testing Strategy

> **Tests are part of every module's deliverable.** A module whose tests do not exist is not
> built. Implementation subagents MUST create the test file in the same unit of work as the
> source file, and the module's acceptance criterion is `pnpm test` passing with those tests
> present.

### Runner, libraries, and exact dev dependencies

| Package | Purpose |
|---|---|
| `vitest` | Test runner + `expect` assertion library (Jest/Chai-compatible) + `vi` mocking. |
| `@vitest/coverage-v8` | Coverage with enforced thresholds. |
| `@testing-library/react` | Render React components into jsdom; query by accessible role/label. |
| `@testing-library/user-event` | Realistic interaction (typing, clicking, tabbing). |
| `@testing-library/jest-dom` | `toBeInTheDocument`, `toHaveTextContent`, `toBeDisabled` matchers. |
| `jsdom` | DOM environment for component tests. |
| `@vitejs/plugin-react` | JSX transform for tests. |
| `relay-test-utils` | `createMockEnvironment` / `MockPayloadGenerator` — Relay components tested with zero network. |

### Config files (both required, at the project root)

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "jsdom",
    globals: false,                       // explicit imports from "vitest" — no ambient magic
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    passWithNoTests: false,               // MANDATORY: an empty suite is a failure
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.d.ts", "src/app/routes/**/*.css.ts", "src/**/__generated__/**"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
```

```ts
// vitest.setup.ts
import { afterEach, expect, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

// Any test that hits the network is a bug, not a flake: make it fail loudly.
vi.stubGlobal("fetch", vi.fn(() => {
  throw new Error("Network access is forbidden in unit tests. Fake at the module boundary.");
}));

// A React warning (act(), key, prop types) fails the test that produced it.
const originalError = console.error;
console.error = (...args: unknown[]) => {
  originalError(...args);
  throw new Error(`console.error during test: ${String(args[0])}`);
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
```

### File naming and location — ONE convention

**All tests live under `tests/`, mirroring `src/`, named `<subject>.test.ts` (or `.test.tsx`
for anything that renders React).**

```
src/core/cursors.ts                       → tests/core/cursors.test.ts
src/modules/concepts/service.ts           → tests/modules/concepts/service.test.ts
src/modules/concepts/repo.ts              → tests/modules/concepts/repo.test.ts
src/server/registry.ts                    → tests/server/registry.test.ts
src/app/components/sidebar/SidebarTree.tsx → tests/components/sidebar/SidebarTree.test.tsx
```

No `__tests__` directories, no `.spec.` suffix, no tests inside `src/`. Shared fakes live in
`tests/fakes/`, shared fixtures in `tests/fixtures/`. Fixtures are named for what makes them
interesting: `conceptWithCyclicParent`, `frontmatterMissingTrust`, `editorStateWithCodeBlock`.

### package.json scripts

```json
{
  "scripts": {
    "dev": "vite dev --port 3000",
    "build": "vite build",
    "start": "node .output/server/index.mjs",
    "collab": "node --experimental-strip-types src/collab-server/main.ts",
    "typecheck": "tsc --noEmit",
    "relay": "relay-compiler",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "migrate": "node scripts/migrate.mjs",
    "verify": "pnpm typecheck && pnpm test"
  }
}
```

`test` is `vitest run` — non-interactive, whole suite, **no `--passWithNoTests`** (and the
config pins `passWithNoTests: false`, so an empty or mis-globbed suite exits non-zero).
`vitest run` also fails if any file has zero tests collected.

### Per-layer coverage requirements

**1. Pure functions / parsers / codecs (`src/core/**`) — exhaustive tables.**

- `encodeGlobalId`/`decodeGlobalId`: round-trip for every `NodeTypeName`; reject non-base64,
  reject missing separator, reject unknown type — assert `InvalidGlobalIdError` and its `code`.
- `encodeCursor`/`decodeCursor`: round-trip; ordering preserved; reject tampered cursor.
- `buildConnection`: empty rows → `hasNextPage:false`, null cursors; `first` smaller than rows →
  `hasNextPage:true`; `first: 0`; `first` and `last` both supplied → `ValidationError`.
- `parseOkfDocument`: valid frontmatter+body; body-only (no fences); unterminated fence;
  malformed YAML; duplicate keys; unknown trust value; unknown keys preserved in `extra`;
  CRLF line endings; empty body.
- `serializeOkfDocument`: round-trips `parseOkfDocument` for every fixture; key order stable.
- Markdown transforms: each block type (paragraph, h1–h3, ul, ol, code, quote, divider)
  serializes and re-parses to an equivalent editor state; unknown node type → `ValidationError`.

**2. Data-access modules (`src/modules/*/repo.ts`) — against `FakeDb`, never Postgres.**

`tests/fakes/fake-db.ts` implements the `Db` interface with a recorded call log and a
programmable response queue:

```ts
export function createFakeDb(): Db & {
  calls: { sql: string; params: readonly unknown[] }[];
  enqueue(rows: QueryRow[], rowCount?: number): void;
  enqueueError(err: Error): void;
} { /* … */ }
```

Every repo test asserts:
- **the exact SQL shape** (contains `jsonb_path_ops` operator `@>` where required; contains the
  expected `WHERE`/`ORDER BY`/`LIMIT`) and **the exact parameter array** — this is how we prove
  queries stay parameterised;
- **row → domain mapping** on real values (a returned row becomes a `Concept` with a branded id);
- **empty result** → `NotFoundError` for `getById`, `[]` for list queries;
- **driver error** → wrapped in `StorageError` with `cause` preserved;
- **transaction semantics**: a throwing callback rolls back and rethrows the original error
  unchanged (assert identity, not just type).

A single integration smoke test may run against a real Postgres **only** behind
`describe.skipIf(!process.env.INTEGRATION_DATABASE_URL)`; it is not part of `pnpm test`'s
required path and never substitutes for the unit tests above.

**3. Service / business logic (`src/modules/*/service.ts`) — repo faked, all branches.**

Each service test injects a fake repo (a plain object satisfying the repo interface, built with
`vi.fn()`), `FakeClock` (fixed `Date`), `FakeIds` (`uuid()` returns `id-1`, `id-2`, …), and
`FakeLogger` (collects lines).

Required cases per service:
- happy path asserted on the **returned value**, not "did not throw";
- every branch: `ConceptModule.move` — valid reparent, move to root, move onto self
  (`ConflictError("hierarchy.cycle")`), move onto a descendant (same), move to a parent in a
  different bundle (`ValidationError`);
- `setIndexDocument` — set true when no sibling index, set true when one exists (`ConflictError`),
  set false;
- `delete(cascade:false)` with children → `ConflictError`; `cascade:true` → children removed;
- `DocumentModule.save` — matching version succeeds and increments; stale version →
  `ConflictError("document.staleVersion")`; version 0 on a fresh concept;
- `FrontmatterModule.validateTransition` — table of all 16 `(from,to)` lifecycle pairs, legal
  ones return the merged value, illegal ones throw with `code === "validation"` and
  `details.reason === "frontmatter.illegalTransition"`;
- `SearchModule.normalizeQuery` — normal query, extra whitespace, punctuation-only, empty string
  and `"   "` → `ValidationError("search.emptyQuery")`;
- `GitSyncModule.planExport` — empty bundle → `[]`; nested concepts → correct `index.md` paths;
  deterministic ordering asserted by comparing the full array; a title with `/` is slugified,
  not written as a directory (path-traversal guard, asserted explicitly);
- boundary/empty everywhere: empty title, `first: 0`, `after` pointing past the end, `null`
  parent, empty `tags`, frontmatter with only required keys.

**4. Orchestrator & registry (`src/server/**`).**

- `wireModules`: correct topological order; a cycle throws `ConfigError("module.cycle")`; an
  undeclared dependency throws `ConfigError("module.missingDependency")`; a module receives
  **only** the deps it declared (assert the `deps` object's keys).
- `createOrchestrator` with fake ports: `schema()` is memoized (two calls, same object
  identity); `execute()` returns `data` on a valid query, returns `errors` with the mapped
  `extensions.code` when a resolver throws an `AppError`, and returns `code: "internal"` with
  **no leaked message** when a resolver throws a raw `Error`.
- `toGraphQLError`: one case per `AppError` subclass plus the unknown-error path.
- GraphQL resolvers: executed with `graphql()` against the merged schema and fake modules —
  assert `data` for each query/mutation, and assert Relay-shape invariants (`edges[].cursor`
  present, `pageInfo` complete, `id` decodes to the expected type).
- `loadConfig`: valid env; missing `DATABASE_URL` → `ConfigError` with the offending path in
  `details.issues`; non-numeric `PORT`; out-of-range `GIT_SYNC_INTERVAL_MS`; defaults applied.

**5. Route handlers (`src/app/routes/api.graphql.ts`).**

Call the exported handler directly with a real `Request` object and a fake orchestrator:
- valid body → 200, `data` present, `x-request-id` header set;
- malformed JSON and body failing the zod schema → 400 with `extensions.code === "validation"`;
- resolver-level `AppError` → 200 with `errors[0].extensions.code` (GraphQL semantics);
- no real HTTP server is started.

**6. React components (`src/app/components/**`) — render, interact, assert output.**

Using `@testing-library/react` + `user-event` + `relay-test-utils`:

```tsx
// tests/components/frontmatter/FrontmatterPanel.test.tsx
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMockEnvironment, MockPayloadGenerator } from "relay-test-utils";
import { RelayEnvironmentProvider } from "react-relay";
import { FrontmatterPanel } from "@/app/components/frontmatter/FrontmatterPanel";

describe("FrontmatterPanel", () => {
  test("renders the persisted trust level and lifecycle", async () => {
    const env = createMockEnvironment();
    render(
      <RelayEnvironmentProvider environment={env}>
        <FrontmatterPanel conceptId="Q29uY2VwdDox" />
      </RelayEnvironmentProvider>,
    );
    env.mock.resolveMostRecentOperation((op) =>
      MockPayloadGenerator.generate(op, {
        Concept: () => ({ frontmatter: { trust: "human-reviewed", lifecycle: "active", tags: ["runtime"] } }),
      }),
    );
    expect(await screen.findByLabelText("Trust")).toHaveValue("human-reviewed");
    expect(screen.getByText("runtime")).toBeInTheDocument();
  });

  test("commits an optimistic update when trust is changed", async () => {
    const env = createMockEnvironment();
    render(/* … */);
    env.mock.resolveMostRecentOperation((op) => MockPayloadGenerator.generate(op));
    await userEvent.selectOptions(await screen.findByLabelText("Trust"), "machine-confirmed");
    const mutation = env.mock.getMostRecentOperation();
    expect(mutation.fragment.node.name).toBe("FrontmatterPanelUpdateMutation");
    expect(mutation.request.variables.input.trust).toBe("machine-confirmed");
  });

  test("shows the server error and restores the previous value when the mutation fails", async () => {
    // env.mock.rejectMostRecentOperation(new Error("boom"))
    // assert the error text renders AND the select is back to its original value
  });
});
```

Component coverage required per component:
- **`SidebarTree`** — renders the first page; clicking "Load more" requests the next page with
  the returned `endCursor`; an empty connection renders the empty state, not a spinner; a node
  with `hasNextPage:false` shows no "Load more"; expanding a leaf issues no query.
- **`ConceptEditor`** — mounts the Lexical composer with the registered custom nodes; typing
  `"# "` converts the paragraph to a `HeadingNode` (assert the serialized state, not the DOM
  class); typing `"- "` produces a list item; `readOnly` disables editing; the markdown
  round-trip (`fromMarkdown → toMarkdown`) is asserted on the editor state for each block type.
  Custom node classes are additionally unit-tested directly: constructor initialises **every**
  custom property (the `@lexical/yjs` serialization requirement from the research),
  `clone`/`importJSON`/`exportJSON` round-trip, `$isX` type guard true and false cases.
- **`AppShell`** — renders slots; the theme toggle switches the Astryx theme attribute and the
  choice is read back from the injected storage fake.
- **`PresenceBar`** — zero peers renders nothing; N peers renders N badges; a peer without a
  name falls back to a placeholder.
- **`SearchPanel`** — debounce asserted with `vi.useFakeTimers()`; empty query never issues an
  operation; results render; zero results renders the empty state; an errored operation renders
  the error.

**7. Collaboration and CRDT logic.**

`CollabModule`'s pure functions (`roomNameFor`, `conceptIdFor`) get table tests including
malformed room names. `onRoomUpdate` is tested with **real `yjs` in-memory docs** (yjs is a pure
library — no network, fully deterministic): construct two `Y.Doc`s, apply divergent updates,
merge, and assert convergence and that applying the same update twice is a no-op. The
`y-websocket` provider is **never** instantiated in a test; the websocket server module is
tested by calling `CollabModule` directly with a fake `DocumentModule`.

### How external systems are faked

| System | Faking strategy |
|---|---|
| **PostgreSQL** | Never touched. Repos depend on the `Db` interface; tests inject `createFakeDb()`. `pg` is not imported anywhere except `src/adapters/pg-db.ts`, whose own test uses `vi.mock("pg")` and asserts the pool config, the parameterised call, and `ROLLBACK` on error. |
| **Network / HTTP** | `fetch` is stubbed in `vitest.setup.ts` to throw. Relay components use `relay-test-utils`' mock environment — no transport at all. |
| **Websockets** | `y-websocket` and `ws` never instantiated in unit tests; only `CollabModule` (pure + `DocumentModule` fake) is exercised. |
| **Child processes (git)** | `GitPort` is an interface; `createFakeGit()` records commands. `src/adapters/git-cli.ts` is tested with `vi.mock("node:child_process")`, asserting the **exact argv array** (proving no shell string is ever built), the working directory, and non-zero-exit → `GitSyncError` with the `stage` detail. |
| **Filesystem** | `FsPort` with `createFakeFs()` — an in-memory `Map<string,string>` exposing `files` for assertions. `src/adapters/node-fs.ts` is tested with `vi.mock("node:fs/promises")`. No test writes to disk. |
| **Clock** | `Clock` port; `createFakeClock(new Date("2026-01-01T00:00:00Z"))` with `advance(ms)`. `Date.now()` is never called in `src/`. Timer-driven UI uses `vi.useFakeTimers()` (reset in the global `afterEach`). |
| **Randomness / ids** | `IdGenerator` port; `createFakeIds()` returns `"00000000-0000-4000-8000-000000000001"`, `…002`, … in order. `crypto.randomUUID()` appears only in the route handler, which tests fake by injecting the orchestrator. |
| **Environment** | `loadConfig(env)` takes the env object as an argument; tests pass literals. `process.env` is never mutated (`unstubEnvs: true` guards the exceptions). |

### Definition of done (per module, enforced by acceptance criteria)

```
[ ] pnpm typecheck              clean, zero errors
[ ] pnpm test                   whole suite passes; no .skip, no .only, no --passWithNoTests
[ ] every exported symbol in the module has at least one test asserting a real value
[ ] every branch, boundary, and failure mode listed above is covered
[ ] no test imports pg, ws, y-websocket, node:fs, or node:child_process outside tests/adapters/
[ ] coverage thresholds (90/90/85/90) met
```

A CI-style guard test, `tests/meta/no-skipped-tests.test.ts`, greps the `tests/` tree and fails
if it finds `describe.skip`, `test.skip`, `it.skip`, `.only`, or `--passWithNoTests` anywhere.

---

## Best Practices

### Type safety

- `tsconfig.json` is strict and stays strict: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`.
- Consequences to design around: index access is `T | undefined` (`rows[0]?.id`); never assign
  `undefined` to an optional property — spread conditionally (`...(x ? { x } : {})`).
- **Branded ids** (`ConceptId`) make it impossible to pass a `BundleId` where a `ConceptId`
  belongs. Construction goes through `toConceptId(raw)`, which validates the UUID shape.
- **`unknown` at every boundary, `zod` immediately after.** No `any` in `src/`; no non-null `!`
  outside the registry's `deps` access (which `wireModules` has already proven non-null).
- Exhaustive `switch` over union types with a `assertNever(x: never)` default.
- `relay-compiler` generates types for every fragment/query; hand-written GraphQL response types
  are forbidden.

### Security

- **Every SQL statement is parameterised** (`$1`, `$2`). String concatenation of user input into
  SQL is an automatic review failure; repo tests assert the params array.
- **`execFile` with an argv array** for git — never `exec` with a shell string. Repo directories
  are resolved against the configured export root and rejected if the resolved path escapes it
  (`path.relative(root, target).startsWith("..")` → `ValidationError`).
- **Export paths are slugified**, so a concept titled `../../etc/passwd` cannot produce a
  traversal. Asserted by a dedicated test.
- Secrets from environment only; never in files, logs, or tests. The logger has a field
  denylist.
- GraphQL: query depth and complexity limits enforced in `orchestrator.execute` before
  execution; introspection disabled when `NODE_ENV === "production"`.
- Frontmatter and editor state are validated with zod on **read** as well as write — a hostile
  or corrupted `JSONB` row cannot become a typed value.
- No `dangerouslySetInnerHTML`. Markdown rendering goes through Lexical's node tree, never
  through raw HTML injection.
- CSRF: the GraphQL route accepts `POST` with `content-type: application/json` only.

### Performance

- **StyleX compile-time CSS**: zero runtime style computation; atomic classes deduplicate
  across the whole app.
- **Astryx context-aware spacing compensation** is relied on for nested layout rather than
  hand-tuned negative margins.
- **Relay Connections** load the sidebar one level at a time (`first: 50`); the tree is never
  fetched whole. `@defer`-free, cursor-based, with `usePaginationFragment`.
- **GIN `jsonb_path_ops`** for `@>` containment; a covering btree `(bundle_id, parent_id, slug)`
  for tree traversal; FTS via a GIN `tsvector` index.
- **Yjs binary updates** over the websocket — never JSON. Updates are debounced (250 ms) before
  being flushed to Postgres, and persistence is a single `UPDATE … SET content = …` with an
  optimistic `version` check.
- **Lexical `NodeTransforms`** batch multiple mutations into one reconciliation pass — markdown
  shortcuts never trigger a second render.
- The `plain_text` column is derived on write so search never parses `JSONB` at query time.
- `pg` pool sized from config; every repo method issues exactly one round trip unless it
  declares a transaction.

---

## Deployment Shape

### Processes

| Process | Command | Port | Role |
|---|---|---|---|
| App server | `pnpm start` (`node .output/server/index.mjs`) | `3000` | TanStack Start SSR + `/api/graphql`. |
| Collaboration server | `pnpm collab` | `1234` | `ws` + y-websocket relay; persistence via `CollabModule`. |
| PostgreSQL 17 | container | `5432` | Persistence. |
| Git sync worker | in-process timer in the app server, gated by `GIT_SYNC_ENABLED` | — | Periodic OKF export + commit + push. |

### Local development

```bash
docker compose up -d postgres      # postgres:17
cp .env.example .env               # fill DATABASE_URL, COLLAB_WS_URL
pnpm install
pnpm migrate                       # applies sql/migrations/*.sql in order
pnpm relay                         # generates __generated__ artifacts
pnpm dev                           # http://localhost:3000
pnpm collab                        # second terminal: ws://localhost:1234
pnpm verify                        # typecheck + full test suite
```

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: ekw
      POSTGRES_PASSWORD: ekw
      POSTGRES_DB: ekw
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ekw"]
      interval: 5s
      retries: 10
volumes: { pgdata: {} }
```

### Production

- `pnpm build` produces the Vite/Nitro output; StyleX CSS is extracted at build time by
  `@astryxdesign/build`, and `relay-compiler` runs in the same step (`prebuild`).
- App server and collaboration server are separate containers from the same image, differing
  only in entrypoint. The collaboration server is stateless with respect to durable data —
  authority lives in Postgres; a restarted room reloads via `CollabModule.onRoomOpen`.
- Migrations run as a one-shot job before the app rollout (`pnpm migrate`); they are additive
  and forward-only.
- Health: `GET /api/health` returns `{ ok, version, db: "up" | "down" }` — the only endpoint
  permitted to touch the database outside a resolver.
- Observability: structured JSON logs to stdout with `requestId` on every line; the collector is
  the platform's, not the app's.
- Rollback: containers are versioned; because migrations are additive, rolling the app back one
  version never requires a schema rollback.

### Build gate

CI runs, in order, and all must pass:

```
pnpm install --frozen-lockfile
pnpm relay          # generated artifacts must be current
pnpm typecheck
pnpm test           # vitest run — no --passWithNoTests, no skipped tests
pnpm build
```

A red test suite blocks the build. There is no path by which an untested module ships.