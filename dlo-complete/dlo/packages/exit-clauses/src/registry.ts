import type { ExitClause, ExitClauseResult } from "@dlo/core";
export interface ClauseContext {
  workspace: string;
  backendDir?: string;
  frontendDir?: string;
  pgConnection?: {
    host: string;
    port: number;
    user: string;
    database: string;
  };
  evidenceMaxBytes?: number;
  signal?: AbortSignal;
}

export interface ClauseEvaluator {
  readonly kind: string;
  evaluate(clause: ExitClause, ctx: ClauseContext): Promise<ExitClauseResult>;
}

export class ClauseEvaluatorRegistry {
  #byKind = new Map<string, ClauseEvaluator>();

  register(e: ClauseEvaluator): void {
    if (this.#byKind.has(e.kind)) {
      throw new Error(`Duplicate evaluator registered for kind: ${e.kind}`);
    }
    this.#byKind.set(e.kind, e);
  }

  resolve(kind: string): ClauseEvaluator | undefined {
    return this.#byKind.get(kind);
  }
}
