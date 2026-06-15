# Plan: MariaDB Pipeline Persistence Backend

## Goal
Replace the current file-based pipeline storage (`.dlo/pipelines/*.json`) with a proper MariaDB-backed backend service that captures every stage, gate, artifact, and event for later mining.

---

## New Package: `dlo/packages/db-service`

Express.js service on **port 3099**. Pipeline-helper calls it over HTTP. All pipeline state flows through it.

### Files to create

```
dlo/packages/db-service/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          Express server entry
│   ├── db.ts             MariaDB connection pool
│   ├── schema.sql        DDL for all 11 tables
│   └── routes/
│       ├── pipelines.ts  CRUD + list + full-state endpoint
│       ├── gates.ts      Create gate / resolve gate
│       ├── artifacts.ts  Save / list file artifacts
│       ├── modules.ts    Module + attempt upserts
│       ├── events.ts     Append / query audit events
│       └── health.ts     Health check
```

### Schema (11 tables)

| Table | Purpose |
|---|---|
| `pipelines` | Core record: id, project_name, objectives, workspace_dir, phase, config, error, app_url, db_connection_string, timestamps |
| `pipeline_phase_history` | Append-only log of every phase transition with timestamp |
| `pipeline_gates` | Every gate: kind, exhibits_json, context_json, decision, instructions, status, create/resolve timestamps |
| `pipeline_domain_documents` | Full Gemini research markdown + citations per pipeline |
| `pipeline_plans` | CEO plan, architecture plan, full engineering_plan_json |
| `pipeline_modules` | Per-module status, attempts count, full spec_json (title, stackTarget, prompt, exitClauses, touches, maxAttempts) |
| `pipeline_module_attempts` | Per-attempt: executor, started/finished, verdict, summary, changes_json, critique, clause_results_json |
| `pipeline_artifacts` | All file artifacts: type (DOMAIN/PLAN/HANDOFF/CONTEXT/SOURCE_FILE), file_path, LONGTEXT content, metadata_json |
| `pipeline_steering_notes` | User steering notes with timestamps |
| `pipeline_test_results` | passed, output, duration_ms, supervisor_reasoning |
| `pipeline_events` | Complete audit log: event_type, event_data_json, timestamp |

### REST API (db-service)

```
GET    /health
GET    /pipelines                       → list all, summary fields
POST   /pipelines                       → create
GET    /pipelines/:id                   → full state JSON
PATCH  /pipelines/:id                   → update phase/error/appUrl/gate/etc.
GET    /pipelines/:id/phases            → full phase history
POST   /pipelines/:id/gates             → create gate
PATCH  /gates/:gateId                   → resolve gate (decision + instructions)
POST   /pipelines/:id/domain            → save domain document
POST   /pipelines/:id/plan              → save tripartite plan
POST   /pipelines/:id/modules           → upsert module
POST   /pipelines/:id/modules/:mod/attempts → save attempt
POST   /pipelines/:id/artifacts         → save artifact (file content)
GET    /pipelines/:id/artifacts         → list all artifacts
POST   /pipelines/:id/steering-notes    → add note
POST   /pipelines/:id/test-results      → save test results
POST   /pipelines/:id/events            → append event
GET    /pipelines/:id/events            → full audit log
```

---

## Modified: `pipeline-helper.ts`

### Replace file-based storage functions

| Old (file-based) | New (DB via HTTP) |
|---|---|
| `savePipeline(state)` | `savePipelineToDB(state)` — PATCH /pipelines/:id (creates on first call) |
| `getPipeline(id)` | `getPipelineFromDB(id)` — GET /pipelines/:id |
| `listAllPipelines()` | `listPipelinesFromDB()` — GET /pipelines |
| `findPipelineByGateId(gateId)` | GET /pipelines?gateId=... |

### Additional DB calls inserted at key points

| Where in pipeline-helper | New DB call |
|---|---|
| After research completes (DOMAIN.md written) | POST /pipelines/:id/domain — saves full markdown + citations |
| After planning completes (PLAN.md written) | POST /pipelines/:id/plan — saves ceoPlan, architecturePlan, engineeringPlan |
| When activeGate is set | POST /pipelines/:id/gates — saves kind, exhibits, context |
| When gate is resolved (in gate resolve route) | PATCH /gates/:gateId — saves decision + instructions |
| Each phase transition (pushPhaseHistory) | POST /pipelines/:id/events with type=PHASE_TRANSITION |
| Each module status change | POST /pipelines/:id/modules — upserts module record |
| When HANDOFF.md written | POST /pipelines/:id/artifacts type=HANDOFF |
| When CONTEXT.md written | POST /pipelines/:id/artifacts type=CONTEXT |
| All source files written by executor | POST /pipelines/:id/artifacts type=SOURCE_FILE per file |
| After test run | POST /pipelines/:id/test-results |
| On COMPLETED/FAILED/ABORTED | POST /pipelines/:id/events with final event |

### Remove
- `getPipelinesDir()` and all `readFile/writeFile` calls for `.dlo/pipelines/*.json`
- The in-process JSON file reads/writes for pipeline state

### Keep
- Workspace directory creation and markdown file writes (PLAN.md etc. must still exist on disk for the executor tools)
- All existing phase/gate logic and execution flow

---

## Environment Config

`.env.local` in `copilotkit-ui`:
```
DB_SERVICE_URL=http://localhost:3099
```

`db-service` environment:
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=dlo
DB_PASSWORD=dlopassword
DB_NAME=dlo_pipelines
```

---

## Build Sequence

1. Create `dlo/packages/db-service/` with schema, db client, Express routes
2. Create MariaDB database + user + tables (schema.sql)
3. Modify `pipeline-helper.ts` — replace storage functions, add DB calls
4. Add `db-service` to pnpm workspace dev script
5. Test with a full pipeline run

---

## Not in scope
- Migrating existing `.dlo/pipelines/*.json` files (they stay as-is; new runs use DB)
- UI changes to show DB-backed history list (the existing `/api/pipelines` Next.js route already calls `listAllPipelines()` which will now hit the DB)
- Authentication on the db-service (internal only, port not exposed)
