import type { ExitClause, ExitClauseResult } from "@dlo/core";
import { ExitClauseEvaluationError } from "@dlo/core";
import type { ClauseContext, ClauseEvaluatorRegistry } from "./registry.js";

export class ClauseRunner {
  #registry: ClauseEvaluatorRegistry;

  constructor(registry: ClauseEvaluatorRegistry) {
    this.#registry = registry;
  }

  async runAll(
    clauses: ReadonlyArray<ExitClause>,
    ctx: ClauseContext
  ): Promise<ReadonlyArray<ExitClauseResult>> {
    const results: ExitClauseResult[] = [];
    for (const clause of clauses) {
      const evaluator = this.#registry.resolve(clause.kind);
      if (!evaluator) {
        throw new ExitClauseEvaluationError(
          `No evaluator registered for kind: ${clause.kind}`,
          clause.clauseId
        );
      }

      try {
        const result = await evaluator.evaluate(clause, ctx);
        results.push(result);
      } catch (e) {
        throw new ExitClauseEvaluationError(
          `Clause evaluation failed: ${e instanceof Error ? e.message : String(e)}`,
          clause.clauseId,
          { cause: e }
        );
      }
    }
    return results;
  }
}
