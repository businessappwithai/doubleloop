import { z } from "zod";
import { ArtifactRefSchema, DomainDocumentSchema } from "@dlo/core";

export const PipelineStartedPayloadSchema = z.object({
  pipelineId: z.string(),
  config: z.record(z.unknown()),
});

export const PipelineAbortRequestedPayloadSchema = z.object({
  reason: z.string().optional(),
});

export const PipelineCompletedPayloadSchema = z.object({
  completedAt: z.string().datetime(),
});

export const PipelineFailedPayloadSchema = z.object({
  error: z.record(z.unknown()),
});

export const ResearchDispatchedPayloadSchema = z.object({
  pipelineId: z.string(),
  interactionId: z.string(),
});

export const ResearchPollTickPayloadSchema = z.object({
  interactionId: z.string(),
  status: z.string(),
});

export const ResearchCompletedPayloadSchema = z.object({
  document: DomainDocumentSchema,
  gateId: z.string(),
});

export const ResearchFailedPayloadSchema = z.object({
  error: z.record(z.unknown()),
});

export const ResearchSteeredPayloadSchema = z.object({
  instructions: ArtifactRefSchema,
});

export const GateOpenedPayloadSchema = z.object({
  gateId: z.string(),
  kind: z.enum(["DOMAIN_DOCUMENT", "TRIPARTITE_PLAN", "MODULE_ESCALATION"]),
  exhibits: z.array(ArtifactRefSchema),
  context: z.record(z.string(), z.string()).optional(),
});

export const GateApprovedPayloadSchema = z.object({
  gateId: z.string(),
  decision: z.literal("APPROVE"),
  escalatePermissions: z.boolean().default(false),
  note: z.string().optional(),
});

export const GateSteeredPayloadSchema = z.object({
  gateId: z.string(),
  decision: z.literal("STEER"),
  instructions: z.string(),
});

export const GateRejectedPayloadSchema = z.object({
  gateId: z.string(),
  decision: z.literal("REJECT"),
  reason: z.string(),
});

export const GateExpiredPayloadSchema = z.object({
  gateId: z.string(),
});

export const PlanningDispatchedPayloadSchema = z.object({
  pipelineId: z.string(),
});

export const PlanningCompletedPayloadSchema = z.object({
  plan: z.any(), // TripartitePlanRefs
  gateId: z.string(),
});

export const PlanningFailedPayloadSchema = z.object({
  error: z.record(z.unknown()),
});

export const PlanningSteeredPayloadSchema = z.object({
  instructions: ArtifactRefSchema,
});

export const PlanningRewoundPayloadSchema = z.object({});

export const PlanValidatedPayloadSchema = z.object({
  planVersion: z.number(),
});

export const PlanValidationFailedPayloadSchema = z.object({
  error: z.record(z.unknown()),
});

export const DagBuiltPayloadSchema = z.object({
  moduleCount: z.number(),
});

export const DagModuleReadyPayloadSchema = z.object({
  moduleId: z.string(),
});

export const DagAllPassedPayloadSchema = z.object({});

export const ModuleDispatchedPayloadSchema = z.object({
  moduleId: z.string(),
  attemptId: z.string(),
  sessionRef: z.string(),
  preSnapshot: z.string(),
});

export const ModuleInnerLoopTickPayloadSchema = z.object({
  moduleId: z.string(),
  errorCount: z.number(),
});

export const ModuleExecutorFinishedPayloadSchema = z.object({
  moduleId: z.string(),
  attemptId: z.string(),
  sessionRef: z.string(),
  summary: z.string().optional(),
  preSnapshot: z.string(),
  exitedCleanly: z.boolean(),
});

export const ModuleVerificationStartedPayloadSchema = z.object({
  moduleId: z.string(),
  attemptId: z.string(),
});

export const ModulePassedPayloadSchema = z.object({
  moduleId: z.string(),
  attemptId: z.string(),
});

export const ModuleRejectedPayloadSchema = z.object({
  moduleId: z.string(),
  attemptId: z.string(),
  critique: ArtifactRefSchema,
});

export const ModuleRolledBackPayloadSchema = z.object({
  moduleId: z.string(),
  snapshotRef: z.string(),
});

export const ModuleExhaustedPayloadSchema = z.object({
  moduleId: z.string(),
});

export const ClauseEvaluatedPayloadSchema = z.object({
  moduleId: z.string(),
  clauseResults: z.array(
    z.object({
      clauseId: z.string(),
      passed: z.boolean(),
      observed: z.string(),
      durationMs: z.number(),
    })
  ),
});

export const BudgetChargedPayloadSchema = z.object({
  dimension: z.string(),
  amount: z.number(),
  attribution: z.string(),
});

export const BudgetWarningThresholdPayloadSchema = z.object({
  dimension: z.string(),
  fraction: z.number(),
});

export const BudgetExhaustedPayloadSchema = z.object({
  dimension: z.string(),
});

export const SettlementRegisteredPayloadSchema = z.object({
  token: z.string(),
  epoch: z.number(),
});

export const SettlementSettledPayloadSchema = z.object({
  token: z.string(),
});

export const SettlementDiscardedPayloadSchema = z.object({
  token: z.string(),
  reason: z.string(),
});

export const FinalizationDispatchedPayloadSchema = z.object({});

export const FinalizationAgentFinishedPayloadSchema = z.object({
  agent: z.string(),
});

export const FinalizationEscalatedPayloadSchema = z.object({
  moduleIds: z.array(z.string()),
});

export const FinalizationCompletedPayloadSchema = z.object({});

export const SnapshotTakenPayloadSchema = z.object({
  seq: z.number(),
});

export const SnapshotRestoredPayloadSchema = z.object({
  seq: z.number(),
});

export const SnapshotPromotedPayloadSchema = z.object({
  preSnapshot: z.string(),
  moduleId: z.string(),
});

export const schemas: Record<string, z.ZodSchema> = {
  "pipeline.started": PipelineStartedPayloadSchema,
  "pipeline.abortRequested": PipelineAbortRequestedPayloadSchema,
  "pipeline.completed": PipelineCompletedPayloadSchema,
  "pipeline.failed": PipelineFailedPayloadSchema,
  "research.dispatched": ResearchDispatchedPayloadSchema,
  "research.pollTick": ResearchPollTickPayloadSchema,
  "research.completed": ResearchCompletedPayloadSchema,
  "research.failed": ResearchFailedPayloadSchema,
  "research.steered": ResearchSteeredPayloadSchema,
  "gate.opened": GateOpenedPayloadSchema,
  "gate.approved": GateApprovedPayloadSchema,
  "gate.steered": GateSteeredPayloadSchema,
  "gate.rejected": GateRejectedPayloadSchema,
  "gate.expired": GateExpiredPayloadSchema,
  "planning.dispatched": PlanningDispatchedPayloadSchema,
  "planning.completed": PlanningCompletedPayloadSchema,
  "planning.failed": PlanningFailedPayloadSchema,
  "planning.steered": PlanningSteeredPayloadSchema,
  "planning.rewound": PlanningRewoundPayloadSchema,
  "plan.validated": PlanValidatedPayloadSchema,
  "plan.validationFailed": PlanValidationFailedPayloadSchema,
  "dag.built": DagBuiltPayloadSchema,
  "dag.moduleReady": DagModuleReadyPayloadSchema,
  "dag.allPassed": DagAllPassedPayloadSchema,
  "module.dispatched": ModuleDispatchedPayloadSchema,
  "module.innerLoopTick": ModuleInnerLoopTickPayloadSchema,
  "module.executorFinished": ModuleExecutorFinishedPayloadSchema,
  "module.verificationStarted": ModuleVerificationStartedPayloadSchema,
  "module.passed": ModulePassedPayloadSchema,
  "module.rejected": ModuleRejectedPayloadSchema,
  "module.rolledBack": ModuleRolledBackPayloadSchema,
  "module.exhausted": ModuleExhaustedPayloadSchema,
  "clause.evaluated": ClauseEvaluatedPayloadSchema,
  "budget.charged": BudgetChargedPayloadSchema,
  "budget.warningThreshold": BudgetWarningThresholdPayloadSchema,
  "budget.exhausted": BudgetExhaustedPayloadSchema,
  "settlement.registered": SettlementRegisteredPayloadSchema,
  "settlement.settled": SettlementSettledPayloadSchema,
  "settlement.discarded": SettlementDiscardedPayloadSchema,
  "finalization.dispatched": FinalizationDispatchedPayloadSchema,
  "finalization.agentFinished": FinalizationAgentFinishedPayloadSchema,
  "finalization.escalated": FinalizationEscalatedPayloadSchema,
  "finalization.completed": FinalizationCompletedPayloadSchema,
  "snapshot.taken": SnapshotTakenPayloadSchema,
  "snapshot.restored": SnapshotRestoredPayloadSchema,
  "snapshot.promoted": SnapshotPromotedPayloadSchema,
};

export class PayloadRegistry {
  private schemas = new Map<string, z.ZodSchema>();

  constructor() {
    for (const [type, schema] of Object.entries(schemas)) {
      this.register(type, schema);
    }
  }

  register(eventType: string, schema: z.ZodSchema): void {
    if (this.schemas.has(eventType)) {
      throw new Error(`Event type already registered: ${eventType}`);
    }
    this.schemas.set(eventType, schema);
  }

  validate(eventType: string, payload: unknown): unknown {
    const schema = this.schemas.get(eventType);
    if (!schema) {
      throw new Error(`Unknown event type: ${eventType}`);
    }
    return schema.parse(payload);
  }
}
