# Architecture — Todo App using Meta Astryx

## Technology Choices

**Framework note on Astryx:** The research specifies building with the Astryx framework (https://astryx.atmeta.com/) but provides no further detail on its routing model, server integration, or backend requirements. Since the research does not clearly mandate a full application stack (server framework, data layer, deployment model), per the Framework Rule we default to **TanStack Start** (React, file-based routing, server functions, Vite) as the application shell, with **PostgreSQL** as the database. Astryx is treated as a **UI component/interaction layer** integrated into this TanStack Start app — supplying the colorful, animated visual components (buttons, cards, transitions) that satisfy the steering note "make it more colorful," while TanStack Start handles routing, server functions, and data plumbing.

| Concern | Choice | Justification |
|---|---|---|
| App framework | TanStack Start (React 18, Vite, file-based routing, server functions) | Default per Framework Rule; single full-stack framework, no separate API server needed |
| UI component/animation layer | Astryx (`@astryx/react` or equivalent client SDK) | Explicitly requested in research; provides colorful, motion-rich UI primitives |
| Styling | Tailwind CSS + Astryx theme tokens | Utility-first styling composes cleanly with Astryx components; enables a vibrant, consistent color palette per steering note |
| Database | PostgreSQL | Mandated by Framework Rule |
| ORM | Drizzle ORM | Type-safe, lightweight, first-class TanStack Start/Vite compatibility, good migration story |
| Validation | Zod | Shared schema validation between client forms and server functions |
| State/data fetching | TanStack Query (via TanStack Start's built-in server function + query integration) | Consistent with TanStack Start conventions, avoids ad-hoc fetch logic |
| Testing | Vitest + Testing Library (unit/integration), Playwright (e2e) | Matches Vite-based toolchain |

## Central Orchestrator

**Module:** `src/lib/orchestrator/todoOrchestrator.ts`

The Central Orchestrator is the single module that mediates all cross-cutting application behavior. No feature module calls another feature module directly — everything routes through the orchestrator or through TanStack Start's server function boundary (which the orchestrator itself is invoked from).

**Responsibilities:**
- Register and expose all domain operations (create/read/update/delete/toggle/reorder todos) as a single typed facade.
- Own the lifecycle of cross-cutting concerns: validation (via Zod schemas), logging, error normalization, and authorization checks (if/when auth is added).
- Translate module-level results into a consistent `Result<T, AppError>` shape returned to server functions/UI.
- Provide the single registration point for feature modules — each module exports a set of handlers that the orchestrator wires into its public interface at startup.

**Public interface:**
```ts
// src/lib/orchestrator/todoOrchestrator.ts
export interface TodoOrchestrator {
  listTodos(input: ListTodosInput): Promise<Result<Todo[]>>;
  createTodo(input: CreateTodoInput): Promise<Result<Todo>>;
  updateTodo(input: UpdateTodoInput): Promise<Result<Todo>>;
  toggleTodo(input: ToggleTodoInput): Promise<Result<Todo>>;
  deleteTodo(input: DeleteTodoInput): Promise<Result<void>>;
  reorderTodos(input: ReorderTodosInput): Promise<Result<Todo[]>>;
}

export function createTodoOrchestrator(deps: {
  repository: TodoRepository;   // from data module
  logger: Logger;               // from logging module
}): TodoOrchestrator
```

**Registration pattern:** Feature modules do not import each other. Instead, each module exposes a narrow interface (e.g. `TodoRepository`, `TodoValidator`) that is injected into `createTodoOrchestrator` at the composition root (`src/lib/orchestrator/index.ts`). The orchestrator is instantiated once per server function invocation (stateless, connection pooled) and imported by route/server-function files only — UI components never import the orchestrator or data modules directly.

## Modules

### 1. `db` — Database Access
- **Responsibility:** Postgres connection pooling, Drizzle schema definitions, migrations.
- **Public interface:** `getDb(): DrizzleClient`, exported `schema` (todos table).
- **Dependencies:** None (leaf module).
- Location: `src/lib/db/schema.ts`, `src/lib/db/client.ts`

### 2. `todoRepository` — Data Access Layer
- **Responsibility:** CRUD + reorder operations against the `todos` table; no business logic.
- **Public interface:**
  ```ts
  interface TodoRepository {
    findAll(userId?: string): Promise<Todo[]>;
    findById(id: string): Promise<Todo | null>;
    insert(data: NewTodo): Promise<Todo>;
    update(id: string, data: Partial<Todo>): Promise<Todo>;
    remove(id: string): Promise<void>;
    reorder(ids: string[]): Promise<Todo[]>;
  }
  ```
- **Dependencies:** `db` module only.
- Location: `src/lib/repositories/todoRepository.ts`

### 3. `validation` — Schema Definitions
- **Responsibility:** Zod schemas for all todo inputs, shared by client forms and server functions.
- **Public interface:** `CreateTodoSchema`, `UpdateTodoSchema`, `ReorderTodosSchema`, plus inferred TS types.
- **Dependencies:** None.
- Location: `src/lib/validation/todo.ts`

### 4. `logging` — Structured Logger
- **Responsibility:** Uniform structured logging (info/warn/error) with request context.
- **Public interface:** `Logger.info/warn/error(message, meta?)`.
- **Dependencies:** None.
- Location: `src/lib/logging/logger.ts`

### 5. `orchestrator` — Central Orchestrator (see above)
- **Dependencies:** `todoRepository`, `validation`, `logging` (injected).

### 6. `server-functions` — TanStack Start Server Functions
- **Responsibility:** HTTP-facing boundary; parses requests, calls the orchestrator, serializes responses.
- **Public interface:** `createServerFn`-based functions: `listTodosFn`, `createTodoFn`, `updateTodoFn`, `toggleTodoFn`, `deleteTodoFn`, `reorderTodosFn`.
- **Dependencies:** `orchestrator` only.
- Location: `src/server/todos.ts`

### 7. `ui/todo` — Feature UI Components
- **Responsibility:** Todo list, todo item, add-todo form, filters — built using Astryx components (`AstryxCard`, `AstryxButton`, `AstryxCheckbox`, `AstryxToast`) for colorful, animated presentation.
- **Public interface:** React components: `<TodoList />`, `<TodoItem />`, `<AddTodoForm />`, `<TodoFilters />`.
- **Dependencies:** TanStack Query hooks calling `server-functions` exclusively; Astryx UI primitives + `theme` module for styling.
- Location: `src/components/todo/*`

### 8. `theme` — Astryx Theme & Color System
- **Responsibility:** Central definition of the colorful palette (per steering note), Astryx theme provider configuration, Tailwind color tokens (priority colors, category colors, gradient accents).
- **Public interface:** `<AstryxThemeProvider theme={todoAppTheme}>`, exported `todoAppTheme` token object, Tailwind config extension.
- **Dependencies:** None (consumed by `ui/todo` and root layout only).
- Location: `src/lib/theme/todoAppTheme.ts`, `tailwind.config.ts`

### 9. `routes` — File-based Routes
- **Responsibility:** Page composition (`/`, `/todos/:id`), layout, loading states.
- **Public interface:** N/A (framework-owned file convention).
- **Dependencies:** `ui/todo` components, `server-functions` (via loaders).
- Location: `src/routes/*`

**Dependency graph (strict, one direction):**
```
routes → ui/todo → server-functions → orchestrator → { todoRepository, validation, logging }
                        ↑                                        ↓
                     theme                                     db
```
No module skips a layer; `ui/todo` never imports `todoRepository` or `db` directly.

## Plumbing & Conventions

**Folder layout:**
```
src/
  routes/                # file-based routes (TanStack Start)
    index.tsx
    todos.$id.tsx
  components/
    todo/                # TodoList, TodoItem, AddTodoForm, TodoFilters
    ui/                   # Astryx-wrapped shared primitives
  server/
    todos.ts             # server functions (HTTP boundary)
  lib/
    orchestrator/
      index.ts           # composition root — wires deps, exports singleton getter
      todoOrchestrator.ts
    repositories/
      todoRepository.ts
    db/
      client.ts
      schema.ts
      migrations/
    validation/
      todo.ts
    logging/
      logger.ts
    theme/
      todoAppTheme.ts
  app.config.ts           # TanStack Start config
drizzle.config.ts
tailwind.config.ts
.env / .env.example
```

**Error handling:**
```ts
// src/lib/orchestrator/result.ts
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
```
Server functions catch `AppError` and map `code`/`status` to HTTP responses; unexpected errors are logged and surfaced as a generic 500 without leaking internals.

**Configuration:** Environment variables loaded via `.env` (`DATABASE_URL`, `ASTRYX_API_KEY` if required by the Astryx SDK), validated at startup with a Zod `envSchema` in `src/lib/config/env.ts`. No module reads `process.env` directly — all config flows through this single validated object.

**Dependency wiring (composition root):**
```ts
// src/lib/orchestrator/index.ts
import { getDb } from "../db/client";
import { createTodoRepository } from "../repositories/todoRepository";
import { logger } from "../logging/logger";
import { createTodoOrchestrator } from "./todoOrchestrator";

let orchestrator: TodoOrchestrator | null = null;

export function getOrchestrator(): TodoOrchestrator {
  if (!orchestrator) {
    orchestrator = createTodoOrchestrator({
      repository: createTodoRepository(getDb()),
      logger,
    });
  }
  return orchestrator;
}
```

**Server function example:**
```ts
// src/server/todos.ts
import { createServerFn } from "@tanstack/start";
import { getOrchestrator } from "~/lib/orchestrator";
import { CreateTodoSchema } from "~/lib/validation/todo";

export const createTodoFn = createServerFn("POST", async (raw: unknown) => {
  const input = CreateTodoSchema.parse(raw);
  const result = await getOrchestrator().createTodo(input);
  if (!result.ok) throw result.error;
  return result.data;
});
```

**Logging:** Every server function and orchestrator method logs entry/exit at `info` level with a correlation id; errors log at `error` with stack trace stripped in production responses.

## Best Practices

- **Type safety:** End-to-end typed via Drizzle-inferred DB types → Zod-validated inputs → orchestrator interfaces → TanStack Query hooks. No `any` at module boundaries.
- **Testing strategy:**
  - Unit tests (Vitest) for `todoRepository` (against a test Postgres schema/transaction rollback) and `todoOrchestrator` (with mocked repository).
  - Integration tests for server functions using an in-memory/test DB.
  - E2E tests (Playwright) covering the golden path: add → toggle → reorder → delete a todo, verifying Astryx UI renders and animations don't block interaction.
- **Security:** All inputs validated with Zod at the server-function boundary before reaching the orchestrator; parameterized queries only (Drizzle prevents raw SQL injection by default); no secrets in client bundles (Astryx API key, if any, used server-side only or restricted to a public/scoped key).
- **Performance:** TanStack Query caching for list reads; optimistic updates for toggle/reorder to keep the colorful UI feeling instant; Postgres index on `(user_id, position)` for ordered list reads.

## Deployment Shape

**Local development:**
- `docker-compose.yml` running a local PostgreSQL instance.
- `pnpm dev` starts Vite dev server (TanStack Start) with HMR.
- `drizzle-kit migrate` run against local DB on setup.

**Production:**
- TanStack Start builds to a Node server bundle (or edge/serverless target, e.g. Vercel/Netlify adapter) — single deployable artifact serving both UI and server functions.
- PostgreSQL hosted as a managed instance (e.g. Neon, Supabase, RDS); connection string via `DATABASE_URL` env var.
- Migrations run as a pre-deploy step (`drizzle-kit migrate`) against the production database.
- Astryx assets/SDK loaded per its documented integration (client bundle or CDN script) — no server-side dependency beyond optional API key for premium features.