/**
 * packages/copilotkit-ui/src/lib/dlo-client.ts
 * HTTP client for communicating with the DLO daemon.
 * Handles pipeline initialization, status polling, gate resolution, artifact retrieval.
 */

import axios, { AxiosInstance } from "axios";
import type {
  PipelineId,
  ModuleId,
  GateId,
  PipelinePhase,
  DloError,
} from "@dlo/core";

export interface DaemonConfig {
  baseUrl: string; // e.g., "http://localhost:9090"
  timeout?: number;
}

export interface PipelineStatus {
  pipelineId: PipelineId;
  phase: PipelinePhase;
  createdAt: string;
  lastTransitionAt: string;
  domainDocument?: {
    markdown: string;
    citations: Array<{ url: string; title: string }>;
  };
  plan?: {
    ceoPlan: string;
    architecturePlan: string;
    engineeringPlan: unknown;
  };
  board?: {
    modules: Array<{
      moduleId: ModuleId;
      status: string;
      attempts: number;
      lastAttempt?: {
        verdict: "PASS" | "FAIL";
        index: number;
      };
    }>;
  };
  budget?: {
    spent: Record<string, number>;
    remaining: Record<string, number>;
  };
  activeGate?: {
    gateId: GateId;
    kind: string;
    exhibits: unknown[];
    expiresAt?: string;
  };
}

export interface InitPipelineRequest {
  projectName: string;
  objectivesMarkdown: string;
  groundingDocuments?: Array<{ name: string; contentBase64: string; mediaType: string }>;
  workspaceDir: string;
  config: unknown; // DloConfig
  researchMarkdown?: string; // user-supplied research; skips the Gemini research phase
}

export interface GateResolutionRequest {
  gateId: GateId;
  decision: "APPROVE" | "STEER" | "REJECT";
  escalatePermissions?: boolean;
  instructions?: string;
  reason?: string;
  note?: string;
}

/**
 * Main DLO daemon client. All operations are async and throw on daemon error.
 */
export class DloDaemonClient {
  private http: AxiosInstance;

  constructor(config: DaemonConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout || 30_000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Add response error handling
    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        if (axios.isAxiosError(err) && err.response?.data?.code) {
          const dloErr = err.response.data as DloError;
          throw new Error(`[${dloErr.code}] ${dloErr.message || err.message}`);
        }
        throw err;
      },
    );
  }

  /**
   * Initialize a new pipeline.
   * Spawns a research phase and returns immediately with a pipeline ID.
   */
  async initPipeline(req: InitPipelineRequest): Promise<{ pipelineId: PipelineId }> {
    const res = await this.http.post<{ pipelineId: PipelineId }>("/api/pipelines/init", req);
    return res.data;
  }

  /**
   * Get the current status of a pipeline.
   * Returns the full state: phase, board, budget, active gate.
   */
  async getPipelineStatus(pipelineId: PipelineId): Promise<PipelineStatus> {
    const res = await this.http.get<PipelineStatus>(`/api/pipelines/${pipelineId}/status`);
    return res.data;
  }

  /**
   * Stream pipeline status updates via Server-Sent Events.
   * Useful for real-time UI updates.
   */
  streamStatus(pipelineId: PipelineId): EventSource {
    return new EventSource(`/api/pipelines/${pipelineId}/status/stream`);
  }

  /**
   * Resolve an open HITL gate.
   */
  async resolveGate(req: GateResolutionRequest): Promise<{ accepted: boolean }> {
    const res = await this.http.post<{ accepted: boolean }>(
      `/api/gates/${req.gateId}/resolve`,
      req,
    );
    return res.data;
  }

  /**
   * Fetch an artifact by its sha256 hash.
   */
  async getArtifact(sha256: string): Promise<Buffer> {
    const res = await this.http.get<any>(
      `/api/artifacts/${sha256}`,
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data);
  }

  /**
   * Get the text content of an artifact.
   */
  async getArtifactText(sha256: string): Promise<string> {
    const buf = await this.getArtifact(sha256);
    return buf.toString("utf-8");
  }

  /**
   * List all pipelines (with basic metadata).
   */
  async listPipelines(): Promise<
    Array<{
      pipelineId: PipelineId;
      projectName: string;
      phase: PipelinePhase;
      createdAt: string;
      status: "running" | "paused" | "completed" | "failed";
    }>
  > {
    const res = await this.http.get<any>("/api/pipelines");
    return res.data.pipelines;
  }

  /**
   * Abort a running pipeline.
   */
  async abortPipeline(pipelineId: PipelineId): Promise<void> {
    await this.http.post(`/api/pipelines/${pipelineId}/abort`);
  }

  /**
   * Resume a paused pipeline.
   */
  async resumePipeline(pipelineId: PipelineId): Promise<void> {
    await this.http.post(`/api/pipelines/${pipelineId}/resume`);
  }

  /**
   * Pause the pipeline (blocks further execution until resumed).
   */
  async pausePipeline(pipelineId: PipelineId): Promise<void> {
    await this.http.post(`/api/pipelines/${pipelineId}/pause`);
  }

  /**
   * Get the full execution report for a completed pipeline.
   */
  async getReport(pipelineId: PipelineId): Promise<{
    title: string;
    summary: string;
    modulesCompleted: number;
    totalAttempts: number;
    costUsd: number;
    wallClockSeconds: number;
    commits: Array<{ hash: string; message: string }>;
    details: unknown;
  }> {
    const res = await this.http.get(`/api/pipelines/${pipelineId}/report`);
    return res.data;
  }
}

export function createDloClient(baseUrl: string = process.env.NEXT_PUBLIC_DLO_DAEMON_URL || "http://localhost:8090"): DloDaemonClient {
  return new DloDaemonClient({ baseUrl });
}
