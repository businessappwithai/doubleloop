/**
 * orchestrator/state.ts
 * PipelineState — the single state shape for a DLO pipeline — plus its
 * persistence (Postgres db-service with local-file fallback, as before).
 *
 * Extracted from pipeline-helper.ts (M-A refactor) and extended with:
 *  - designDocs   : the three Design Analyst documents (+ research)
 *  - reviews      : /plan-ceo-review suggestion sets per document
 *  - agentDesign  : first-class per-module subagent configuration
 *                   (written by Langflow import or the designer canvas,
 *                   read by the build fleet)
 */

import { join } from "node:path";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import type { PipelinePhase } from "@dlo/core";

// ─── Database Service Client ──────────────────────────────────────────────────

const DB_SERVICE_URL = process.env.DB_SERVICE_URL || "http://localhost:3099";

export async function dbCall(
  method: string,
  path: string,
  body?: any
): Promise<any> {
  try {
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${DB_SERVICE_URL}${path}`, opts);
    if (!res.ok) throw new Error(`DB: ${res.status}`);
    return await res.json();
  } catch (e: any) {
    console.warn(`[DB] ${method} ${path} failed:`, e.message);
    return null;
  }
}

// ─── Document & review types ──────────────────────────────────────────────────

/** Canonical document keys. File names on disk are fixed per key. */
export type DesignDocKey = "research" | "architecture" | "database" | "implementation";

export const DOC_FILENAMES: Record<DesignDocKey, string> = {
  research: "RESEARCH.md",
  architecture: "Architecture.md",
  database: "Database.md",
  implementation: "Implementation.md",
};

export const REVIEW_FILENAMES: Record<Exclude<DesignDocKey, "research">, string> = {
  architecture: "Architecture.review.md",
  database: "Database.review.md",
  implementation: "Implementation.review.md",
};

export interface DesignDoc {
  markdown: string;
  /** Bumped on every saved edit (UI or suggestion apply). */
  version: number;
  updatedAt: string;
  approvedAt?: string;
}

export interface ReviewSuggestion {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  rationale: string;
  proposedChange: string;
  status: "open" | "applied" | "dismissed";
}

export interface DocumentReview {
  /** Which reviewer actually ran — never silently substituted. */
  reviewer: "gstack/plan-ceo-review" | "built-in";
  rawMarkdown: string;
  suggestions: ReviewSuggestion[];
  reviewedAt: string;
}

/** Per-module subagent assignment (Langflow / designer canvas output). */
export interface AgentAssignment {
  vendor: "claude-code" | "codewhale" | "gemini";
  model: string;
  systemPrompt?: string;
  maxAttempts?: number;
}

export interface AgentDesign {
  /** moduleId → assignment. Missing modules use the pipeline default executor. */
  modules: Record<string, AgentAssignment>;
  maxConcurrent?: number;
  /** Where this design came from, for the UI. */
  source: "langflow" | "designer-canvas";
  langflowFlowId?: string;
  updatedAt: string;
}

// ─── PipelineState ────────────────────────────────────────────────────────────

export interface PipelineState {
  pipelineId: string;
  projectName: string;
  objectivesMarkdown: string;
  workspaceDir: string;
  config: any;
  phase: PipelinePhase;
  createdAt: string;
  lastTransitionAt: string;
  phaseHistory?: Array<{ phase: PipelinePhase; timestamp: string }>;
  contextNotes?: Array<{ note: string; timestamp: string }>;
  domainDocument?: {
    markdown: string;
    citations: Array<{ url: string; title: string }>;
  };
  /** Which subagent runner produced the research (visibility, never hidden). */
  researchMeta?: {
    runner: "pi-sdk" | "local";
    subagents: string[];
    model: string;
    generatedAt: string;
  };
  /** The three Design Analyst documents plus the (editable) research doc. */
  designDocs?: Partial<Record<DesignDocKey, DesignDoc>>;
  /** /plan-ceo-review output per design document. */
  reviews?: Partial<Record<Exclude<DesignDocKey, "research">, DocumentReview>>;
  /** First-class subagent configuration honored by the build fleet. */
  agentDesign?: AgentDesign;
  plan?: {
    ceoPlan: string;
    architecturePlan: string;
    engineeringPlan: any;
  };
  board?: {
    modules: Array<{
      moduleId: string;
      status: string;
      attempts: number;
    }>;
  };
  budget?: {
    spent: Record<string, number>;
    remaining: Record<string, number>;
  };
  activeGate?: {
    gateId: string;
    kind: string;
    exhibits: any[];
    /** Context for TERMINAL_PERMISSION gates to know what runs after approval */
    context?: Record<string, unknown>;
  } | null;
  buildResults?: {
    passed: boolean;
    output: string;
    durationMs: number;
    artifacts?: string[];
    fixRounds?: number;
  };
  testResults?: {
    passed: boolean;
    output: string;
    durationMs: number;
    supervisorReasoning?: string;
    fixRounds?: number;
    /** How many individual tests actually executed. 0 is always a failure. */
    testsRun?: number;
    /** How many times the Test Author subagent had to build/extend the suite. */
    testAuthorRounds?: number;
  };
  deployResults?: {
    deployed: boolean;
    output: string;
    deployUrl?: string;
    artifactPath?: string;
  };
  appUrl?: string;
  dbConnectionString?: string;
  dbContainerId?: string;
  error?: string;
}

export function pushPhaseHistory(state: PipelineState, phase: PipelinePhase): void {
  if (!state.phaseHistory) state.phaseHistory = [];
  state.phaseHistory.push({ phase, timestamp: new Date().toISOString() });
}

// ─── Persistence (DB dual-write + local JSON, unchanged behavior) ─────────────

const getPipelinesDir = () => join(process.cwd(), ".dlo/pipelines");

export async function savePipeline(state: PipelineState): Promise<void> {
  try {
    const existing = await getPipelineFromDb(state.pipelineId);
    if (!existing) {
      await dbCall("POST", "/pipelines", {
        pipelineId: state.pipelineId,
        projectName: state.projectName,
        objectivesMarkdown: state.objectivesMarkdown,
        workspaceDir: state.workspaceDir,
        config: state.config,
      });
    } else {
      await dbCall("PATCH", `/pipelines/${state.pipelineId}`, {
        phase: state.phase,
        error_message: state.error,
        app_url: state.appUrl,
        db_connection_string: state.dbConnectionString,
        db_container_id: state.dbContainerId,
      });
    }
  } catch (e: any) {
    console.warn("[DB] savePipeline failed:", e.message);
  }

  const dir = getPipelinesDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${state.pipelineId}.json`), JSON.stringify(state, null, 2), "utf-8");
}

async function getPipelineFromDb(pipelineId: string): Promise<any | null> {
  try {
    return await dbCall("GET", `/pipelines/${pipelineId}`);
  } catch {
    return null;
  }
}

export async function getPipeline(pipelineId: string): Promise<PipelineState | null> {
  // The local JSON file is the full-fidelity record (designDocs, reviews,
  // agentDesign, gates…); the DB row only carries the summary columns. Prefer
  // the file and fall back to the DB summary if the file is gone.
  try {
    const content = await readFile(join(getPipelinesDir(), `${pipelineId}.json`), "utf-8");
    return JSON.parse(content);
  } catch {
    /* fall through to DB */
  }

  const dbState = await getPipelineFromDb(pipelineId);
  if (dbState) {
    return {
      pipelineId: dbState.id,
      projectName: dbState.project_name,
      objectivesMarkdown: dbState.objectives_markdown,
      workspaceDir: dbState.workspace_dir,
      phase: dbState.phase,
      config: dbState.config_json,
      createdAt: dbState.created_at,
      lastTransitionAt: dbState.updated_at,
      error: dbState.error_message,
      appUrl: dbState.app_url,
      dbConnectionString: dbState.db_connection_string,
      dbContainerId: dbState.db_container_id,
    } as PipelineState;
  }
  return null;
}

export async function listAllPipelines(): Promise<PipelineState[]> {
  try {
    const dbPipelines = await dbCall("GET", "/pipelines");
    if (dbPipelines && Array.isArray(dbPipelines)) {
      return dbPipelines.map((p: any) => ({
        pipelineId: p.id,
        projectName: p.project_name,
        phase: p.phase,
        createdAt: p.created_at,
        lastTransitionAt: p.updated_at,
        workspaceDir: p.workspace_dir,
      })) as PipelineState[];
    }
  } catch {
    console.warn("[DB] listAllPipelines from DB failed, using local files");
  }

  try {
    const dir = getPipelinesDir();
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    const pipelines: PipelineState[] = [];
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = await readFile(join(dir, file), "utf-8");
        pipelines.push(JSON.parse(content));
      }
    }
    return pipelines;
  } catch {
    return [];
  }
}

export async function findPipelineByGateId(gateId: string): Promise<PipelineState | null> {
  const pipelines = await listAllPipelines();
  const summary = pipelines.find((p) => p.activeGate?.gateId === gateId);
  if (summary?.activeGate) return summary;
  // DB summaries don't carry gates — check full local records.
  for (const p of pipelines) {
    const full = await getPipeline(p.pipelineId);
    if (full?.activeGate?.gateId === gateId) return full;
  }
  return null;
}

// ─── Workspace file helpers ───────────────────────────────────────────────────

export async function writeWorkspaceMarkdown(
  workspaceDir: string,
  filename: string,
  content: string
): Promise<void> {
  try {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, filename), content, "utf-8");
  } catch (e: any) {
    console.warn(`[Workspace] Failed to write ${filename}:`, e.message);
  }
}

/** Persist a design document to state AND to its canonical file on disk. */
export async function saveDesignDoc(
  state: PipelineState,
  key: DesignDocKey,
  markdown: string
): Promise<void> {
  if (!state.designDocs) state.designDocs = {};
  const prev = state.designDocs[key];
  state.designDocs[key] = {
    markdown,
    version: (prev?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    ...(prev?.approvedAt ? {} : {}),
  };
  await writeWorkspaceMarkdown(state.workspaceDir, DOC_FILENAMES[key], markdown);
  if (key === "research") {
    // Keep research in the legacy slot too so older UI panels keep working,
    // and mirror to DOMAIN.md for backward compatibility.
    state.domainDocument = {
      markdown,
      citations: state.domainDocument?.citations ?? [],
    };
    await writeWorkspaceMarkdown(state.workspaceDir, "DOMAIN.md", markdown);
  }
}
