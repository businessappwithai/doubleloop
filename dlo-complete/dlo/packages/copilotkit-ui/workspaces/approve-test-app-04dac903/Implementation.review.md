# CEO Review — Implementation.md

> Reviewer: built-in
> Reviewed: 2026-07-24T12:00:03.998Z

# CEO Plan Review — Approve Test App Implementation

## Suggestion 1 — Add Infrastructure & Environment Setup Module [severity: high]

**Rationale:** The plan assumes a working PostgreSQL database and environment configuration exist before Phase 1 even starts. There's no module for provisioning the test database, managing credentials, or validating the infrastructure layer exists. m1 requires NODE_ENV, DATABASE_URL, and other secrets to work, but nothing creates them.

**Proposed change:** Add **m0 (Infrastructure Setup)** as a mandatory serial step before m1:
- Provision test PostgreSQL database (local Docker or cloud instance)
- Create `.env` file with DATABASE_URL, SESSION_SECRET, and other required variables
- Validate database connectivity before Phase 1 starts
- Document connection string format and secrets management strategy

Place this between Dependencies and "**Phase 1: Foundation**":
```
**Phase 0: Infrastructure (Serial)**
- **m0 (Infrastructure Setup)**: Provision test PostgreSQL database, create .env file with DATABASE_URL and secrets, validate connectivity. Must execute before m1; unblocks all downstream modules.
```

---

## Suggestion 2 — Chicken-and-Egg: User Seeding Before Auth Works [severity: high]

**Rationale:** m4 (Authentication Service) implements `login(email, password)` but there's no module to create initial users. The first user can't log in because they don't exist in the database. This breaks the entire approval workflow — you can't test m5–m10 without seeded test users.

**Proposed change:** Add a **m3.5 (Test Data Seeding)** step after m3 repositories are complete:
```
**Phase 1b: Seeding (Serial)**
- **m3.5 (Test Data Seeding)**: Seed test database with fixture users (submitter, approver, admin) and their hashed passwords. Create sample todos in 'draft' state. Allows m4+ to assume users exist for auth testing.
```

Alternatively, integrate this into m4's acceptance criteria:
```
**Acceptance Criteria (added to m4):**
- Test database contains at least two pre-seeded users: one with 'submitter' role, one with 'approver' role
- `login('submitter@test.local', 'password123')` succeeds and returns valid session
```

---

## Suggestion 3 — Misleading "Isolated" Dependency Claims [severity: medium]

**Rationale:** The plan claims m4 (Auth) is "isolated in `src/lib/auth/`; no other services depend on it yet," and m6 (Audit Logger) is "independent business logic." In reality:
- m7 (Todo Service) explicitly depends on m4 for auth checks: `check auth (user owns todo for submit)`
- m5 (Orchestrator) should call m6 whenever state changes, but the plan doesn't formalize this integration
- The parallelism claim (Phase 2) is misleading if integration isn't accounted for

**Proposed change:** Revise the dependency graph to be explicit:
```
**Phase 2: Business Logic (Parallel where indicated)**
- **m4 (Authentication Service)**: ... Isolated; used by m7 and m8 for auth checks.
- **m5 (Approval Orchestrator)**: ... Calls m6 (Audit Logger) on all state transitions.
- **m6 (Audit Logger)**: ... Used by m5 for compliance logging.

**Integration Points (before m7 starts):**
- m5 must call m6.logSubmitted, m6.logApproved, m6.logRejected on state changes
- m4 session and permission checks must be integrated into m7's submitForApproval
```

---

## Suggestion 4 — Acceptance Criteria Reference Non-Existent Architecture.md [severity: high]

**Rationale:** Multiple modules say "All return types match Architecture.md interfaces" and "per Database.md" but these documents aren't provided. How will you know if m3 repositories are correct if Architecture.md is vague or missing? This creates ambiguity and rework risk.

**Proposed change:** Move Architecture.md requirements into the plan itself. For example, m3 currently says:
> All repository methods exist and match the public interfaces in Architecture.md

Rewrite to:
> All repository methods exist and match these interfaces (from Architecture.md):
> - `UserRepository.findByEmail(email: string): Promise<User | null>`
> - `TodoRepository.create(title: string, description: string, userId: string): Promise<Todo>`
> - `ApprovalRepository.createTicket(...): Promise<ApprovalTicket>`
> - [etc.]

Same for m2 (Database Schema) — list all table names and critical columns inline, don't reference an external doc:
```
**Acceptance Criteria (revised):**
- schema.ts exports tables: `users` (id, email, password_hash, role, created_at), 
  `todos` (id, title, description, user_id, status, created_at),
  `approvals` (id, todo_id, status, created_at),
  `approvals_decisions` (id, approval_id, approver_id, decision, feedback, created_at),
  `audit_logs` (id, todo_id, action, actor_id, details, created_at)
```

---

## Suggestion 5 — Server Function API Contract Not Specified [severity: high]

**Rationale:** m8 (API Layer) says "implement server functions for all user-facing operations" but doesn't specify the contract. m9 (UI Components) depends on knowing the exact function signatures, response shapes, and error formats. Without this spec upfront, m8 and m9 will have rework cycles.

**Proposed change:** Add an **API Contract** section to m8 before implementation. Example:

```
**Server Function Contracts:**

```typescript
// src/app/api/todos.server.ts
export const createTodo = server$(async (input: { title: string; description: string }) => {
  return { success: true; data: { id: string; title: string; status: "draft" } }
})

export const getTodos = server$(async () => {
  return { success: true; data: Todo[] }
})

export const submitTodoForApproval = server$(async (todoId: string) => {
  return { success: true; data: { ticket_id: string; status: "pending-approval" } }
})
```

Add this to m8's **Files Created/Modified** and **Acceptance Criteria**, so m9 has a testable contract to build against.

---

## Suggestion 6 — Error Handling & Failure Recovery Not Specified [severity: high]

**Rationale:** What happens when the database is unavailable? When bcrypt hashing fails? When the orchestrator detects an invalid state transition? The plan doesn't specify error responses, retry logic, or recovery. This is critical for production reliability but is unaddressed.

**Proposed change:** Add an **Error Handling Strategy** section after the Build Order:

```
## Error Handling & Failure Modes

- **Database Unavailable**: All server functions throw a 503 Service Unavailable error with message "Database connection failed". Clients show a retry banner.
- **Auth Failure**: Invalid credentials return 401 with `{success: false; error: "Invalid email or password"}`. Expired sessions return 401 with `{success: false; error: "Session expired"}`.
- **Orchestrator Validation Failure**: Invalid state transitions (e.g., approving a rejected todo) throw 400 Bad Request with `{success: false; error: "Cannot approve a rejected todo"}`.
- **Handler Execution Failure**: If a handler throws, log the error but do not fail the approval. Return success but set error flag: `{success: true; data: {...}; handlerError: "..."}`.
```

Update m5 (Orchestrator), m8 (API Layer), and m10 (Tests) acceptance criteria to include error scenarios.

---

## Suggestion 7 — Complexity Mismatch for m3 and m10 [severity: medium]

**Rationale:** m3 (Repository Layer) is marked "easy" but implementing 4 type-safe repositories with Drizzle queries, foreign key handling, and composite indexes is "medium" complexity. Conversely, m10 (E2E Tests) is "hard" but is only testing the happy path and basic auth — that's closer to "medium." This under-estimates risk for data access and over-scopes testing.

**Proposed change:** Revise complexity estimates:
```
- m3: "easy" → "medium" (Max Attempts: 3 → 4) — type-safe queries and constraints are error-prone
- m10: "hard" → "medium" (Max Attempts: 4 → 3) — testing the happy path is straightforward; adjust scope to focus on critical paths only
```

---

## Suggestion 8 — Multi-Approval Workflows Underspecified [severity: medium]

**Rationale:** m5 (Orchestrator) says `approve(approvalId, approverId)` updates ticket "once required approvals met" but doesn't specify: How many approvers are required? Is it 1? 3? Can different todos have different counts? How do you handle partial approvals (1 approve, 1 reject)? This is core business logic but is left vague.

**Proposed change:** Add a **Approval Rules** section in m5:

```
**Approval Rules:**
- One approval required per todo (configurable per future phases, but hardcoded to 1 for MVP)
- Any user with 'approver' or 'admin' role can approve a todo
- Approval is idempotent: approving twice by the same user is a no-op
- Rejection is final: once rejected, a todo must be resubmitted (creates new ticket)
- A user cannot approve their own todo (even if they have approver role)
```

Update m5's `approve` signature:
```
approve(approvalId: string, approverId: string, feedback?: string): Promise<{ticket: ApprovalTicket; isApprovalComplete: boolean}>
```

---

## Suggestion 9 — No Resource Allocation or Timeline [severity: medium]

**Rationale:** The plan says "Total wall-clock time is roughly equivalent to 7 sequential modules" but doesn't specify how many developers, or expected duration. With 1 developer and 5 hours/module, this is a 35-hour project. With 3 developers and poor coordination, Phase 2 parallelism adds overhead. Without this context, stakeholders can't plan milestones or release dates.

**Proposed change:** Add a **Timeline & Resources** section after the Build Order:

```
## Timeline & Resources

**Assumptions:**
- 1 full-stack developer, or 1 backend + 1 frontend developer
- Estimated effort: m1–m2: 4h each, m3–m6: 3h each, m7–m9: 5h each, m10: 6h
- Total sequential time: ~40 hours
- **Recommended timeline:** 1 week (single developer, 40h/week) or 2 weeks (parallel: backend + frontend, 20h/week each)

**Critical Path (blocks all work):**
- m0 (Infrastructure) → m1 (Scaffolding) → m2 (Schema) → m3 (Repositories) → m7 (Service) → m8 (API) → m9 (UI) → m10 (Tests)
- This is ~32 hours of critical path work. Phase 2 parallelism saves ~6 hours but only if m7 starts exactly when m6 finishes.
```

---

## Suggestion 10 — No Production Deployment or Canary Step [severity: medium]

**Rationale:** m10 (E2E Tests) validates the happy path in a test environment, but there's no module for deploying to staging, running smoke tests against real infrastructure, or canary-deploying to production. This plan ends at testing — shipping is not a step.

**Proposed change:** Add **m11 (Deployment & Smoke Tests)** after m10:

```
**Phase 4: Deployment (Serial)**
- **m11 (Deployment & Smoke Tests)**: Deploy application to staging environment (via Docker, k8s, or equivalent). Run smoke tests against staging (create todo, submit for approval, approve). Deploy to production. Monitor error rate and latency for 1 hour post-deploy.
```

Update the plan summary:
> Total wall-clock time is roughly equivalent to 8 sequential modules instead of 11, including deployment.

---

## Overall Verdict

This is a solid tactical plan with clear module boundaries and realistic sequencing for the core approval workflow. The bottom-up dependency graph and Phase 2 parallelism will compress timeline meaningfully. However, the plan has **three critical gaps** that will cause rework if not addressed upfront: (1) infrastructure and environment setup are assumed but not specified, (2) API contracts between m8 and m9 are left vague, creating a rework risk, and (3) initial user seeding is missing, breaking the auth workflow. Additionally, several modules have **misleading independence claims** (m4, m6) that overstate parallelism, and **acceptance criteria are too abstract**, referencing external Architecture.md instead of being self-contained. Complexity estimates are slightly optimistic (m3 is "easy" but should be "medium"). Finally, there's **no deployment or production validation step** — testing is complete, but shipping is not. Recommend adding m0 (Infrastructure), m3.5 (Seeding), and m11 (Deployment), collapsing vague acceptance criteria into the plan itself, and documenting API contracts explicitly before m8 starts.