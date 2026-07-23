/**
 * packages/copilotkit-ui/src/lib/erd-service.ts
 *
 * Bridges a pipeline's EML (.eml.mmd) ERD file to:
 *  - a DBML preview (dbml.dbdiagram.io syntax),
 *  - the live Postgres database DB_PROVISIONING_RUNNING stood up
 *    (create/alter statements via @dlo/erd's diff engine),
 *  - a static Liam ERD viewer (https://github.com/liam-hq/liam),
 * so the "Database & ERD" panel and CopilotKit actions have one place to
 * call into.
 */

import { join } from "node:path";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseEmlSource,
  toDbml,
  toLiamSchema,
  fullCreateScript,
  computeDiff,
  introspectLiveSchema,
  applyStatements,
  testConnection,
  type SchemaModel,
  type ParseWarning,
  type DiffStatement,
} from "@dlo/erd";
import { getPipeline, dbCall, spawnClaude } from "./pipeline-helper";

const execFileAsync = promisify(execFile);

const EML_FILENAME_RE = /\.(eml\.mmd|erd\.mmd|mmd|mml)$/i;

/** Finds the first EML-ish ERD file in a workspace (bounded depth, skips node_modules/.git). */
export async function findEmlFile(workspaceDir: string): Promise<string | null> {
  const preferred = ["schema.eml.mmd", "erd.eml.mmd", "schema.mmd"];
  for (const name of preferred) {
    try {
      await readFile(join(workspaceDir, name), "utf-8");
      return join(workspaceDir, name);
    } catch {
      /* not found, keep looking */
    }
  }

  async function scan(dir: string, depth: number): Promise<string | null> {
    if (depth > 3) return null;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await scan(full, depth + 1);
        if (found) return found;
      } else if (EML_FILENAME_RE.test(entry.name)) {
        return full;
      }
    }
    return null;
  }

  return scan(workspaceDir, 0);
}

export interface ErdPreview {
  sourcePath: string;
  source: string;
  schema: SchemaModel;
  warnings: ParseWarning[];
  dbml: string;
  sql: string[];
  liamSchema: ReturnType<typeof toLiamSchema>;
}

export async function loadErdPreview(pipelineId: string): Promise<ErdPreview | { error: string }> {
  const state = await getPipeline(pipelineId);
  if (!state) return { error: "Pipeline not found" };

  const sourcePath = await findEmlFile(state.workspaceDir);
  if (!sourcePath) {
    return {
      error:
        "No EML (.eml.mmd) ERD file found in the workspace yet. Generate one from the research document, or add one to the workspace.",
    };
  }

  const source = await readFile(sourcePath, "utf-8");
  const { schema, warnings } = parseEmlSource(source, sourcePath);
  if (schema.entities.length === 0) {
    return { error: `"${sourcePath}" was found but no entities could be parsed from its erDiagram section.` };
  }

  return {
    sourcePath,
    source,
    schema,
    warnings,
    dbml: toDbml(schema),
    sql: fullCreateScript(schema),
    liamSchema: toLiamSchema(schema),
  };
}

const EML_GENERATION_GUIDE = `EML (ERDwithAI Modeling Language) is valid Mermaid \`erDiagram\` syntax plus a few "%%" directive comments. Follow this exactly:

erDiagram
    EntityName {
        string  id PK
        string  other_entity_id FK
        string  name
        string  email UK
        decimal amount OPTIONAL
        string  status
    }

    LeftEntity ||--o{ RightEntity : "relationship_label"

Rules:
- Types: string, text, integer, decimal, boolean, date, datetime, json (aliases like varchar/int/bool/timestamp are also fine).
- Modifiers (space separated, after the field name): PK (primary key), FK (foreign key), UK (unique), OPTIONAL (nullable).
- Every entity needs exactly one \`id PK\` field (string type) unless you have a clear reason not to.
- Every FK field must be named \`<snake_case_target_entity>_id\` and paired with a relationship line for that same pair of entities.
- Cardinality operators (left entity is "one" or "many" relative to right): \`||--o{\` (one-to-many), \`}o--||\` (many-to-one), \`||--||\` (one-to-one), \`}o--o{\` (many-to-many).
- Optional: \`%%enum EnumName: value1, value2, value3\` to declare an enum, then \`%%field Entity.field enum: EnumName\` to bind it to a field.
- Optional: \`%%index Entity(col1, col2) unique\` to declare an index.
- Output ONLY the \`erDiagram\` block (plus any %%enum/%%field/%%index lines) — no markdown fences, no prose, no rules/workflow sections.`;

/** Uses Claude to synthesize an EML ERD from the pipeline's domain document + objectives, and writes it into the workspace. */
export async function generateEmlFromResearch(pipelineId: string): Promise<{ path: string; schema: SchemaModel; warnings: ParseWarning[] }> {
  const state = await getPipeline(pipelineId);
  if (!state) throw new Error("Pipeline not found");

  const model = state.config?.providers?.planner?.model || "claude-haiku-4-5-20251001";
  const prompt = `You are the Data Modeling Agent of the Double-Loop Orchestrator. Design the entity-relationship model for this project as an EML document.

Project: ${state.projectName}
Objectives: ${state.objectivesMarkdown}

${state.domainDocument?.markdown ? `Research / Requirements:\n${state.domainDocument.markdown.slice(0, 4000)}` : ""}

${EML_GENERATION_GUIDE}`;

  const raw = await spawnClaude(prompt, model, state.workspaceDir);
  const cleaned = raw.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "").trim();

  const { schema, warnings } = parseEmlSource(cleaned, "generated");
  if (schema.entities.length === 0) {
    throw new Error("The generated ERD could not be parsed — no entities found. Try again, or edit the workspace file by hand.");
  }

  const path = join(state.workspaceDir, "schema.eml.mmd");
  await mkdir(state.workspaceDir, { recursive: true });
  const header = `%% ============================================================================\n%% EML ERD — ${state.projectName}\n%% Generated by the DLO Data Modeling Agent from the research/domain document.\n%% ============================================================================\n\n%%meta name: ${state.projectName}\n%%meta kind: erd\n`;
  await writeFile(path, `${header}${cleaned}\n`, "utf-8");

  return { path, schema, warnings };
}

export interface SyncResult {
  applied: DiffStatement[];
  destructive: DiffStatement[];
  warnings: string[];
  failedAt?: { statement: string; error: string };
  liamSchema: ReturnType<typeof toLiamSchema>;
}

/** Diffs the EML-derived schema against the live DB and auto-applies every non-destructive statement. */
export async function syncErdToDatabase(pipelineId: string): Promise<SyncResult | { error: string }> {
  const state = await getPipeline(pipelineId);
  if (!state) return { error: "Pipeline not found" };
  if (!state.dbConnectionString) {
    return {
      error:
        "No database has been provisioned for this pipeline yet (it needs to reach the DB provisioning step). The ERD/DBML preview and viewer are still available without it.",
    };
  }

  const preview = await loadErdPreview(pipelineId);
  if ("error" in preview) return preview;

  const reachable = await testConnection(state.dbConnectionString);
  if (!reachable) return { error: `Could not connect to the pipeline's database (${state.dbConnectionString}).` };

  const live = await introspectLiveSchema(state.dbConnectionString);
  const diff = computeDiff(preview.schema, live);

  const toApply = diff.statements.map((s) => s.sql);
  const result = await applyStatements(state.dbConnectionString, toApply);

  const appliedStatements = diff.statements.filter((s) => result.applied.includes(s.sql));

  await dbCall("POST", `/pipelines/${pipelineId}/events`, {
    event_type: "ERD_SCHEMA_SYNCED",
    event_data: {
      sourcePath: preview.sourcePath,
      appliedCount: appliedStatements.length,
      destructiveCount: diff.destructive.length,
      failedAt: result.failedAt,
    },
  });
  await dbCall("POST", `/pipelines/${pipelineId}/artifacts`, {
    artifact_type: "ERD_DBML",
    file_path: "schema.dbml",
    content: preview.dbml,
    metadata: { sourcePath: preview.sourcePath },
  });

  const syncResult: SyncResult = {
    applied: appliedStatements,
    destructive: diff.destructive,
    warnings: [...preview.warnings.map((w) => w.message), ...diff.warnings],
    liamSchema: preview.liamSchema,
  };
  if (result.failedAt) syncResult.failedAt = result.failedAt;

  await buildLiamViewer(pipelineId, preview.liamSchema).catch((e) => {
    console.warn(`[ERD] Liam viewer build failed for ${pipelineId}:`, e.message);
  });

  return syncResult;
}

/** Applies a specific set of previously-returned (and user-confirmed) destructive statements. */
export async function applyDestructiveStatements(
  pipelineId: string,
  statements: string[],
): Promise<{ applied: string[]; failedAt?: { statement: string; error: string } } | { error: string }> {
  const state = await getPipeline(pipelineId);
  if (!state) return { error: "Pipeline not found" };
  if (!state.dbConnectionString) return { error: "No database connection for this pipeline." };

  const result = await applyStatements(state.dbConnectionString, statements);

  await dbCall("POST", `/pipelines/${pipelineId}/events`, {
    event_type: "ERD_DESTRUCTIVE_APPLIED",
    event_data: { appliedCount: result.applied.length, failedAt: result.failedAt },
  });

  const preview = await loadErdPreview(pipelineId);
  if (!("error" in preview)) {
    await buildLiamViewer(pipelineId, preview.liamSchema).catch(() => {});
  }

  return result;
}

/**
 * Builds the static Liam ERD viewer (via the `@liam-hq/cli` `liam erd build`
 * command — see https://github.com/liam-hq/liam) into
 * public/erd/<pipelineId>/, so it can be served by Next.js as a static site
 * and opened/embedded from the "View ERD" button.
 */
export async function buildLiamViewer(pipelineId: string, liamSchema: unknown): Promise<{ url: string }> {
  const workDir = join(process.cwd(), ".dlo/erd-build", pipelineId);
  await mkdir(workDir, { recursive: true });
  const schemaPath = join(workDir, "schema.json");
  await writeFile(schemaPath, JSON.stringify(liamSchema, null, 2), "utf-8");

  const outDir = join(process.cwd(), "public", "erd", pipelineId);
  await rm(outDir, { recursive: true, force: true });

  const liamBin = join(process.cwd(), "node_modules", ".bin", "liam");
  await execFileAsync(liamBin, ["erd", "build", "--input", schemaPath, "--format", "liam", "--output-dir", outDir], {
    timeout: 60_000,
  });

  return { url: `/erd/${pipelineId}/index.html` };
}

export async function getErdViewerUrl(pipelineId: string): Promise<string | null> {
  try {
    const indexPath = join(process.cwd(), "public", "erd", pipelineId, "index.html");
    await readFile(indexPath, "utf-8");
    return `/erd/${pipelineId}/index.html`;
  } catch {
    return null;
  }
}
