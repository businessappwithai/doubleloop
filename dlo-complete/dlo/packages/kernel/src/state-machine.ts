import type { PipelinePhase, DomainDocument, TripartitePlanRefs, GateId } from "@dlo/core";
import { IllegalStateTransitionError } from "@dlo/core";
import type { JournalEvent } from "@dlo/journal";

export interface PipelineState {
  readonly phase: PipelinePhase;
  readonly sessionEpoch: number;
  readonly activeGateId: GateId | null;
  readonly domainDocument: DomainDocument | null;
  readonly planArtifacts: TripartitePlanRefs | null;
}

export type KernelIntent =
  | { kind: "intent.research.start" }
  | { kind: "intent.research.steer"; instructions: any }
  | { kind: "intent.research.restart" }
  | { kind: "intent.gate.open"; gateId: GateId; gateKind: string; exhibits: any[]; context?: any }
  | { kind: "intent.planning.start" }
  | { kind: "intent.planning.steer"; instructions: any }
  | { kind: "intent.planning.rewind" }
  | { kind: "intent.execution.begin" }
  | { kind: "intent.execution.remediate"; moduleIds: string[] }
  | { kind: "intent.finalization.start" }
  | { kind: "intent.wrapup.flush" }
  | { kind: "intent.report.success" }
  | { kind: "intent.report.failure"; error: any };

export class StateMachine {
  initialState(): PipelineState {
    return {
      phase: "INIT",
      sessionEpoch: 0,
      activeGateId: null,
      domainDocument: null,
      planArtifacts: null,
    };
  }

  reduce(
    state: PipelineState,
    event: JournalEvent
  ): { next: PipelineState; intents: ReadonlyArray<KernelIntent> } {
    const key = `${state.phase}::${event.type}`;

    // Handle global abort request from non-terminal states
    if (event.type === "pipeline.abortRequested" && !["COMPLETED", "FAILED", "ABORTED"].includes(state.phase)) {
      return {
        next: {
          ...state,
          phase: "ABORTED",
          activeGateId: null,
        },
        intents: [{ kind: "intent.wrapup.flush" }],
      };
    }

    // Handle global budget exhausted
    if (event.type === "budget.exhausted" && !["COMPLETED", "FAILED", "ABORTED"].includes(state.phase)) {
      return {
        next: {
          ...state,
          phase: "ABORTED",
          activeGateId: null,
        },
        intents: [{ kind: "intent.wrapup.flush" }],
      };
    }

    // Handle events that are allowed in any state without changing state or emitting intents
    const globalPassThroughEvents = [
      "budget.charged",
      "budget.warningThreshold",
      "settlement.registered",
      "settlement.settled",
      "settlement.discarded",
      "snapshot.taken",
      "snapshot.restored",
    ];
    if (globalPassThroughEvents.includes(event.type)) {
      return { next: state, intents: [] };
    }

    switch (key) {
      case "INIT::pipeline.started":
        return {
          next: {
            ...state,
            phase: "RESEARCH_RUNNING",
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.research.start" }],
        };

      case "RESEARCH_RUNNING::research.pollTick":
        return { next: state, intents: [] };

      case "RESEARCH_RUNNING::research.completed": {
        const payload = event.payload as { document: DomainDocument; gateId: GateId };
        return {
          next: {
            ...state,
            phase: "GATE1_PENDING",
            domainDocument: payload.document,
            activeGateId: payload.gateId,
          },
          intents: [
            {
              kind: "intent.gate.open",
              gateId: payload.gateId,
              gateKind: "DOMAIN_DOCUMENT",
              exhibits: [payload.document.markdown],
            },
          ],
        };
      }

      case "RESEARCH_RUNNING::research.failed":
        return {
          next: {
            ...state,
            phase: "FAILED",
          },
          intents: [{ kind: "intent.report.failure", error: event.payload }],
        };

      case "GATE1_PENDING::gate.approved":
        return {
          next: {
            ...state,
            phase: "PLANNING_RUNNING",
            activeGateId: null,
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.planning.start" }],
        };

      case "GATE1_PENDING::gate.steered": {
        const payload = event.payload as { instructions: string };
        return {
          next: {
            ...state,
            phase: "RESEARCH_RUNNING",
            activeGateId: null,
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.research.steer", instructions: payload.instructions }],
        };
      }

      case "GATE1_PENDING::gate.rejected":
        return {
          next: {
            ...state,
            phase: "RESEARCH_RUNNING",
            activeGateId: null,
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.research.restart" }],
        };

      case "GATE1_PENDING::gate.expired":
        return { next: state, intents: [] }; // No phase change, wait for user action

      case "PLANNING_RUNNING::planning.completed": {
        const payload = event.payload as { plan: TripartitePlanRefs; gateId: GateId };
        return {
          next: {
            ...state,
            phase: "GATE2_PENDING",
            planArtifacts: payload.plan,
            activeGateId: payload.gateId,
          },
          intents: [
            {
              kind: "intent.gate.open",
              gateId: payload.gateId,
              gateKind: "TRIPARTITE_PLAN",
              exhibits: [payload.plan.ceoPlan, payload.plan.architecturePlan, payload.plan.engineeringPlan],
            },
          ],
        };
      }

      case "PLANNING_RUNNING::planning.failed":
        return {
          next: {
            ...state,
            phase: "FAILED",
          },
          intents: [{ kind: "intent.report.failure", error: event.payload }],
        };

      case "GATE2_PENDING::gate.approved":
        return {
          next: {
            ...state,
            phase: "EXECUTION_RUNNING",
            activeGateId: null,
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.execution.begin" }],
        };

      case "GATE2_PENDING::gate.steered": {
        const payload = event.payload as { instructions: string };
        return {
          next: {
            ...state,
            phase: "PLANNING_RUNNING",
            activeGateId: null,
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.planning.steer", instructions: payload.instructions }],
        };
      }

      case "GATE2_PENDING::gate.rejected":
        return {
          next: {
            ...state,
            phase: "PLANNING_RUNNING",
            activeGateId: null,
            sessionEpoch: state.sessionEpoch + 1,
          },
          intents: [{ kind: "intent.planning.rewind" }],
        };

      case "GATE2_PENDING::gate.expired":
        return { next: state, intents: [] };

      // In EXECUTION_RUNNING, let all execution events pass through without changing phase
      case "EXECUTION_RUNNING::module.dispatched":
      case "EXECUTION_RUNNING::module.innerLoopTick":
      case "EXECUTION_RUNNING::module.executorFinished":
      case "EXECUTION_RUNNING::module.verificationStarted":
      case "EXECUTION_RUNNING::module.passed":
      case "EXECUTION_RUNNING::module.rejected":
      case "EXECUTION_RUNNING::module.rolledBack":
      case "EXECUTION_RUNNING::clause.evaluated":
      case "EXECUTION_RUNNING::snapshot.promoted":
        return { next: state, intents: [] };

      case "EXECUTION_RUNNING::dag.allPassed":
        return {
          next: {
            ...state,
            phase: "FINALIZATION_RUNNING",
          },
          intents: [{ kind: "intent.finalization.start" }],
        };

      case "EXECUTION_RUNNING::module.exhausted": {
        const payload = event.payload as { moduleId: string; gateId: GateId; exhibits: any[] };
        return {
          next: {
            ...state,
            phase: "GATE2_PENDING",
            activeGateId: payload.gateId,
          },
          intents: [
            {
              kind: "intent.gate.open",
              gateId: payload.gateId,
              gateKind: "MODULE_ESCALATION",
              exhibits: payload.exhibits,
              context: { moduleId: payload.moduleId },
            },
          ],
        };
      }

      case "FINALIZATION_RUNNING::finalization.dispatched":
      case "FINALIZATION_RUNNING::finalization.agentFinished":
        return { next: state, intents: [] };

      case "FINALIZATION_RUNNING::finalization.completed":
        return {
          next: {
            ...state,
            phase: "COMPLETED",
          },
          intents: [{ kind: "intent.report.success" }],
        };

      case "FINALIZATION_RUNNING::finalization.escalated": {
        const payload = event.payload as { moduleIds: string[] };
        return {
          next: {
            ...state,
            phase: "EXECUTION_RUNNING",
          },
          intents: [{ kind: "intent.execution.remediate", moduleIds: payload.moduleIds }],
        };
      }

      default:
        throw new IllegalStateTransitionError(
          `No transition from ${state.phase} on event ${event.type}`,
          state.phase,
          event.type
        );
    }
  }
}
