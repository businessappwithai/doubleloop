# Implementation Plan — Todo App using Meta Astryx

## Build Order

The build proceeds in four waves, following the strict dependency graph from Architecture.md (`routes → ui/todo → server-functions → orchestrator → {todoRepository, validation, logging}`, with `theme` and `db` as side inputs).

**Wave 0 — Scaffold (m1).** A single module stands up the installable/buildable TanStack Start shell: `package.json` with every dependency and script the rest of the plan will need (so no later module has to add a dependency), base configs, and stub entry/root files. Every other module depends on this directly or transitively.

**Wave 1 — Leaf modules (m2, m3, m4, m5 — run in parallel).** These have no dependencies on each other and touch disjoint files: the Postgres/Drizzle database layer (schema, client, migrations, docker-compose), the Zod validation schemas, the structured logger, and the Astryx-powered colorful theme system. Because Wave 0 already created `package.json` and `tailwind.config.ts`, these modules only add new files or extend that one config file — no collisions.

**Wave 2 — Data & domain (m6, then m7).** `todoRepository`/`categoryRepository` (m6) build on the schema/client from m2. Once the repository exists, the Central Orchestrator (m7) wires repository + validation + logging behind the single `TodoOrchestrator` facade and `Result<T>` error contract — the only module every feature-facing layer above it is allowed to talk to.

**Wave 3 — HTTP boundary (m8).** TanStack Start server functions wrap the orchestrator 1:1, so UI code never imports the orchestrator or repository directly.

**Wave 4 — UI (m9, then m10, in parallel with m11).** Todo feature components and TanStack Query hooks (m9) consume server functions and the theme tokens. Routes (m10) compose those components into pages. In parallel, the seed script (m11) only needs the db layer and repository (m2/m6), so it can be built alongside m9/m10 without waiting on the UI.

**Wave 5 — Verification (m12).** Once orchestrator, components, and routes all exist, the test suite (unit, component, e2e) is added last so it can exercise the real, finished surfaces.

## Modules

### m1 — Project Scaffold & Config
Scaffolds the installable TanStack Start app: `package.json` (all deps/scripts up front), TypeScript/Vite/Tailwind configs, router entry, root route stub, and the single validated env-config module every other module reads config through.
**Files:** `package.json`, `tsconfig.json`, `app.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `src/router.tsx`, `src/routes/__root.tsx`, `src/client.tsx`, `src/server.tsx`, `src/lib/config/env.ts`, `.env.example`, `.gitignore`
**Depends on:** none
**Acceptance:** `npm install` succeeds; `npx tsc --noEmit` passes; dev server boots without throwing.

### m2 — Database Layer
Implements the Postgres schema, connection client, and migrations exactly per Database.md's DDL (users/categories/todos, `todo_priority` enum, indexes, deferrable unique constraint, `updated_at` triggers).
**Files:** `src/lib/db/schema.ts`, `src/lib/db/client.ts`, `src/lib/db/migrations/*`, `drizzle.config.ts`, `docker-compose.yml`
**Depends on:** m1
**Acceptance:** schema matches Database.md DDL column-for-column; `drizzle-kit generate` produces a migration containing `pgcrypto`, all three tables, all four indexes, and both triggers; `getDb()` is a singleton reading `DATABASE_URL` only via `env.ts`.

### m3 — Validation Schemas
Zod schemas shared by client forms and server functions.
**Files:** `src/lib/validation/todo.ts`
**Depends on:** m1
**Acceptance:** `CreateTodoSchema`, `UpdateTodoSchema`, `ToggleTodoSchema`, `DeleteTodoSchema`, `ListTodosSchema`, `ReorderTodosSchema` exported with inferred types; typecheck passes.

### m4 — Structured Logger
Uniform info/warn/error logging with request context, injected into the orchestrator.
**Files:** `src/lib/logging/logger.ts`
**Depends on:** m1
**Acceptance:** logger methods emit structured JSON (timestamp, level, message, meta); typecheck passes.

### m5 — Astryx Theme & Color System
Central colorful palette (priority colors, category colors, gradient accents) satisfying the "make it more colorful" steering note, plus the Astryx theme provider config and Tailwind token extension.
**Files:** `src/lib/theme/todoAppTheme.ts`, `tailwind.config.ts` (extends m1's file)
**Depends on:** m1
**Acceptance:** exported color tokens match the seed data hexes (`#f97316`, `#22c55e`, `#a855f7`, `#ef4444`); Tailwind build picks up the new tokens.

### m6 — Data Access Layer
CRUD + reorder against `todos`, plus category reads, with no business logic.
**Files:** `src/lib/repositories/todoRepository.ts`, `src/lib/repositories/categoryRepository.ts`
**Depends on:** m2
**Acceptance:** `reorder()` updates `position` transactionally without violating the deferred unique constraint; `categoryRepository.findAll` scopes by `user_id`; typecheck passes.

### m7 — Central Orchestrator
Single facade mediating all cross-cutting concerns (validation, logging, error normalization) per Architecture.md's `TodoOrchestrator` contract, plus the composition root.
**Files:** `src/lib/orchestrator/result.ts`, `src/lib/orchestrator/todoOrchestrator.ts`, `src/lib/orchestrator/index.ts`
**Depends on:** m3, m4, m6
**Acceptance:** every method validates via Zod before touching the repository; invalid input returns `Result{ok:false}` with an `AppError`; `getOrchestrator()` is a stable singleton.

### m8 — TanStack Start Server Functions
HTTP-facing boundary translating server-function calls into orchestrator calls exclusively.
**Files:** `src/server/todos.ts`
**Depends on:** m7
**Acceptance:** each function validates input, calls `getOrchestrator()`, never imports the repository/db directly; failed `Result`s surface as correctly-coded HTTP errors.

### m9 — Todo Feature UI Components
Colorful, animated todo UI built on Astryx primitives (`AstryxCard`, `AstryxButton`, `AstryxCheckbox`, `AstryxToast`) and TanStack Query hooks over the server functions.
**Files:** `src/hooks/useTodos.ts`, `src/components/todo/TodoList.tsx`, `src/components/todo/TodoItem.tsx`, `src/components/todo/AddTodoForm.tsx`, `src/components/todo/TodoFilters.tsx`
**Depends on:** m5, m8
**Acceptance:** components fetch/mutate only through `useTodos` hooks (no direct `fetch`); toggle/add/filter interactions call the correct hook.

### m10 — Routes/Pages
Composes feature components into the root layout and pages via file-based routing.
**Files:** `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/routes/todos.$id.tsx`
**Depends on:** m9
**Acceptance:** `/` renders the full add/list/filter workflow; `/todos/:id` renders a single todo's detail view; `npm run build` succeeds.

### m11 — Seed Script
Populates local dev data per Database.md's seed strategy.
**Files:** `src/lib/db/seed.ts`
**Depends on:** m2, m6
**Acceptance:** inserts 1 demo user, 4 categories with the specified hexes, and 8 todos spanning all priorities/completion states; idempotent on repeat runs.

### m12 — Test Suite
Unit, component, and e2e coverage across the finished surfaces.
**Files:** `vitest.config.ts`, `playwright.config.ts`, `src/lib/orchestrator/todoOrchestrator.test.ts`, `src/components/todo/TodoItem.test.tsx`, `src/components/todo/AddTodoForm.test.tsx`, `tests/e2e/todo-flow.spec.ts`
**Depends on:** m7, m9, m10
**Acceptance:** `npm test` and `npm run test:e2e` both pass; orchestrator tests cover validation-failure and success paths for create/toggle/reorder.

## Machine-Readable Plan

```json implementation-plan
{
  "planVersion": 1,
  "generatedBy": "DLO Design Analyst",
  "modules": [
    {
      "moduleId": "m1",
      "title": "Project Scaffold & Config",
      "stackTarget": "fullstack",
      "prompt": "Scaffold a TanStack Start app (React18, Vite/Vinxi, file routing). package.json deps: @tanstack/react-start, @tanstack/react-router, @tanstack/react-query, react, react-dom, drizzle-orm, pg, zod, @astryx/react, vinxi; devDeps: typescript, vite, tailwindcss, postcss, autoprefixer, drizzle-kit, vitest, @testing-library/react, jsdom, playwright, tsx. Scripts: dev/build/start=vinxi, test=vitest run, test:e2e=playwright test, typecheck=tsc --noEmit, db:generate/db:migrate=drizzle-kit, db:seed=tsx src/lib/db/seed.ts. Add tsconfig.json, app.config.ts, tailwind.config.ts (content paths only, no colors yet), postcss.config.js, src/router.tsx, src/routes/__root.tsx (HTML shell + Outlet), src/client.tsx, src/server.tsx, src/lib/config/env.ts (zod schema: DATABASE_URL required string, ASTRYX_API_KEY optional string), .env.example, .gitignore.",
      "dependsOn": [],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["package.json", "tsconfig.json", "app.config.ts", "tailwind.config.ts", "postcss.config.js", "src/router.tsx", "src/routes/__root.tsx", "src/client.tsx", "src/server.tsx", "src/lib/config/env.ts", ".env.example", ".gitignore"],
      "acceptance": ["npm install completes without error", "npx tsc --noEmit passes", "npm run dev boots the dev server without throwing"],
      "exitClauses": [
        {"clauseId": "c1", "description": "dependencies install cleanly", "kind": "command", "argv": ["npm", "install"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m2",
      "title": "Database Layer",
      "stackTarget": "backend",
      "prompt": "Implement Postgres/Drizzle DB layer per Database.md DDL. src/lib/db/schema.ts: users(id uuid pk gen_random_uuid, email text unique not null, display_name text not null, avatar_color text default '#6366f1', created_at/updated_at timestamptz default now); categories(id uuid pk, user_id uuid fk users.id cascade nullable, name text not null, color_hex text default '#8b5cf6' check hex format, icon text nullable, created_at timestamptz); todos(id uuid pk, user_id uuid fk users.id cascade nullable, category_id uuid fk categories.id set null nullable, title text not null check length>0, description text nullable, completed boolean default false, priority enum low/medium/high default medium, position integer not null, due_date timestamptz nullable, created_at/updated_at timestamptz). Unique (user_id,name) via COALESCE on categories; deferrable unique (user_id,position) on todos. Indexes: idx_categories_user_id, idx_todos_user_position, idx_todos_category_id, idx_todos_user_completed. src/lib/db/client.ts: pg.Pool singleton + drizzle-orm/node-postgres using env.DATABASE_URL. drizzle.config.ts pointing at schema.ts + src/lib/db/migrations. Generate initial migration matching the DDL incl. pgcrypto extension and updated_at triggers. Add docker-compose.yml with a postgres:15 service.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/lib/db/schema.ts", "src/lib/db/client.ts", "src/lib/db/migrations/", "drizzle.config.ts", "docker-compose.yml"],
      "acceptance": ["schema matches Database.md DDL column-for-column including defaults/constraints", "drizzle-kit generate produces a migration with pgcrypto extension, all 3 tables, all 4 indexes, and both updated_at triggers", "getDb() is a singleton reading DATABASE_URL only via env.ts"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "migration generates without error", "kind": "command", "argv": ["npx", "drizzle-kit", "generate"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m3",
      "title": "Validation Schemas",
      "stackTarget": "backend",
      "prompt": "Create src/lib/validation/todo.ts using Zod. Export CreateTodoSchema {title: string min1, description?: string, priority: enum(low,medium,high) default medium, categoryId?: uuid, dueDate?: ISO datetime}. UpdateTodoSchema (partial of create + id: uuid). ToggleTodoSchema {id: uuid}. DeleteTodoSchema {id: uuid}. ListTodosSchema {userId?: uuid, completed?: boolean}. ReorderTodosSchema {ids: uuid array min1}. Export z.infer TS types for each (CreateTodoInput, UpdateTodoInput, ToggleTodoInput, DeleteTodoInput, ListTodosInput, ReorderTodosInput). No dependencies on other modules.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["src/lib/validation/todo.ts"],
      "acceptance": ["all six schemas exported and correctly accept/reject sample payloads", "typecheck passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m4",
      "title": "Structured Logger",
      "stackTarget": "backend",
      "prompt": "Create src/lib/logging/logger.ts exporting a `logger` object with info(message: string, meta?: Record<string, unknown>), warn(...), error(...) methods writing structured JSON lines (timestamp, level, message, meta) to console. Export a `Logger` TS interface matching the shape for dependency injection into the orchestrator. No external deps, no dependency on other modules.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["src/lib/logging/logger.ts"],
      "acceptance": ["logger.info/warn/error emit structured JSON with timestamp+level+message+meta", "typecheck passes"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m5",
      "title": "Astryx Theme & Color System",
      "stackTarget": "frontend",
      "prompt": "Create src/lib/theme/todoAppTheme.ts exporting `todoAppTheme` with a vibrant color system per steering note 'make it more colorful': priority colors (low=#22c55e, medium=#f59e0b, high=#ef4444), category colors matching seed categories (Work=#f97316, Personal=#22c55e, Ideas=#a855f7, Urgent=#ef4444), gradient accent tokens, and an AstryxThemeProvider config consuming @astryx/react's theming API. Extend tailwind.config.ts (created in m1) with theme.colors tokens for these values and enable Astryx's tailwind preset if exported. Only touch tailwind.config.ts and the new theme file.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/lib/theme/todoAppTheme.ts", "tailwind.config.ts"],
      "acceptance": ["exported color tokens match seed data hexes (#f97316, #22c55e, #a855f7, #ef4444)", "tailwind config exposes the new tokens and builds without error"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m6",
      "title": "Data Access Layer",
      "stackTarget": "backend",
      "prompt": "Create src/lib/repositories/todoRepository.ts implementing TodoRepository against schema/client from m2: findAll(userId?) ordered by position, findById(id), insert(data: NewTodo) computing next position, update(id, data: Partial<Todo>), remove(id), reorder(ids: string[]) updating position transactionally using the deferred unique (user_id,position) constraint. Create src/lib/repositories/categoryRepository.ts: findAll(userId?), insert(data), remove(id) against categories table. Export factory functions createTodoRepository(db) and createCategoryRepository(db) for DI into the orchestrator.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/lib/repositories/todoRepository.ts", "src/lib/repositories/categoryRepository.ts"],
      "acceptance": ["CRUD+reorder methods compile against Drizzle schema types", "reorder() updates position within a single transaction without unique-constraint violations", "categoryRepository.findAll scopes by user_id"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m7",
      "title": "Central Orchestrator",
      "stackTarget": "backend",
      "prompt": "Build the Central Orchestrator. src/lib/orchestrator/result.ts: `Result<T> = {ok:true,data:T}|{ok:false,error:AppError}` and `class AppError extends Error {constructor(code,message,status=400)}`. src/lib/orchestrator/todoOrchestrator.ts: `TodoOrchestrator` interface with listTodos, createTodo, updateTodo, toggleTodo, deleteTodo, reorderTodos, listCategories — each validates input via Zod schemas from src/lib/validation/todo.ts, calls injected repository/categoryRepository, logs via injected logger, returns Result<T>, wraps unexpected errors as AppError('INTERNAL',...,500). `createTodoOrchestrator(deps:{repository,categoryRepository,logger})`. src/lib/orchestrator/index.ts: composition root exposing `getOrchestrator()` singleton wiring getDb(), createTodoRepository, createCategoryRepository, logger.",
      "dependsOn": ["m3", "m4", "m6"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/lib/orchestrator/result.ts", "src/lib/orchestrator/todoOrchestrator.ts", "src/lib/orchestrator/index.ts"],
      "acceptance": ["every method validates via Zod before touching the repository", "invalid input returns Result{ok:false} with an AppError", "getOrchestrator() returns a stable singleton across calls"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m8",
      "title": "TanStack Start Server Functions",
      "stackTarget": "backend",
      "prompt": "Create src/server/todos.ts using TanStack Start's createServerFn. Export listTodosFn, createTodoFn, updateTodoFn, toggleTodoFn, deleteTodoFn, reorderTodosFn, listCategoriesFn — each createServerFn({method}).validator(zod schema from src/lib/validation/todo.ts).handler(async ({data}) => { const orch = getOrchestrator(); const result = await orch.X(data); if(!result.ok) throw appErrorToHttp(result.error); return result.data; }). Add an appErrorToHttp helper mapping AppError.status/code to a thrown Response. Import getOrchestrator only from src/lib/orchestrator/index.ts — never import repository/db directly.",
      "dependsOn": ["m7"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/server/todos.ts"],
      "acceptance": ["each server function validates input and delegates to getOrchestrator()", "no direct import of todoRepository or db client", "failed Result surfaces as an HTTP error response with correct status"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m9",
      "title": "Todo Feature UI Components",
      "stackTarget": "frontend",
      "prompt": "Build todo UI using @astryx/react primitives (AstryxCard, AstryxButton, AstryxCheckbox, AstryxToast) + Tailwind + todoAppTheme from src/lib/theme/todoAppTheme.ts. Create src/hooks/useTodos.ts: TanStack Query hooks (useTodosQuery, useCreateTodo, useUpdateTodo, useToggleTodo, useDeleteTodo, useReorderTodos, useCategoriesQuery) calling only the server functions in src/server/todos.ts. Create src/components/todo/TodoList.tsx (renders items, drag-reorder via useReorderTodos), TodoItem.tsx (AstryxCard with checkbox, title, colorful priority chip + category badge, edit/delete actions, AstryxToast on delete), AddTodoForm.tsx (title/description/priority/category/dueDate fields, zod-validated submit via AstryxButton), TodoFilters.tsx (active/completed/all toggle + category filter chips with colorful active state).",
      "dependsOn": ["m5", "m8"],
      "estimatedComplexity": "hard",
      "maxAttempts": 4,
      "touches": ["src/hooks/useTodos.ts", "src/components/todo/TodoList.tsx", "src/components/todo/TodoItem.tsx", "src/components/todo/AddTodoForm.tsx", "src/components/todo/TodoFilters.tsx"],
      "acceptance": ["components fetch/mutate only via useTodos hooks, no direct fetch calls", "toggle/add/filter interactions invoke the correct hook and re-render with updated data", "priority chips and category badges render with theme colors"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m10",
      "title": "Routes/Pages",
      "stackTarget": "frontend",
      "prompt": "Finalize src/routes/__root.tsx to wrap the app in AstryxThemeProvider (theme=todoAppTheme) plus a QueryClientProvider, keep <Outlet/>. Create src/routes/index.tsx: main page rendering TodoFilters, AddTodoForm, TodoList from src/components/todo/*, with a loader prefetching listTodosFn/listCategoriesFn into the query cache. Create src/routes/todos.$id.tsx: detail/edit view for a single todo with a loader calling the same server functions filtered by id, showing full description/dueDate/category, and a delete/back action.",
      "dependsOn": ["m9"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": ["src/routes/__root.tsx", "src/routes/index.tsx", "src/routes/todos.$id.tsx"],
      "acceptance": ["'/' renders the full add/list/filter workflow", "'/todos/:id' renders a single todo's detail view", "npm run build succeeds"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "production build succeeds", "kind": "command", "argv": ["npm", "run", "build"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m11",
      "title": "Seed Script",
      "stackTarget": "backend",
      "prompt": "Create src/lib/db/seed.ts (run via tsx, wired to package.json db:seed script from m1). Using getDb()/schema from src/lib/db/client.ts + schema.ts: insert one demo user (email demo@example.com, display_name 'Demo User'), 4 categories scoped to that user (Work #f97316, Personal #22c55e, Ideas #a855f7, Urgent #ef4444), and 8 sample todos spanning all priorities (low/medium/high) and completion states, sequential position values, mixed categories and due dates. Make the script idempotent by deleting the existing demo user (cascades clean up todos/categories) before inserting.",
      "dependsOn": ["m2", "m6"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": ["src/lib/db/seed.ts"],
      "acceptance": ["db:seed inserts 1 user, 4 categories with the specified hexes, and 8 todos spanning all priorities/completion states", "running db:seed twice does not duplicate rows"],
      "exitClauses": [
        {"clauseId": "c1", "description": "typecheck passes", "kind": "command", "argv": ["npx", "tsc", "--noEmit"], "expect": {"exitCode": 0}}
      ]
    },
    {
      "moduleId": "m12",
      "title": "Test Suite",
      "stackTarget": "fullstack",
      "prompt": "Add vitest.config.ts + playwright.config.ts (wired to package.json test/test:e2e scripts from m1). src/lib/orchestrator/todoOrchestrator.test.ts: unit tests for createTodoOrchestrator using in-memory fake repository/logger, covering create/toggle/reorder validation failures and success Result shapes. src/components/todo/TodoItem.test.tsx and AddTodoForm.test.tsx: Testing Library tests for render, toggle click, and form submit against mocked useTodos hooks. tests/e2e/todo-flow.spec.ts: Playwright test loading '/', adding a todo, toggling it complete, filtering by category, and deleting it, asserting colorful priority chip/category badge UI renders.",
      "dependsOn": ["m7", "m9", "m10"],
      "estimatedComplexity": "hard",
      "maxAttempts": 4,
      "touches": ["vitest.config.ts", "playwright.config.ts", "src/lib/orchestrator/todoOrchestrator.test.ts", "src/components/todo/TodoItem.test.tsx", "src/components/todo/AddTodoForm.test.tsx", "tests/e2e/todo-flow.spec.ts"],
      "acceptance": ["npm test passes", "npm run test:e2e passes against a running dev server", "orchestrator tests cover validation-failure and success paths for create/toggle/reorder"],
      "exitClauses": [
        {"clauseId": "c1", "description": "unit/component tests pass", "kind": "command", "argv": ["npm", "test"], "expect": {"exitCode": 0}},
        {"clauseId": "c2", "description": "e2e tests pass", "kind": "command", "argv": ["npm", "run", "test:e2e"], "expect": {"exitCode": 0}}
      ]
    }
  ]
}
```