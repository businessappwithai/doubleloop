# Implementation Plan — Quick Notes

## Build Order

The build follows the dependency chain laid out in Architecture.md: **UI → server functions → NoteService → NoteRepository → db-client → PostgreSQL**, plus a scaffold step that must exist before anything else can compile.

1. **Scaffold (m1)** comes first and alone. Nothing else can run `tsc`, `vitest`, or `npm run dev` until `package.json`, the TanStack Start config, the router, and the root route exist. This module must leave the app in an installable, buildable state (even though it renders almost nothing yet).

2. **Server-side foundation, built bottom-up (m2 → m3 → m4 → m5).** `config` must exist before `db-client` can read `DATABASE_URL` through it; `db-client` must exist before `note-repository` can construct a `PostgresNoteRepository`; `note-repository` must exist before `note-service` can be built on top of it and expose the singleton `getNoteService()`. Each of these is a strict linear dependency per Architecture.md's "no layer skipped" rule, so they build sequentially.

3. **UI components (m6) fork off after m4**, not after m5. Components only need the `Note`/`NoteInput` *types* (a compile-time-only `import type` from `note-repository.ts`) — they have zero runtime dependency on `note-service` or any repository implementation, per Architecture.md's explicit UI/server boundary. This lets `note-service` (m5) and the components (m6) build **in parallel**, maximizing throughput.

4. **Routes (m7, m8, m9) fan out once both m5 and m6 are done.** The three route files (`index.tsx`, `notes.new.tsx`, `notes.$noteId.tsx`) touch disjoint files and each independently wires its own `createServerFn` calls to `getNoteService()` and renders the shared components — they have no dependency on each other, so all three build **in parallel**.

5. **Final integration (m10)** closes the loop: wires styling across the views, double-checks the router registers all routes, and is the single module responsible for confirming `npm run build` and `npm test` both pass end-to-end across every module produced above.

## Modules

### m1 — Project scaffold
**Build:** `package.json` (all deps/scripts), TanStack Start config, TypeScript config, Vite config, router entry, root route, base stylesheet, env template. Must leave the app installable and buildable with a blank root route.
**Files:** `package.json`, `tsconfig.json`, `app.config.ts`, `vite.config.ts`, `src/router.tsx`, `src/routes/__root.tsx`, `src/styles/app.css`, `.env.example`, `.gitignore`
**Depends on:** none
**Acceptance:** `npm install` succeeds; `npm run dev` boots without error; `npm run build` produces output; `npx tsc --noEmit` passes.

### m2 — Config module
**Build:** `src/server/config.ts` — sole reader of `process.env`.
**Files:** `src/server/config.ts`
**Depends on:** m1
**Acceptance:** `getConfig()` returns `{ databaseUrl: null }` when `DATABASE_URL` is unset and echoes it back when set; `npx tsc --noEmit` passes.

### m3 — DB client module
**Build:** `src/server/db-client.ts` — pool ownership + idempotent schema bootstrap per Database.md's DDL.
**Files:** `src/server/db-client.ts`
**Depends on:** m2
**Acceptance:** `getPool()` returns `null` with no `DATABASE_URL`; `ensureSchema` runs the exact DDL from Database.md (pgcrypto extension, `notes` table, `notes_updated_at_idx`) using `IF NOT EXISTS` guards; `npx tsc --noEmit` passes.

### m4 — Note repository module
**Build:** `Note` type, `NoteRepository` interface, `PostgresNoteRepository` (the 5 parameterized queries from Database.md), `InMemoryNoteRepository`. Plus repository unit tests against the in-memory implementation.
**Files:** `src/server/note-repository.ts`, `tests/note-repository.test.ts`
**Depends on:** m3
**Acceptance:** `list()` returns notes ordered `updatedAt` desc; `findById` returns `null` for missing ids; `update`/`remove` on a missing id return `null`/`false`; `npx vitest run tests/note-repository.test.ts` passes; `npx tsc --noEmit` passes.

### m5 — Note service module
**Build:** `NoteServiceError`, `NoteService` (validation: title 1–200 chars trimmed, body ≤10,000 chars; stamps id/timestamps), and `getNoteService()` singleton picking Postgres vs in-memory backend from `getConfig()`. Plus service unit tests.
**Files:** `src/server/note-service.ts`, `tests/note-service.test.ts`
**Depends on:** m4
**Acceptance:** creating a note with empty/201+ char title throws `NoteServiceError('VALIDATION', ...)`; body >10,000 chars throws validation error; update/delete on unknown id throws `NoteServiceError('NOT_FOUND', ...)`; successful create/update stamp timestamps correctly; `npx vitest run tests/note-service.test.ts` passes; `npx tsc --noEmit` passes.

### m6 — UI components module
**Build:** `NoteListItem`, `NoteList` (with empty state), `NoteForm` (create/edit, client-side length validation). Type-only import of `Note`/`NoteInput` from `note-repository.ts`; no runtime server dependency. Plus a component test.
**Files:** `src/components/NoteListItem.tsx`, `src/components/NoteList.tsx`, `src/components/NoteForm.tsx`, `tests/NoteForm.test.tsx`
**Depends on:** m1, m4
**Acceptance:** `NoteList` renders an empty-state message for `notes: []` and one `NoteListItem` per note otherwise; `NoteListItem`'s delete button calls `onDelete(id)`; `NoteForm` blocks submit on empty/too-long title and calls `onSubmit` with valid input; `npx vitest run tests/NoteForm.test.tsx` passes; `npx tsc --noEmit` passes.

### m7 — List route (index)
**Build:** `src/routes/index.tsx` — `listNotesFn` and `deleteNoteFn` server functions delegating to `getNoteService()`, mapping `NoteServiceError` to `{ error: { code, message } }`; route loads notes and renders `NoteList`, with a link to `/notes/new`.
**Files:** `src/routes/index.tsx`
**Depends on:** m5, m6
**Acceptance:** visiting `/` lists notes newest-updated-first; deleting a note removes it from the list without a full reload of unrelated state; empty store shows the empty-state UI; `npx tsc --noEmit` passes.

### m8 — New-note route
**Build:** `src/routes/notes.new.tsx` — `createNoteFn` server function delegating to `getNoteService().createNote`; renders `NoteForm` with no initial value, navigates to `/` on success, shows `error.message` inline on validation failure.
**Files:** `src/routes/notes.new.tsx`
**Depends on:** m5, m6
**Acceptance:** submitting a valid title creates a note and redirects to `/`; submitting an empty title shows the validation error inline without navigating; `npx tsc --noEmit` passes.

### m9 — Edit-note route
**Build:** `src/routes/notes.$noteId.tsx` — `getNoteFn`, `updateNoteFn`, `deleteNoteFn` server functions; loads the note by route param, renders `NoteForm` pre-filled, handles not-found, save, and delete flows, all navigating to `/` on success.
**Files:** `src/routes/notes.$noteId.tsx`
**Depends on:** m5, m6
**Acceptance:** editing and saving a note updates its `updatedAt` and content, then returns to `/`; deleting from the edit view removes the note and returns to `/`; navigating to an unknown note id shows a not-found state instead of crashing; `npx tsc --noEmit` passes.

### m10 — Final integration & polish
**Build:** minimal shared styling for list/editor views wired into `__root.tsx`/`app.css`; verify `src/router.tsx` registers all three routes; confirm `.env.example` is accurate; run the full build and test suite and fix any cross-module integration issues (import paths, type mismatches) without altering any module's responsibilities.
**Files:** `src/styles/app.css`, `src/router.tsx`, `.env.example`
**Depends on:** m7, m8, m9
**Acceptance:** `npm run build` succeeds; `npm test` runs all suites (`note-repository`, `note-service`, `NoteForm`) and all pass; `npm run dev` serves a working list → create → edit → delete flow end-to-end against the in-memory store; `npx tsc --noEmit` passes with zero errors across the whole project.

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
      "prompt": "Scaffold a TanStack Start app: package.json with dependencies (@tanstack/react-start, @tanstack/react-router, react, react-dom, vinxi, pg) and devDependencies (typescript, vite, vitest, @testing-library/react, @testing-library/jest-dom, jsdom, @vitejs/plugin-react, @types/node, @types/pg, @types/react, @types/react-dom), scripts dev/build/test. Add app.config.ts, tsconfig.json, vite.config.ts, src/router.tsx (createRouter), src/routes/__root.tsx (root layout importing src/styles/app.css), a minimal src/styles/app.css, .env.example (DATABASE_URL=), and .gitignore (node_modules, dist, .env). App must install and `npm run dev`/`npm run build` cleanly with a blank root route.",
      "dependsOn": [],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["package.json", "tsconfig.json", "app.config.ts", "vite.config.ts", "src/router.tsx", "src/routes/__root.tsx", "src/styles/app.css", ".env.example", ".gitignore"],
      "acceptance": ["npm install succeeds", "npm run dev boots without error", "npm run build produces output", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "production build succeeds", "kind": "command", "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m2",
      "title": "Config module",
      "stackTarget": "backend",
      "prompt": "Create src/server/config.ts exporting `interface AppConfig { databaseUrl: string | null }` and `getConfig(): AppConfig` that reads `process.env.DATABASE_URL ?? null`. This must be the ONLY module in the codebase that reads process.env directly; every other server module must call getConfig() instead.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["src/server/config.ts"],
      "acceptance": ["getConfig() returns databaseUrl: null when DATABASE_URL is unset", "getConfig() returns the env value when DATABASE_URL is set", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m3",
      "title": "DB client module",
      "stackTarget": "backend",
      "prompt": "Create src/server/db-client.ts. Export `getPool(): Pool | null` — lazily constructs and memoizes a pg.Pool from getConfig().databaseUrl, returning null when unset (no connection attempted). Export `async ensureSchema(pool: Pool): Promise<void>` running the idempotent DDL from Database.md: CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE IF NOT EXISTS notes (id uuid PK default gen_random_uuid(), title varchar(200) not null, body text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now()); CREATE INDEX IF NOT EXISTS notes_updated_at_idx ON notes (updated_at DESC). Depend only on config.ts.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/db-client.ts"],
      "acceptance": ["getPool() returns null with no DATABASE_URL and does not throw", "ensureSchema executes the exact DDL from Database.md with IF NOT EXISTS guards", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m4",
      "title": "Note repository module",
      "stackTarget": "backend",
      "prompt": "Create src/server/note-repository.ts: export the Note type {id, title, body, createdAt, updatedAt (ISO strings)}, a NoteRepository interface (list, findById, insert, update, remove per Database.md's 5 query patterns), PostgresNoteRepository (constructor(pool: Pool), issues the exact parameterized SQL from Database.md, maps snake_case rows to camelCase Note), and InMemoryNoteRepository (array-backed, same semantics, list ordered updatedAt desc). No business validation in this module. Write tests/note-repository.test.ts covering list/insert/update/remove/findById exclusively against InMemoryNoteRepository.",
      "dependsOn": ["m3"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/note-repository.ts", "tests/note-repository.test.ts"],
      "acceptance": ["list() returns notes ordered by updatedAt desc", "findById returns null for a missing id", "update/remove on a missing id return null/false respectively", "npx vitest run tests/note-repository.test.ts passes", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "repository tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/note-repository.test.ts"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m5",
      "title": "Note service module",
      "stackTarget": "backend",
      "prompt": "Create src/server/note-service.ts: NoteServiceError class (code: 'VALIDATION'|'NOT_FOUND'), NoteInput type, NoteService class with listNotes/getNote/createNote/updateNote/deleteNote enforcing title required 1-200 chars trimmed and body max 10000 chars, stamping id (crypto.randomUUID) and createdAt/updatedAt ISO timestamps, throwing NoteServiceError on rule violations or missing ids. Export singleton getNoteService() that picks PostgresNoteRepository(getPool()) when getConfig().databaseUrl is set, else InMemoryNoteRepository, memoized module-level. Write tests/note-service.test.ts constructing NoteService directly with an InMemoryNoteRepository, covering validation errors, not-found errors, and successful CRUD.",
      "dependsOn": ["m4"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/note-service.ts", "tests/note-service.test.ts"],
      "acceptance": ["empty or 201+ char title throws NoteServiceError VALIDATION", "body over 10000 chars throws NoteServiceError VALIDATION", "update/delete on unknown id throws NoteServiceError NOT_FOUND", "successful create/update stamp timestamps correctly", "npx vitest run tests/note-service.test.ts passes", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "service tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/note-service.test.ts"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m6",
      "title": "UI components module",
      "stackTarget": "frontend",
      "prompt": "Create presentation-only components in src/components/: NoteListItem.tsx (title, formatted updatedAt, body preview truncated to ~120 chars, delete button calling onDelete(id)); NoteList.tsx (renders one NoteListItem per note, empty-state message when notes.length===0, props {notes: Note[], onDelete(id): void}); NoteForm.tsx (title+body fields, client-side validation mirroring server rules — title 1-200 chars, body max 10000 — save/cancel buttons, props {initial?: Note, onSubmit(input: NoteInput): void, onCancel?(): void}). Use `import type` only from src/server/note-repository.ts for Note/NoteInput (compile-time only, zero runtime server dependency). Write tests/NoteForm.test.tsx with @testing-library/react covering validation and submit behavior.",
      "dependsOn": ["m1", "m4"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/components/NoteListItem.tsx", "src/components/NoteList.tsx", "src/components/NoteForm.tsx", "tests/NoteForm.test.tsx"],
      "acceptance": ["NoteList renders empty-state for notes: []", "NoteListItem delete button invokes onDelete(id)", "NoteForm blocks submit on empty or too-long title", "NoteForm calls onSubmit with valid input", "npx vitest run tests/NoteForm.test.tsx passes", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "component tests pass", "kind": "command", "argv": ["npx", "vitest", "run", "tests/NoteForm.test.tsx"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m7",
      "title": "List route (index)",
      "stackTarget": "fullstack",
      "prompt": "Create src/routes/index.tsx. Define listNotesFn (GET createServerFn calling getNoteService().listNotes()) and deleteNoteFn (POST createServerFn with a validator for id, calling getNoteService().deleteNote(id)), both catching NoteServiceError and returning {error:{code,message}} on failure. Route component loads notes via listNotesFn on mount/loader, renders NoteList with onDelete invoking deleteNoteFn then refreshing the list, plus a link/button to /notes/new.",
      "dependsOn": ["m5", "m6"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/routes/index.tsx"],
      "acceptance": ["visiting / lists notes newest-updated-first", "deleting a note removes it from the rendered list", "empty store shows the NoteList empty state", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m8",
      "title": "New-note route",
      "stackTarget": "fullstack",
      "prompt": "Create src/routes/notes.new.tsx. Define createNoteFn (POST createServerFn, validator for {title, body?}, calling getNoteService().createNote(input), catching NoteServiceError and returning {error:{code,message}}). Route component renders NoteForm with no initial value; onSubmit calls createNoteFn then navigates to '/'. Display error.message inline near the title field on validation failure without navigating.",
      "dependsOn": ["m5", "m6"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["src/routes/notes.new.tsx"],
      "acceptance": ["submitting a valid title creates a note and redirects to /", "submitting an empty title shows the inline validation error without navigating", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m9",
      "title": "Edit-note route",
      "stackTarget": "fullstack",
      "prompt": "Create src/routes/notes.$noteId.tsx. Define getNoteFn (GET createServerFn, validator for id, calling getNoteService().getNote(id), mapping a null result to a NOT_FOUND error response), updateNoteFn (POST, validator for {id,title,body?}, calling getNoteService().updateNote), and deleteNoteFn (POST, validator for id, calling getNoteService().deleteNote). Route component loads the note via getNoteFn using the noteId route param, renders NoteForm with initial=note; onSubmit calls updateNoteFn then navigates to '/'; a delete button calls deleteNoteFn then navigates to '/'. Show a not-found state when getNoteFn returns NOT_FOUND.",
      "dependsOn": ["m5", "m6"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/routes/notes.$noteId.tsx"],
      "acceptance": ["editing and saving updates the note's content and updatedAt, then returns to /", "deleting from the edit view removes the note and returns to /", "navigating to an unknown note id shows a not-found state instead of crashing", "npx tsc --noEmit passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m10",
      "title": "Final integration & polish",
      "stackTarget": "fullstack",
      "prompt": "Wire minimal shared styling for the list and editor views into src/styles/app.css (imported once in __root.tsx), verify src/router.tsx registers the root route plus index/notes.new/notes.$noteId, and confirm .env.example documents DATABASE_URL. Run npm run build and npm test to validate the full app end-to-end (routes, server functions, components, repository, service) and fix any cross-module integration issues (import paths, type mismatches) without changing any module's documented responsibility.",
      "dependsOn": ["m7", "m8", "m9"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/styles/app.css", "src/router.tsx", ".env.example"],
      "acceptance": ["npm run build succeeds", "npm test runs and passes note-repository, note-service, and NoteForm suites", "npm run dev serves a working list -> create -> edit -> delete flow against the in-memory store", "npx tsc --noEmit passes with zero errors project-wide"],
      "exitClauses": [
        {"clauseId": "c1", "description": "full test suite passes", "kind": "command", "argv": ["npm", "test"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "production build succeeds", "kind": "command", "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}},
        {"clauseId": "c3", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    }
  ]
}
```