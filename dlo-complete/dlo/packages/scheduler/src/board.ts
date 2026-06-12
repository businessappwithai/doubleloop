import type { EngineeringPlan, EngineeringModule } from "@dlo/plan-schema";
import type { JournalEvent } from "@dlo/journal";
import { IllegalStateTransitionError, type ModuleId, type ModuleStatus, type ModuleAttempt } from "@dlo/core";

export interface ModuleState {
  module: EngineeringModule;
  status: ModuleStatus;
  attempts: ModuleAttempt[];
}

export class DagBoard {
  #modules = new Map<ModuleId, ModuleState>();
  #criticality = new Map<ModuleId, number>();

  private constructor(plan: EngineeringPlan) {
    // 1. Initialize all modules
    for (const mod of plan.modules) {
      this.#modules.set(mod.moduleId as ModuleId, {
        module: mod,
        status: mod.dependsOn.length === 0 ? "READY" : "BLOCKED",
        attempts: [],
      });
    }

    // 2. Compute criticality
    const adj = new Map<string, string[]>();
    const memo = new Map<string, number>();

    for (const mod of plan.modules) {
      adj.set(mod.moduleId, []);
    }

    for (const mod of plan.modules) {
      for (const dep of mod.dependsOn) {
        const list = adj.get(dep) || [];
        list.push(mod.moduleId);
        adj.set(dep, list);
      }
    }

    const getHeight = (id: string): number => {
      if (memo.has(id)) return memo.get(id)!;
      const dependents = adj.get(id) || [];
      if (dependents.length === 0) {
        memo.set(id, 1);
        return 1;
      }
      let maxSub = 0;
      for (const dep of dependents) {
        maxSub = Math.max(maxSub, getHeight(dep));
      }
      const height = 1 + maxSub;
      memo.set(id, height);
      return height;
    };

    for (const mod of plan.modules) {
      this.#criticality.set(mod.moduleId as ModuleId, getHeight(mod.moduleId));
    }
  }

  static build(plan: EngineeringPlan, replay: Iterable<JournalEvent>): DagBoard {
    const board = new DagBoard(plan);
    for (const event of replay) {
      board.apply(event);
    }
    return board;
  }

  ready(): ReadonlyArray<EngineeringModule> {
    const readyModules: EngineeringModule[] = [];
    for (const state of this.#modules.values()) {
      if (state.status === "READY" || state.status === "REJECTED") {
        readyModules.push(state.module);
      }
    }

    // Order by depth-first criticality (highest first)
    return readyModules.sort((a, b) => {
      const critA = this.#criticality.get(a.moduleId as ModuleId) || 0;
      const critB = this.#criticality.get(b.moduleId as ModuleId) || 0;
      return critB - critA;
    });
  }

  apply(event: JournalEvent): void {
    // Check if the event is a module event or clause event
    if (!event.type.startsWith("module.") && event.type !== "clause.evaluated") {
      return;
    }

    const payload = event.payload as any;
    if (!payload || !payload.moduleId) {
      return;
    }

    const moduleId = payload.moduleId as ModuleId;
    const state = this.#modules.get(moduleId);
    if (!state) {
      return; // Ignore events for modules not in the plan
    }

    const fromStatus = state.status;

    switch (event.type) {
      case "module.dispatched": {
        if (fromStatus !== "READY" && fromStatus !== "REJECTED") {
          throw new IllegalStateTransitionError(
            `Cannot dispatch module ${moduleId} from status ${fromStatus}`,
            fromStatus,
            event.type
          );
        }
        state.status = "EXECUTING";
        // Record attempt
        const attempt: ModuleAttempt = {
          attemptId: payload.attemptId,
          index: payload.attempt?.index || (state.attempts.length + 1),
          executorSessionRef: payload.sessionRef || "",
          startedAt: event.ts,
          preSnapshot: payload.preSnapshot || "",
        };
        state.attempts = [...state.attempts, attempt];
        break;
      }

      case "module.executorFinished": {
        if (fromStatus !== "EXECUTING") {
          throw new IllegalStateTransitionError(
            `Cannot verify finished executor for module ${moduleId} from status ${fromStatus}`,
            fromStatus,
            event.type
          );
        }
        state.status = "VERIFYING";
        // Update attempt
        const attempts = [...state.attempts];
        const last = attempts[attempts.length - 1];
        if (last) {
          attempts[attempts.length - 1] = {
            ...last,
            finishedAt: event.ts,
            summary: payload.summary,
            changes: payload.changes,
          };
        }
        state.attempts = attempts;
        break;
      }

      case "module.verificationStarted": {
        if (fromStatus === "EXECUTING") {
          state.status = "VERIFYING";
        }
        break;
      }

      case "clause.evaluated": {
        // Record exit clause results
        const attempts = [...state.attempts];
        const last = attempts[attempts.length - 1];
        if (last) {
          attempts[attempts.length - 1] = {
            ...last,
            clauseResults: payload.clauseResults,
          };
        }
        state.attempts = attempts;
        break;
      }

      case "module.passed": {
        if (fromStatus !== "VERIFYING" && fromStatus !== "EXECUTING") {
          throw new IllegalStateTransitionError(
            `Cannot pass module ${moduleId} from status ${fromStatus}`,
            fromStatus,
            event.type
          );
        }
        state.status = "PASSED";
        // Update attempt
        const attempts = [...state.attempts];
        const last = attempts[attempts.length - 1];
        if (last) {
          attempts[attempts.length - 1] = {
            ...last,
            verdict: "PASS",
            finishedAt: last.finishedAt || event.ts,
          };
        }
        state.attempts = attempts;

        // Propagate READY status to downstream modules
        this.#recomputeBlockedStates();
        break;
      }

      case "module.rejected": {
        if (fromStatus !== "VERIFYING" && fromStatus !== "EXECUTING") {
          throw new IllegalStateTransitionError(
            `Cannot reject module ${moduleId} from status ${fromStatus}`,
            fromStatus,
            event.type
          );
        }
        state.status = "REJECTED";
        // Update attempt
        const attempts = [...state.attempts];
        const last = attempts[attempts.length - 1];
        if (last) {
          attempts[attempts.length - 1] = {
            ...last,
            verdict: "FAIL",
            critique: payload.critique,
            finishedAt: last.finishedAt || event.ts,
          };
        }
        state.attempts = attempts;
        break;
      }

      case "module.exhausted": {
        if (fromStatus !== "VERIFYING" && fromStatus !== "REJECTED" && fromStatus !== "EXECUTING") {
          throw new IllegalStateTransitionError(
            `Cannot exhaust module ${moduleId} from status ${fromStatus}`,
            fromStatus,
            event.type
          );
        }
        state.status = "EXHAUSTED";
        break;
      }
    }
  }

  #recomputeBlockedStates(): void {
    for (const state of this.#modules.values()) {
      if (state.status === "BLOCKED") {
        let allPassed = true;
        for (const dep of state.module.dependsOn) {
          const depState = this.#modules.get(dep as ModuleId);
          if (!depState || depState.status !== "PASSED") {
            allPassed = false;
            break;
          }
        }
        if (allPassed) {
          state.status = "READY";
        }
      }
    }
  }

  allPassed(): boolean {
    for (const state of this.#modules.values()) {
      if (state.status !== "PASSED") {
        return false;
      }
    }
    return true;
  }

  exhausted(): ReadonlyArray<ModuleId> {
    const list: ModuleId[] = [];
    for (const [id, state] of this.#modules.entries()) {
      if (state.status === "EXHAUSTED") {
        list.push(id);
      }
    }
    return list;
  }

  getModuleState(moduleId: ModuleId): ModuleState | undefined {
    return this.#modules.get(moduleId);
  }

  serialize() {
    const serializedModules: any[] = [];
    for (const [id, state] of this.#modules.entries()) {
      serializedModules.push({
        moduleId: id,
        status: state.status,
        attempts: state.attempts,
      });
    }
    return { modules: serializedModules };
  }
}
