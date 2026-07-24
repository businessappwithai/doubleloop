# Architecture — Approve Test App

## Technology Choices

**Framework**: TanStack Start (React + Vite + file-based routing + server functions)
**Database**: PostgreSQL with Drizzle ORM for type-safe queries and migrations
**Frontend Runtime**: React 19 with TanStack Query for server state
**Server Runtime**: Node.js

**Justification**: TanStack Start eliminates explicit API layer boilerplate by colocating server functions with routes, enabling full-stack type safety. Server functions provide RPC-like communication with automatic serialization, perfect for testing complex approval workflows without writing traditional REST endpoints. Drizzle ORM provides compile-time type safety for database operations and first-class migration support. Vite's HMR keeps development velocity high. This stack is minimal and opinionated, reducing decisions for implementation subagents.

## Central Orchestrator

**Module**: `ApprovalOrchestrator`
**Location**: `src/lib/orchestrator/approval-orchestrator.ts`

**Responsibilities**:
- Manages approval workflow state and lifecycle for todos
- Routes approval requests to validation handlers
- Tracks approval progress and history
- Validates authorization before state transitions
- Emits approval events for audit logging

**Public Interface**:

```typescript
export interface ApprovalOrchestrator {
  registerHandler(name: string, handler: ApprovalHandler): void;

  submitForApproval(
    todoId: string,
    userId: string,
    metadata?: Record<string, any>
  ): Promise<ApprovalTicket>;

  getStatus(todoId: string): Promise<ApprovalStatus>;

  approve(
    approvalId: string,
    approverId: string,
    feedback?: string
  ): Promise<ApprovalResult>;

  reject(
    approvalId: string,
    approverId: string,
    reason: string
  ): Promise<ApprovalResult>;

  getHistory(todoId: string): Promise<ApprovalHistoryEntry[]>;
}

export interface ApprovalHandler {
  validate(todo: Todo): Promise<{ valid: boolean; errors: string[] }>;
  onApproved(ticket: ApprovalTicket): Promise<void>;
  onRejected(ticket: ApprovalTicket): Promise<void>;
}

export interface ApprovalTicket {
  id: string;
  todoId: string;
  submittedAt: Date;
  submittedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  requiredApprovals: number;
  approvals: ApproverDecision[];
}

export interface ApprovalStatus {
  todoId: string;
  status: 'pending' | 'approved' | 'rejected';
  approvalProgress: number;
  requiredApprovals: number;
  decisions: ApproverDecision[];
}
```

**How Modules Communicate**: All approval state changes route through the orchestrator's public interface. Modules register as handlers during initialization and respond to lifecycle events (`onApproved`, `onRejected`). Modules do not directly mutate approval state or call each other; the orchestrator is the single source of truth.

## Modules

### 1. **Todo Service**
**Location**: `src/lib/services/todo-service.ts`
**Responsibility**: CRUD operations, todo validation, integration with orchestrator
**Public Interface**:
```typescript
export interface TodoService {
  create(title: string, description: string, userId: string): Promise<Todo>;
  getById(id: string): Promise<Todo | null>;
  listByUser(userId: string): Promise<Todo[]>;
  update(id: string, updates: Partial<Todo>): Promise<Todo>;
  delete(id: string): Promise<void>;
  submitForApproval(id: string, userId: string): Promise<ApprovalTicket>;
}

export interface Todo {
  id: string;
  title: string;
  description?: string;
  userId: string;
  status: 'draft' | 'pending-approval' | 'approved' | 'rejected' | 'completed';
  createdAt: Date;
  updatedAt: Date;
}
```
**Dependencies**: ApprovalOrchestrator, TodoRepository, AuditLogger

---

### 2. **Repository Layer (Database)**
**Location**: `src/lib/db/repositories/`
**Responsibility**: All database queries; schema definitions via Drizzle
**Public Interface**:
```typescript
export interface TodoRepository {
  create(data: { title: string; description?: string; userId: string }): Promise<Todo>;
  findById(id: string): Promise<Todo | null>;
  findByUserId(userId: string): Promise<Todo[]>;
  update(id: string, data: Partial<Todo>): Promise<Todo>;
  delete(id: string): Promise<void>;
}

export interface ApprovalRepository {
  createTicket(ticket: ApprovalTicketInput): Promise<ApprovalTicket>;
  getTicket(id: string): Promise<ApprovalTicket | null>;
  updateTicket(id: string, updates: Partial<ApprovalTicket>): Promise<ApprovalTicket>;
  listByTodo(todoId: string): Promise<ApprovalTicket[]>;
}
```
**Dependencies**: PostgreSQL, Drizzle ORM

**Schema** (Drizzle):
```typescript
// src/lib/db/schema.ts
import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const todos = pgTable('todos', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  userId: uuid('user_id').notNull(),
  status: varchar('status', { length: 50 }).notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  todoId: uuid('todo_id').notNull().references(() => todos.id),
  submittedBy: uuid('submitted_by').notNull(),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  requiredApprovals: integer('required_approvals').notNull().default(1),
  submittedAt: timestamp('submitted_at').defaultNow(),
  approvedAt: timestamp('approved_at'),
  rejectedAt: timestamp('rejected_at'),
});

export const approvals_decisions = pgTable('approvals_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  approvalId: uuid('approval_id').notNull().references(() => approvals.id),
  approverId: uuid('approver_id').notNull(),
  decision: varchar('decision', { length: 50 }).notNull(), // 'approved' | 'rejected'
  feedback: text('feedback'),
  decidedAt: timestamp('decided_at').defaultNow(),
});
```

---

### 3. **Authentication & Authorization Service**
**Location**: `src/lib/auth/`
**Responsibility**: User authentication, session management, permission checks
**Public Interface**:
```typescript
export interface AuthService {
  getCurrentUser(request: Request): Promise<User | null>;
  isAuthenticated(request: Request): Promise<boolean>;
  canApprove(userId: string, todoId: string): Promise<boolean>;
  canSubmit(userId: string, todoId: string): Promise<boolean>;
  login(email: string, password: string): Promise<{ token: string; user: User }>;
  logout(request: Request): Promise<void>;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'approver' | 'admin';
}
```
**Dependencies**: User database, session store (cookie-based with secure flags)

---

### 4. **API Layer (Server Functions)**
**Location**: `src/app/api/` (or routes with `.server.ts` suffix)
**Responsibility**: RPC endpoints for client-server communication, input validation, error handling
**Public Interface** (examples):
```typescript
// src/app/api/todos.server.ts
import { server$ } from '@tanstack/start';
import { z } from 'zod';

export const createTodo = server$(async (title: string, userId: string) => {
  const validated = z.string().min(1).parse(title);
  const todo = await todoService.create(validated, '', userId);
  return { success: true, data: todo };
});

export const submitTodoForApproval = server$(async (todoId: string) => {
  const user = await authService.getCurrentUser();
  if (!user) throw new Error('Not authenticated');
  const ticket = await approvalOrchestrator.submitForApproval(todoId, user.id);
  return { success: true, data: ticket };
});

export const approveTodo = server$(async (approvalId: string, feedback?: string) => {
  const user = await authService.getCurrentUser();
  if (!await authService.canApprove(user.id, approvalId)) {
    throw new Error('Unauthorized');
  }
  const result = await approvalOrchestrator.approve(approvalId, user.id, feedback);
  return { success: true, data: result };
});

export const rejectTodo = server$(async (approvalId: string, reason: string) => {
  const user = await authService.getCurrentUser();
  if (!await authService.canApprove(user.id, approvalId)) {
    throw new Error('Unauthorized');
  }
  const result = await approvalOrchestrator.reject(approvalId, user.id, reason);
  return { success: true, data: result };
});
```
**Dependencies**: AuthService, TodoService, ApprovalOrchestrator, input validation (Zod)

---

### 5. **UI Components**
**Location**: `src/app/components/`
**Responsibility**: React components for todo list, approval workflow UI
**Public Interface**:
```typescript
export function TodoList(): JSX.Element;
export function TodoItem({ id }: { id: string }): JSX.Element;
export function ApprovalPanel({ todoId }: { todoId: string }): JSX.Element;
export function ApprovalDecisionForm({ approvalId }: { approvalId: string }): JSX.Element;
```
**Dependencies**: server functions, TanStack Query, TanStack Router

---

### 6. **Audit Logger**
**Location**: `src/lib/logging/audit-logger.ts`
**Responsibility**: Log all approval actions for compliance and debugging
**Public Interface**:
```typescript
export interface AuditLogger {
  logSubmitted(todoId: string, userId: string): Promise<void>;
  logApproved(approvalId: string, approverId: string): Promise<void>;
  logRejected(approvalId: string, approverId: string, reason: string): Promise<void>;
  getLog(todoId: string): Promise<AuditLogEntry[]>;
}
```
**Dependencies**: ApprovalRepository, logger

---

## Plumbing & Conventions

### Error Handling

All errors are typed and normalized:

```typescript
// src/lib/errors.ts
export class ApplicationError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public context?: Record<string, any>
  ) {
    super(message);
  }
}

export class ValidationError extends ApplicationError {
  constructor(message: string, context?: Record<string, any>) {
    super('VALIDATION_ERROR', 400, message, context);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', 404, `${resource} not found: ${id}`);
  }
}

export class UnauthorizedError extends ApplicationError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', 401, message);
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', 403, message);
  }
}

// Catch handler for server functions
export function handleError(error: unknown) {
  if (error instanceof ApplicationError) {
    return {
      success: false,
      error: { code: error.code, message: error.message, context: error.context },
    };
  }
  console.error('Unexpected error:', error);
  return { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
}
```

### Configuration

```typescript
// src/lib/config.ts
export const config = {
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost/approve-test',
  },
  auth: {
    sessionCookieName: '__session',
    sessionMaxAge: 7 * 24 * 60 * 60, // 7 days in seconds
  },
  approval: {
    requiredApprovals: parseInt(process.env.REQUIRED_APPROVALS ?? '1'),
    timeoutDays: parseInt(process.env.APPROVAL_TIMEOUT_DAYS ?? '30'),
  },
};
```

### Logging

```typescript
// src/lib/logger.ts
export const logger = {
  info: (message: string, context?: Record<string, any>) =>
    console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message, ...context })),
  error: (message: string, error?: Error, context?: Record<string, any>) =>
    console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message, error: error?.message, stack: error?.stack, ...context })),
  warn: (message: string, context?: Record<string, any>) =>
    console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message, ...context })),
};
```

### Dependency Wiring

```typescript
// src/server.ts
import { createRequestHandler } from '@tanstack/start';
import { approvalOrchestrator } from './lib/orchestrator/approval-orchestrator';
import { todoService } from './lib/services/todo-service';
import { todoRepository } from './lib/db/repositories/todo';
import { authService } from './lib/auth';

// Initialize handlers
const todoValidationHandler: ApprovalHandler = {
  async validate(todo: Todo) {
    if (!todo.title.trim()) return { valid: false, errors: ['Title is required'] };
    return { valid: true, errors: [] };
  },
  async onApproved(ticket: ApprovalTicket) {
    await todoService.update(ticket.todoId, { status: 'approved' });
  },
  async onRejected(ticket: ApprovalTicket) {
    await todoService.update(ticket.todoId, { status: 'rejected' });
  },
};

approvalOrchestrator.registerHandler('todo-validation', todoValidationHandler);

export const requestHandler = createRequestHandler({
  // TanStack Start configuration
});
```

### Folder Layout

```
src/
├── app/
│   ├── layout.tsx              # Root layout
│   ├── page.tsx                # Home / todo list
│   ├── api/
│   │   └── todos.server.ts      # Server functions for todos
│   │   └── approvals.server.ts  # Server functions for approvals
│   ├── routes/
│   │   ├── todos/
│   │   │   ├── index.tsx        # List todos
│   │   │   ├── [id].tsx         # View todo detail
│   │   │   └── [id]/approval.tsx # Approval workflow page
│   │   └── approvals/
│   │       └── index.tsx        # Approval queue (for approvers)
│   └── components/
│       ├── TodoList.tsx
│       ├── TodoItem.tsx
│       ├── ApprovalPanel.tsx
│       └── ApprovalDecisionForm.tsx
├── lib/
│   ├── orchestrator/
│   │   └── approval-orchestrator.ts
│   ├── services/
│   │   └── todo-service.ts
│   ├── db/
│   │   ├── schema.ts
│   │   ├── client.ts            # Database connection
│   │   └── repositories/
│   │       ├── todo.ts
│   │       └── approval.ts
│   ├── auth/
│   │   └── index.ts
│   ├── logging/
│   │   └── audit-logger.ts
│   ├── config.ts
│   ├── logger.ts
│   └── errors.ts
├── server.ts                    # Entry point
└── client.tsx                   # Client entry
```

## Best Practices

### Testing Strategy

**Unit Tests** (Vitest): Test services and utilities in isolation with mocked dependencies
```typescript
// tests/services/todo-service.test.ts
describe('TodoService', () => {
  it('creates a todo with validation', async () => {
    const mockRepo = { create: vi.fn().mockResolvedValue({ id: '1', title: 'Test' }) };
    const service = new TodoService(mockRepo as any, null);
    const result = await service.create('Test', '', 'user-1');
    expect(result.title).toBe('Test');
    expect(mockRepo.create).toHaveBeenCalled();
  });
});
```

**Integration Tests** (Vitest + real DB): Test approval workflow end-to-end with test database
```typescript
// tests/integration/approval-workflow.test.ts
describe('Approval Workflow', () => {
  beforeEach(async () => {
    await setupTestDB();
  });

  it('submits, approves, and marks todo as approved', async () => {
    const todo = await todoService.create('Task', '', 'user-1');
    const ticket = await orchestrator.submitForApproval(todo.id, 'user-1');
    expect(ticket.status).toBe('pending');

    const result = await orchestrator.approve(ticket.id, 'approver-1');
    expect(result.success).toBe(true);

    const status = await orchestrator.getStatus(todo.id);
    expect(status.status).toBe('approved');
  });
});
```

**E2E Tests** (Playwright): Test user workflows in browser
```typescript
// tests/e2e/approve-flow.spec.ts
test('user submits todo and approver approves it', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name="title"]', 'Urgent task');
  await page.click('button:has-text("Create Todo")');
  await page.click('button:has-text("Submit for Approval")');

  // Switch to approver
  await page.context().addCookies([{ name: '__session', value: 'approver-token', url: 'http://localhost:3000' }]);
  await page.goto('/approvals');
  await page.click('button:has-text("Approve")');
  await page.fill('textarea[name="feedback"]', 'Looks good');
  await page.click('button:has-text("Confirm")');

  await expect(page.locator('text=Approved')).toBeVisible();
});
```

### Type Safety

- Strict TypeScript (`strict: true` in tsconfig.json)
- Drizzle ORM provides type inference for database queries
- Zod for input validation at server function boundaries
- Discriminated unions for Result types: `{ success: true; data: T } | { success: false; error: string }`

### Security

- **Input Validation**: All server function inputs validated with Zod before processing
- **Authorization Checks**: `authService.canApprove()` gates all approval operations
- **SQL Injection Prevention**: Parameterized queries via Drizzle ORM
- **CSRF Protection**: TanStack Start provides built-in CSRF token handling
- **Session Security**: HttpOnly, Secure, SameSite cookies for session tokens
- **Audit Trail**: All approval actions logged with user ID and timestamp

### Performance

- **Database Indexes**: Create indexes on `userId`, `todoId`, `status` columns
- **Query Optimization**: Use Drizzle relations to avoid N+1 queries
- **Client Caching**: TanStack Query with stale-while-revalidate strategy
- **Lazy Loading**: Load approval history only on request
- **Connection Pooling**: Use Drizzle's connection pool for database (default: min 2, max 10)

## Deployment Shape

### Local Development

```bash
# Setup
npm install
cp .env.example .env.local
npm run db:push              # Create/update schema in local PostgreSQL

# Start dev server
npm run dev                  # http://localhost:3000 with HMR enabled

# Run tests
npm run test                 # Unit + integration tests
npm run test:e2e            # Playwright E2E tests in headed mode
npm run test:e2e:ui         # Playwright UI mode
```

**`.env.local`**:
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/approve_test
NODE_ENV=development
REQUIRED_APPROVALS=1
LOG_LEVEL=debug
```

### Production Deployment

**Build**: `npm run build` produces `dist/` with optimized client and server bundles.

**Runtime**: Node.js process with environment variables injected at startup. PostgreSQL database (managed service or self-hosted).

**Docker**:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist dist/
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
```

**Database Migrations**: Run before or during deployment:
```bash
npm run db:push  # Drizzle auto-migrates schema
```

**Health Check**: Implement `/health` endpoint for load balancer readiness checks.

**Scaling**: Stateless server design enables horizontal scaling. Session data stored in database. Use connection pool for multiple instances.

**Monitoring**: Structured JSON logs to stdout, centralized log aggregation (e.g., Datadog, CloudWatch). Audit trail persisted in approvals_decisions table.