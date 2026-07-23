# Architecture — Quick Notes

## Technology Choices

- **Application framework: TanStack Start** (React 18+, file-based routing, server functions, Vite-based build). No stack was mandated by the domain research beyond "best default full-stack React framework," so per the framework rule this project defaults to TanStack Start. Server functions (`createServerFn`) remove the need for a separate Express/API layer — the note CRUD operations run as typed server functions colocated with routes.
- **Language: TypeScript** throughout (client, server functions, data layer) for end-to-end type safety on the `Note` shape.
- **Database: PostgreSQL**, accessed via the `pg` driver directly (no ORM — the schema is a single table, and the research explicitly says no ORM is needed at this scale).
- **Build tooling: Vite** (bundled with TanStack Start) for dev server and production build.
- **Testing: Vitest** for unit tests, per the research's stated test command (`npm test`).
- **Styling:** plain CSS module(s) — no UI/component library. The UI is two views (list + editor form); a library would be gold-plating for this scope.
- **Fallback store:** when `DATABASE_URL` is unset, the app runs against an in-memory store implementing the same repository interface, so `npm run dev` and demos work without PostgreSQL provisioned.

## Central Orchestrator

**Module: `NoteService`** (`src/server/note-service.ts`)

`NoteService` is the single coordination point for all note business logic. Nothing else in the app talks directly to the data layer, and no UI code talks directly to PostgreSQL. Routes/server functions call `NoteService`; `NoteService` calls the repository.

Responsibilities:
- Own the note lifecycle: validate input, enforce business rules (title required 1–200 chars, body max 10,000 chars), stamp `created_at`/`updated_at`.
- Decide which repository implementation is active (Postgres vs in-memory) at construction time, based on config, and expose one uniform interface regardless of backend.
- Be the sole consumer of the `NoteRepository` interface — no other module imports a repository implementation directly.
- Translate repository errors into typed `NoteServiceError`s that server functions can map to HTTP-friendly responses.

Public interface:

```ts
// src/server/note-service.ts
export interface NoteInput {
  title: string;
  body?: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export class NoteService {
  listNotes(): Promise<Note[]>;                       // ordered updated_at desc
  getNote(id: string): Promise<Note | null>;
  createNote(input: NoteInput): Promise<Note>;
  updateNote(id: string, input: NoteInput): Promise<Note>;
  deleteNote(id: string): Promise<void>;
}

// Singleton wiring — the one place that picks the backend.
export function getNoteService(): NoteService;
```

**Registration model:** this app has no plugin/runtime module registry (out of scope for a 4–6 module app) — "registration" here means static dependency injection at construction: `getNoteService()` builds one `NoteRepository` (Postgres or in-memory, chosen once from config) and injects it into a `NoteService` instance, memoized as a module-level singleton. Every server function calls `getNoteService()` rather than constructing its own instance or importing a repository directly. This is the enforced boundary: **UI → server functions → NoteService → NoteRepository → Postgres/memory**, no layer skipped.

## Modules

Six modules total, each with a narrow, declared interface. No module reaches around `NoteService` or around the repository interface.

### 1. `note-repository` (`src/server/note-repository.ts`)
- **Responsibility:** persistence contract + two implementations (Postgres, in-memory). Pure data access, no business rules (validation lives in `NoteService`).
- **Public interface:**
  ```ts
  export interface NoteRepository {
    list(): Promise<Note[]>;
    findById(id: string): Promise<Note | null>;
    insert(note: Note): Promise<Note>;
    update(id: string, patch: Partial<Pick<Note,'title'|'body'|'updatedAt'>>): Promise<Note | null>;
    remove(id: string): Promise<boolean>;
  }
  export class PostgresNoteRepository implements NoteRepository { constructor(pool: Pool) {} ... }
  export class InMemoryNoteRepository implements NoteRepository { ... }
  ```
- **Dependencies:** `db-client` (for `PostgresNoteRepository`'s `Pool`); no dependency on `NoteService` or routes.

### 2. `db-client` (`src/server/db-client.ts`)
- **Responsibility:** own the PostgreSQL connection pool and schema bootstrap (creates `notes` table + index if not present, using `CREATE TABLE IF NOT EXISTS`). Reads `DATABASE_URL` from `config`.
- **Public interface:**
  ```ts
  export function getPool(): Pool | null;   // null when DATABASE_URL is unset
  export async function ensureSchema(pool: Pool): Promise<void>;
  ```
- **Dependencies:** `config`. Consumed only by `note-repository`.

### 3. `config` (`src/server/config.ts`)
- **Responsibility:** single source of truth for environment configuration (`DATABASE_URL`, `PORT`). No other module reads `process.env` directly.
- **Public interface:**
  ```ts
  export interface AppConfig { databaseUrl: string | null; }
  export function getConfig(): AppConfig;
  ```
- **Dependencies:** none.

### 4. `note-service` (described above as Central Orchestrator) — also counts as a module in the 4–6 budget.
- **Dependencies:** `note-repository`, `config` (to decide backend).

### 5. Server functions / routes — `src/routes/` (TanStack Start file-based routes + `createServerFn` calls)
- **Responsibility:** HTTP/RPC boundary. `src/routes/index.tsx` renders the list view and loads notes via a server function; `src/routes/notes.$noteId.tsx` (and `notes.new.tsx`) render the editor form. Server functions here are thin: parse/forward input to `NoteService`, map `NoteServiceError` to a client-safe error shape.
- **Public interface (server functions, callable from client code via TanStack Start's RPC):**
  ```ts
  export const listNotesFn = createServerFn({ method: 'GET' }).handler(...);
  export const getNoteFn = createServerFn({ method: 'GET' }).validator(...).handler(...);
  export const createNoteFn = createServerFn({ method: 'POST' }).validator(...).handler(...);
  export const updateNoteFn = createServerFn({ method: 'POST' }).validator(...).handler(...);
  export const deleteNoteFn = createServerFn({ method: 'POST' }).validator(...).handler(...);
  ```
- **Dependencies:** `note-service` only (never `note-repository` or `db-client` directly).

### 6. UI components — `src/components/` (`NoteList`, `NoteListItem`, `NoteForm`)
- **Responsibility:** presentation only. `NoteList` renders notes (title, updated date, truncated body preview, delete button) and empty state. `NoteForm` is the create/edit form (title + body fields, client-side length validation mirroring server rules, save/cancel).
- **Public interface:** standard React props, e.g. `NoteList({ notes: Note[], onDelete(id): void })`, `NoteForm({ initial?: Note, onSubmit(input: NoteInput): void })`.
- **Dependencies:** none on server modules — components receive data/callbacks as props from route components, which own the server-function calls. This keeps components independently testable and enforces the module boundary (UI never imports `note-service` or repositories).

**Dependency graph (enforced by import boundaries, checked in review):**

```
routes/components (UI)
        │  (props/callbacks)
routes (server functions)
        │
   note-service   ← config
        │
 note-repository
        │
   db-client  ← config
        │
   PostgreSQL
```

## Plumbing & Conventions

**Folder layout:**
```
quick-notes/
├── src/
│   ├── routes/
│   │   ├── __root.tsx
│   │   ├── index.tsx            # list view + createNoteFn/listNotesFn wiring
│   │   ├── notes.new.tsx        # new note form
│   │   └── notes.$noteId.tsx    # edit note form
│   ├── components/
│   │   ├── NoteList.tsx
│   │   ├── NoteListItem.tsx
│   │   └── NoteForm.tsx
│   ├── server/
│   │   ├── config.ts
│   │   ├── db-client.ts
│   │   ├── note-repository.ts
│   │   └── note-service.ts
│   ├── styles/
│   │   └── app.css
│   └── router.tsx
├── tests/
│   ├── note-service.test.ts
│   ├── note-repository.test.ts   # runs against InMemoryNoteRepository
│   └── NoteForm.test.tsx
├── app.config.ts                 # TanStack Start config
├── vite.config.ts
├── package.json
├── tsconfig.json
└── .env.example                  # DATABASE_URL=
```

**Configuration:** all env access funnels through `config.ts`:
```ts
// src/server/config.ts
export function getConfig(): AppConfig {
  return { databaseUrl: process.env.DATABASE_URL ?? null };
}
```

**Dependency wiring** (singleton, lazily constructed):
```ts
// src/server/note-service.ts
let instance: NoteService | null = null;

export function getNoteService(): NoteService {
  if (!instance) {
    const { databaseUrl } = getConfig();
    const repo = databaseUrl
      ? new PostgresNoteRepository(getPool()!)
      : new InMemoryNoteRepository();
    instance = new NoteService(repo);
  }
  return instance;
}
```

**Error handling:** a single `NoteServiceError` (with `code: 'VALIDATION' | 'NOT_FOUND'`) is thrown by `NoteService` and caught at the server-function boundary, mapped to a typed error response (`{ error: { code, message } }`). Server functions never leak raw `pg` errors to the client. Client forms surface `error.message` inline near the relevant field.

```ts
export class NoteServiceError extends Error {
  constructor(public code: 'VALIDATION' | 'NOT_FOUND', message: string) { super(message); }
}

// note-service.ts
async createNote(input: NoteInput): Promise<Note> {
  const title = input.title?.trim();
  if (!title || title.length > 200) {
    throw new NoteServiceError('VALIDATION', 'Title must be 1-200 characters.');
  }
  if ((input.body?.length ?? 0) > 10_000) {
    throw new NoteServiceError('VALIDATION', 'Body must be at most 10,000 characters.');
  }
  const now = new Date().toISOString();
  return this.repo.insert({ id: crypto.randomUUID(), title, body: input.body ?? '', createdAt: now, updatedAt: now });
}
```

**Logging:** minimal `console.error` at the server-function catch boundary only (`console.error('[quick-notes]', err)`), no logging library — appropriate for this app's size.

**Schema bootstrap** (`db-client.ts`), run once at server startup when `DATABASE_URL` is present:
```sql
CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(200) NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_updated_at_idx ON notes (updated_at DESC);
```

## Best Practices

- **Testing strategy:**
  - `note-service.test.ts` — unit tests against `InMemoryNoteRepository` covering: create trims/validates title, rejects empty/too-long title, rejects too-long body, list ordered by `updatedAt` desc, update bumps `updatedAt`, delete removes and subsequent `getNote` returns null.
  - `note-repository.test.ts` — same contract tests run against `InMemoryNoteRepository` (the Postgres implementation is exercised via this shared contract if a `DATABASE_URL` is available locally; CI runs the in-memory path only, keeping `npm test` dependency-free per the research's graceful-degradation requirement).
  - `NoteForm.test.tsx` — component test (Vitest + Testing Library) for required-title validation and submit callback payload.
  - This satisfies "at least a few unit tests" without over-testing a small app.
- **Type safety:** `Note`/`NoteInput` defined once in `note-service.ts` and imported everywhere (UI, routes, repository) — no duplicate/parallel type definitions. `strict: true` in `tsconfig.json`.
- **Security:** all SQL uses parameterized queries via `pg` (no string concatenation), preventing SQL injection. No auth by design (explicitly out of scope) — this is a single-user demo app, not exposed as multi-tenant.
- **Performance:** the `updated_at DESC` index backs the list query directly; list view truncates long bodies client-side in `NoteListItem` (CSS `line-clamp` or substring) rather than fetching less data, since bodies are capped at 10,000 chars — no pagination needed at this scale.

## Deployment Shape

- **Local dev:** `npm run dev` starts the TanStack Start Vite dev server. If `DATABASE_URL` is set (e.g. pointing at a local Postgres via Docker), notes persist there; if unset, `NoteService` transparently falls back to `InMemoryNoteRepository` so the full UI works with zero setup.
- **Build:** `npm run build` produces the TanStack Start production server bundle (Nitro-based) + client assets.
- **Run in production:** the built server is started with `node .output/server/index.mjs` (standard TanStack Start/Nitro output), reading `DATABASE_URL` from the environment. A single Postgres instance is the only external dependency; schema is created on first boot via `ensureSchema`, no separate migration tool needed for this one-table schema.
- **Tests:** `npm test` runs Vitest in CI/local without requiring a database (in-memory repository backs the shared contract tests).