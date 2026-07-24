# Database — Approve Test App

## Overview

**Storage Engine**: PostgreSQL 13+

**Extensions**: None required for MVP (uuid-ossp is built-in)

**Connection Strategy**:
- Environment variable `DATABASE_URL` contains full connection string (postgresql://user:password@host/database)
- Connection pooling via node-postgres (pg) or Drizzle's built-in pooling
- Connection timeout: 30 seconds; idle timeout: 5 minutes
- Production: use Supabase, Render, or managed PostgreSQL with SSL enabled

**Migration Approach**:
- Drizzle ORM migrations in `src/lib/db/migrations/` directory
- Migrations run automatically on server startup (via migration runner)
- Rollback capability via timestamp-based migration files
- Schema versioning stored in `drizzle_migrations` table (auto-created by Drizzle)

---

## Data Models

### Table: `users`

| Column | Type | Constraints | Default | Notes |
|--------|------|-------------|---------|-------|
| `id` | UUID | PK, NOT NULL | random() | Unique user identifier |
| `email` | VARCHAR(255) | NOT NULL, UNIQUE | — | Email for login and contact |
| `name` | VARCHAR(255) | NOT NULL | — | Display name |
| `password_hash` | VARCHAR(255) | NOT NULL | — | Bcrypt-hashed password (min 60 chars for bcrypt) |
| `role` | VARCHAR(50) | NOT NULL | 'user' | Enum: 'user', 'approver', 'admin' |
| `created_at` | TIMESTAMP | NOT NULL | now() | Account creation timestamp |
| `updated_at` | TIMESTAMP | NOT NULL | now() | Last update timestamp |

**Indexes**:
- PK on `id`
- UNIQUE on `email`
- Index on `role` (for permission queries)

**Notes**: Role determines approval capabilities. 'approver' and 'admin' roles can approve todos.

---

### Table: `todos`

| Column | Type | Constraints | Default | Notes |
|--------|------|-------------|---------|-------|
| `id` | UUID | PK, NOT NULL | random() | Unique todo identifier |
| `title` | VARCHAR(255) | NOT NULL | — | Todo title/summary |
| `description` | TEXT | NULL | — | Optional detailed description |
| `user_id` | UUID | NOT NULL, FK→users.id | — | Owner of the todo |
| `status` | VARCHAR(50) | NOT NULL | 'draft' | Enum: 'draft', 'pending-approval', 'approved', 'rejected', 'completed' |
| `created_at` | TIMESTAMP | NOT NULL | now() | Creation timestamp |
| `updated_at` | TIMESTAMP | NOT NULL | now() | Last modification timestamp |

**Indexes**:
- PK on `id`
- FK index on `user_id`
- Composite index on `(user_id, status)` for list queries by user and status
- Index on `status` (for filtering pending approvals)

**Constraints**:
- FK: `user_id` → `users.id` (ON DELETE CASCADE)
- CHECK: `status IN ('draft', 'pending-approval', 'approved', 'rejected', 'completed')`

**Notes**: Status lifecycle: draft → pending-approval → (approved | rejected). Draft todos skip approval. Completed status for done items.

---

### Table: `approvals`

| Column | Type | Constraints | Default | Notes |
|--------|------|-------------|---------|-------|
| `id` | UUID | PK, NOT NULL | random() | Unique approval ticket identifier |
| `todo_id` | UUID | NOT NULL, FK→todos.id | — | Todo under approval |
| `submitted_by` | UUID | NOT NULL, FK→users.id | — | User who submitted for approval |
| `status` | VARCHAR(50) | NOT NULL | 'pending' | Enum: 'pending', 'approved', 'rejected' |
| `required_approvals` | INTEGER | NOT NULL | 1 | Number of approvals needed to approve (typically 1) |
| `submitted_at` | TIMESTAMP | NOT NULL | now() | When approval was requested |
| `approved_at` | TIMESTAMP | NULL | — | When approval was granted (all required approvers decided) |
| `rejected_at` | TIMESTAMP | NULL | — | When approval was rejected (first rejection) |

**Indexes**:
- PK on `id`
- FK index on `todo_id`
- FK index on `submitted_by`
- Composite index on `(todo_id, status)` for status checks per todo
- Index on `status` (for finding pending approvals)

**Constraints**:
- FK: `todo_id` → `todos.id` (ON DELETE CASCADE)
- FK: `submitted_by` → `users.id` (ON DELETE RESTRICT)
- CHECK: `status IN ('pending', 'approved', 'rejected')`
- CHECK: `required_approvals >= 1`
- UNIQUE: one active approval per todo (enforced in application logic; DB constraint could be `UNIQUE(todo_id) WHERE status = 'pending'`)

**Notes**: Approval lifecycle: pending → (approved | rejected). Timestamps track decision completion. Status is derived from `approvals_decisions` table once all required approvers decide.

---

### Table: `approvals_decisions`

| Column | Type | Constraints | Default | Notes |
|--------|------|-------------|---------|-------|
| `id` | UUID | PK, NOT NULL | random() | Unique decision record identifier |
| `approval_id` | UUID | NOT NULL, FK→approvals.id | — | Parent approval ticket |
| `approver_id` | UUID | NOT NULL, FK→users.id | — | User making the decision |
| `decision` | VARCHAR(50) | NOT NULL | — | Enum: 'approved', 'rejected' |
| `feedback` | TEXT | NULL | — | Optional explanation or comments |
| `decided_at` | TIMESTAMP | NOT NULL | now() | When decision was made |

**Indexes**:
- PK on `id`
- FK index on `approval_id`
- FK index on `approver_id`
- Composite index on `(approval_id, approver_id)` to prevent duplicate decisions from same approver

**Constraints**:
- FK: `approval_id` → `approvals.id` (ON DELETE CASCADE)
- FK: `approver_id` → `users.id` (ON DELETE RESTRICT)
- CHECK: `decision IN ('approved', 'rejected')`
- UNIQUE: `(approval_id, approver_id)` — one decision per approver per approval

**Notes**: Immutable audit trail of approval decisions. Multiple rows per approval if multi-approval workflow. "approved" or "rejected" determines individual approver's stance.

---

### Table: `audit_logs`

| Column | Type | Constraints | Default | Notes |
|--------|------|-------------|---------|-------|
| `id` | UUID | PK, NOT NULL | random() | Unique log entry identifier |
| `action` | VARCHAR(100) | NOT NULL | — | Enum: 'todo_created', 'approval_submitted', 'approval_approved', 'approval_rejected', 'todo_completed' |
| `todo_id` | UUID | NULL, FK→todos.id | — | Associated todo (NULL if not todo-related) |
| `approval_id` | UUID | NULL, FK→approvals.id | — | Associated approval (NULL if not approval-related) |
| `actor_id` | UUID | NOT NULL, FK→users.id | — | User who performed the action |
| `details` | JSONB | NULL | — | Structured metadata (e.g., feedback, reason) |
| `created_at` | TIMESTAMP | NOT NULL | now() | Timestamp of action |

**Indexes**:
- PK on `id`
- FK index on `todo_id`
- FK index on `approval_id`
- FK index on `actor_id`
- Composite index on `(todo_id, created_at DESC)` for audit trail retrieval
- Index on `action` (for filtering by action type)
- Index on `created_at` (for time-range queries)

**Constraints**:
- FK: `todo_id` → `todos.id` (ON DELETE SET NULL) — retain history even if todo deleted
- FK: `approval_id` → `approvals.id` (ON DELETE SET NULL)
- FK: `actor_id` → `users.id` (ON DELETE RESTRICT)
- CHECK: `action IN (...valid actions...)`

**Notes**: Immutable append-only log for compliance and debugging. JSONB for flexible metadata without schema changes. Created_at is timestamp of event, not log insertion time.

---

## Entity Relationship Diagram

```mermaid
erDiagram
  USERS ||--o{ TODOS : "owns"
  USERS ||--o{ APPROVALS : "submits"
  USERS ||--o{ APPROVALS_DECISIONS : "makes"
  USERS ||--o{ AUDIT_LOGS : "performs"
  TODOS ||--o{ APPROVALS : "requires"
  APPROVALS ||--o{ APPROVALS_DECISIONS : "contains"
  TODOS ||--o{ AUDIT_LOGS : "associated-with"
  APPROVALS ||--o{ AUDIT_LOGS : "associated-with"

  USERS {
    uuid id PK
    string email UK
    string name
    string password_hash
    string role
    timestamp created_at
    timestamp updated_at
  }

  TODOS {
    uuid id PK
    string title
    string description
    uuid user_id FK
    string status
    timestamp created_at
    timestamp updated_at
  }

  APPROVALS {
    uuid id PK
    uuid todo_id FK
    uuid submitted_by FK
    string status
    int required_approvals
    timestamp submitted_at
    timestamp approved_at
    timestamp rejected_at
  }

  APPROVALS_DECISIONS {
    uuid id PK
    uuid approval_id FK
    uuid approver_id FK
    string decision
    string feedback
    timestamp decided_at
  }

  AUDIT_LOGS {
    uuid id PK
    string action
    uuid todo_id FK
    uuid approval_id FK
    uuid actor_id FK
    jsonb details
    timestamp created_at
  }
```

---

## DDL

```sql
-- Enable uuid generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'approver', 'admin')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- Todos table
CREATE TABLE todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending-approval', 'approved', 'rejected', 'completed')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_todos_user_id ON todos(user_id);
CREATE INDEX idx_todos_status ON todos(status);
CREATE INDEX idx_todos_user_status ON todos(user_id, status);

-- Approvals table
CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  todo_id UUID NOT NULL UNIQUE REFERENCES todos(id) ON DELETE CASCADE,
  submitted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  required_approvals INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals >= 1),
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMP,
  rejected_at TIMESTAMP
);

CREATE INDEX idx_approvals_todo_id ON approvals(todo_id);
CREATE INDEX idx_approvals_submitted_by ON approvals(submitted_by);
CREATE INDEX idx_approvals_status ON approvals(status);
CREATE INDEX idx_approvals_todo_status ON approvals(todo_id, status);

-- Approvals decisions table
CREATE TABLE approvals_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  approver_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision VARCHAR(50) NOT NULL CHECK (decision IN ('approved', 'rejected')),
  feedback TEXT,
  decided_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(approval_id, approver_id)
);

CREATE INDEX idx_approvals_decisions_approval_id ON approvals_decisions(approval_id);
CREATE INDEX idx_approvals_decisions_approver_id ON approvals_decisions(approver_id);
CREATE INDEX idx_approvals_decisions_approval_approver ON approvals_decisions(approval_id, approver_id);

-- Audit logs table
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(100) NOT NULL CHECK (action IN ('todo_created', 'approval_submitted', 'approval_approved', 'approval_rejected', 'todo_completed')),
  todo_id UUID REFERENCES todos(id) ON DELETE SET NULL,
  approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  details JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_todo_id ON audit_logs(todo_id);
CREATE INDEX idx_audit_logs_approval_id ON audit_logs(approval_id);
CREATE INDEX idx_audit_logs_actor_id ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_todo_created ON audit_logs(todo_id, created_at DESC);
```

---

## Seed & Fixture Strategy

**Development Seed** (`src/lib/db/seed.ts`):

```typescript
// Run once on fresh database or via npm run seed
// Creates:
// - 3 test users: "user@test.com" (role: user), "approver@test.com" (role: approver), "admin@test.com" (role: admin)
// - 5 sample todos for user@test.com in various statuses
// - 2 approval tickets with decisions
// - Audit trail entries matching all actions

// Passwords: all use "password123" (bcrypt hashed)
```

**Fixture Loading**:
- Test suite imports fixtures from `src/lib/db/__fixtures__/`
- Each fixture file exports `getFixture(name: string)` returning cloned, pre-initialized data
- Fixtures never modify database; they return in-memory objects for test setup

**Database Reset**:
- `npm run db:reset` drops and recreates schema, runs migrations, runs seed
- `npm run db:test-setup` creates isolated test database with fixtures ready

---

## Query Patterns

### 1. **List todos by user with approval status**
```sql
SELECT t.*, a.status as approval_status
FROM todos t
LEFT JOIN approvals a ON t.id = a.todo_id
WHERE t.user_id = $1
ORDER BY t.created_at DESC;
```
**Index Used**: `idx_todos_user_id`
**Frequency**: High (dashboard load)

### 2. **Get pending approvals for an approver**
```sql
SELECT a.*, t.title, t.description, u.name as submitted_by_name
FROM approvals a
JOIN todos t ON a.todo_id = t.id
JOIN users u ON a.submitted_by = u.id
WHERE a.status = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM approvals_decisions ad
    WHERE ad.approval_id = a.id AND ad.approver_id = $1
  )
ORDER BY a.submitted_at ASC;
```
**Index Used**: `idx_approvals_status`, `idx_approvals_decisions_approver_id`
**Frequency**: High (approver dashboard)

### 3. **Check if todo has active approval**
```sql
SELECT id, status FROM approvals
WHERE todo_id = $1 AND status = 'pending'
LIMIT 1;
```
**Index Used**: `idx_approvals_todo_status`
**Frequency**: Very high (on every todo update attempt)

### 4. **Get approval decisions for a ticket**
```sql
SELECT * FROM approvals_decisions
WHERE approval_id = $1
ORDER BY decided_at DESC;
```
**Index Used**: `idx_approvals_decisions_approval_id`
**Frequency**: High (approval detail view)

### 5. **Get audit trail for a todo**
```sql
SELECT * FROM audit_logs
WHERE todo_id = $1
ORDER BY created_at DESC;
```
**Index Used**: `idx_audit_logs_todo_created`
**Frequency**: Medium (audit history view)

### 6. **Count approvals needed vs completed**
```sql
SELECT
  a.required_approvals,
  COUNT(ad.id) as approvals_received
FROM approvals a
LEFT JOIN approvals_decisions ad ON a.id = ad.approval_id
WHERE a.id = $1
GROUP BY a.id, a.required_approvals;
```
**Index Used**: `idx_approvals_decisions_approval_id`
**Frequency**: Medium (approval progress calculation)

### 7. **List recent activity for dashboard**
```sql
SELECT al.* FROM audit_logs al
WHERE al.created_at > NOW() - INTERVAL '7 days'
ORDER BY al.created_at DESC
LIMIT 50;
```
**Index Used**: `idx_audit_logs_created_at`
**Frequency**: Low (dashboard summary)