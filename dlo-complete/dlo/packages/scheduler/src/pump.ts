import { makeRunToken, type ExecutorProvider } from "@dlo/core";
import type { DagBoard } from "./board.js";
import type { BudgetLedger, SettlementTracker } from "@dlo/kernel";

export interface JournalAppender {
  append(type: string, payload: unknown): Promise<void>;
}

export class DispatchPump {
  #running = false;
  #pendingPump = false;

  constructor(
    private readonly deps: {
      board: DagBoard;
      executor: ExecutorProvider;
      settlement: SettlementTracker;
      budget: BudgetLedger;
      journal: JournalAppender;
      epoch: () => number;
      workspace: string;
    }
  ) {}

  /** Invoked after every settled module event and on execution begin/resume. Idempotent. */
  async pump(): Promise<void> {
    if (this.#running) {
      this.#pendingPump = true;
      return;
    }

    this.#running = true;
    try {
      await this.#runPumpLoop();
    } finally {
      this.#running = false;
      if (this.#pendingPump) {
        this.#pendingPump = false;
        // Schedule next pump in next tick to avoid stack overflow
        process.nextTick(() => void this.pump());
      }
    }
  }

  async #runPumpLoop(): Promise<void> {
    while (true) {
      const cap = this.deps.executor.capacity();
      if (cap.inFlight >= cap.max) {
        break;
      }

      const ready = this.deps.board.ready();
      if (ready.length === 0) {
        break;
      }

      // 1. Budget headroom check
      this.deps.budget.assertHeadroom("usd", "moduleDispatch");

      // 2. Get next ready module by criticality (the ready list is already sorted)
      const nextMod = ready[0]!;

      // 3. Mark the module as executing by dispatching it
      const attemptIndex = (this.deps.board.getModuleState(nextMod.moduleId as any)?.attempts.length || 0) + 1;
      const attemptId = crypto.randomUUID();

      // 4. preSnapshot
      const preSnapshot = await this.deps.executor.snapshot(this.deps.workspace);

      // 5. Run token & settlement registration
      const token = makeRunToken();
      const epoch = this.deps.epoch();
      this.deps.settlement.register(token, epoch, {
        kind: "intent.gate.open",
        gateId: attemptId as any,
        gateKind: "MODULE_DISPATCH",
        exhibits: [],
      } as any);

      // We append the settlement registered event to trace it in the journal
      await this.deps.journal.append("settlement.registered", {
        runToken: token,
        epoch,
        moduleId: nextMod.moduleId,
        attemptId,
      });

      // Retrieve critique if this is a retry (attemptIndex > 1)
      let critique: string | undefined;
      if (attemptIndex > 1) {
        const attempts = this.deps.board.getModuleState(nextMod.moduleId as any)?.attempts || [];
        const lastAttempt = attempts[attempts.length - 1];
        if (lastAttempt?.critique) {
          critique = lastAttempt.critique.sha256; 
        }
      }

      // 6. Dispatch to executor
      const dispatchParams: any = {
        module: nextMod,
        attemptId,
        attempt: { index: attemptIndex },
        preSnapshot,
        workspace: this.deps.workspace,
        runToken: token,
      };
      if (critique !== undefined) {
        dispatchParams.critique = critique;
      }
      const sessionRef = await this.deps.executor.dispatch(dispatchParams);

      // Apply the dispatch event to the local board state
      this.deps.board.apply({
        seq: 0,
        pipelineId: "",
        epoch,
        ts: new Date().toISOString(),
        type: "module.dispatched",
        payload: {
          moduleId: nextMod.moduleId,
          attemptId,
          attempt: { index: attemptIndex },
          sessionRef,
          preSnapshot,
        },
        integrity: "",
      });
    }
  }
}
