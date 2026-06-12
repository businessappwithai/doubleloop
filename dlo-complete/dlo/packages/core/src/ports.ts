import type { DomainDocument, TripartitePlanRefs, ArtifactRef, RunToken, ModuleId, ExitClauseResult, SessionRef, SnapshotRef } from "./index.js";

export type ResearchHandle = string;
export type ExecutorSessionRef = string;
export type Unsubscribe = () => void;

export interface ResearchRequest {
  projectName: string;
  objectivesMarkdown: string;
  workspaceDir: string;
}

export interface ResearchProvider {
  dispatch(req: ResearchRequest): Promise<ResearchHandle>;
  await(handle: ResearchHandle, signal: AbortSignal): Promise<DomainDocument>;
  steer(handle: ResearchHandle, instructions: ArtifactRef, signal: AbortSignal): Promise<DomainDocument>;
}

export interface PlanningRequest {
  domainDocument: DomainDocument;
  workspaceDir: string;
}

export interface PlannerProvider {
  plan(req: PlanningRequest, signal: AbortSignal): Promise<TripartitePlanRefs>;
  steer(prior: TripartitePlanRefs, instructions: ArtifactRef, signal: AbortSignal): Promise<TripartitePlanRefs>;
}

export interface ExecutionTask {
  module: any;
  attemptId: string;
  attempt: { index: number };
  critique?: string;
  preSnapshot: string;
  workspace: string;
  runToken: RunToken;
}

export interface ExecutorFinish {
  moduleId: ModuleId;
  attemptId: string;
  attempt: { index: number };
  runToken: RunToken;
  sessionRef: ExecutorSessionRef;
  summary: string;
  changes: Array<{ file: string; description: string }>;
  preSnapshot: string;
  workspace: string;
  workspaceCtx: any;
  exitedCleanly: boolean;
  transcriptHandle?: string;
}

export interface ExecutorProvider {
  dispatch(task: ExecutionTask): Promise<ExecutorSessionRef>;
  onFinish(cb: (result: ExecutorFinish) => void): Unsubscribe;
  snapshot(workspace: string): Promise<SnapshotRef>;
  restore(workspace: string, ref: SnapshotRef): Promise<void>;
  capacity(): { max: number; inFlight: number };
}

export interface EvaluationRequest {
  module: any;
  attempt: { index: number };
  clauseResults: ReadonlyArray<ExitClauseResult>;
  transcriptHandle?: string;
  workspace: string;
  timeoutMs: number;
}

export interface EvaluationVerdict {
  kind: "PASS" | "FAIL";
  critique: string;
}

export interface SupervisorProvider {
  evaluate(req: EvaluationRequest, signal: AbortSignal): Promise<EvaluationVerdict>;
}

export interface HarnessSession {
  forkContext(parent: SessionRef | null, systemMd: ArtifactRef[]): Promise<SessionRef>;
  steerSession(ref: SessionRef, message: string): Promise<void>;
  rewindTo(ref: SessionRef, checkpoint: string): Promise<void>;
  compact(ref: SessionRef): Promise<void>;
}
