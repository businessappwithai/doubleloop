# Implementation Plan — Quick Notes

## Build Order

The build proceeds in four waves, mirroring the strict two-level dependency tree fixed by Architecture.md (`NotesService` at the root, stores and routes as leaves).

**Wave 1 — Scaffold (m1).** Everything else needs a working TypeScript/Vite/TanStack Start project to build against, so the first module creates `package.json` (with every dependency and the `dev`/`build`/`test` scripts already wired), `tsconfig.json`, `vite.config.ts`, `app.config.ts`, the router root (`app/routes/__root.tsx`), a minimal `app/styles/app.css`, and `.env.example`. Nothing else starts until this compiles and `npm install` succeeds.

**Wave 2 — Contract (m2).** `app/server/note-store.ts` is written next, but only the `Note` type and the `NoteStore` interface — not yet the `createNoteStore()` factory. The factory (per Architecture.md) must import both concrete store classes, which don't exist yet, so it is deferred to Wave 4 (m5), which needs it anyway to wire `NotesService`. This keeps the DAG acyclic while still landing the exact final file contents Architecture.md specifies.

**Wave 3 — Store implementations (m3, m4, parallel).** With the interface in place, `InMemoryNoteStore` and `PostgresNoteStore` are built independently and in parallel — they share no files and each only reads the `NoteStore` interface. `PostgresNoteStore`'s module also lands `app/server/schema.sql`, the DDL from Database.md verbatim. Each ships with its own unit test (the Postgres store's contract test is gated behind `DATABASE_URL` being set, per Database.md's seed/fixture strategy).

**Wave 4 — Orchestrator (m5).** `NotesService` is the central orchestrator: it defines `NoteInputSchema` (Zod), the five server functions (`listNotes`, `getNote`, `createNote`, `updateNote`, `deleteNote`), and — as part of this module's work — appends the `createNoteStore(databaseUrl)` factory function to `app/server/note-store.ts` (now that both concrete stores exist to import). This is the only module allowed to import the two store classes directly. Ships with `notes-service.test.ts` against `InMemoryNoteStore`.

**Wave 5 — Routes (m6, m7, parallel).** `NotesListRoute` and `NoteEditorRoute` are UI leaves that depend only on `NotesService`'s exported server functions/schema, never on each other or on the stores. They can be built in parallel because they touch disjoint files. To avoid a parallel write-conflict on the shared stylesheet, `m6` owns `app/styles/app.css` (writing the complete stylesheet, list *and* form styles, using the shared class-name convention below); `m7` only reuses those classes and never edits the CSS file.

**Shared CSS class convention** (both m6 and m7 must follow this so parallel builds stay visually consistent): `.page`, `.note-list`, `.note-card`, `.note-card-title`, `.note-card-meta`, `.note-card-preview`, `.empty-state`, `.note-form`, `.field`, `.field-label`, `.field-input`, `.field-textarea`, `.field-error`, `.btn`, `.btn-primary`, `.btn-danger`, `.toolbar`.

## Modules

### m1 — Project Scaffold
**Build:** Initialize the TanStack Start + Vite + TypeScript + Vitest project skeleton. `package.json` includes: `@tanstack/react-start`, `@tanstack/react-router`, `react`, `react-dom`, `zod`, `pg`, `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `@types/pg`, `@types/react`, `@types/react-dom`. Scripts: `"dev": "vite dev"`, `"build": "vite build"`, `"test": "vitest run"`. `tsconfig.json` targets ES2022/DOM, strict mode on. `vite.config.ts` wires the TanStack Start Vite plugin plus a `test` block (environment `jsdom`, globals true). `app.config.ts` holds the TanStack Start app config. `app/routes/__root.tsx` renders the root HTML shell and imports `app/styles/app.css`. `app/styles/app.css` starts as a minimal reset (body font/margin) — full styling lands in m6. `.env.example` documents `DATABASE_URL=postgres://user:pass@localhost:5432/quick_notes`.
**Files:** `package.json`, `tsconfig.json`, `vite.config.ts`, `app.config.ts`, `app/routes/__root.tsx`, `app/styles/app.css`, `.env.example`
**Depends on:** none
**Acceptance:** `npm install` succeeds; `npm run build` succeeds on the empty shell; `npx tsc --noEmit` passes.

### m2 — NoteStore Contract
**Build:** Create `app/server/note-store.ts` containing the `Note` TypeScript type (`id: string; title: string; body: string; created_at: string; updated_at: string`) and the `NoteStore` interface exactly as specified in Architecture.md (`list`, `get`, `create`, `update`, `remove`). Do **not** add the `createNoteStore` factory yet — that's added in m5 once both implementations exist. Leave a `// TODO(m5): createNoteStore factory` marker comment only if useful; no runtime code beyond the type/interface.
**Files:** `app/server/note-store.ts`
**Depends on:** m1
**Acceptance:** `npx tsc --noEmit` passes with the new file; file exports `Note` and `NoteStore` and nothing else executable.

### m3 — InMemoryNoteStore
**Build:** Implement `app/server/in-memory-note-store.ts` — a default-exported `class InMemoryNoteStore implements NoteStore` backed by a process-local array. `create` generates a `crypto.randomUUID()` id and stamps `created_at`/`updated_at` to the current ISO timestamp; `update` re-stamps only `updated_at`; `list` returns entries sorted by `updated_at` descending; `get`/`update`/`remove` return `null`/`null`/`false` on a missing id (never throw — that's `NotesService`'s job). Write `tests/in-memory-note-store.test.ts` covering: create then list ordering, update changes `updated_at` and moves the note to the top, delete removes it, get/update/remove on a missing id behave per contract.
**Files:** `app/server/in-memory-note-store.ts`, `tests/in-memory-note-store.test.ts`
**Depends on:** m2
**Acceptance:** `npx tsc --noEmit` passes; `npx vitest run tests/in-memory-note-store.test.ts` passes with ≥4 test cases.

### m4 — PostgresNoteStore + Schema
**Build:** Create `app/server/schema.sql` with the exact DDL from Database.md (`pgcrypto` extension, `notes` table, `notes_updated_at_idx` index, all `if not exists`). Implement `app/server/postgres-note-store.ts` — a default-exported `class PostgresNoteStore implements NoteStore` that owns one `pg.Pool` constructed from the `databaseUrl` passed to its constructor, and issues exactly the parameterized queries listed in Database.md's Query Patterns table (list/get/create/update/delete), including `update ... set updated_at = now()`. No connection is attempted until a method is called. Add an optional Postgres-backed contract test, `tests/postgres-note-store.test.ts`, wrapped in `describe.skipIf(!process.env.DATABASE_URL)`, which truncates `notes` (`truncate table notes restart identity`) before each test and exercises the same CRUD contract as m3's suite.
**Files:** `app/server/schema.sql`, `app/server/postgres-note-store.ts`, `tests/postgres-note-store.test.ts`
**Depends on:** m2
**Acceptance:** `npx tsc --noEmit` passes; `npx vitest run tests/postgres-note-store.test.ts` passes (skips cleanly with no `DATABASE_URL` set, exit code 0); `schema.sql` is valid, idempotent Postgres DDL matching Database.md verbatim.

### m5 — NotesService (Central Orchestrator)
**Build:** Two changes to `app/server/note-store.ts`: append `export function createNoteStore(databaseUrl: string | undefined): NoteStore { return databaseUrl ? new PostgresNoteStore(databaseUrl) : new InMemoryNoteStore(); }`, importing the two concrete classes. Create `app/server/notes-service.ts`: define and export `NoteInputSchema` (Zod: `title` trimmed string 1–200 chars, `body` string max 10,000 chars defaulting to `''`); construct `const store: NoteStore = createNoteStore(process.env.DATABASE_URL);` once at module load; export the five `createServerFn` server functions exactly as specified in Architecture.md's Central Orchestrator section (`listNotes`, `getNote`, `createNote`, `updateNote`, `deleteNote`), each validating input with the Zod schema (or a raw `id: string` validator for get/delete), applying list ordering / timestamp stamping via the store, throwing `Error('Note not found')` on a missing id for `getNote`/`updateNote`/`deleteNote`, and logging failures with a one-line `console.error` in each handler's catch. Write `tests/notes-service.test.ts` against an `InMemoryNoteStore`-backed instance (construct the service functions with `DATABASE_URL` unset) covering: create validates title length, create/list ordering, update stamps `updated_at`, delete removes, get/update/delete on missing id throw `Note not found`.
**Files:** `app/server/note-store.ts` (append factory only), `app/server/notes-service.ts`, `tests/notes-service.test.ts`
**Depends on:** m2, m3, m4
**Acceptance:** `npx tsc --noEmit` passes; `npx vitest run tests/notes-service.test.ts` passes with ≥5 test cases; `note-store.ts` now exports `createNoteStore` in addition to the m2 types; no module outside `notes-service.ts` imports `PostgresNoteStore`/`InMemoryNoteStore` directly.

### m6 — NotesListRoute
**Build:** Implement `app/routes/index.tsx` — the list view. On load, calls `listNotes()` (via TanStack Start's route loader) and renders each note as a `.note-card` showing title, formatted `updated_at`, and a body preview truncated to ~150 characters with an ellipsis. Includes a "New note" link to `/notes/new` and a per-row delete button that calls `deleteNote(id)` and refreshes the list (optimistic removal or router invalidation, either is acceptable). Renders an `.empty-state` message when there are zero notes. Also writes the **complete** `app/styles/app.css` (superseding m1's minimal reset) implementing every class in the shared convention listed under Build Order, covering both list and form layouts.
**Files:** `app/routes/index.tsx`, `app/styles/app.css` (full rewrite)
**Depends on:** m5
**Acceptance:** `npx tsc --noEmit` passes; `npm run build` succeeds; manually verified (or covered by m7's route test patterns) that the empty state, populated list, and delete action all render without runtime errors; `app.css` defines every class in the shared convention.

### m7 — NoteEditorRoute
**Build:** Implement `app/routes/notes.$noteId.tsx` — the create/edit form, keyed by the `$noteId` path param with the literal value `"new"` signaling create mode. In edit mode, loads the existing note via `getNote(noteId)` in the route loader and pre-fills the form; in create mode, starts blank. Client-side validates against the exported `NoteInputSchema` before submit (inline error rendered in a `.field-error` under the offending field) and submits to `createNote`/`updateNote` accordingly, redirecting to `/` on success. Server-thrown validation errors (Zod) and `Note not found` are caught and rendered inline rather than crashing the route. Uses only the shared CSS classes from m6's `app.css` — adds no new stylesheet rules. Write `tests/note-editor-route.test.tsx` using `@testing-library/react` covering: renders empty form in create mode, renders pre-filled form in edit mode (mocking `getNote`), shows a validation error for an empty title, calls `createNote`/`updateNote` with trimmed input on valid submit (mocking the server functions).
**Files:** `app/routes/notes.$noteId.tsx`, `tests/note-editor-route.test.tsx`
**Depends on:** m5
**Acceptance:** `npx tsc --noEmit` passes; `npx vitest run tests/note-editor-route.test.tsx` passes with ≥4 test cases; `npm run build` succeeds; no edits made to `app/styles/app.css`.

## Machine-Readable Plan

```json implementation-plan
{
  "planVersion": 1,
  "generatedBy": "DLO Design Analyst",
  "modules": [
    {
      "moduleId": "m1",
      "title": "Project Scaffold",
      "stackTarget": "fullstack",
      "prompt": "Scaffold a TanStack Start + Vite + TypeScript + Vitest project. Create package.json with deps @tanstack/react-start, @tanstack/react-router, react, react-dom, zod, pg, vite, @vitejs/plugin-react, typescript, vitest, @testing-library/react, @testing-library/jest-dom, jsdom, @types/pg, @types/react, @types/react-dom, and scripts dev='vite dev', build='vite build', test='vitest run'. Add tsconfig.json (strict, ES2022/DOM), vite.config.ts (TanStack Start plugin + vitest jsdom test block), app.config.ts, app/routes/__root.tsx (root HTML shell importing app/styles/app.css), a minimal app/styles/app.css reset, and .env.example documenting DATABASE_URL=postgres://user:pass@localhost:5432/quick_notes.",
      "dependsOn": [],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["package.json", "tsconfig.json", "vite.config.ts", "app.config.ts", "app/routes/__root.tsx", "app/styles/app.css", ".env.example"],
      "acceptance": ["npm install succeeds", "npm run build succeeds", "npx tsc --noEmit exits 0"],
      "exitClauses": [
        {"clauseId": "c1", "description": "install succeeds", "kind": "command", "argv": ["npm", "install"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c3", "description": "build succeeds", "kind": "command", "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m2",
      "title": "NoteStore Contract",
      "stackTarget": "backend",
      "prompt": "Create app/server/note-store.ts exporting a Note type (id, title, body, created_at, updated_at, all strings — timestamps as ISO strings) and a NoteStore interface with list(): Promise<Note[]>, get(id): Promise<Note|null>, create(input:{title,body}): Promise<Note>, update(id, input:{title,body}): Promise<Note|null>, remove(id): Promise<boolean>. Do not add any factory function or implementation yet — interface and type only.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["app/server/note-store.ts"],
      "acceptance": ["file exports Note type and NoteStore interface", "no executable/runtime code beyond type declarations"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m3",
      "title": "InMemoryNoteStore",
      "stackTarget": "backend",
      "prompt": "Implement app/server/in-memory-note-store.ts: default-exported class InMemoryNoteStore implements NoteStore (from app/server/note-store.ts) backed by an in-process array. create() uses crypto.randomUUID() for id and stamps created_at/updated_at to now (ISO string); update() re-stamps only updated_at; list() returns notes sorted by updated_at descending; get/update/remove return null/null/false (never throw) on a missing id. Write tests/in-memory-note-store.test.ts (Vitest) covering create+list ordering, update moves note to top and changes updated_at, delete removes the note, and missing-id behavior for get/update/remove.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["app/server/in-memory-note-store.ts", "tests/in-memory-note-store.test.ts"],
      "acceptance": ["implements NoteStore fully", "list ordered by updated_at desc", "missing-id calls return null/false, never throw", "vitest suite has at least 4 cases and passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "unit tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/in-memory-note-store.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m4",
      "title": "PostgresNoteStore + Schema",
      "stackTarget": "backend",
      "prompt": "Create app/server/schema.sql with this exact idempotent DDL: pgcrypto extension, notes table (id uuid pk default gen_random_uuid(), title varchar(200) not null, body text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now()), and index notes_updated_at_idx on notes(updated_at desc), all using 'if not exists'. Implement app/server/postgres-note-store.ts: default-exported class PostgresNoteStore implements NoteStore (from app/server/note-store.ts), constructed with a databaseUrl string, owning one pg.Pool built from it. Implement list/get/create/update/remove using parameterized queries exactly matching: select ... order by updated_at desc; select ... where id=$1; insert ... returning ...; update ... set title=$1, body=$2, updated_at=now() where id=$3 returning ...; delete from notes where id=$1. Add tests/postgres-note-store.test.ts wrapped in describe.skipIf(!process.env.DATABASE_URL) that truncates notes (restart identity) before each test and exercises the same CRUD contract as the in-memory store's tests.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["app/server/schema.sql", "app/server/postgres-note-store.ts", "tests/postgres-note-store.test.ts"],
      "acceptance": ["schema.sql matches Database.md DDL exactly and is idempotent", "PostgresNoteStore implements NoteStore using only parameterized queries", "test suite skips cleanly with no DATABASE_URL and passes exit 0"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "postgres store tests run (skip or pass)", "kind": "command", "argv": ["npx", "vitest", "run", "tests/postgres-note-store.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m5",
      "title": "NotesService (Central Orchestrator)",
      "stackTarget": "backend",
      "prompt": "Append to app/server/note-store.ts: export function createNoteStore(databaseUrl: string|undefined): NoteStore that returns new PostgresNoteStore(databaseUrl) when databaseUrl is set, else new InMemoryNoteStore() (import both concrete classes). Create app/server/notes-service.ts exporting NoteInputSchema (Zod: title trimmed string 1-200 chars required, body string max 10000 chars default ''), a module-level store built once via createNoteStore(process.env.DATABASE_URL), and five createServerFn exports (listNotes GET, getNote GET validated by id:string, createNote POST validated by NoteInputSchema, updateNote POST validated by NoteInputSchema.extend({id: z.string().uuid()}), deleteNote POST validated by id:string) matching Architecture.md's Central Orchestrator signatures exactly. getNote/updateNote/deleteNote throw Error('Note not found') on a missing id; each handler logs failures via console.error in a catch. Write tests/notes-service.test.ts against these functions backed by InMemoryNoteStore (DATABASE_URL unset) covering title validation, create/list ordering, update stamps updated_at, delete removes, and Note not found on missing id.",
      "dependsOn": ["m2", "m3", "m4"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["app/server/note-store.ts", "app/server/notes-service.ts", "tests/notes-service.test.ts"],
      "acceptance": ["note-store.ts exports createNoteStore in addition to Note/NoteStore", "notes-service.ts exports NoteInputSchema, listNotes, getNote, createNote, updateNote, deleteNote", "no module other than notes-service.ts imports PostgresNoteStore or InMemoryNoteStore directly", "vitest suite has at least 5 cases and passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "orchestrator tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/notes-service.test.ts"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m6",
      "title": "NotesListRoute",
      "stackTarget": "frontend",
      "prompt": "Implement app/routes/index.tsx: the notes list view. Loader calls listNotes() from app/server/notes-service.ts. Render each note as a .note-card with .note-card-title, .note-card-meta (formatted updated_at), .note-card-preview (body truncated to ~150 chars with ellipsis). Include a 'New note' link to /notes/new and a per-row delete button calling deleteNote(id) then refreshing the list. Render an .empty-state message when there are zero notes. Also write the complete app/styles/app.css (replacing m1's minimal reset) defining: .page, .note-list, .note-card, .note-card-title, .note-card-meta, .note-card-preview, .empty-state, .note-form, .field, .field-label, .field-input, .field-textarea, .field-error, .btn, .btn-primary, .btn-danger, .toolbar. Keep styling plain and clean, no UI kit.",
      "dependsOn": ["m5"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["app/routes/index.tsx", "app/styles/app.css"],
      "acceptance": ["renders empty state with zero notes", "renders note cards sorted per listNotes ordering", "delete button calls deleteNote and updates the list", "app.css defines every class in the shared naming convention", "npm run build succeeds"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "build succeeds", "kind": "command", "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m7",
      "title": "NoteEditorRoute",
      "stackTarget": "frontend",
      "prompt": "Implement app/routes/notes.$noteId.tsx: the create/edit form route, where $noteId==='new' means create mode. In edit mode, loader calls getNote(noteId) and pre-fills the form; create mode starts blank. Validate client-side against NoteInputSchema (imported from app/server/notes-service.ts) before submit, showing errors inline in .field-error. Submit to createNote or updateNote accordingly and redirect to / on success. Catch server-thrown Zod validation errors and 'Note not found' and render them inline instead of crashing. Reuse only the existing CSS classes from app/styles/app.css (.note-form, .field, .field-label, .field-input, .field-textarea, .field-error, .btn, .btn-primary) — do not edit app.css. Write tests/note-editor-route.test.tsx with @testing-library/react covering: blank form in create mode, pre-filled form in edit mode (mock getNote), validation error shown for empty title, and createNote/updateNote called with trimmed input on valid submit (mock the server functions).",
      "dependsOn": ["m5"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["app/routes/notes.$noteId.tsx", "tests/note-editor-route.test.tsx"],
      "acceptance": ["create mode renders blank form", "edit mode pre-fills from getNote", "empty title shows inline validation error and does not submit", "valid submit calls createNote or updateNote with trimmed values", "does not modify app/styles/app.css", "vitest suite has at least 4 cases and passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "editor route tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/note-editor-route.test.tsx"], "expect": {"exitCode": 0}},
        {"clauseId": "c3", "description": "build succeeds", "kind": "command", "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    }
  ]
}
```