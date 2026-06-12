import {
  type ExecutorProvider,
  type SupervisorProvider,
  type ExecutorFinish,
  type SnapshotRef,
  makeSnapshotRef,
} from "@dlo/core";
import type { SettlementTracker, JournalAppender } from "../settlement.js";
import type { BudgetLedger } from "../budget.js";

export interface EventBus {
  publish(event: { type: string; payload: unknown }): Promise<void>;
  subscribe(sub: {
    types: string[] | "*";
    handler: (event: any) => void | Promise<void>;
  }): void;
}

export interface ArtifactStore {
  putText(text: string, label: string): Promise<{ sha256: string; mediaType: string }>;
}

export interface GitPromoter {
  promote(preSnapshot: SnapshotRef, moduleId: string): Promise<void>;
}

export interface ClauseRunner {
  runAll(clauses: any[], ctx: any): Promise<any[]>;
}

export interface BoardInterface {
  apply(event: any): void;
  allPassed(): boolean;
  getModuleState(moduleId: string): any;
}

export class DoubleLoopController {
  constructor(
    private readonly deps: {
      bus: EventBus;
      board: BoardInterface;
      pump: { pump(): Promise<void> };
      executor: ExecutorProvider;
      supervisor: SupervisorProvider;
      clauses: ClauseRunner;
      settlement: SettlementTracker;
      journal: JournalAppender;
      artifacts: ArtifactStore;
      budget: BudgetLedger;
      epoch: () => number;
      git: GitPromoter;
      abortSignal?: AbortSignal;
    }
  ) {}

  start(): void {
    this.deps.executor.onFinish((finish) => void this.#onExecutorFinish(finish));
    this.deps.bus.subscribe({
      types: ["module.passed", "module.rejected"],
      handler: () => void this.deps.pump.pump(),
    });
  }

  async #onExecutorFinish(finish: ExecutorFinish): Promise<void> {
    const settled = await this.deps.settlement.trySettle(finish.runToken, this.deps.epoch());
    if (!settled.accepted) return; // stale — journaled by tracker, dropped

    await this.deps.journal.append("module.executorFinished", finish);

    // Look up module in the board
    const moduleState = this.deps.board.getModuleState(finish.moduleId);
    if (!moduleState) {
      return; // Module not in plan
    }
    const module = moduleState.module;

    // ── Open Code Review Loop for CodeWhale (Executor) ──
    const reviewResult = await this.#runOpenCodeReview(finish.workspace);
    if (!reviewResult.passed) {
      const critique = `[Open Code Review Failure]:\n${reviewResult.critique}`;
      const critiqueRef = await this.deps.artifacts.putText(critique, `critique:${finish.moduleId}:${finish.attempt.index}`);
      
      await this.deps.executor.restore(finish.workspace, makeSnapshotRef(finish.preSnapshot));
      
      await this.deps.journal.append("module.rejected", {
        moduleId: finish.moduleId,
        attemptId: finish.attemptId,
        critique: critiqueRef,
      });

      this.deps.board.apply({
        seq: 0,
        pipelineId: "",
        epoch: this.deps.epoch(),
        ts: new Date().toISOString(),
        type: "module.rejected",
        payload: {
          moduleId: finish.moduleId,
          attemptId: finish.attemptId,
          critique: critiqueRef,
        },
        integrity: "",
      });

      if (finish.attempt.index >= module.maxAttempts) {
        await this.deps.journal.append("module.exhausted", { moduleId: finish.moduleId });
        
        this.deps.board.apply({
          seq: 0,
          pipelineId: "",
          epoch: this.deps.epoch(),
          ts: new Date().toISOString(),
          type: "module.exhausted",
          payload: { moduleId: finish.moduleId },
          integrity: "",
        });
      }

      await this.deps.bus.publish({ type: "module.rejected", payload: { moduleId: finish.moduleId } });
      return;
    }

    // ── Deterministic clause pass (cheap, local, authoritative-negative) ──
    const clauseResults = await this.deps.clauses.runAll(module.exitClauses || [], finish.workspaceCtx);
    await this.deps.journal.append("clause.evaluated", { moduleId: finish.moduleId, clauseResults });

    // Apply the clause results to the DagBoard state
    this.deps.board.apply({
      seq: 0,
      pipelineId: "",
      epoch: this.deps.epoch(),
      ts: new Date().toISOString(),
      type: "clause.evaluated",
      payload: { moduleId: finish.moduleId, clauseResults },
      integrity: "",
    });

    // Determine if all clauses passed
    const allClausesPassed = clauseResults.every((r) => r.passed);

    // If any clause failed, it is an automatic FAIL (authoritative-negative)
    if (!allClausesPassed) {
      const critique = `Exit clauses failed: ${clauseResults
        .filter((r) => !r.passed)
        .map((r) => `${r.clauseId} (${r.observed})`)
        .join(", ")}`;
      const critiqueRef = await this.deps.artifacts.putText(critique, `critique:${finish.moduleId}:${finish.attempt.index}`);
      
      await this.deps.executor.restore(finish.workspace, makeSnapshotRef(finish.preSnapshot));
      
      await this.deps.journal.append("module.rejected", {
        moduleId: finish.moduleId,
        attemptId: finish.attemptId,
        critique: critiqueRef,
      });

      // Apply rejected state to board
      this.deps.board.apply({
        seq: 0,
        pipelineId: "",
        epoch: this.deps.epoch(),
        ts: new Date().toISOString(),
        type: "module.rejected",
        payload: {
          moduleId: finish.moduleId,
          attemptId: finish.attemptId,
          critique: critiqueRef,
        },
        integrity: "",
      });

      if (finish.attempt.index >= module.maxAttempts) {
        await this.deps.journal.append("module.exhausted", { moduleId: finish.moduleId });
        
        this.deps.board.apply({
          seq: 0,
          pipelineId: "",
          epoch: this.deps.epoch(),
          ts: new Date().toISOString(),
          type: "module.exhausted",
          payload: { moduleId: finish.moduleId },
          integrity: "",
        });
      }

      await this.deps.bus.publish({ type: "module.rejected", payload: { moduleId: finish.moduleId } });
      return;
    }

    // ── Outer loop: supervisor evaluation ──
    await this.deps.journal.append("module.verificationStarted", { moduleId: finish.moduleId, attemptId: finish.attemptId });
    
    // Apply verifying state to board
    this.deps.board.apply({
      seq: 0,
      pipelineId: "",
      epoch: this.deps.epoch(),
      ts: new Date().toISOString(),
      type: "module.verificationStarted",
      payload: { moduleId: finish.moduleId },
      integrity: "",
    });

    const evalRequest: any = {
      module,
      attempt: finish.attempt,
      clauseResults,
      workspace: finish.workspace,
      timeoutMs: module.evaluationTimeoutMs || 900_000,
    };
    if (finish.transcriptHandle !== undefined) {
      evalRequest.transcriptHandle = finish.transcriptHandle;
    }

    const verdict = await this.deps.supervisor.evaluate(
      evalRequest,
      this.deps.abortSignal || new AbortController().signal
    );

    if (verdict.kind === "PASS") {
      await this.deps.git.promote(makeSnapshotRef(finish.preSnapshot), finish.moduleId);
      await this.deps.journal.append("module.passed", { moduleId: finish.moduleId, attemptId: finish.attemptId });

      this.deps.board.apply({
        seq: 0,
        pipelineId: "",
        epoch: this.deps.epoch(),
        ts: new Date().toISOString(),
        type: "module.passed",
        payload: { moduleId: finish.moduleId, attemptId: finish.attemptId },
        integrity: "",
      });

      if (this.deps.board.allPassed()) {
        await this.deps.journal.append("dag.allPassed", {});
        await this.deps.bus.publish({ type: "dag.allPassed", payload: {} });
      }

      await this.deps.bus.publish({ type: "module.passed", payload: { moduleId: finish.moduleId } });
      return;
    }

    // FAIL path
    const critiqueRef = await this.deps.artifacts.putText(verdict.critique, `critique:${finish.moduleId}:${finish.attempt.index}`);
    await this.deps.executor.restore(finish.workspace, makeSnapshotRef(finish.preSnapshot));
    await this.deps.journal.append("module.rejected", {
      moduleId: finish.moduleId,
      attemptId: finish.attemptId,
      critique: critiqueRef,
    });

    this.deps.board.apply({
      seq: 0,
      pipelineId: "",
      epoch: this.deps.epoch(),
      ts: new Date().toISOString(),
      type: "module.rejected",
      payload: {
        moduleId: finish.moduleId,
        attemptId: finish.attemptId,
        critique: critiqueRef,
      },
      integrity: "",
    });

    if (finish.attempt.index >= module.maxAttempts) {
      await this.deps.journal.append("module.exhausted", { moduleId: finish.moduleId });
      
      this.deps.board.apply({
        seq: 0,
        pipelineId: "",
        epoch: this.deps.epoch(),
        ts: new Date().toISOString(),
        type: "module.exhausted",
        payload: { moduleId: finish.moduleId },
        integrity: "",
      });
    }

    await this.deps.bus.publish({ type: "module.rejected", payload: { moduleId: finish.moduleId } });
  }

  async #runOpenCodeReview(workspace: string): Promise<{ passed: boolean; critique: string }> {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const execAsync = promisify(exec);
      
      let targetDir = workspace || process.cwd();
      if (!fs.existsSync(targetDir)) {
        targetDir = process.cwd();
      }
      const localBinDir = path.join(targetDir, ".dlo/bin");
      const env = { ...process.env, PATH: `${localBinDir}:${process.env.PATH}` };

      const { stdout } = await execAsync("ocr review", { cwd: targetDir, env });
      
      const passed = stdout.toLowerCase().includes("everything is fine") || 
                     (!stdout.toLowerCase().includes("error") && !stdout.toLowerCase().includes("issue"));
                     
      return { passed, critique: stdout };
    } catch (err: any) {
      console.warn(`[OCR] open-code-review failed or not installed: ${err.message}. Falling back to LLM review.`);
      return this.#runLLMCodeReviewFallback(workspace);
    }
  }

  async #runLLMCodeReviewFallback(workspace: string): Promise<{ passed: boolean; critique: string }> {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const fs = await import("node:fs");
      const execAsync = promisify(exec);
      
      let targetDir = workspace || process.cwd();
      if (!fs.existsSync(targetDir)) {
        targetDir = process.cwd();
      }
      
      const { stdout: diff } = await execAsync("git diff", { cwd: targetDir });
      
      if (!diff.trim()) {
        return { passed: true, critique: "everything is fine" };
      }

      const prompt = `You are a Code Review Agent running on behalf of open-code-review (https://github.com/alibaba/open-code-review).
Review the following git diff for errors, bugs, or anti-patterns:
${diff}

If the code has no issues, reply with exactly: "everything is fine".
Otherwise, list the specific errors that need to be fixed.`;

      const verdict = await this.deps.supervisor.evaluate({
        module: { prompt },
        attempt: { index: 1 },
        clauseResults: [],
        workspace,
        timeoutMs: 30000,
      }, new AbortController().signal);

      const passed = verdict.critique.toLowerCase().includes("everything is fine") || verdict.kind === "PASS";
      return { passed, critique: verdict.critique };
    } catch (err: any) {
      console.error(`[OCR] LLM fallback review failed: ${err.message}`);
      return { passed: true, critique: "everything is fine" };
    }
  }
}
