# Architecture — Quick Notes

## Technology Choices

- **Application framework: TanStack Start** (React, file-based routing, server functions, Vite). No framework was mandated by the research beyond "best default full-stack React framework," so per the framework rule this defaults to TanStack Start. It gives us file-based routes, `createServerFn` RPC-style server functions, and Vite tooling in one package — no separate Express/API server is needed for a 6-module CRUD app.
- **Build tooling: Vite** — fast dev server and build, as required by the research (`npm run dev`, `npm run build`).
- **Testing: Vitest** — colocates with Vite config, required by research (`npm test`).
- **Database: PostgreSQL**, accessed via the raw `pg` driver (`node-postgres`). No ORM — the schema is a single table with five columns, so an ORM would add indirection without value.
- **Language: TypeScript** throughout (routes, server functions, store, tests) for compile-time safety on the Note shape.
- **Styling:** plain CSS (a single stylesheet). No UI kit — the UI is one list view and one form; a component library would be gold-plating.
- **Validation: Zod** — small, works naturally with TanStack Start server functions' `.validator()` hook, and gives us one source of truth for the title/body constraints from the research (title 1–200 chars, body ≤10,000 chars).

## Central Orchestrator

**Module:** `NotesService` (`app/server/notes-service.ts`)

`NotesService` is the single module every other part of the app funnels through. Routes never talk to a store directly, and the two store implementations never talk to each other or to the UI — everything is mediated by this orchestrator.

Responsibilities:
- Owns the one `NoteStore` instance for the process (selected at startup — Postgres or in-memory).
- Validates all input (via the shared Zod schema) before it reaches a store.
- Applies domain rules that are store-agnostic: list ordering (`updated_at desc`), stamping `created_at`/`updated_at`.
- Exposes the **only** public interface the rest of the app is allowed to call, as a set of TanStack Start server functions (this doubles as the orchestrator's public API and the client/server RPC boundary — no separate API layer is needed).

Public interface (exported server functions, `app/server/notes-service.ts`):

```ts
export const listNotes = createServerFn({ method: 'GET' })
  .handler(async (): Promise<NoteSummary[]> => { ... })

export const getNote = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<Note> => { ... })

export const createNote = createServerFn({ method: 'POST' })
  .validator(NoteInputSchema)
  .handler(async ({ data }): Promise<Note> => { ... })

export const updateNote = createServerFn({ method: 'POST' })
  .validator(NoteInputSchema.extend({ id: z.string().uuid() }))
  .handler(async ({ data }): Promise<Note> => { ... })

export const deleteNote = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<void> => { ... })
```

**Registration:** the two store implementations "register" with the orchestrator by satisfying the `NoteStore` interface (declared in its own module, see below) and being handed to `NotesService` through a single factory call, `createNoteStore()`, invoked once at module load:

```ts
const store: NoteStore = createNoteStore(process.env.DATABASE_URL);
```

No other module is permitted to import `PostgresNoteStore` or `InMemoryNoteStore` directly — only `NotesService` does, via the factory.

## Modules

### 1. `NotesService` (Central Orchestrator)
- **Responsibility:** validation, domain rules, and the public server-function API (see above).
- **Public interface:** `listNotes`, `getNote`, `createNote`, `updateNote`, `deleteNote` (server functions); `NoteInputSchema` (Zod schema, re-exported for client-side form validation).
- **Depends on:** `NoteStore` contract module (interface + factory) only.

### 2. `NoteStore` contract (`app/server/note-store.ts`)
- **Responsibility:** declares the storage-agnostic interface every store must implement, and the `createNoteStore()` factory that picks an implementation based on `DATABASE_URL`.
- **Public interface:**
  ```ts
  export interface NoteStore {
    list(): Promise<Note[]>;
    get(id: string): Promise<Note | null>;
    create(input: { title: string; body: string }): Promise<Note>;
    update(id: string, input: { title: string; body: string }): Promise<Note | null>;
    remove(id: string): Promise<boolean>;
  }
  export function createNoteStore(databaseUrl: string | undefined): NoteStore;
  ```
- **Depends on:** nothing (pure contract + factory wiring). Imports the two implementations below only inside the factory function body.

### 3. `PostgresNoteStore` (`app/server/postgres-note-store.ts`)
- **Responsibility:** implements `NoteStore` against PostgreSQL using `pg`. Owns the connection pool and the `notes` table SQL.
- **Public interface:** default export `class PostgresNoteStore implements NoteStore`.
- **Depends on:** `NoteStore` contract (for the interface shape) and the `pg` package. Never imported by anything except the factory in module 2.

### 4. `InMemoryNoteStore` (`app/server/in-memory-note-store.ts`)
- **Responsibility:** implements `NoteStore` with a process-local array, used automatically when `DATABASE_URL` is unset. Enables local demo/test use without a database, per the research's graceful-degradation requirement.
- **Public interface:** default export `class InMemoryNoteStore implements NoteStore`.
- **Depends on:** `NoteStore` contract only. Never imported by anything except the factory in module 2.

### 5. `NotesListRoute` (`app/routes/index.tsx`)
- **Responsibility:** the list view — fetches notes via `listNotes`, renders title/updated-at/truncated-body preview, a "New note" link, and per-row delete (calling `deleteNote`). Renders the empty-list state.
- **Public interface:** none (leaf route component); consumed only by the TanStack Start router.
- **Depends on:** `NotesService`'s exported server functions only.

### 6. `NoteEditorRoute` (`app/routes/notes.$noteId.tsx`, with `$noteId` = `"new"` for creation)
- **Responsibility:** the create/edit form — loads an existing note via `getNote` when editing, client-side validates with `NoteInputSchema`, and submits to `createNote`/`updateNote`.
- **Public interface:** none (leaf route component); consumed only by the router.
- **Depends on:** `NotesService`'s exported server functions and schema only.

No module imports another module's internals — routes import only `NotesService`'s exported server functions/schema; `NotesService` imports only the `NoteStore` contract module; the two store implementations import only the contract module. This keeps the dependency graph a strict two-level tree with `NotesService` at the root.

## Plumbing & Conventions

**Folder layout:**
```
app/
  routes/
    index.tsx              # NotesListRoute
    notes.$noteId.tsx       # NoteEditorRoute (noteId="new" => create mode)
    __root.tsx
  server/
    notes-service.ts        # Central Orchestrator + server functions
    note-store.ts            # NoteStore interface + createNoteStore() factory
    postgres-note-store.ts
    in-memory-note-store.ts
    schema.sql                # notes table DDL, run manually / via psql on deploy
  styles/
    app.css
tests/
  notes-service.test.ts
  in-memory-note-store.test.ts
  note-editor-route.test.tsx
app.config.ts
vite.config.ts
package.json
.env.example
```

**Configuration:** a single environment variable, `DATABASE_URL`. Read once in `note-store.ts`:
```ts
export function createNoteStore(databaseUrl: string | undefined): NoteStore {
  return databaseUrl ? new PostgresNoteStore(databaseUrl) : new InMemoryNoteStore();
}
```
`.env.example` documents `DATABASE_URL=postgres://user:pass@localhost:5432/quick_notes`. No other config surface — no feature flags, no multi-environment matrix.

**Validation & errors:** `NoteInputSchema` (Zod) is the single source of truth for the title/body rules:
```ts
export const NoteInputSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  body: z.string().max(10_000).default(''),
});
```
Server functions let Zod's thrown error propagate — TanStack Start serializes it back to the client as a rejected call, which the editor route catches and renders inline next to the offending field. `getNote`/`update`/`delete` on a missing id throw a plain `Error('Note not found')`, caught by the route and shown as a toast/message rather than crashing. No custom error hierarchy — the app is too small to justify one.

**Logging:** a one-line wrapper (`console.error` in the catch block of each server function) is sufficient at this scale; no logging library. Example:
```ts
export const deleteNote = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const removed = await store.remove(id);
    if (!removed) throw new Error('Note not found');
  });
```

**Dependency wiring:** all wiring is static module-level composition (the `store` const in `notes-service.ts`, built once via `createNoteStore(process.env.DATABASE_URL)`) — no DI container, since there is exactly one thing to wire.

**Postgres schema** (`app/server/schema.sql`, applied manually via `psql -f schema.sql` before first run in a real Postgres environment):
```sql
create extension if not exists pgcrypto;

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  title varchar(200) not null,
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notes_updated_at_idx on notes (updated_at desc);
```

## Best Practices

- **Testing:** Vitest for unit tests, run via `npm test`.
  - `notes-service.test.ts` — exercises `NotesService` against an `InMemoryNoteStore`, covering create/list-ordering/update/delete and the title/body validation edge cases (empty title, 201-char title, 10,001-char body).
  - `in-memory-note-store.test.ts` — direct `NoteStore` contract tests (also runnable against `PostgresNoteStore` behind a `DATABASE_URL`-gated `describe.skipIf` block, so CI without a database still passes).
  - A couple of component-level tests for `NoteEditorRoute` (required-field validation renders an error, submit calls `createNote`) round out "a few unit tests" from the requirements — no exhaustive e2e suite, matching the small-app scope.
- **Type safety:** the `Note` type is inferred once from the Zod schema plus generated fields (`id`, `created_at`, `updated_at`) and reused everywhere — store, service, routes — so there is one canonical shape, no duplicate hand-written interfaces.
- **Security:** the `pg` driver's parameterized queries are used exclusively in `PostgresNoteStore` (no string-concatenated SQL), which closes SQL injection. No auth is in scope (single-user app per the research). Zod validation on the server function boundary means the store never receives unvalidated input, even if a client bypasses the UI.
- **Performance:** the `notes_updated_at_idx` index backs the list query's `order by updated_at desc`. List view truncates long bodies client-side (CSS `line-clamp` or a simple substring) rather than fetching a truncated column, keeping the store logic simple. No pagination — out of scope at this app's expected scale, consistent with "avoid gold-plating."

## Deployment Shape

- **Local dev:** `npm run dev` starts the TanStack Start Vite dev server (React app + server functions on one process/port). Without `DATABASE_URL` set, `InMemoryNoteStore` kicks in automatically so the UI is fully usable with zero setup; with a local Postgres running and `DATABASE_URL` exported, notes persist there instead.
- **Build:** `npm run build` produces the TanStack Start production build (client bundle + server function bundle) via Vite/Nitro.
- **Production run:** the built server is started with `node .output/server/index.mjs` (TanStack Start's standard Nitro output), behind whatever process manager/hosting the deploy target uses. `DATABASE_URL` must be set in production so `PostgresNoteStore` is selected — the in-memory fallback is a dev/demo convenience only, not intended for production use (data would not persist across restarts and would not be shared across instances).
- **Database:** a standard managed or self-hosted PostgreSQL instance; `schema.sql` is applied once against it before the app's first run. No migration framework — a single static DDL file matches the single-table scope.
- **Single deployable unit:** one process serves both the UI and the server functions; there is no separate API service to deploy or version independently.