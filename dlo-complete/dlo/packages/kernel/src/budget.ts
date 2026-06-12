import { BudgetExhaustedError } from "@dlo/core";
import type { JournalAppender } from "./settlement.js";

export type BudgetDimension = "usd" | "tokens" | "wallClockMs" | "spawnDepth" | "turns";

export interface BudgetConfig {
  usd: number;
  tokens: number;
  wallClockMs: number;
  spawnDepth: number;
  turns: number;
  warnAtFraction: number; // default 0.8
}

export class BudgetLedger {
  #limits: BudgetConfig;
  #spent: Record<BudgetDimension, number> = {
    usd: 0,
    tokens: 0,
    wallClockMs: 0,
    spawnDepth: 0,
    turns: 0,
  };
  #warned = new Set<BudgetDimension>();
  #journal: JournalAppender;

  constructor(config: BudgetConfig, journal: JournalAppender) {
    this.#limits = {
      ...config,
      warnAtFraction: config.warnAtFraction ?? 0.8,
    };
    this.#journal = journal;
  }

  async charge(dim: BudgetDimension, amount: number, attribution: string): Promise<void> {
    this.#spent[dim] += amount;

    await this.#journal.append("budget.charged", {
      dimension: dim,
      amount,
      attribution,
    });

    const fraction = this.#spent[dim] / this.#limits[dim];

    if (fraction >= this.#limits.warnAtFraction && !this.#warned.has(dim)) {
      this.#warned.add(dim);
      await this.#journal.append("budget.warningThreshold", {
        dimension: dim,
        fraction,
      });
    }

    if (this.#spent[dim] > this.#limits[dim]) {
      await this.#journal.append("budget.exhausted", {
        dimension: dim,
      });
      throw new BudgetExhaustedError(
        `Budget exhausted for ${dim}: spent ${this.#spent[dim]} of limit ${this.#limits[dim]}`,
        dim,
        this.#spent[dim],
        this.#limits[dim]
      );
    }
  }

  assertHeadroom(dim: BudgetDimension, op: string): void {
    if (this.#spent[dim] >= this.#limits[dim]) {
      throw new BudgetExhaustedError(
        `Cannot perform ${op}: ${dim} budget exhausted`,
        dim,
        this.#spent[dim],
        this.#limits[dim]
      );
    }
  }

  spent(): Record<BudgetDimension, number> {
    return { ...this.#spent };
  }

  remaining(dim: BudgetDimension): number {
    return Math.max(0, this.#limits[dim] - this.#spent[dim]);
  }

  serialize() {
    return { spent: { ...this.#spent }, limits: this.#limits };
  }

  static deserialize(
    data: { spent: Record<BudgetDimension, number>; limits: BudgetConfig },
    journal: JournalAppender
  ): BudgetLedger {
    const ledger = new BudgetLedger(data.limits, journal);
    ledger.#spent = { ...data.spent };
    // Rebuild the #warned set based on loaded spent values
    for (const key of ["usd", "tokens", "wallClockMs", "spawnDepth", "turns"] as BudgetDimension[]) {
      const fraction = ledger.#spent[key] / ledger.#limits[key];
      if (fraction >= ledger.#limits.warnAtFraction) {
        ledger.#warned.add(key);
      }
    }
    return ledger;
  }
}
