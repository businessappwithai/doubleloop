import express, { Express, Request, Response } from "express";
import { initDB, closeDB, query, execute } from "./db.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app: Express = express();
const PORT = process.env.PORT || 3099;

app.use(express.json());

// ─── Health Check ───────────────────────────────────────────────────────────

app.get("/health", async (req: Request, res: Response) => {
  try {
    const result = await query("SELECT 1");
    res.json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(503).json({
      status: "degraded",
      database: "disconnected",
      error: e.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── List All Pipelines ─────────────────────────────────────────────────────

app.get("/pipelines", async (req: Request, res: Response) => {
  try {
    const pipelines = await query(
      "SELECT id, project_name, phase, created_at, completed_at FROM pipelines ORDER BY created_at DESC"
    );
    res.json(pipelines);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Get Pipeline Full State ─────────────────────────────────────────────────

app.get("/pipelines/:id", async (req: Request, res: Response) => {
  try {
    const pipeline = await query(
      `SELECT * FROM pipelines WHERE id = ?`,
      [req.params.id]
    );
    if (!pipeline.length) {
      return res.status(404).json({ error: "Pipeline not found" });
    }
    const p = pipeline[0];
    if (p.config_json && typeof p.config_json === "string") {
      p.config_json = JSON.parse(p.config_json);
    }
    res.json(p);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Create Pipeline ────────────────────────────────────────────────────────

app.post("/pipelines", async (req: Request, res: Response) => {
  try {
    const {
      pipelineId,
      projectName,
      objectivesMarkdown,
      workspaceDir,
      config,
    } = req.body;

    await execute(
      `INSERT INTO pipelines
       (id, project_name, objectives_markdown, workspace_dir, phase, config_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        pipelineId,
        projectName,
        objectivesMarkdown,
        workspaceDir,
        "INIT",
        config ? JSON.stringify(config) : null,
      ]
    );

    res.status(201).json({ pipelineId, phase: "INIT" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Update Pipeline (phase, error, appUrl, etc.) ────────────────────────────

app.patch("/pipelines/:id", async (req: Request, res: Response) => {
  try {
    const { phase, error_message, app_url, db_connection_string, db_container_id, activeGate } = req.body;
    const updates: string[] = [];
    const values: any[] = [];

    if (phase !== undefined) {
      updates.push("phase = ?");
      values.push(phase);
    }
    if (error_message !== undefined) {
      updates.push("error_message = ?");
      values.push(error_message);
    }
    if (app_url !== undefined) {
      updates.push("app_url = ?");
      values.push(app_url);
    }
    if (db_connection_string !== undefined) {
      updates.push("db_connection_string = ?");
      values.push(db_connection_string);
    }
    if (db_container_id !== undefined) {
      updates.push("db_container_id = ?");
      values.push(db_container_id);
    }
    if (phase === "COMPLETED" || phase === "FAILED" || phase === "ABORTED") {
      updates.push("completed_at = NOW()");
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(req.params.id);
    const sql = `UPDATE pipelines SET ${updates.join(", ")} WHERE id = ?`;
    await execute(sql, values);

    if (phase && activeGate !== undefined) {
      await execute(
        `INSERT INTO pipeline_events (pipeline_id, event_type, event_data_json)
         VALUES (?, 'PHASE_TRANSITION', ?)`,
        [
          req.params.id,
          JSON.stringify({
            from_phase: "?",
            to_phase: phase,
            timestamp: new Date().toISOString(),
          }),
        ]
      );
    }

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Phase History ──────────────────────────────────────────────────────────

app.get("/pipelines/:id/phases", async (req: Request, res: Response) => {
  try {
    const phases = await query(
      `SELECT phase, transitioned_at FROM pipeline_phase_history WHERE pipeline_id = ? ORDER BY transitioned_at ASC`,
      [req.params.id]
    );
    res.json(phases);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Create Gate ────────────────────────────────────────────────────────────

app.post("/pipelines/:id/gates", async (req: Request, res: Response) => {
  try {
    const { gateId, gate_kind, exhibits, context } = req.body;
    await execute(
      `INSERT INTO pipeline_gates
       (id, pipeline_id, gate_kind, status, exhibits_json, context_json)
       VALUES (?, ?, ?, 'PENDING', ?, ?)`,
      [
        gateId,
        req.params.id,
        gate_kind,
        JSON.stringify(exhibits),
        JSON.stringify(context),
      ]
    );
    res.status(201).json({ gateId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Resolve Gate ───────────────────────────────────────────────────────────

app.patch("/gates/:gateId", async (req: Request, res: Response) => {
  try {
    const { decision, instructions } = req.body;
    await execute(
      `UPDATE pipeline_gates SET status = 'RESOLVED', decision = ?, decision_instructions = ?, resolved_at = NOW() WHERE id = ?`,
      [decision, instructions, req.params.gateId]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Save Domain Document ───────────────────────────────────────────────────

app.post("/pipelines/:id/domain", async (req: Request, res: Response) => {
  try {
    const { markdown, citations } = req.body;
    await execute(
      `INSERT INTO pipeline_domain_documents (pipeline_id, markdown, citations_json)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
       markdown = VALUES(markdown),
       citations_json = VALUES(citations_json),
       updated_at = NOW()`,
      [req.params.id, markdown, JSON.stringify(citations)]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Save Plan ──────────────────────────────────────────────────────────────

app.post("/pipelines/:id/plan", async (req: Request, res: Response) => {
  try {
    const { ceo_plan, architecture_plan, engineering_plan } = req.body;
    await execute(
      `INSERT INTO pipeline_plans (pipeline_id, ceo_plan, architecture_plan, engineering_plan_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       ceo_plan = VALUES(ceo_plan),
       architecture_plan = VALUES(architecture_plan),
       engineering_plan_json = VALUES(engineering_plan_json),
       updated_at = NOW()`,
      [
        req.params.id,
        ceo_plan,
        architecture_plan,
        JSON.stringify(engineering_plan),
      ]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Upsert Module ──────────────────────────────────────────────────────────

app.post("/pipelines/:id/modules", async (req: Request, res: Response) => {
  try {
    const { module_id, title, status, spec } = req.body;
    const existing = await query(
      `SELECT id FROM pipeline_modules WHERE pipeline_id = ? AND module_id = ?`,
      [req.params.id, module_id]
    );

    if (existing.length > 0) {
      await execute(
        `UPDATE pipeline_modules SET title = ?, status = ?, spec_json = ?, updated_at = NOW() WHERE pipeline_id = ? AND module_id = ?`,
        [title, status, JSON.stringify(spec), req.params.id, module_id]
      );
    } else {
      await execute(
        `INSERT INTO pipeline_modules (pipeline_id, module_id, title, status, spec_json)
         VALUES (?, ?, ?, ?, ?)`,
        [req.params.id, module_id, title, status, JSON.stringify(spec)]
      );
    }

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Save Module Attempt ────────────────────────────────────────────────────

app.post("/pipelines/:id/modules/:moduleId/attempts", async (req: Request, res: Response) => {
  try {
    const {
      attempt_index,
      executor,
      verdict,
      summary,
      changes,
      critique,
      clause_results,
    } = req.body;

    await execute(
      `INSERT INTO pipeline_module_attempts
       (pipeline_id, module_id, attempt_index, executor, verdict, summary, changes_json, critique, clause_results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.params.id,
        req.params.moduleId,
        attempt_index,
        executor,
        verdict,
        summary,
        JSON.stringify(changes),
        critique,
        JSON.stringify(clause_results),
      ]
    );

    // Update attempts_count on the module
    await execute(
      `UPDATE pipeline_modules SET attempts_count = attempts_count + 1 WHERE pipeline_id = ? AND module_id = ?`,
      [req.params.id, req.params.moduleId]
    );

    res.status(201).json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Save Artifact ──────────────────────────────────────────────────────────

app.post("/pipelines/:id/artifacts", async (req: Request, res: Response) => {
  try {
    const { artifact_type, file_path, content, metadata } = req.body;
    await execute(
      `INSERT INTO pipeline_artifacts (pipeline_id, artifact_type, file_path, content, metadata_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.params.id,
        artifact_type,
        file_path,
        content,
        JSON.stringify(metadata),
      ]
    );
    res.status(201).json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── List Artifacts ─────────────────────────────────────────────────────────

app.get("/pipelines/:id/artifacts", async (req: Request, res: Response) => {
  try {
    const artifacts = await query(
      `SELECT artifact_type, file_path, created_at FROM pipeline_artifacts WHERE pipeline_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(artifacts);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Add Steering Note ──────────────────────────────────────────────────────

app.post("/pipelines/:id/steering-notes", async (req: Request, res: Response) => {
  try {
    const { note } = req.body;
    await execute(
      `INSERT INTO pipeline_steering_notes (pipeline_id, note) VALUES (?, ?)`,
      [req.params.id, note]
    );
    res.status(201).json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Save Test Results ──────────────────────────────────────────────────────

app.post("/pipelines/:id/test-results", async (req: Request, res: Response) => {
  try {
    const { passed, output, duration_ms, supervisor_reasoning } = req.body;
    await execute(
      `INSERT INTO pipeline_test_results (pipeline_id, passed, output, duration_ms, supervisor_reasoning)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, passed, output, duration_ms, supervisor_reasoning]
    );
    res.status(201).json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Append Event ───────────────────────────────────────────────────────────

app.post("/pipelines/:id/events", async (req: Request, res: Response) => {
  try {
    const { event_type, event_data } = req.body;
    await execute(
      `INSERT INTO pipeline_events (pipeline_id, event_type, event_data_json)
       VALUES (?, ?, ?)`,
      [req.params.id, event_type, JSON.stringify(event_data)]
    );
    res.status(201).json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Query Events ───────────────────────────────────────────────────────────

app.get("/pipelines/:id/events", async (req: Request, res: Response) => {
  try {
    const events = await query(
      `SELECT event_type, event_data_json, created_at FROM pipeline_events WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT 1000`,
      [req.params.id]
    );
    res.json(events);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Initialize and Start Server ────────────────────────────────────────────

async function start() {
  try {
    await initDB();

    // Load and execute schema
    const schemaPath = join(__dirname, "schema.sql");
    const schemaSQL = readFileSync(schemaPath, "utf-8");
    const statements = schemaSQL.split(";").filter((s) => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        await execute(stmt);
      }
    }
    console.log("[DB] Schema initialized");

    app.listen(PORT, () => {
      console.log(`[Server] DLO DB Service listening on port ${PORT}`);
    });
  } catch (e: any) {
    console.error("[Error] Failed to start:", e.message);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  await closeDB();
  process.exit(0);
});

start();
