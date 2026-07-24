# Implementation Plan — Approve Test App

## Build Order

The implementation follows a standard bottom-up dependency graph, maximizing parallelism where modules have no shared file dependencies.

**Phase 1: Foundation (Serial)**
- **m1 (Scaffolding)**: Sets up TanStack Start project with all dependencies, framework config, and entry point. Must execute first; everything depends on this.
- **m2 (Database Schema)**: Defines PostgreSQL schema via Drizzle ORM and generates migrations. Must follow m1 so the dev environment exists.
- **m3 (Repositories)**: Implements type-safe CRUD layer for all database tables. Depends on m2 schema being defined.

**Phase 2: Business Logic (Parallel)**
After m3, three independent service modules can run concurrently:
- **m4 (Authentication Service)**: User login/logout, session management, permission checks. Isolated in `src/lib/auth/`; no other services depend on it yet.
- **m5 (Approval Orchestrator)**: Core state machine for approval workflows. Isolated in `src/lib/orchestrator/`; manages lifecycle and validation logic.
- **m6 (Audit Logger)**: Compliance logging for all state changes. Isolated in `src/lib/logging/`; independent business logic.

**Phase 3: Integration (Serial)**
- **m7 (Todo Service)**: Business logic layer orchestrating auth (m4), orchestrator (m5), logger (m6), and repositories (m3). First module that pulls everything together.
- **m8 (API Layer)**: Server functions (RPC endpoints) exposing m7 and m4 to the client. Depends on m7 existing and m4 for request auth.
- **m9 (UI Components)**: React components calling m8 server functions. Depends on m8 endpoints being available.
- **m10 (End-to-End Tests)**: Integration tests validating the complete approval flow from UI through database. Runs last to verify m1–m9 work together.

This order minimizes blocked time: Phase 1 is serial (unavoidable); Phase 2 runs three agents in parallel; Phase 3 re-serializes as each layer depends on the previous. Total wall-clock time is roughly equivalent to 7 sequential modules instead of 10.

---

## Modules

### m1: Project Scaffolding

**Title**: TanStack Start Project Setup

**What to Build**: Initialize a new TanStack Start project with all dependencies, framework configuration, and scaffold the entry point and root route.

**Files Created/Modified**:
- `package.json` — all dependencies and scripts (dev, build, test, type-check)
- `app.config.ts` — TanStack Start configuration
- `tsconfig.json` — TypeScript compiler options
- `src/entry.server.ts` — server entry point
- `src/entry.client.tsx` — client entry point
- `src/routes/__root.tsx` — root layout route
- `src/routes/index.tsx` — home route (placeholder)
- `.gitignore`, `.env.example`, `README.md` — project docs and git config

**Dependencies**: None

**Acceptance Criteria**:
- `npm install` completes successfully
- `npm run dev` starts dev server without errors
- `npm run build` creates production bundle
- `npx tsc --noEmit` passes (TypeScript typecheck)
- Browser can load `http://localhost:5173` (or dev server port) and render the root route

**Estimated Complexity**: medium

**Max Attempts**: 3

---

### m2: Database Schema & Migrations

**Title**: PostgreSQL Schema via Drizzle ORM

**What to Build**: Define all database tables using Drizzle ORM schema definitions, generate Drizzle migration files, and set up the database client with connection pooling.

**Files Created/Modified**:
- `src/lib/db/schema.ts` — Drizzle table definitions (users, todos, approvals, approvals_decisions, audit_logs)
- `src/lib/db/migrations/001_initial_schema.ts` — Drizzle migration file (auto-generated from schema)
- `src/lib/db/index.ts` — database client initialization and connection pool setup
- `.env.example` — add `DATABASE_URL` variable

**Dependencies**: m1

**Acceptance Criteria**:
- Schema file defines all tables per Database.md (users, todos, approvals, approvals_decisions, audit_logs) with correct columns, types, and constraints
- Migration file can be applied to a test PostgreSQL database without errors
- Drizzle types are correctly generated and importable
- Database client exports a pool and query function for use by repositories

**Estimated Complexity**: medium

**Max Attempts**: 3

---

### m3: Database Repository Layer

**Title**: Type-Safe Data Access

**What to Build**: Implement CRUD repositories for each domain entity (users, todos, approvals) as the single interface to the database. Use Drizzle ORM queries and export typed interfaces.

**Files Created/Modified**:
- `src/lib/db/repositories/user-repository.ts` — user CRUD, lookups by email/id, role queries
- `src/lib/db/repositories/todo-repository.ts` — todo CRUD, list by user, status queries
- `src/lib/db/repositories/approval-repository.ts` — approval ticket CRUD, decisions, history queries
- `src/lib/db/repositories/audit-log-repository.ts` — append-only audit log queries

**Dependencies**: m2

**Acceptance Criteria**:
- All repository methods exist and match the public interfaces in Architecture.md
- Queries are type-safe (no `any` types)
- Can perform full CRUD cycle on test database (create, read, update, delete)
- Foreign key constraints are respected (cascading deletes work as designed)
- Composite indexes are used in queries (e.g., (user_id, status) for filtering)

**Estimated Complexity**: easy

**Max Attempts**: 3

---

### m4: Authentication & Authorization Service

**Title**: User Authentication & Permission Checks

**What to Build**: Implement login/logout, session management via cookies, and permission checks (canApprove, canSubmit) based on user roles.

**Files Created/Modified**:
- `src/lib/auth/auth-service.ts` — login, logout, getCurrentUser, canApprove, canSubmit
- `src/lib/auth/session.ts` — session encoding/decoding, secure cookie helpers
- `src/lib/auth/types.ts` — User, Session, AuthContext types
- `src/lib/auth/password.ts` — bcrypt hashing/verification utilities

**Dependencies**: m1, m3

**Acceptance Criteria**:
- `login(email, password)` hashes password with bcrypt and returns session token if valid
- `getCurrentUser(request)` extracts session from cookies and returns user or null
- `canApprove(userId, todoId)` returns true only if user role is 'approver' or 'admin'
- `canSubmit(userId, todoId)` returns true only if user is the todo owner
- Session cookies are httpOnly and Secure (production) or Secure flag set
- Logout clears session cookie

**Estimated Complexity**: medium

**Max Attempts**: 3

---

### m5: Approval Orchestrator

**Title**: Approval Workflow State Machine

**What to Build**: Core business logic orchestrating approval lifecycle: submit, approve, reject, track status, emit events for handlers.

**Files Created/Modified**:
- `src/lib/orchestrator/approval-orchestrator.ts` — ApprovalOrchestrator implementation
- `src/lib/orchestrator/types.ts` — ApprovalTicket, ApprovalStatus, ApprovalHandler interfaces
- `src/lib/orchestrator/handlers/index.ts` — handler registration and invocation

**Dependencies**: m1, m3

**Acceptance Criteria**:
- `registerHandler(name, handler)` stores handler for lifecycle events
- `submitForApproval(todoId, userId)` creates ApprovalTicket, updates todo status to 'pending-approval', calls handler validation
- `approve(approvalId, approverId)` updates ApprovalTicket to 'approved' once required approvals met, calls onApproved handlers, updates todo status
- `reject(approvalId, approverId, reason)` updates ApprovalTicket to 'rejected' immediately, calls onRejected handlers, updates todo status
- `getStatus(todoId)` returns ApprovalStatus with current progress
- `getHistory(todoId)` returns chronological list of state changes

**Estimated Complexity**: hard

**Max Attempts**: 4

---

### m6: Audit Logger

**Title**: Compliance & Audit Logging

**What to Build**: Service that logs all approval actions (submitted, approved, rejected) to the audit_logs table with actor, action type, and structured metadata.

**Files Created/Modified**:
- `src/lib/logging/audit-logger.ts` — AuditLogger implementation
- `src/lib/logging/types.ts` — AuditLogEntry, AuditAction types

**Dependencies**: m1, m3

**Acceptance Criteria**:
- `logSubmitted(todoId, userId)` creates audit entry with action='approval_submitted'
- `logApproved(approvalId, approverId)` creates entry with action='approval_approved'
- `logRejected(approvalId, approverId, reason)` creates entry with action='approval_rejected', stores reason in details JSON
- `getLog(todoId)` retrieves all entries for a todo ordered by created_at DESC
- Timestamps are accurate and stored in UTC

**Estimated Complexity**: easy

**Max Attempts**: 2

---

### m7: Todo Service

**Title**: Todo Business Logic & Orchestration

**What to Build**: High-level service integrating repositories, orchestrator, auth, and logger. Provides create, list, update, delete, and submitForApproval operations.

**Files Created/Modified**:
- `src/lib/services/todo-service.ts` — TodoService implementation

**Dependencies**: m3, m4, m5, m6

**Acceptance Criteria**:
- `create(title, description, userId)` validates title (non-empty), persists todo in 'draft' status, logs creation
- `getById(id)` returns Todo or null
- `listByUser(userId)` returns todos owned by user, ordered by createdAt DESC
- `update(id, updates)` allows updating title/description/status, rejects status changes outside orchestrator
- `delete(id)` soft-deletes or cascades per design, logs deletion
- `submitForApproval(id, userId)` calls orchestrator.submitForApproval, checks auth (userId must own todo), logs submission
- All return types match Architecture.md interfaces

**Estimated Complexity**: medium

**Max Attempts**: 3

---

### m8: API Layer / Server Functions

**Title**: RPC Endpoints (TanStack Start Server Functions)

**What to Build**: Implement server functions for all user-facing operations: create/list/delete todos, submit for approval, approve/reject, get status.

**Files Created/Modified**:
- `src/app/api/todos.server.ts` — server functions for todo CRUD and approval submission
- `src/app/api/approvals.server.ts` — server functions for approval decisions (approve/reject/getStatus)

**Dependencies**: m1, m7, m4

**Acceptance Criteria**:
- `createTodo(title, description)` validates input with Zod, checks auth, calls TodoService.create, returns typed response
- `getTodos()` calls TodoService.listByUser for authenticated user, returns list
- `submitTodoForApproval(todoId)` validates auth (user owns todo), calls TodoService.submitForApproval, returns ticket
- `approveTodo(approvalId, feedback?)` validates auth (user has approver role), calls orchestrator.approve, returns result
- `rejectTodo(approvalId, reason)` validates auth, calls orchestrator.reject, returns result
- `getTodoStatus(todoId)` returns ApprovalStatus via orchestrator
- Unauthenticated requests throw 401 error; unauthorized requests throw 403
- All errors return consistent JSON error responses

**Estimated Complexity**: medium

**Max Attempts**: 3

---

### m9: UI Components & Pages

**Title**: React Components & Routes

**What to Build**: Build the user-facing React components for todo list, form, approval panel, and route pages. Use TanStack Query for server state.

**Files Created/Modified**:
- `src/app/components/TodoList.tsx` — component listing todos with approval status indicator
- `src/app/components/TodoForm.tsx` — form to create new todo
- `src/app/components/TodoItem.tsx` — individual todo item with actions (submit for approval, mark done)
- `src/app/components/ApprovalPanel.tsx` — panel showing pending approvals (approver view)
- `src/app/components/ApprovalDecisionForm.tsx` — form to approve/reject with feedback/reason
- `src/app/routes/todos.tsx` — /todos page with TodoList and TodoForm
- `src/app/routes/approvals.tsx` — /approvals page with pending approvals for current user (approver-only)

**Dependencies**: m1, m8

**Acceptance Criteria**:
- All components render without console errors
- TodoList fetches todos via getTodos server function and displays them
- TodoForm calls createTodo, clears form on success, shows validation errors
- TodoItem displays status badge (draft/pending-approval/approved/rejected)
- TodoItem "Submit for Approval" button calls submitTodoForApproval, shows loading state, displays success/error toast
- ApprovalPanel fetches pending approvals (via new getApprovalsPending server function)
- ApprovalDecisionForm allows approver to submit approval or rejection with feedback
- All UX follows React best practices: optimistic updates, error boundaries, loading states
- TypeScript types are correct (server function return types match component prop expectations)

**Estimated Complexity**: medium

**Max Attempts**: 3

---

### m10: End-to-End Tests

**Title**: Integration Tests for Approval Flow

**What to Build**: Write integration tests validating the complete approval workflow from UI submission through database state, using a test database and mocked browser/server.

**Files Created/Modified**:
- `tests/e2e/approval-flow.test.ts` — test scenarios for full approval lifecycle
- `tests/unit/approval-orchestrator.test.ts` — unit tests for orchestrator state transitions
- `tests/setup.ts` — test database setup/teardown, fixtures

**Dependencies**: m9

**Acceptance Criteria**:
- Test: User creates a todo → todo exists in 'draft' status
- Test: User submits todo for approval → todo status changes to 'pending-approval', approval ticket created, audit log entry added
- Test: Approver views pending approvals → list includes submitted todo
- Test: Approver approves todo → status changes to 'approved', onApproved handlers called, audit log entry added
- Test: Approver rejects todo → status changes to 'rejected', audit log entry added
- Test: Todo owner cannot approve their own todo → canApprove returns false
- Test: Audit log contains complete history of all state changes
- All tests pass; coverage of approval orchestrator and todo service > 80%

**Estimated Complexity**: hard

**Max Attempts**: 4

---

## Machine-Readable Plan

```json implementation-plan
{
  "planVersion": 1,
  "generatedBy": "DLO Design Analyst",
  "projectName": "Approve Test App",
  "modules": [
    {
      "moduleId": "m1",
      "title": "Project Scaffolding",
      "stackTarget": "fullstack",
      "prompt": "Initialize TanStack Start project with all dependencies (React, TanStack Query, Drizzle, PostgreSQL driver, bcryptjs, zod). Create app.config.ts, tsconfig.json, package.json with dev/build/test/typecheck scripts. Scaffold src/entry.server.ts, src/entry.client.tsx, src/routes/__root.tsx root layout, src/routes/index.tsx placeholder. Ensure npm install and npm run dev work without errors.",
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
        "src/entry.server.ts",
        "src/entry.client.tsx",
        "src/routes/__root.tsx",
        "src/routes/index.tsx"
      ],
      "acceptance": [
        "npm install succeeds without errors",
        "npm run dev starts server on default port (5173)",
        "npm run build creates .output or dist directory",
        "npx tsc --noEmit passes (no TypeScript errors)",
        "http://localhost:5173 loads in browser and renders root layout"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "npm install succeeds",
          "kind": "command",
          "argv": ["npm", "install"],
          "expect": {"exitCode": 0}
        },
        {
          "clauseId": "c2",
          "description": "TypeScript compilation succeeds",
          "kind": "command",
          "argv": ["npx", "tsc", "--noEmit"],
          "expect": {"exitCode": 0}
        }
      ]
    },
    {
      "moduleId": "m2",
      "title": "Database Schema & Migrations",
      "stackTarget": "backend",
      "prompt": "Define PostgreSQL schema using Drizzle ORM in src/lib/db/schema.ts: tables users, todos, approvals, approvals_decisions, audit_logs with exact columns per Database.md. Generate migration file src/lib/db/migrations/001_initial_schema.ts. Create src/lib/db/index.ts with database client initialization using node-postgres (pg) connection pool. Support DATABASE_URL env var. Test migration runs without errors on test PostgreSQL instance.",
      "dependsOn": ["m1"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/lib/db/schema.ts",
        "src/lib/db/migrations/001_initial_schema.ts",
        "src/lib/db/index.ts",
        ".env.example"
      ],
      "acceptance": [
        "schema.ts exports all table definitions (users, todos, approvals, approvals_decisions, audit_logs) with correct columns and constraints per Database.md",
        "Drizzle migration file exists and is syntactically valid",
        "Database client exports db instance and connection pool",
        "Migration applies to test PostgreSQL database without errors",
        "Drizzle types are generated and can be imported"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "Schema file has all required tables and columns",
          "kind": "grep",
          "pattern": "users|todos|approvals|approvals_decisions|audit_logs",
          "file": "src/lib/db/schema.ts",
          "expect": {"matches": 5}
        }
      ]
    },
    {
      "moduleId": "m3",
      "title": "Database Repository Layer",
      "stackTarget": "backend",
      "prompt": "Implement CRUD repositories in src/lib/db/repositories/: user-repository.ts (create, findById, findByEmail, findByUserId), todo-repository.ts (create, findById, findByUserId, update, delete), approval-repository.ts (createTicket, getTicket, updateTicket, listByTodo), audit-log-repository.ts (append, getByTodo). Use Drizzle ORM queries with type safety. All methods return typed objects matching Architecture.md interfaces. Test on real database to verify CRUD cycles and constraints work.",
      "dependsOn": ["m2"],
      "estimatedComplexity": "easy",
      "maxAttempts": 3,
      "touches": [
        "src/lib/db/repositories/user-repository.ts",
        "src/lib/db/repositories/todo-repository.ts",
        "src/lib/db/repositories/approval-repository.ts",
        "src/lib/db/repositories/audit-log-repository.ts",
        "src/lib/db/repositories/index.ts"
      ],
      "acceptance": [
        "All repository interfaces from Architecture.md are implemented",
        "No TypeScript 'any' types in repository code",
        "CRUD operations work on test database (create, read, update, delete)",
        "Foreign key constraints are respected (cascade deletes work)",
        "Queries use composite indexes where applicable"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "Repositories are exportable and typed",
          "kind": "command",
          "argv": ["npx", "tsc", "--noEmit", "--project", "."],
          "expect": {"exitCode": 0}
        }
      ]
    },
    {
      "moduleId": "m4",
      "title": "Authentication & Authorization Service",
      "stackTarget": "backend",
      "prompt": "Implement auth service in src/lib/auth/auth-service.ts with methods: login(email, password) → {token, user}, logout(), getCurrentUser(request) → User|null, canApprove(userId, todoId) → bool, canSubmit(userId, todoId) → bool. Use bcryptjs for password hashing. Implement session management in src/lib/auth/session.ts using httpOnly/Secure cookies. Permissions: 'approver' and 'admin' roles can approve; user can only submit their own todos. Export typed User and AuthContext interfaces. Test login/logout flow, permission checks by role.",
      "dependsOn": ["m1", "m3"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/lib/auth/auth-service.ts",
        "src/lib/auth/session.ts",
        "src/lib/auth/types.ts",
        "src/lib/auth/password.ts"
      ],
      "acceptance": [
        "login(email, password) hashes password with bcrypt and returns session token or null",
        "getCurrentUser(request) extracts and validates session from httpOnly cookie",
        "canApprove(userId, todoId) returns true only for 'approver' or 'admin' role",
        "canSubmit(userId, todoId) returns true only if user owns todo",
        "logout clears session cookie",
        "Session cookies are httpOnly and Secure in production"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "Auth service exports correct interfaces",
          "kind": "command",
          "argv": ["npx", "tsc", "--noEmit", "--project", "."],
          "expect": {"exitCode": 0}
        }
      ]
    },
    {
      "moduleId": "m5",
      "title": "Approval Orchestrator",
      "stackTarget": "backend",
      "prompt": "Implement ApprovalOrchestrator in src/lib/orchestrator/approval-orchestrator.ts. Core methods: registerHandler(name, handler), submitForApproval(todoId, userId) → ticket, approve(approvalId, approverId, feedback?) → result, reject(approvalId, approverId, reason) → result, getStatus(todoId) → status, getHistory(todoId) → entries. State machine: validate submission, track approvals, emit handler lifecycle events (onApproved, onRejected). Update todo status to 'pending-approval'/'approved'/'rejected'. Ensure one active approval per todo. Handlers receive validation errors and lifecycle events.",
      "dependsOn": ["m1", "m3"],
      "estimatedComplexity": "hard",
      "maxAttempts": 4,
      "touches": [
        "src/lib/orchestrator/approval-orchestrator.ts",
        "src/lib/orchestrator/types.ts",
        "src/lib/orchestrator/handlers/index.ts"
      ],
      "acceptance": [
        "registerHandler(name, handler) stores handler for lifecycle events",
        "submitForApproval creates ApprovalTicket, updates todo status, validates submission",
        "approve updates ticket to 'approved' once required approvals met, calls onApproved handlers",
        "reject updates ticket to 'rejected' immediately, calls onRejected handlers",
        "getStatus returns current approval progress (e.g., 1/1 approvals)",
        "getHistory returns chronological list of state changes for todo",
        "Only one active approval per todo at a time"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "Orchestrator state management is type-safe",
          "kind": "command",
          "argv": ["npx", "tsc", "--noEmit", "--project", "."],
          "expect": {"exitCode": 0}
        }
      ]
    },
    {
      "moduleId": "m6",
      "title": "Audit Logger",
      "stackTarget": "backend",
      "prompt": "Implement AuditLogger in src/lib/logging/audit-logger.ts with methods: logSubmitted(todoId, userId), logApproved(approvalId, approverId), logRejected(approvalId, approverId, reason), getLog(todoId) → entries[]. Each log entry records action (approval_submitted|approval_approved|approval_rejected), actor_id, timestamps, and structured metadata (feedback/reason in details JSON). Persist to audit_logs table via audit-log-repository. Entries are immutable once created. Ordered by created_at DESC on retrieval.",
      "dependsOn": ["m1", "m3"],
      "estimatedComplexity": "easy",
      "maxAttempts": 2,
      "touches": [
        "src/lib/logging/audit-logger.ts",
        "src/lib/logging/types.ts"
      ],
      "acceptance": [
        "logSubmitted creates audit_logs entry with action='approval_submitted'",
        "logApproved creates entry with action='approval_approved'",
        "logRejected creates entry with action='approval_rejected', reason in details",
        "getLog(todoId) retrieves entries ordered by created_at DESC",
        "All timestamps in UTC"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "Audit logger can be imported and used",
          "kind": "command",
          "argv": ["npx", "tsc", "--noEmit", "--project", "."],
          "expect": {"exitCode": 0}
        }
      ]
    },
    {
      "moduleId": "m7",
      "title": "Todo Service",
      "stackTarget": "backend",
      "prompt": "Implement TodoService in src/lib/services/todo-service.ts orchestrating repositories, orchestrator, auth, and logger. Methods: create(title, description, userId) → todo, getById(id) → todo|null, listByUser(userId) → todos, update(id, updates) → todo, delete(id) → void, submitForApproval(id, userId) → ticket. Validate title non-empty. Check auth (user owns todo for submit). Integrate with orchestrator.submitForApproval. Log all state changes. Return types match Architecture.md Todo interface.",
      "dependsOn": ["m3", "m4", "m5", "m6"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/lib/services/todo-service.ts"
      ],
      "acceptance": [
        "create validates title, persists in 'draft' status, logs creation",
        "getById returns typed Todo or null",
        "listByUser returns todos ordered by createdAt DESC",
        "update rejects invalid status transitions (must go through orchestrator)",
        "delete removes todo from database",
        "submitForApproval checks auth, calls orchestrator, logs submission",
        "All return types match Architecture.md"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "TodoService uses all dependencies correctly",
          "kind": "command",
          "argv": ["npx", "tsc", "--noEmit", "--project", "."],
          "expect": {"exitCode": 0}
        }
      ]
    },
    {
      "moduleId": "m8",
      "title": "API Layer / Server Functions",
      "stackTarget": "backend",
      "prompt": "Implement TanStack Start server functions in src/app/api/todos.server.ts (createTodo, getTodos, submitTodoForApproval, updateTodo, deleteTodo) and src/app/api/approvals.server.ts (approveTodo, rejectTodo, getApprovalStatus, getApprovalsPending). Use server$() from @tanstack/start. Validate input with Zod. Check auth for all endpoints (401 unauthenticated, 403 unauthorized). Call TodoService and ApprovalOrchestrator. Return typed responses {success, data} or throw errors. Unauthenticated users cannot access any endpoint.",
      "dependsOn": ["m1", "m7", "m4"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/app/api/todos.server.ts",
        "src/app/api/approvals.server.ts"
      ],
      "acceptance": [
        "createTodo validates input, checks auth, returns typed response",
        "getTodos returns user's todos for authenticated user only",
        "submitTodoForApproval checks auth (user owns todo), calls orchestrator",
        "approveTodo checks auth (user is approver), calls orchestrator",
        "rejectTodo checks auth (user is approver), calls orchestrator",
        "Unauthenticated requests throw 401; unauthorized throw 403",
        "All endpoints validate input with Zod before processing"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "Server functions are type-safe and callable",
          "kind": "command",
          "argv": ["npx", "tsc", "--noEmit", "--project", "."],
          "expect": {"exitCode": 0}
        }
      ]
    },
    {
      "moduleId": "m9",
      "title": "UI Components & Pages",
      "stackTarget": "frontend",
      "prompt": "Build React components in src/app/components/: TodoList (fetches todos, displays list), TodoForm (create new todo), TodoItem (displays todo with status, submit button), ApprovalPanel (lists pending approvals for approver), ApprovalDecisionForm (approve/reject form). Create routes in src/app/routes/: todos.tsx (/todos page with list+form), approvals.tsx (/approvals approver-only). Use TanStack Query for server state. Components handle loading, error, success states. TodoForm clears on success, shows validation errors. Approval form shows feedback/reason inputs. All types match server function returns.",
      "dependsOn": ["m1", "m8"],
      "estimatedComplexity": "medium",
      "maxAttempts": 3,
      "touches": [
        "src/app/components/TodoList.tsx",
        "src/app/components/TodoForm.tsx",
        "src/app/components/TodoItem.tsx",
        "src/app/components/ApprovalPanel.tsx",
        "src/app/components/ApprovalDecisionForm.tsx",
        "src/app/routes/todos.tsx",
        "src/app/routes/approvals.tsx"
      ],
      "acceptance": [
        "All components render without console errors or warnings",
        "TodoList fetches and displays todos with status badge",
        "TodoForm submits, clears on success, shows validation errors",
        "TodoItem displays title, status, submit-for-approval button",
        "ApprovalPanel shows pending approvals with approver actions",
        "ApprovalDecisionForm allows approve/reject with feedback",
        "Loading states and error boundaries present",
        "TypeScript types match server function signatures"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "React components compile without TypeScript errors",
          "kind": "command",
          "argv": ["npx", "tsc", "--noEmit", "--project", "."],
          "expect": {"exitCode": 0}
        }
      ]
    },
    {
      "moduleId": "m10",
      "title": "End-to-End Tests",
      "stackTarget": "fullstack",
      "prompt": "Write integration tests in tests/e2e/approval-flow.test.ts and tests/unit/approval-orchestrator.test.ts validating complete approval workflow: user creates todo (draft), submits for approval (pending), approver approves/rejects (approved/rejected). Verify todo status transitions, approval tickets created, audit log entries added, permissions enforced, handlers called. Use test database with setup/teardown. Mock or use real server. Cover happy path (approve) and error cases (reject, unauthorized, validation). Aim for >80% coverage of orchestrator and todo service.",
      "dependsOn": ["m9"],
      "estimatedComplexity": "hard",
      "maxAttempts": 4,
      "touches": [
        "tests/e2e/approval-flow.test.ts",
        "tests/unit/approval-orchestrator.test.ts",
        "tests/setup.ts",
        "package.json"
      ],
      "acceptance": [
        "User creates todo → status is 'draft'",
        "User submits for approval → status is 'pending-approval', ticket created",
        "Approver approves → status is 'approved', handlers called, audit log entry added",
        "Approver rejects → status is 'rejected', audit log entry added",
        "User cannot approve their own todo → canApprove returns false",
        "Non-approver cannot approve → authorization check fails",
        "Audit log contains complete state history",
        "All tests pass; coverage >80% for orchestrator and todo service"
      ],
      "exitClauses": [
        {
          "clauseId": "c1",
          "description": "All tests pass",
          "kind": "command",
          "argv": ["npm", "test"],
          "expect": {"exitCode": 0}
        }
      ]
    }
  ]
}
```