# CEO Review — Database.md

> Reviewer: built-in
> Reviewed: 2026-07-24T11:59:55.273Z

I'll review this database design with a CEO's lens: is this the right schema to build, what's over/under-scoped, and what risks exist?

## Suggestion 1 — Approval Resubmission Workflow is Broken [severity: high]

**Rationale:** The `approvals` table has a `UNIQUE` constraint on `todo_id`, but the schema also allows `todos.status = 'rejected'`. If a user wants to resubmit a rejected todo for approval, they'll attempt to create a new approval record for the same `todo_id`, violating the UNIQUE constraint. This is a showstopper for any real rejection workflow.

**Proposed change:** Replace the database `UNIQUE` constraint with a *partial* unique constraint that only enforces uniqueness for pending approvals:

```sql
-- Replace this line in the DDL:
-- CREATE UNIQUE INDEX idx_approvals_todo_id ON approvals(todo_id);

-- With this:
CREATE UNIQUE INDEX idx_approvals_todo_pending ON approvals(todo_id) 
WHERE status = 'pending';
```

Then update the notes to clarify: "Only one *active* (pending) approval per todo; rejected approvals allow resubmission with a new approval record."

---

## Suggestion 2 — Rejection Workflow is Under-Specified [severity: high]

**Rationale:** The schema captures rejection events (`rejected_at` timestamp, `status = 'rejected'`), but doesn't define whether a rejected todo is terminal or can be resubmitted, who can resubmit, or what metadata explains the rejection. This creates ambiguity in the approval workflow that will force ad-hoc application logic.

**Proposed change:** Add a `rejection_reason` field to the `approvals` table and clarify the workflow in the notes:

```sql
ALTER TABLE approvals ADD COLUMN rejection_reason TEXT;
```

And update the **Notes** section of the `approvals` table:

**From:** "Approval lifecycle: pending → (approved | rejected). Timestamps track decision completion."

**To:** "Approval lifecycle: pending → (approved | rejected). Rejected approvals are terminal and cannot be re-approved. Todos with rejected status can be edited and resubmitted (creates a new approval record). `rejection_reason` captures the first rejection reason."

---

## Suggestion 3 — No SLA, Escalation, or Approval Timeouts [severity: high]

**Rationale:** An approval system without SLAs is operationally risky—approvals can be stuck in "pending" indefinitely with no accountability or escalation. Your app has no `due_at`, `escalated_at`, or `escalation_count` fields, and no indexes to find "overdue approvals." This is a blind spot for ops and affects user experience.

**Proposed change:** Add SLA fields to the `approvals` table:

```sql
ALTER TABLE approvals ADD COLUMN (
  due_at TIMESTAMP,
  escalated_at TIMESTAMP,
  escalation_count INTEGER DEFAULT 0
);

CREATE INDEX idx_approvals_due_at ON approvals(due_at) 
WHERE status = 'pending' AND due_at < NOW();
```

Document in the **Notes**: "due_at defaults to submitted_at + 3 business days (set by application). escalation triggers automated reminders or manager notifications. Queries can now identify overdue approvals."

---

## Suggestion 4 — No Authorization/Permission Model [severity: high]

**Rationale:** The schema has a `role` field (user, approver, admin), but no way to express scoped permissions like "this approver can only review todos from their team" or "approvals over $X require director sign-off." This forces all approver logic into the application layer and risks approval authority creep.

**Proposed change:** Define explicit permissions in the schema or document the current limitation. If MVP assumes all approvers are equal, state this as a constraint. If you need role-based scoping, add a mapping table:

```sql
CREATE TABLE approver_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope VARCHAR(50) NOT NULL, -- e.g., 'team', 'budget', 'department'
  scope_value VARCHAR(255) NOT NULL, -- e.g., team ID, max budget, etc.
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Document in **Overview**: "Role defines approval capability; `approver_permissions` optionally restricts scope. MVP: assume all approvers have equal authority."

---

## Suggestion 5 — Audit Details Structure is Undocumented [severity: medium]

**Rationale:** The `audit_logs.details` column is JSONB, which is flexible, but the schema doesn't define the expected schema for different `action` types. This creates inconsistency risk and makes auditing and compliance queries hard.

**Proposed change:** Document the expected `details` structure for each action type. Add a **Audit Log Details Schema** section:

```markdown
## Audit Log Details Schema

The `details` JSONB column contains structured metadata by action type:

- **todo_created**: `{ draft: boolean }`
- **approval_submitted**: `{ submitted_by_id: uuid, required_approvals: int }`
- **approval_approved**: `{ approver_id: uuid, feedback?: string }`
- **approval_rejected**: `{ approver_id: uuid, reason: string }`
- **todo_completed**: `{ marked_done_by: uuid }`
```

---

## Suggestion 6 — No Soft-Delete or Compliance Data Retention [severity: medium]

**Rationale:** Your schema uses `ON DELETE CASCADE` for todos→approvals, which means deleted todos are unrecoverable. For compliance or audit purposes, you may need to retain deleted todos. The `ON DELETE SET NULL` for audit_logs is partial protection, but leaves an incomplete audit trail.

**Proposed change:** Either implement soft-deletes or explicitly document the retention policy. Add a `deleted_at` field to `todos`, or document:

```markdown
## Data Retention Policy

- **Todos**: Hard-deleted when user deletes them; audit_logs retain proof of deletion
- **Approvals**: Cascaded delete with todos; retention period is undefined
- **Audit Logs**: Retained indefinitely for compliance

**TODO**: Define legal/compliance retention requirements for approvals (SOX, GDPR, etc.)
```

---

## Suggestion 7 — Connection Pooling Strategy is Under-Specified [severity: medium]

**Rationale:** The document says "use node-postgres or Drizzle's built-in pooling" without specifying pool size, timeout strategy, or production behavior. This risks connection exhaustion or timeout cascades in production.

**Proposed change:** Update the **Connection Strategy** section:

```markdown
**Connection Pooling**:
- Development: Drizzle built-in pooling, max 5 connections
- Production: node-postgres with pg-pool, configured as follows:
  - Max pool size: 20 connections
  - Idle timeout: 30 seconds
  - Connection timeout: 10 seconds
  - Retry logic: exponential backoff (max 3 retries)
  - Monitor: log pool.totalCount, pool.idleCount to observability platform
```

---

## Suggestion 8 — Multi-Approver Progress Query is Missing [severity: low]

**Rationale:** The query patterns don't include an efficient way to fetch "approval progress" (e.g., "1 of 3 approvers decided"). This seems like a high-frequency query for an approval dashboard, but no index supports it efficiently.

**Proposed change:** Add a query pattern and index:

```sql
-- In Query Patterns section, add:

### Query: Get approval decision progress
SELECT
  a.id,
  a.required_approvals,
  COUNT(ad.id) as decisions_received,
  SUM(CASE WHEN ad.decision = 'approved' THEN 1 ELSE 0 END) as approved_count,
  SUM(CASE WHEN ad.decision = 'rejected' THEN 1 ELSE 0 END) as rejected_count
FROM approvals a
LEFT JOIN approvals_decisions ad ON a.id = ad.approval_id
WHERE a.id = $1
GROUP BY a.id, a.required_approvals;

**Index Used**: `idx_approvals_decisions_approval_id`
**Frequency**: High (approval detail view)
```

---

## Suggestion 9 — Draft Approval Bypass Logic is Not Schema-Enforced [severity: low]

**Rationale:** The notes say "Draft todos skip approval," but there's no `requires_approval` flag or trigger in the schema. This forces the application to track and enforce this rule, increasing bug risk.

**Proposed change:** Add a `requires_approval` boolean to the `todos` table:

```sql
ALTER TABLE todos ADD COLUMN requires_approval BOOLEAN DEFAULT true;
```

Update the trigger/application logic to prevent approval submission if `requires_approval = false`. This makes the intent explicit and easier to audit.

---

## Overall Verdict

The database design is fundamentally sound for a basic approval workflow, with good indexing and audit coverage. However, it has three showstoppers for production: (1) the UNIQUE constraint on `approvals.todo_id` breaks resubmission workflows, (2) missing SLA/escalation fields and queries will create operational chaos as approvals pile up, and (3) the lack of permission scoping limits flexibility for multi-team scenarios. Beyond these, there are several under-specifications (rejection workflows, JSONB schema, data retention) that will require cleanup as the app matures. I'd recommend blocking on fixes #1 and #2 before shipping MVP, and scheduling #3 as a follow-up once you understand real approval patterns from early users.